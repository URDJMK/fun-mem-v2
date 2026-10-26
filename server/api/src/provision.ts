import { countryCode } from '@funmem/core';
import type { Pool } from 'pg';

export interface ProvisionInput {
  /** Verified auth.users id — from the JWT sub, never the request body. */
  userId: string;
  subjectName: string;
  /** FR-128: no default; the caller must supply it. */
  jurisdiction: string;
  /** personal (one person; the default) or family (the subject name is the family's name) */
  kind?: 'personal' | 'family';
  tenantName?: string;
}

export interface Provisioned {
  tenantId: string;
  archiveId: string;
}

export class ProvisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Signup provisioning: personal tenant → archive → owner membership, in FK order,
 * inside ONE transaction — a failure at any step leaves zero rows behind.
 * (PostgREST can't span statements, hence direct pg per the FM-014 scout brief.)
 */
export async function provisionSignup(pool: Pool, input: ProvisionInput): Promise<Provisioned> {
  const subjectName = input.subjectName?.trim();
  if (!subjectName || !input.jurisdiction?.trim()) {
    throw new ProvisionError('subjectName and jurisdiction are required', 400);
  }
  const kind = input.kind ?? 'personal';
  if (kind !== 'personal' && kind !== 'family') {
    throw new ProvisionError('kind must be personal or family', 400);
  }
  // only a real country, as its ISO code: free text ("USA", "my house") is refused, not stored
  const jurisdiction = countryCode(input.jurisdiction);
  if (!jurisdiction) {
    throw new ProvisionError(
      'jurisdiction must be a two-letter ISO country code, like US or GB',
      400,
    );
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tenant = await client.query(
      `insert into public.tenants (kind, name) values ('personal', $1) returning id`,
      [input.tenantName?.trim() || `${subjectName} archive`],
    );
    const tenantId: string = tenant.rows[0].id;
    const archive = await client.query(
      `insert into public.archives (tenant_id, subject_name, jurisdiction, kind)
       values ($1, $2, $3, $4) returning id`,
      [tenantId, subjectName, jurisdiction, kind],
    );
    const archiveId: string = archive.rows[0].id;
    await client.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'owner')`,
      [archiveId, input.userId],
    );
    await client.query('commit');
    return { tenantId, archiveId };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
