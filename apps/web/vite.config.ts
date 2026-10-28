import { defineConfig, loadEnv, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
 * loaded by this dev server, with the NVIDIA key from the repo's .env. Same prompts, same checks,
 * same answers as the real routes (suggest, topics, corrections); only the sign-in check is
 * missing, as everywhere in demo mode. The full-recording transcription goes the same way, with
 * the Deepgram key.
 */
function demoInterviewCoach(): Plugin {
  return {
    name: 'demo-interview-coach',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv('development', '../..', '');
      const file = (name: string) =>
        fileURLToPath(new URL(`../../server/api/src/${name}.ts`, import.meta.url));
      let model: unknown;
      const send = (res: ServerResponse, status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const read = (req: IncomingMessage, max: number) =>
        new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let size = 0;
          req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > max) req.destroy(new Error('too large'));
            else chunks.push(chunk);
          });
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });

      server.middlewares.use('/demo/interview-transcribe', (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { code: 'method' });
        void (async () => {
          const t = (await server.ssrLoadModule(
            file('transcription'),
          )) as typeof import('../../server/api/src/transcription');
          const audio = new Uint8Array(await read(req, t.MAX_RECORDING_BYTES));
          const query = t.readRecordingQuery(new URL(req.url ?? '', 'http://x').searchParams);
          try {
            const segments = await t.transcribeRecording(env.DEEPGRAM_API_KEY, audio, {
              contentType: req.headers['content-type'] ?? 'audio/webm',
              ...query,
            });
            send(res, 200, { segments });
          } catch (e) {
            const code = e instanceof t.TranscriptionError ? e.code : 'upstream';
            send(res, code === 'not_configured' ? 503 : 502, { code });
          }
        })().catch(() => send(res, 500, { code: 'internal' }));
      });

      // /demo/interview/suggest, /demo/interview/topics, /demo/interview/corrections
      server.middlewares.use('/demo/interview', (req, res) => {
        const action = (req.url ?? '').replace(/^\//, '').split('?')[0];
        if (req.method !== 'POST') return send(res, 405, { code: 'method' });
        if (action !== 'suggest' && action !== 'topics' && action !== 'corrections')
          return send(res, 404, { code: 'not_found' });
        void (async () => {
          const raw = (await read(req, 320 * 1024)).toString('utf8');
          const coach = (await server.ssrLoadModule(
            file('interview-coach'),
          )) as typeof import('../../server/api/src/interview-coach');
          const nim = (await server.ssrLoadModule(
            file('nim'),
          )) as typeof import('../../server/api/src/nim');
          model ??= nim.createNimChat({
            apiKey: env.NVIDIA_API_KEY || undefined,
            model: env.INTERVIEW_MODEL || coach.INTERVIEW_MODEL_DEFAULT,
            timeoutMs: 45_000,
            attempts: 1,
            hedgeMs: 0,
          });
          const out = await coach.answerCoach(
            action,
            model as Parameters<typeof coach.answerCoach>[1],
            JSON.parse(raw || 'null'),
          );
          send(res, out.status, out.body);
        })().catch(() => send(res, 500, { code: 'internal' }));
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
