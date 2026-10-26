import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { ImportRequest } from '../lib/api';
import { inArchive } from '../lib/archive';
import { clock, speakerLabels, tellerVoice, turnsOf, type Draft } from '../lib/interview';
import { Transcript } from './Transcript';

/**
 * After the interview: confirm whose words are the memories (already known when the voices were
 * introduced), name it, and hand it to the import, where every memory is read before it is kept.
 */
export function InterviewReview({
  archiveId,
  name,
  draft,
  onDiscard,
}: {
  archiveId: string;
  name: string;
  draft: Draft;
  onDiscard: () => void;
}) {
  const navigate = useNavigate();
  const labels = speakerLabels(draft.segments, draft.mode, draft.setup, name);
  const speakers = [...new Set(draft.segments.map((s) => s.speaker))];
  const said = (sp: string) =>
    draft.segments.filter((s) => s.speaker === sp).reduce((n, s) => n + s.text.length, 0);
  const known = tellerVoice(draft);
  // the person being remembered: known from the introductions, or else whoever talked most
  const [teller, setTeller] = useState(
    () => known ?? [...speakers].sort((a, b) => said(b) - said(a))[0] ?? '',
  );
  const [source, setSource] = useState(() => {
    const about = draft.setup?.about.trim() ?? '';
    if (about && about.length <= 60) return about;
    return `Interview, ${new Date(draft.startedAt).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })}`;
  });

  const named = (sp: string) => !/^Speaker \d+$/.test(labels.get(sp) ?? '');
  // the archive's own name for the person being remembered, so memories say who told them
  const finalName = (sp: string) =>
    sp === teller
      ? name
      : named(sp)
        ? labels.get(sp)!
        : speakers.length <= 2
          ? 'Interviewer'
          : labels.get(sp)!;

  function bringIn() {
    const transcript = JSON.stringify({
      language: 'en',
      interviewee: name,
      segments: draft.segments.map((s) => ({
        start: Math.round(s.start * 100) / 100,
        end: Math.round(s.end * 100) / 100,
        text: s.text,
        speaker: finalName(s.speaker),
      })),
    });
    const request: ImportRequest = { transcript, teller: name, source: source.trim() || undefined };
    // The words are handed to the import, but the draft stays until they are saved there
    // (pages/ImportInterview.tsx): an import that fails, or a page left mid-way, loses nothing.
    void navigate(inArchive(archiveId, '/interviews/new'), { state: { request, fromLive: true } });
  }

  function download() {
    const text = turnsOf(draft.segments)
      .map((t) => `[${clock(t.start)}] ${finalName(t.speaker)}: ${t.text}`)
      .join('\n\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `${source.trim() || 'interview'}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="review">
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="page-title">Interview with {name}</h1>
        <p className="muted">
          {clock(draft.segments[draft.segments.length - 1]?.end ?? 0)} recorded. Next, Firepit sorts
          it into memories for you to read over.
        </p>
      </div>

      {draft.mode === 'room' && !known && speakers.length > 1 && (
        <fieldset className="stack live-who-pick" style={{ gap: 8 }}>
          <legend className="label-heading">Which voice is {name}?</legend>
          {speakers.map((sp) => (
            <label key={sp} className="live-mode" data-on={sp === teller}>
              <input
                type="radio"
                name="teller"
                checked={sp === teller}
                onChange={() => setTeller(sp)}
              />
              <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                <span className="row-title">{labels.get(sp)}</span>
                <span className="small muted live-sample">
                  “{draft.segments.find((s) => s.speaker === sp)?.text}”
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <label className="field" style={{ maxWidth: 420 }}>
        Name this interview
        <input
          id="interview-source"
          className="input"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <span className="hint">Shown under each memory it adds.</span>
      </label>

      <div className="row">
        <button type="button" className="btn btn-primary btn-lg" onClick={bringIn}>
          Turn into memories
        </button>
        <button type="button" className="btn btn-outline" onClick={download}>
          Download transcript
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            if (window.confirm('Throw away this interview’s transcript? It can’t be brought back.'))
              onDiscard();
          }}
        >
          Discard
        </button>
      </div>

      <section className="stack" style={{ gap: 8 }}>
        <h2 className="label-heading">Transcript</h2>
        <div className="review-box">
          <Transcript
            segments={draft.segments}
            names={new Map(speakers.map((sp) => [sp, finalName(sp)]))}
            partials={[]}
            empty="Nothing was heard."
          />
        </div>
      </section>
    </div>
  );
}
