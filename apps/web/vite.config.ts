import { defineConfig, loadEnv, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

/**
 * Demo mode answers /v1 in the browser, so there is no API to trade the Deepgram key for a
 * recording token. Under `vite dev` only, this does that one job: the key is read from the
 * repo's .env here, in Node, and the browser only ever gets a one-minute token.
 */
function demoTranscriptionToken(): Plugin {
  return {
    name: 'demo-transcription-token',
    apply: 'serve',
    configureServer(server) {
      const key = loadEnv('development', '../..', '').DEEPGRAM_API_KEY;
      server.middlewares.use('/demo/transcription-token', (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return send(405, { code: 'method' });
        if (!key) return send(503, { code: 'not_configured' });
        fetch('https://api.deepgram.com/v1/auth/grant', {
          method: 'POST',
          headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl_seconds: 60 }),
        })
          .then(async (r) => {
            const b = (await r.json().catch(() => null)) as { access_token?: string } | null;
            if (!r.ok || !b?.access_token) return send(502, { code: 'upstream' });
            send(200, { token: b.access_token, expiresIn: 60 });
          })
          .catch(() => send(502, { code: 'upstream' }));
      });
    },
  };
}

/**
 * The interview coach in demo mode: the API's own code (server/api/src/interview-coach.ts),
 * loaded by this dev server, with the NVIDIA key from the repo's .env. Same prompt, same checks,
 * same answers as the real route; only the sign-in check is missing, as everywhere in demo mode.
 */
function demoInterviewCoach(): Plugin {
  return {
    name: 'demo-interview-coach',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv('development', '../..', '');
      const coachFile = fileURLToPath(
        new URL('../../server/api/src/interview-coach.ts', import.meta.url),
      );
      const nimFile = fileURLToPath(new URL('../../server/api/src/nim.ts', import.meta.url));
      let model: unknown;
      server.middlewares.use('/demo/interview-suggest', (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return send(405, { code: 'method' });
        let raw = '';
        req.on('data', (chunk: Buffer) => {
          raw += chunk;
          if (raw.length > 64 * 1024) req.destroy();
        });
        req.on('end', () => {
          void (async () => {
            const coach = (await server.ssrLoadModule(
              coachFile,
            )) as typeof import('../../server/api/src/interview-coach');
            const nim = (await server.ssrLoadModule(
              nimFile,
            )) as typeof import('../../server/api/src/nim');
            model ??= nim.createNimChat({
              apiKey: env.NVIDIA_API_KEY || undefined,
              model: env.INTERVIEW_MODEL || coach.INTERVIEW_MODEL_DEFAULT,
              timeoutMs: 9000,
              attempts: 1,
              hedgeMs: 0,
            });
            const body = coach.readCoachRequest(JSON.parse(raw || 'null'));
            if ('error' in body) return send(400, { code: 'bad_request' });
            try {
              send(200, await coach.suggest(model as Parameters<typeof coach.suggest>[0], body));
            } catch (e) {
              const code = e instanceof coach.CoachError ? e.code : 'unavailable';
              send(code === 'not_configured' ? 503 : 502, { code });
            }
          })().catch(() => send(500, { code: 'internal' }));
        });
      });
    },
  };
}

// /v1 is proxied same-origin to the API (avoids an Authorization preflight); the
// browser tests point it at an in-process server on a free port instead
export default defineConfig({
  plugins: [react(), demoTranscriptionToken(), demoInterviewCoach()],
  server: {
    port: 3000,
    proxy: { '/v1': 'http://127.0.0.1:8788' },
  },
});
