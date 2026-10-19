import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext } from './helpers';

/**
 * FM-036 — the composition root, proven by running it.
 *
 * These spawn the SHIPPED start script as a real OS process and talk to it over
 * a real socket. Nothing here imports drainOnce: the point is that the process
 * drains by ITSELF. An absence is not observable, so the positive signal is a
 * chunk_embeddings row appearing without this file ever having asked for one.
 */
const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

const SERVICE_KEY =
  process.env.FUNMEM_SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const spawned: ChildProcess[] = [];

/** Kill a spawned server's whole process group and wait for it to go. */
async function stop(b: Booted | null): Promise<void> {
  if (!b?.proc.pid || b.proc.exitCode !== null) return;
  try {
    process.kill(-b.proc.pid, 'SIGTERM');
  } catch {
    return;
  }
  await Promise.race([
    new Promise((r) => b.proc.on('exit', r)),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
}

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

interface Booted {
  proc: ChildProcess;
  port: number;
  log: () => string;
}

/** Spawn the shipped script on an ephemeral port; resolve when /health answers. */
async function boot(env: Record<string, string>, port: number): Promise<Booted | null> {
  let out = '';
  const proc = spawn('pnpm', ['--filter', '@funmem/api', 'start'], {
    cwd: path.resolve(API_ROOT, '../..'),
    detached: true, // own process group, so teardown kills vite-node too
    env: {
      ...process.env,
      FUNMEM_PORT: String(port),
      FUNMEM_EMBEDDING_PROVIDER: 'deterministic', // D-30's test/CI default
      ...env,
    },
  });
  spawned.push(proc);
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));

  // poll for readiness — never a fixed sleep
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) return null; // died during boot
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return { proc, port, log: () => out };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const BASE_ENV = {
  FUNMEM_DB_URL:
    process.env.FUNMEM_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  FUNMEM_SUPABASE_URL: process.env.FUNMEM_SUPABASE_URL ?? 'http://127.0.0.1:54321',
  FUNMEM_SERVICE_KEY: SERVICE_KEY,
};

/** Poll the DB for an embedding of this archive. The process must produce it. */
async function waitForEmbedding(archive: string, atLeast: number, ms = 60_000): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await ctx.pool.query<{ n: string }>(
      `select count(*)::text as n from public.chunk_embeddings where archive_id = $1`,
      [archive],
    );
    const n = Number(r.rows[0]!.n);
    if (n >= atLeast) return n;
    if (Date.now() > deadline) return n;
    await new Promise((x) => setTimeout(x, 500));
  }
}

describe('FM-036 bootstrap and pipeline liveness', () => {
  it('the shipped start script boots a real process that serves HTTP and self-drains', async () => {
    const s = await ctx.realSession(`boot1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Boot1 ${RUN}`);
    const booted = await boot(BASE_ENV, 8801);
    expect(booted, 'the shipped start script never became ready').not.toBeNull();

    const ready = await fetch(`http://127.0.0.1:${booted!.port}/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json()) as { ready: boolean }).toMatchObject({ ready: true });

    // save a note OVER HTTP, through the spawned process
    const res = await fetch(`http://127.0.0.1:${booted!.port}/v1/archives/${archive}/notes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: `Booted ${RUN}`,
        type: 'event',
        body: 'a memory worth keeping.',
      }),
    });
    expect(res.status).toBe(201);

    // THE POSITIVE SIGNAL: an embedding appears without this test ever calling
    // drainOnce. That is the only observable proof of self-draining.
    expect(
      await waitForEmbedding(archive, 1),
      'the process never drained by itself',
    ).toBeGreaterThan(0);
    await stop(booted);
  }, 120_000);

  it('the loop keeps draining notes saved after it started', async () => {
    const s = await ctx.realSession(`boot2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Boot2 ${RUN}`);
    const booted = await boot(BASE_ENV, 8802);
    expect(booted).not.toBeNull();

    const save = async (title: string, body: string) => {
      const r = await fetch(`http://127.0.0.1:${booted!.port}/v1/archives/${archive}/notes`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title, type: 'event', body }),
      });
      expect(r.status).toBe(201);
    };

    await save(`First ${RUN}`, 'the first memory.');
    const afterFirst = await waitForEmbedding(archive, 1);
    expect(afterFirst).toBeGreaterThan(0);

    // saved only AFTER the first drained, so a LATER tick must run. A one-note
    // version of this test passes even with setInterval deleted, because kick()
    // fires once at boot.
    await save(`Second ${RUN}`, 'a second, later memory.');
    expect(
      await waitForEmbedding(archive, afterFirst + 1),
      'the loop stopped after its first tick',
    ).toBeGreaterThan(afterFirst);
    await stop(booted);
  }, 150_000);

  it('missing required config refuses to boot', async () => {
    const noDb = { ...BASE_ENV } as Record<string, string | undefined>;
    delete noDb.FUNMEM_DB_URL;
    const proc = spawn('pnpm', ['--filter', '@funmem/api', 'start'], {
      cwd: path.resolve(API_ROOT, '../..'),
      detached: true,
      env: { ...process.env, ...noDb, FUNMEM_DB_URL: '', FUNMEM_PORT: '8803' } as NodeJS.ProcessEnv,
    });
    spawned.push(proc);
    const code = await new Promise<number | null>((r) => proc.on('exit', r));
    expect(code, 'a half-wired server started anyway').not.toBe(0);

    // and it never opened the port
    await expect(fetch('http://127.0.0.1:8803/health')).rejects.toBeTruthy();
  }, 60_000);

  it('a provider that fails to load serves search but does not drain', async () => {
    const s = await ctx.realSession(`boot4-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Boot4 ${RUN}`);
    // Force a genuine load failure: an EMPTY cache dir (so the weights must be
    // fetched) plus a dead endpoint. Pointing only at a dead endpoint is not
    // enough — the 568MB model is usually already cached from a prior run, and
    // the provider loads happily offline.
    const emptyCache = await mkdtemp(path.join(tmpdir(), 'funmem-nocache-'));
    const booted = await boot(
      {
        ...BASE_ENV,
        FUNMEM_EMBEDDING_PROVIDER: 'bge-m3',
        FUNMEM_MODEL_CACHE: emptyCache,
        HF_ENDPOINT: 'http://127.0.0.1:1',
        HF_HUB_OFFLINE: '0',
        FUNMEM_PROVIDER_LOAD_TIMEOUT_MS: '8000', // fail fast; 5 min is the real default
      },
      8804,
    );
    expect(booted, 'a provider failure crashed the server instead of degrading').not.toBeNull();

    const ready = (await (await fetch(`http://127.0.0.1:${booted!.port}/ready`)).json()) as {
      embeddings: string;
      draining: boolean;
    };
    expect(ready.embeddings).toBe('degraded');
    // draining under a FALLBACK provider would re-embed the whole corpus at the
    // wrong model_version — the pending join is model_version-scoped
    expect(ready.draining, 'the loop ran under a fallback provider').toBe(false);

    const res = await fetch(`http://127.0.0.1:${booted!.port}/v1/archives/${archive}/notes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: `Degraded ${RUN}`, type: 'event', body: 'still writable.' }),
    });
    expect(res.status, 'the API stopped working when the model did').toBe(201);

    // keyword search still serves
    const q = await fetch(
      `http://127.0.0.1:${booted!.port}/v1/archives/${archive}/search?q=writable`,
      { headers: { authorization: `Bearer ${s.token}` } },
    );
    expect(q.status).toBe(200);

    // BEHAVIOUR, not the report: /ready saying draining:false is satisfied by a
    // mutant that starts the loop anyway. The real assertion is that no
    // embedding is ever written — a drain under a FALLBACK provider would write
    // rows at funmem-det-1024-v1 and re-embed the corpus at the wrong model.
    await new Promise((r) => setTimeout(r, 20_000)); // > the 15s loop interval
    const wrote = await ctx.pool.query<{ n: string }>(
      `select count(*)::text as n from public.chunk_embeddings where archive_id = $1`,
      [archive],
    );
    expect(Number(wrote.rows[0]!.n), 'the loop drained under a fallback provider').toBe(0);
    await stop(booted);
  }, 120_000);

  it('the default port matches the web app proxy target', async () => {
    // Every other test overrides FUNMEM_PORT, so a mutant changing the default
    // passes the whole suite while silently breaking FM-044's browser app. The
    // proxy target in apps/web/vite.config.ts is the contract here.
    const cfg = await readFile(path.resolve(API_ROOT, '../../apps/web/vite.config.ts'), 'utf8');
    const target = /proxy:\s*\{\s*'\/v1':\s*'http:\/\/([\d.]+):(\d+)'/.exec(cfg);
    expect(target, 'could not read the vite proxy target').not.toBeNull();
    const [, host, port] = target!;

    // boot with NO FUNMEM_PORT/FUNMEM_HOST — the shipped defaults must land here
    const noPortEnv = { ...BASE_ENV };
    const proc = spawn('pnpm', ['--filter', '@funmem/api', 'start'], {
      cwd: path.resolve(API_ROOT, '../..'),
      detached: true,
      env: { ...process.env, ...noPortEnv, FUNMEM_EMBEDDING_PROVIDER: 'deterministic' },
    });
    spawned.push(proc);
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        up = (await fetch(`http://${host}:${port}/health`)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(up, `the shipped default is not http://${host}:${port}`).toBe(true);
    await stop({ proc, port: Number(port), log: () => '' });
  }, 90_000);

  it('SIGTERM shuts down cleanly with no in-flight query error', async () => {
    const s = await ctx.realSession(`boot5-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Boot5 ${RUN}`);
    // Seed a BACKLOG before the server exists. startEmbeddingLoop calls kick()
    // immediately at boot, so the first pass is already running by the time
    // /health answers — which is what makes the in-flight race deterministic
    // rather than a coin flip. A single note saved after boot usually drains
    // before the signal arrives, and the mutant survives.
    for (let i = 0; i < 12; i++) {
      await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
        title: `Backlog ${i} ${RUN}`,
        type: 'event',
        body: `# A\n\nblock one of note ${i}.\n\n# B\n\nblock two of note ${i}.`,
      });
    }

    const booted = await boot(BASE_ENV, 8805);
    expect(booted).not.toBeNull();
    process.kill(-booted!.proc.pid!, 'SIGTERM');
    const code = await Promise.race([
      new Promise<number | null>((r) => booted!.proc.on('exit', r)),
      new Promise<number | null>((r) => setTimeout(() => r(-1), 20_000)),
    ]);
    expect(code, 'the process did not exit promptly on SIGTERM').toBe(0);

    const log = booted!.log();
    expect(log, 'a query ran against an already-closed pool').not.toMatch(
      /Cannot use a pool after calling end|called end on pool/i,
    );
  }, 90_000);
});
