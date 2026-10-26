/**
 * A project's own settings: its name, its kind, and deleting it.
 *
 * The name can be changed by those who look after the project (owner, steward). The kind can only
 * grow, personal → family, and only by the owner: a family project holds many people's stories,
 * and narrowing it back to one person would leave the rest without a place. The country is not
 * here on purpose: it decides which privacy law applies, so it is set once at the start.
 *
 * Deleting is the owner's alone, and takes the project's name typed out as confirmation. Every
 * table that holds a project's data references it ON DELETE CASCADE, so one delete erases it
 * all (the tombstones, which hold ids and no content, are kept by design), and the import
 * records scrub themselves as their notes' history goes.
 */
import type { App, AppDeps } from './app';
import { memberRole } from './membership';
import { onLostConnection } from './notes';

const NAME_MAX = 120;

export function registerProjectSettingsRoutes(app: App, deps: AppDeps): void {
  const notFound = { error: 'not found' };

  app.patch('/v1/archives/:archiveId', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const role = await memberRole(deps.pool, c.get('userId'), archiveId);
    if (role === null) return c.json(notFound, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      subjectName?: unknown;
      kind?: unknown;
    };

    const sets: string[] = [];
    const values: unknown[] = [archiveId];
    if (body.subjectName !== undefined) {
      if (role !== 'owner' && role !== 'steward')
        return c.json({ error: 'only an owner or steward can rename', code: 'forbidden' }, 403);
      const name = typeof body.subjectName === 'string' ? body.subjectName.trim() : '';
      if (!name || name.length > NAME_MAX)
        return c.json({ error: `a name is 1 to ${NAME_MAX} characters`, code: 'bad_request' }, 400);
      values.push(name);
      sets.push(`subject_name = $${values.length}`);
    }
    if (body.kind !== undefined) {
      if (role !== 'owner')
        return c.json({ error: 'only the owner can change the kind', code: 'forbidden' }, 403);
      if (body.kind !== 'family')
        return c.json(
          { error: 'a project can only become a family project', code: 'bad_request' },
          400,
        );
      sets.push(`kind = 'family'`);
    }
    if (sets.length === 0) return c.json({ error: 'nothing to change', code: 'bad_request' }, 400);

    const r = await deps.pool.query(
      `update public.archives set ${sets.join(', ')} where id = $1
       returning id, subject_name as "subjectName", kind, jurisdiction`,
      values,
    );
    return c.json(r.rows[0]);
  });

  app.delete('/v1/archives/:archiveId', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const role = await memberRole(deps.pool, c.get('userId'), archiveId);
    if (role === null) return c.json(notFound, 404);
    if (role !== 'owner')
      return c.json({ error: 'only the owner can delete a project', code: 'forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };

    const client = await deps.pool.connect();
    // a connection that dies mid-delete must cost this request, not the server (notes.ts)
    const unguard = onLostConnection(client);
    try {
      await client.query('begin');
      const a = await client.query(
        `select subject_name, tenant_id from public.archives where id = $1 for update`,
        [archiveId],
      );
      const project = a.rows[0] as { subject_name: string; tenant_id: string } | undefined;
      if (!project) {
        await client.query('rollback');
        return c.json(notFound, 404);
      }
      if (typeof body.confirm !== 'string' || body.confirm.trim() !== project.subject_name) {
        await client.query('rollback');
        return c.json(
          { error: 'type the project’s name to delete it', code: 'confirm_mismatch' },
          400,
        );
      }
      // the revision log is append-only except on erasure's own path (FR-143), which this is
      await client.query(`select set_config('funmem.erasure', 'on', true)`);
      await client.query(`delete from public.archives where id = $1`, [archiveId]);
      // import jobs hold the words of previews nobody saved; they have no foreign key (see their
      // migration), so they go here. A job still running then finds nothing to write to.
      await client.query(`delete from public.ingest_jobs where archive_id = $1`, [archiveId]);
      // each project is provisioned with a tenant of its own; take it too once it holds nothing
      await client.query(
        `delete from public.tenants t where t.id = $1
           and not exists (select 1 from public.archives a where a.tenant_id = t.id)`,
        [project.tenant_id],
      );
      await client.query('commit');
      return c.json({ deleted: true });
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      unguard();
      client.release();
    }
  });
}
