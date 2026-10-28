import { Hono } from 'hono';
import type { Pool } from 'pg';
import { supabaseAuth, type AuthConfig, type AuthVariables } from './auth';
import { provisionSignup, ProvisionError } from './provision';
import { isMember } from './membership';
import { registerNotesRoutes } from './notes';
import { registerViewsRoutes } from './views';
import { registerChunkRoutes } from './chunks';
import { registerSearchRoutes } from './search';
import { registerAskRoutes } from './ask';
import { registerDraftRoutes } from './drafts';
import { registerAgentRoutes, type AgentModelConfig } from './agent';
import { registerIngestRoutes, type ChatModel } from './ingest';
import type { IngestJobsOptions } from './ingest-jobs';
import { registerInternalRoutes } from './internal';
import { registerTranscriptionRoutes } from './transcription';
import { registerCoachRoutes } from './interview-coach';
import { registerInviteRoutes } from './invites';
import { registerProjectSettingsRoutes } from './project-settings';
import { registerInterviewRoutes } from './stories/interviews';
import { parseProfileInput } from './stories/profile';
import { registerProfileRoutes, setSubjectProfile } from './stories/profile-store';
import type { EmbeddingProvider } from '@funmem/core';

export interface AppDeps {
  pool: Pool;
  auth: AuthConfig;
  /**
   * Embedding provider for the vector search leg + drain (FM-022). Selection
   * is DI-only (never env-branched in src). Absent/null = model unavailable:
   * the vector leg and drain switch off, keyword search keeps working
   * (degrade, never crash, never silently swap model_version). Optional so
   * pre-FM-022 consumers (e.g. the web e2e harness) keep working unchanged.
   */
  embeddings?: EmbeddingProvider | null;
  /**
   * Chat model for transcript ingestion (NVIDIA NIM at the composition root).
   * Absent = ingestion still works, but every memory is the speaker's own words
   * grouped by question — no AI rewrite.
   */
  chat?: ChatModel | null;
  /** Model for the archive assistant (Mastra Agent). Absent = POST /agent answers 503. */
  agentModel?: AgentModelConfig | null;
  /**
   * How interview imports run (ingest-jobs.ts). Absent: in this process, swept every minute,
   * sharing jobs with every instance that uses the default scope (the Node server).
   */
  ingestJobs?: IngestJobsOptions;
  /**
   * Turns on the /internal routes (internal.ts) and is what a request to them must carry: the
   * Worker's cron and queue handlers reach the drain and the import runner through them.
   * Absent (the Node server, which runs those on its own timers): there are no such routes.
   */
  internalSecret?: string | null;
  /**
   * Deepgram API key for live interview transcription. Absent = the token route answers 503
   * `not_configured`; everything else, importing a transcript included, works as before.
   */
  transcriptionKey?: string | null;
  /**
   * A fast model for the live interview coach (INTERVIEW_MODEL at the composition root): one
   * short call after each answer, so it must answer within a pause. Absent = the coach route
   * answers 503 and the app suggests from its own question bank.
   */
  interviewChat?: ChatModel | null;
  /**
   * How an imported interview becomes notes (ingest-jobs.ts). 'stories': the story workflow
   * (stories/workflow.ts) writes whole stories from it and its transcript is kept with the
   * interview. 'memories': the earlier import, which turns every spoken line into a memory.
   * Absent = 'memories' (selected at the composition root from FUNMEM_IMPORT_MODE).
   */
  importMode?: 'stories' | 'memories';
}

export type App = Hono<{ Variables: AuthVariables }>;

export function createApp(deps: AppDeps): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  app.get('/health', (c) => c.json({ ok: true }));

  // every /v1 route runs behind verified auth; userId below is always the JWT sub
  app.use('/v1/*', supabaseAuth(deps.auth));

  app.get('/v1/me', (c) => c.json({ userId: c.get('userId') }));

  app.post('/v1/provision', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      subjectName?: string;
      jurisdiction?: string;
      tenantName?: string;
      kind?: string;
      /** the protagonist's profile (PRD D13): born, died, what the family calls them */
      profile?: unknown;
    };
    // checked before anything is made: a date that cannot be read refuses the project
    const profile = parseProfileInput(body.profile ?? {});
    if (typeof profile === 'string') return c.json({ error: profile, code: 'bad_request' }, 400);
    try {
      const provisioned = await provisionSignup(deps.pool, {
        userId: c.get('userId'),
        subjectName: body.subjectName ?? '',
        jurisdiction: body.jurisdiction ?? '',
        tenantName: body.tenantName,
        kind: body.kind as 'personal' | 'family' | undefined,
      });
      // a personal project is about one person: their person note holds the profile. Made only
      // when something was entered (else the first time it is saved in Settings). If this fails
      // the project still stands, and the profile can be entered in Settings.
      if (profile.born || profile.died || profile.aliases.length) {
        await setSubjectProfile(deps, provisioned.archiveId, c.get('userId'), profile).catch(
          (e: unknown) => console.error(`[provision] the profile was not saved: ${String(e)}`),
        );
      }
      return c.json(provisioned, 201);
    } catch (e) {
      if (e instanceof ProvisionError) return c.json({ error: e.message }, 400);
      return c.json({ error: 'provision failed' }, 500);
    }
  });

  // The caller's own archives. Membership is the filter, so there is no foreign
  // row to leak; a brand-new Google sign-in gets [] and the web app provisions.
  app.get('/v1/archives', async (c) => {
    const r = await deps.pool.query(
      `select a.id, a.subject_name as "subjectName", a.kind, a.jurisdiction, m.role
         from public.archives a
         join public.memberships m on m.archive_id = a.id
        where m.user_id = $1
        order by a.created_at`,
      [c.get('userId')],
    );
    return c.json(r.rows);
  });

  app.get('/v1/archives/:id', async (c) => {
    const archiveId = c.req.param('id');
    // membership check BEFORE any retrieval; foreign/unknown/malformed → uniform 404
    if (!(await isMember(deps.pool, c.get('userId'), archiveId))) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json({ id: archiveId });
  });

  registerNotesRoutes(app, deps);
  registerViewsRoutes(app, deps);
  registerChunkRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerAskRoutes(app, deps);
  registerDraftRoutes(app, deps);
  const jobs = registerIngestRoutes(app, deps);
  registerAgentRoutes(app, deps);
  registerTranscriptionRoutes(app, deps);
  registerCoachRoutes(app, deps);
  registerInviteRoutes(app, deps);
  registerProjectSettingsRoutes(app, deps);
  registerInterviewRoutes(app, deps);
  registerProfileRoutes(app, deps);
  registerInternalRoutes(app, deps, jobs);

  return app;
}
