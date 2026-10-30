/**
 * A pretend recording, for looking at the interview screen without a microphone (dev only:
 * add `?simulate` to the URL under `vite dev`). It speaks a short scripted interview word by
 * word through the same surface as LiveTranscriber, so the page cannot tell the difference.
 */
import type { LiveStatus, Segment } from './live';

export interface Recorder {
  readonly segments: Segment[];
  readonly partials: Array<{ speaker: string; text: string } | null>;
  elapsed(): number;
  paused(): boolean;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  setKeyterms(terms: readonly string[]): void;
  /** the names being listened for */
  readonly keyterms?: readonly string[];
  /** each source's whole recording, once stopped; a simulation has none */
  recordings?(): Blob[];
}

const today = new Date().toLocaleDateString('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const SCRIPT: Array<[string, string]> = [
  ['S1', 'Okay, I think it is recording.'],
  ['S1', "I'm Theo, Nell's grandson."],
  ['S2', "And I'm Nell. Hello, everyone."],
  ['S1', 'Today I would love to hear about your childhood in Duluth, and about your family.'],
  [
    'S1',
    `This is Theo. Today is ${today}. I'm interviewing Grandma Nell. We'll talk about childhood and family.`,
  ],
  ['S1', 'Tell me about your childhood.'],
  [
    'S2',
    'We lived in Duluth, in the house on Garfield Avenue. It had a green door, two blocks from the streetcar, and my mother kept chickens in the yard. My father built the coop himself the summer before I was born, out of boards from the old dairy.',
  ],
  ['S1', 'Tell me more about the chicken coop your father built.'],
  [
    'S2',
    'Oh, it leaned a little, everyone teased him about it. But it stood for thirty years. I used to hide in it when my brother Walter was chasing me, and the hens never seemed to mind.',
  ],
  ['S1', 'Who else lived in the house with you?'],
  [
    'S2',
    'My parents, Walter and me, and for a few winters my grandmother Agnes, who slept in the front room by the stove and told us stories about the old country.',
  ],
];

export const SIMULATE =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('simulate');

export class SimulatedRecorder implements Recorder {
  readonly segments: Segment[] = [];
  readonly partials: Array<{ speaker: string; text: string } | null> = [null];
  private t0 = performance.now();
  private banked = 0;
  private held = false;
  private isPaused = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private line = 0;
  private word = 0;
  private id = 1;
  private lineStart = 0;

  constructor(
    private readonly onChange: () => void,
    private readonly onStatus: (s: LiveStatus) => void,
  ) {}

  start(): void {
    this.onStatus('connecting');
    setTimeout(() => {
      this.t0 = performance.now();
      this.onStatus('live');
      this.timer = setInterval(() => this.tick(), 260);
    }, 700);
  }

  private tick(): void {
    if (this.held) return;
    // the conversation goes round again, so a page left open keeps hearing voices
    if (this.line >= SCRIPT.length) this.line = 0;
    const [speaker, text] = SCRIPT[this.line]!;
    const words = text.split(' ');
    if (this.word === 0) this.lineStart = this.elapsed();
    this.word++;
    if (this.word < words.length) {
      this.partials[0] = { speaker, text: words.slice(0, this.word).join(' ') };
    } else {
      this.partials[0] = null;
      this.segments.push({
        id: this.id++,
        speaker,
        start: this.lineStart,
        end: this.elapsed(),
        text,
      });
      this.line++;
      this.word = 0;
      // a pause between turns, longer once the introductions are over
      this.held = true;
      // the room waits for the assistant after the introductions and after saying what today is
      // about, and after each long answer, the way people pause for the next prompt
      const waits = this.line <= 5 ? this.line >= 3 : speaker === 'S2';
      setTimeout(() => (this.held = false), waits ? 9000 : 2200);
    }
    this.onChange();
  }

  elapsed(): number {
    return this.banked + (this.timer ? (performance.now() - this.t0) / 1000 : 0);
  }
  paused(): boolean {
    return this.isPaused;
  }
  /** as the real one does: the clock and the words stop, and the status says so */
  pause(): void {
    if (this.isPaused || !this.timer) return;
    this.banked = this.elapsed();
    clearInterval(this.timer);
    this.timer = null;
    this.partials[0] = null;
    this.isPaused = true;
    this.onStatus('paused');
  }
  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.t0 = performance.now();
    this.timer = setInterval(() => this.tick(), 260);
    this.onStatus('live');
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.banked = this.elapsed();
    this.timer = null;
    this.partials[0] = null;
    this.onStatus('stopped');
  }
  setKeyterms(): void {}
}
