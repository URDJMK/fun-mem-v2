import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DB_URL, testContext } from './helpers';

/**
 * A database connection that dies (a restart, a failover, `supabase stop/start`) must cost only
 * the requests that were using it, never the API process (round-3 review D5: the server exited
 * with code 1 and every family lost the API). Only the connections of the process under test
 * are cut, found by their `application_name`.
 */
const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
const SERVICE_KEY =
  process.env.FUNMEM_SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const spawned: ChildProcess[] = [];
afterAll(async () => {
  for (const p of spawned) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await ctx.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withName = (name: string) =>
  `${DB_URL}${DB_URL.includes('?') ? '&' : '?'}application_name=${name}`;
const cut = async (name: string) =>
  (
    await ctx.pool.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1`,
      [name],
    )
  ).rowCount ?? 0;

describe('D5 a lost database connection does not take the API down', () => {
  it(
    'the real server: every one of its connections cut; it keeps running and the next request works',
    { timeout: 120_000 },
    async () => {
      const name = `cl_srv_${RUN}`;
      const port = 8814;
      let out = '';
      const proc = spawn('pnpm', ['--filter', '@funmem/api', 'start'], {
        cwd: path.resolve(API_ROOT, '../..'),
        detached: true,
        env: {
          ...process.env,
          FUNMEM_PORT: String(port),
          FUNMEM_EMBEDDING_PROVIDER: 'deterministic',
          FUNMEM_DB_URL: withName(name),
          FUNMEM_SUPABASE_URL: process.env.FUNMEM_SUPABASE_URL ?? 'http://127.0.0.1:54321',
          FUNMEM_SERVICE_KEY: SERVICE_KEY,
          NVIDIA_API_KEY: '',
        },
      });
      spawned.push(proc);
      proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));
      let up = false;
      for (let i = 0; i < 120 && !up; i++) {
        try {
          up = (await fetch(`http://127.0.0.1:${port}/ready`)).ok;
        } catch {
          await sleep(250);
        }
      }
      expect(up).toBe(true);
      const s = await ctx.realSession(`cl-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(s, `CL ${RUN}`);
      const get = () =>
        fetch(`http://127.0.0.1:${port}/v1/archives/${archive}/notes`, {
          headers: { authorization: `Bearer ${s.token}` },
        }).then((r) => r.status);
      expect(await get()).toBe(200);
      expect(await cut(name)).toBeGreaterThan(0);
      await sleep(1500);
      expect(proc.exitCode, 'the server died with its connections').toBeNull();
      expect(await get()).toBe(200);
      // what it said is content-free: a code, never a value
      expect(out).toMatch(/database connection lost: pg 57P01/);
    },
  );

  it(
    'a write whose connection is cut while it runs fails, alone; the next request works',
    { timeout: 60_000 },
    async () => {
      const name = `cl_busy_${RUN}`;
      const pool = new Pool({ connectionString: withName(name), max: 4 });
      pool.on('error', () => undefined); // as main.ts: the pool's idle clients are not the point here
      const app = createApp({ ...ctx.deps, pool });
      try {
        const s = await ctx.realSession(`cl-busy-${RUN}@test.local`);
        const archive = await ctx.provisionArchive(s, `CL busy ${RUN}`);
        const req = (method: string, p: string, body?: unknown) =>
          Promise.resolve(
            app.request(`/v1/archives/${archive}${p}`, {
              method,
              headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
              ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            }),
          );
        // the write takes its connection, then waits for the archive's lock, which we hold
        const holder = await ctx.pool.connect();
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock(hashtext(lower($1))::bigint)', [archive]);
        const write = req('POST', '/notes', {
          title: `In flight ${RUN}`,
          type: 'event',
          body: 'x',
        }).then((r) => r.status);
        await sleep(500);
        expect(await cut(name)).toBeGreaterThan(0);
        const status = await write;
        await holder.query('commit');
        holder.release();
        expect(status).toBe(500); // that one request failed...
        const left = await ctx.pool.query(`select 1 from public.notes where archive_id = $1`, [
          archive,
        ]);
        expect(left.rowCount).toBe(0); // ...and wrote nothing
        expect((await req('GET', '/notes')).status).toBe(200); // the process, and the pool, go on
      } finally {
        await pool.end().catch(() => undefined);
      }
    },
  );
});
