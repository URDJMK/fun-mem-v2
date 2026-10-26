/**
 * Live transcription of an interview, word by word as it is said (Deepgram's streaming API).
 *
 * Each audio SOURCE is its own stream to Deepgram:
 *
 *   in the room   one microphone hears everybody; Deepgram tells the voices apart
 *                 (`diarize_model`), and its speaker numbers become `S1`, `S2`, …
 *   on a call     the microphone is the interviewer (`mic`) and the call's own audio, shared
 *                 from a tab or window, is the person being remembered (`call`). Two clean
 *                 channels: nobody has to guess who is speaking.
 *
 * The audio goes from the browser straight to Deepgram with a one-minute token the API hands
 * out (lib/api.ts `transcriptionToken`); it is not recorded or kept anywhere. Only the words
 * are, by the page.
 *
 * A dropped connection is reconnected with a fresh token; the words already written stay, and
 * the times carry on from where they were (each stream counts time from its own start, so a
 * reconnected stream is offset by the time already recorded).
 */

export interface Segment {
  id: number;
  /** `S1`, `S2`, … in the room; `mic` or `call` on a call */
  speaker: string;
  /** seconds since recording started, pauses not counted */
  start: number;
  end: number;
  text: string;
}

export interface Source {
  stream: MediaStream;
  /** a fixed speaker for everything this source hears, or null to tell voices apart */
  speaker: string | null;
}

export type LiveStatus = 'connecting' | 'live' | 'paused' | 'reconnecting' | 'stopping' | 'stopped';

export type LiveFailure = 'not_configured' | 'token' | 'connection' | 'unsupported';

interface Callbacks {
  /** words were added or the in-progress line changed */
  onChange: () => void;
  onStatus: (s: LiveStatus) => void;
  /** it cannot go on; the words so far are kept */
  onFail: (f: LiveFailure) => void;
}

const LISTEN = 'wss://api.deepgram.com/v1/listen';
const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
const MAX_RETRIES = 4;

export function liveSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof WebSocket !== 'undefined' &&
    MIME.some((m) => MediaRecorder.isTypeSupported(m))
  );
}

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

interface DgResults {
  type: 'Results';
  is_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string; words?: DgWord[] }> };
}

export class LiveTranscriber {
  readonly segments: Segment[] = [];
  /** what is being said right now, not settled yet: one line per source */
  readonly partials: Array<{ speaker: string; text: string } | null>;
  status: LiveStatus = 'connecting';

  private readonly channels: Channel[];
  private nextId = 1;
  /** the person pressed pause (kept apart from `status`, which a reconnect also changes) */
  private held = false;
  /** seconds recorded before the current run of recording, and when that run began */
  private banked = 0;
  private runFrom: number | null = null;

  constructor(
    private readonly getToken: () => Promise<string>,
    sources: Source[],
    private readonly cb: Callbacks,
    /** names to spell the archive's way (lib/keyterms.ts); the same list for every source */
    public keyterms: readonly string[] = [],
  ) {
    this.partials = sources.map(() => null);
    this.channels = sources.map((s, i) => new Channel(this, i, s));
  }

  /**
   * New names to listen for, while recording (the people the interviewer has just introduced).
   * Deepgram takes the whole list again in a `Configure` message on each open stream; a stream
   * that reconnects later opens with it too.
   */
  setKeyterms(terms: readonly string[]): void {
    this.keyterms = terms;
    for (const c of this.channels) c.configure(terms);
  }

  /** seconds of recording so far, pauses not counted */
  elapsed(): number {
    return this.banked + (this.runFrom === null ? 0 : (performance.now() - this.runFrom) / 1000);
  }

  async start(): Promise<void> {
    if (!liveSupported()) return this.fail('unsupported');
    const token = await this.token();
    if (!token) return;
    await Promise.all(this.channels.map((c) => c.connect(token)));
    if (this.stopping()) return;
    this.runFrom = performance.now();
    // a source that could not open is already reconnecting, and says so itself
    if (this.channels.every((c) => c.open())) this.setStatus('live');
  }

  pause(): void {
    if (this.held || this.stopping()) return;
    this.held = true;
    this.banked = this.elapsed();
    this.runFrom = null;
    for (const c of this.channels) c.pause();
    if (this.status === 'live') this.setStatus('paused');
  }

  resume(): void {
    if (!this.held || this.stopping()) return;
    this.held = false;
    this.runFrom = performance.now();
    for (const c of this.channels) c.resume();
    if (this.status === 'paused') this.setStatus('live');
  }

  /** Stops listening, waiting a moment for the last words to come back. */
  async stop(): Promise<void> {
    if (this.status === 'stopped') return;
    this.banked = this.elapsed();
    this.runFrom = null;
    this.setStatus('stopping');
    await Promise.all(this.channels.map((c) => c.close()));
    this.partials.fill(null);
    this.setStatus('stopped');
    this.cb.onChange();
  }

  /* ── for the channels ─────────────────────────────────── */

  async token(): Promise<string | null> {
    try {
      return await this.getToken();
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      this.fail(code === 'not_configured' ? 'not_configured' : 'token');
      return null;
    }
  }

  add(speaker: string, start: number, end: number, text: string): void {
    this.segments.push({ id: this.nextId++, speaker, start, end, text });
    // two sources can settle out of order; the transcript reads in time order
    this.segments.sort((a, b) => a.start - b.start);
  }

  changed(): void {
    this.cb.onChange();
  }

  setStatus(s: LiveStatus): void {
    if (this.status === 'stopped') return;
    this.status = s;
    this.cb.onStatus(s);
  }

  fail(f: LiveFailure): void {
    if (this.status === 'stopped') return;
    for (const c of this.channels) void c.close();
    this.banked = this.elapsed();
    this.runFrom = null;
    this.status = 'stopped';
    this.cb.onStatus('stopped');
    this.cb.onFail(f);
  }

  stopping(): boolean {
    return this.status === 'stopping' || this.status === 'stopped';
  }

  paused(): boolean {
    return this.held;
  }

  /** after a reconnect: back to whichever of live and paused the person left it in */
  settled(): void {
    if (!this.stopping() && this.channels.every((c) => c.open())) {
      this.setStatus(this.held ? 'paused' : 'live');
    }
  }
}

class Channel {
  private ws: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  /** recording time when this connection opened: its word times are counted from here */
  private base = 0;
  private retries = 0;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly live: LiveTranscriber,
    private readonly index: number,
    private readonly source: Source,
  ) {}

  connect(token: string): Promise<void> {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'en',
      smart_format: 'true',
      punctuate: 'true',
      interim_results: 'true',
      endpointing: '300',
    });
    // `diarize` is deprecated; setting both it and `diarize_model` is refused
    if (this.source.speaker === null) params.set('diarize_model', 'latest');
    for (const term of this.live.keyterms) params.append('keyterm', term);
    this.base = this.live.elapsed();
    const ws = new WebSocket(`${LISTEN}?${params}`, ['bearer', token]);
    this.ws = ws;

    return new Promise((resolve) => {
      ws.onopen = () => {
        this.retries = 0;
        this.record(ws);
        // Deepgram closes a stream that hears nothing for ten seconds, as during a pause
        this.keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }, 5000);
        resolve();
      };
      ws.onmessage = (e) => this.heard(e.data);
      ws.onclose = () => {
        resolve();
        this.cleanup();
        if (this.ws === ws && !this.live.stopping()) void this.reconnect();
      };
    });
  }

  pause(): void {
    if (this.recorder?.state === 'recording') this.recorder.pause();
  }

  resume(): void {
    if (this.recorder?.state === 'paused') this.recorder.resume();
  }

  /** Sends what is left of the audio, asks Deepgram to finish, and waits for it (3 s at most). */
  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        this.cleanup();
        return resolve();
      }
      const done = () => {
        clearTimeout(timer);
        this.cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        ws.close();
        done();
      }, 3000);
      ws.addEventListener('close', done);
      const finish = () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
      };
      const rec = this.recorder;
      if (rec && rec.state !== 'inactive') {
        rec.addEventListener('stop', () => setTimeout(finish, 50), { once: true });
        rec.stop();
      } else finish();
    });
    return this.closing;
  }

  private record(ws: WebSocket): void {
    const mimeType = MIME.find((m) => MediaRecorder.isTypeSupported(m))!;
    // a fresh recorder per connection: the container's header goes out with the first chunk
    const rec = new MediaRecorder(this.source.stream, { mimeType });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    rec.start(250);
    if (this.live.paused()) rec.pause();
    this.recorder = rec;
  }

  private heard(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: DgResults;
    try {
      msg = JSON.parse(data) as DgResults;
    } catch {
      return;
    }
    if (msg.type !== 'Results') return;
    const alt = msg.channel?.alternatives?.[0];
    const words = alt?.words ?? [];
    const text = alt?.transcript?.trim() ?? '';

    if (!msg.is_final) {
      this.live.partials[this.index] = text
        ? { speaker: this.speakerOf(words[0]), text }
        : (this.live.partials[this.index] ?? null);
      this.live.changed();
      return;
    }
    this.live.partials[this.index] = null;
    // one settled piece may hold more than one voice: split it where the speaker changes
    let run: DgWord[] = [];
    const flush = () => {
      if (run.length === 0) return;
      this.live.add(
        this.speakerOf(run[0]),
        this.base + run[0]!.start,
        this.base + run[run.length - 1]!.end,
        run.map((w) => w.punctuated_word ?? w.word).join(' '),
      );
      run = [];
    };
    for (const w of words) {
      if (run.length > 0 && this.speakerOf(w) !== this.speakerOf(run[0])) flush();
      run.push(w);
    }
    flush();
    this.live.changed();
  }

  private speakerOf(w: DgWord | undefined): string {
    return this.source.speaker ?? `S${(w?.speaker ?? 0) + 1}`;
  }

  private async reconnect(): Promise<void> {
    if (this.retries >= MAX_RETRIES) return this.live.fail('connection');
    this.retries++;
    this.live.setStatus('reconnecting');
    await new Promise((r) => setTimeout(r, 500 * 2 ** this.retries));
    if (this.live.stopping()) return;
    const token = await this.live.token();
    if (!token || this.live.stopping()) return;
    await this.connect(token);
    this.live.settled();
  }

  open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  configure(terms: readonly string[]): void {
    if (this.open()) this.ws!.send(JSON.stringify({ type: 'Configure', keyterms: terms }));
  }

  private cleanup(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }
}
