import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ask, listNotes, type AskAnswer, type NoteSummary } from '../lib/api';
import { noteHref, useArchive } from '../lib/archive';
import { ArchiveLayout } from '../components/ArchiveLayout';
import { Failed, Icon } from '../components/ui';

interface Turn {
  question: string;
  answer: AskAnswer | 'pending' | 'failed';
}

const KIND_LABEL: Record<string, string> = {
  quote: 'Their words',
  paraphrase: 'In other words',
  inference: 'Drawn from it',
};

/**
 * Asking the archive. An answer is made only of sentences the notes bear out, each pointing at
 * its note; when the notes do not say, the server says so, and that is shown as it is.
 */
export function Ask() {
  const archive = useArchive();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    listNotes(archive.id)
      .then((n) => live && setNotes(n))
      .catch(() => {
        /* only used to name an answer's sources; the answer still links to them */
      });
    return () => {
      live = false;
    };
  }, [archive.id]);

  const pending = turns[0]?.answer === 'pending';

  async function submit(q: string) {
    const text = q.trim();
    if (!text || pending) return;
    const turn = turns.length;
    setQuestion('');
    setTurns((t) => [{ question: text, answer: 'pending' }, ...t]);
    let answer: Turn['answer'];
    try {
      answer = await ask(archive.id, text, turn);
    } catch {
      answer = 'failed';
    }
    setTurns((t) => t.map((x, i) => (i === 0 ? { ...x, answer } : x)));
  }

  const suggestions = notes
    .filter((n) => n.type === 'person')
    .slice(0, 3)
    .map((n) => `Who was ${n.title}?`);

  return (
    <ArchiveLayout title="Ask">
      <div className="stack" style={{ gap: 5, textAlign: 'center', alignItems: 'center' }}>
        <h1 className="page-title">What would you like to know?</h1>
        <p className="muted">
          Answers use only what {archive.subjectName} and the family have shared — never guesses.
        </p>
      </div>

      <form
        className="ask-box"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(question);
        }}
      >
        <label style={{ flex: 1, display: 'flex' }}>
          <span className="visually-hidden">Your question</span>
          <input
            ref={input}
            data-testid="ask-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`Where did ${archive.subjectName} work after the war?`}
          />
        </label>
        <button
          type="submit"
          className="icon-btn"
          aria-label="Ask"
          disabled={pending || question.trim() === ''}
        >
          <Icon name="arrowUp" size={20} stroke={2.4} />
        </button>
      </form>
      {turns.length === 0 && suggestions.length > 0 && (
        <div className="row" style={{ justifyContent: 'center' }}>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="chip small"
              style={{ color: 'var(--muted)' }}
              onClick={() => void submit(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {turns.map((t, i) => (
        <section
          key={turns.length - i}
          aria-label={`Answer to: ${t.question}`}
          className="card stack"
          style={{ borderRadius: 8, gap: 12 }}
        >
          <p className="small muted">{t.question}</p>
          {t.answer === 'pending' ? (
            <p className="muted" role="status">
              Reading the records…
            </p>
          ) : t.answer === 'failed' ? (
            <Failed>Could not ask just now. Wait a moment and try again.</Failed>
          ) : (
            <Answer answer={t.answer} notes={notes} archiveId={archive.id} />
          )}
        </section>
      ))}
    </ArchiveLayout>
  );
}

function Answer({
  answer,
  notes,
  archiveId,
}: {
  answer: AskAnswer;
  notes: NoteSummary[];
  archiveId: string;
}) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const read = answer.evidence.relevant;

  if (answer.abstained) {
    return (
      <div
        data-testid="ask-abstained"
        className="stack"
        style={{ background: 'var(--wonder-2)', borderRadius: 8, padding: '10px 12px', gap: 4 }}
      >
        <span style={{ fontWeight: 600, color: 'var(--wonder-ink)' }}>Not in the records</span>
        <p style={{ fontSize: 15, lineHeight: 1.5 }}>
          {answer.message ?? 'There is not enough in the records to answer this.'}
        </p>
        <span className="small muted">
          {read === 0
            ? 'No record spoke to this.'
            : `${read} ${read === 1 ? 'record was' : 'records were'} read. None of their sentences answers this.`}
        </span>
      </div>
    );
  }

  const sources = [...new Set(answer.claims.map((c) => c.citation.noteId))];
  return (
    <div data-testid="ask-answer" className="stack" style={{ gap: 12 }}>
      {answer.selfIdentification && <p className="small muted">{answer.selfIdentification}</p>}
      <div className="stack" style={{ gap: 8 }}>
        {answer.claims.map((c, i) => (
          <p key={i} style={{ fontSize: 15, lineHeight: 1.6 }}>
            <span className={c.kind === 'quote' ? 'quote' : undefined}>{c.text}</span>{' '}
            <span className="small" style={{ fontFamily: 'var(--sans)', color: 'var(--muted-2)' }}>
              — {KIND_LABEL[c.kind] ?? c.kind}
            </span>
          </p>
        ))}
      </div>
      <div className="stack" style={{ gap: 5 }}>
        <span className="small muted" style={{ fontWeight: 600 }}>
          Where this comes from
        </span>
        <div className="row">
          {sources.map((id) => {
            const n = byId.get(id);
            return (
              <Link
                key={id}
                to={noteHref(archiveId, n ?? { id, type: 'event' })}
                className="pill pill-sage"
                style={{ minHeight: 32, padding: '0 9px', textDecoration: 'none' }}
              >
                {n?.title ?? 'A record'}
              </Link>
            );
          })}
        </div>
      </div>
      {answer.partial && (
        <p className="notice notice-wonder small">
          Part of an answer was left out because the records didn’t bear it out.
        </p>
      )}
    </div>
  );
}
