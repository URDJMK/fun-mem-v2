import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { cancelImport, type ImportRequest } from '../lib/api';
import { inArchive, useArchive } from '../lib/archive';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { Review, Running, Saved, useImportRun, WhoIsTelling } from '../components/ImportRun';
import { Failed } from '../components/ui';

/**
 * Bringing in a transcript that wasn't made here: pasted or opened from a file, then a preview
 * of memories to read over before anything is kept. A live interview never comes through this
 * page — "Write the stories" (components/InterviewReview.tsx) runs and watches its own job
 * right there on the home page, so leaving mid-way never loses track of it.
 */
export function ImportInterview() {
  const archive = useArchive();
  const [initial, setInitial] = useState<ImportRequest>({ transcript: '' });
  const { step, req, run, saved, reset } = useImportRun(archive.id);

  return (
    <ArchiveLayout title="Add an interview">
      {step === null && (
        <TranscriptForm
          name={archive.subjectName}
          family={archive.kind === 'family'}
          initial={initial}
          onStart={(r) => {
            setInitial(r);
            void run(r);
          }}
        />
      )}
      {step?.kind === 'running' && (
        <Running
          job={step.job}
          onCancel={async () => {
            try {
              await cancelImport(archive.id, step.job.id);
            } catch {
              /* too late to stop: it finishes, and can be undone */
            }
          }}
        />
      )}
      {step?.kind === 'failed' && (
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="page-title">That didn’t work</h1>
          <Failed>{step.text}</Failed>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={reset}>
              Back to the transcript
            </button>
          </div>
        </div>
      )}
      {step?.kind === 'confirm' && (
        <WhoIsTelling
          outcome={step.outcome}
          onChoose={(ids) => void run({ ...(req ?? initial), interviewees: ids, confirm: true })}
          onBack={reset}
        />
      )}
      {step?.kind === 'duplicate' && (
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="page-title">This interview is already here</h1>
          <p className="notice notice-wonder">
            The same words were brought in
            {step.outcome.duplicateOf
              ? ` on ${new Date(step.outcome.duplicateOf.createdAt).toLocaleDateString()}`
              : ' before'}
            {step.outcome.duplicateOf?.source ? `, as “${step.outcome.duplicateOf.source}”` : ''}.
            Bringing it in again makes a second copy of every memory.
          </p>
          <div className="row">
            <Link to={inArchive(archive.id, '/interviews')} className="btn btn-primary">
              See the interviews
            </Link>
            <button
              type="button"
              className="btn"
              onClick={() => void run({ ...(req ?? initial), force: true })}
            >
              Bring it in again anyway
            </button>
          </div>
        </div>
      )}
      {step?.kind === 'review' && (
        <Review
          archiveId={archive.id}
          jobId={step.jobId}
          outcome={step.outcome}
          name={archive.subjectName}
          onSaved={saved}
          onRetry={req ? () => void run(req) : undefined}
        />
      )}
      {step?.kind === 'saved' && <Saved archiveId={archive.id} outcome={step.outcome} />}
    </ArchiveLayout>
  );
}

function TranscriptForm({
  name,
  family,
  initial,
  onStart,
}: {
  name: string;
  /** a family project's name is the family's, not a person's: who is telling is asked, not assumed */
  family: boolean;
  initial: ImportRequest;
  onStart: (r: ImportRequest) => void;
}) {
  const [transcript, setTranscript] = useState(initial.transcript);
  const [teller, setTeller] = useState(initial.teller ?? (family ? '' : name));
  const [source, setSource] = useState(initial.source ?? '');
  const [fileError, setFileError] = useState<string | null>(null);

  async function openFile(file: File) {
    setFileError(null);
    try {
      setTranscript(await file.text());
      if (!source.trim()) setSource(file.name.replace(/\.[^.]+$/, ''));
    } catch {
      setFileError('That file could not be opened.');
    }
  }

  return (
    <>
      <div className="stack" style={{ gap: 3 }}>
        <h1 className="page-title">Add an interview</h1>
        <p className="muted" style={{ fontSize: 16 }}>
          Bring in the transcript of a conversation with {family ? 'someone in the family' : name}.
          It becomes memories in their own words, and you read every one before it joins the
          project.
        </p>
      </div>
      <form
        className="stack"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          onStart({
            transcript,
            ...(teller.trim() ? { teller: teller.trim() } : {}),
            ...(source.trim() ? { source: source.trim() } : {}),
          });
        }}
      >
        <label className="field">
          The transcript
          <textarea
            className="textarea"
            data-testid="import-transcript"
            rows={12}
            required
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder={`Theo: Where did you grow up?\n${family ? 'Nell' : name}: On Garfield Avenue, in a house with a green door…`}
          />
          <span className="hint">
            Paste it here, or open the file. Plain text, subtitles (SRT, VTT) and WhisperX JSON all
            work. A name before each line helps tell who is speaking.
          </span>
        </label>
        <div className="row">
          <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }}>
            Open a file…
            <input
              type="file"
              className="visually-hidden"
              accept=".txt,.srt,.vtt,.json,.md,text/plain,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void openFile(f);
              }}
            />
          </label>
          {fileError && (
            <span role="alert" className="small" style={{ color: 'var(--danger)' }}>
              {fileError}
            </span>
          )}
        </div>
        <div className="grid-auto" style={{ '--min': '240px', gap: 8 } as CSSProperties}>
          <label className="field">
            Who is telling?
            <input
              className="input"
              value={teller}
              onChange={(e) => setTeller(e.target.value)}
              placeholder={family ? 'Grandma Nell' : undefined}
            />
            <span className="hint">
              {family
                ? 'The person whose memories these are, as the transcript names them. Left empty, Firepit asks after reading it.'
                : 'The person whose memories these are.'}
            </span>
          </label>
          <label className="field">
            What should we call this interview?
            <input
              className="input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="The lake house summers"
            />
            <span className="hint">Written under each memory, so you know where it came from.</span>
          </label>
        </div>
        <div className="row">
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            data-testid="import-start"
            disabled={transcript.trim() === ''}
          >
            Read it
          </button>
        </div>
      </form>
    </>
  );
}
