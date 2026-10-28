import { useEffect, useRef, useState } from 'react';
import { listNotes, transcriptionToken } from './api';
import { keytermsFor } from './keyterms';
import { openSources, type Mode, type StartFailure } from './interview';
import { LiveTranscriber, liveSupported, type LiveStatus } from './live';
import { SIMULATE, SimulatedRecorder, type Recorder } from './live-sim';

/**
 * One recording, from the microphone (and the call, on a call) to words on the page. Starts when
 * the component mounts; `finish` stops it and waits for the last words. Re-renders on every
 * change to the words; `onWords` is told too, so the page can keep a draft.
 */
export function useRecording(opts: {
  archiveId: string;
  subjectName: string;
  mode: Mode;
  onWords: () => void;
  onFail: (f: StartFailure) => void;
}) {
  const rec = useRef<Recorder | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const baseTerms = useRef<string[]>([]);
  const [, redraw] = useState(0);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [mic, setMic] = useState<MediaStream | null>(null);
  const [callEnded, setCallEnded] = useState(false);
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    let cancelled = false;
    const changed = () => {
      redraw((n) => n + 1);
      cb.current.onWords();
    };

    if (SIMULATE) {
      const sim = new SimulatedRecorder(changed, setStatus);
      rec.current = sim;
      sim.start();
      return () => void sim.stop();
    }
    if (!liveSupported()) {
      opts.onFail('unsupported');
      return;
    }

    // the archive's names help the spelling; without them it still transcribes
    Promise.all([openSources(opts.mode), listNotes(opts.archiveId).catch(() => [])])
      .then(([{ streams: s, mic: m }, notes]) => {
        if (cancelled) return s.forEach((x) => x.getTracks().forEach((t) => t.stop()));
        streams.current = s;
        setMic(m);
        s[1]?.getAudioTracks()[0]?.addEventListener('ended', () => setCallEnded(true));
        baseTerms.current = keytermsFor(opts.subjectName, notes);
        const t = new LiveTranscriber(
          async () => (await transcriptionToken(opts.archiveId)).token,
          opts.mode === 'room'
            ? [{ stream: s[0]!, speaker: null }]
            : [
                { stream: s[0]!, speaker: 'mic' },
                { stream: s[1]!, speaker: 'call' },
              ],
          { onChange: changed, onStatus: setStatus, onFail: (f) => cb.current.onFail(f) },
          baseTerms.current,
        );
        rec.current = t;
        void t.start();
      })
      .catch((e: Error) => {
        if (!cancelled) cb.current.onFail(e.message as StartFailure);
      });
    return () => {
      cancelled = true;
      void rec.current?.stop();
      streams.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    };
    // one recording per mount: the mode cannot change while it runs
  }, []);

  // leaving the page by accident would end the recording
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  return {
    rec: rec.current,
    status,
    mic,
    callEnded,
    /**
     * The people in the room, and the words in the interviewer's notes (`terms`, kept whole),
     * added to the archive's names Deepgram listens for. The notes come first: they are what
     * this interview is about, and the list has a limit.
     */
    addNames(names: string[], terms: string[] = []) {
      const extra = names.flatMap((n) => [n, ...n.split(/\s+/)]).filter((n) => n.length > 1);
      const all = [...new Set([...terms, ...extra, ...baseTerms.current])];
      // Deepgram refuses more than 500 tokens: about four characters a token, well under
      let chars = 0;
      rec.current?.setKeyterms(all.filter((t, i) => i < 50 && (chars += t.length) <= 1400));
    },
    /** Stops, and hands back each source's whole recording (none in a simulation). */
    async finish(): Promise<Blob[]> {
      await rec.current?.stop();
      streams.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      return rec.current?.recordings?.() ?? [];
    },
  };
}
