import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler } from 'hono';

/** Verified-identity variables set by the auth middleware. */
export interface AuthVariables {
  userId: string;
}

// sub must be an auth.users uuid — a non-uuid sub (mintable only by a legacy-mode
// secret holder) would otherwise surface as a pg 22P02 500 downstream instead of 401
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthConfig {
  /** HS256 shared secret — local stack mode (config.toml jwt_secret). */
  hs256Secret?: string;
  /** Remote JWKS URL — hosted mode (ES256 signing keys). */
  jwksUrl?: string;
  /** Expected iss claim, e.g. http://127.0.0.1:54321/auth/v1 */
  issuer: string;
}

/**
 * Verifies the Supabase JWT server-side: signature (HS256 secret locally, remote
 * JWKS when hosted) AND claims — iss, aud/role 'authenticated', non-anonymous,
 * uuid sub. Anything short of that is a uniform 401. Decoding without signature
 * verification is exactly the shortcut this module exists to prevent.
 */
export function supabaseAuth(cfg: AuthConfig): MiddlewareHandler {
  // fail closed: refusing to construct beats silently accepting every token
  if (!cfg.hs256Secret && !cfg.jwksUrl) {
    throw new Error('supabaseAuth: configure hs256Secret (local) or jwksUrl (hosted)');
  }
  const key: JWTVerifyGetKey | Uint8Array = cfg.jwksUrl
    ? createRemoteJWKSet(new URL(cfg.jwksUrl))
    : new TextEncoder().encode(cfg.hs256Secret);
  // symmetric mode pins the algorithm; JWKS mode takes alg from the published key
  const algorithms = cfg.jwksUrl ? undefined : ['HS256'];

  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/.exec(header)?.[1];
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    try {
      // jose overloads on key type; the union is safe for both modes
      const { payload } = await jwtVerify(token, key as Uint8Array, {
        issuer: cfg.issuer,
        audience: 'authenticated',
        algorithms,
      });
      if (
        payload.role !== 'authenticated' ||
        payload.is_anonymous === true ||
        typeof payload.sub !== 'string' ||
        !UUID_RE.test(payload.sub)
      ) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      c.set('userId', payload.sub);
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
