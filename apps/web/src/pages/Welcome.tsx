import { useState } from 'react';
import { useLocation } from 'react-router';
import { returnPath, supabase } from '../lib/supabase';

/**
 * The first page, for someone who is not signed in: v1's words in English, in v1's order, and
 * one button. No design on purpose; the new design comes later. (v1's star chart and its
 * caption are pictures, not text, so they are not here.)
 */
export function Welcome() {
  const ended = (useLocation().state as { ended?: boolean } | null)?.ended === true;
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setFailed(false);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        // back to the page whose session ended, when there was one
        options: { redirectTo: `${window.location.origin}${returnPath()}` },
      });
      if (error) setFailed(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <main>
      <title>fun-mem — answers only from what your family wrote</title>

      <p>fun-mem</p>

      <section>
        <p>The Engraved Sky</p>
        <h1>
          “What was it Mother said,
          <br />
          back then…”
        </h1>
        <p>
          Only the sentences your family wrote down can answer that. fun-mem repeats only what was
          written, and does not answer what was not.
        </p>

        {ended && (
          <p role="status" data-testid="welcome-ended">
            You have been signed out. Sign in again to come back to this page.
          </p>
        )}
        <p>
          <button type="button" data-testid="login-google" onClick={() => void signIn()}>
            Sign in with Google
          </button>
        </p>
        {failed && (
          <p role="alert" data-testid="login-error">
            Could not sign in. Wait a moment and try again.
          </p>
        )}
      </section>

      <section id="record">
        <p>Record</p>
        <h2>What was written</h2>
        <p>The record below is not a real family’s: it is an example written for this page.</p>
        <p>“What was it Mother said, back then…”</p>
        <blockquote>
          It was the winter of 1997, the day I quit my job and went home. Mother asked me nothing.
          She set the table, and only when I had eaten and stood up did she say, “Make sure you
          eat.”
        </blockquote>
        <p>Second daughter · March 2026</p>
      </section>

      <section id="abstention">
        <p>Abstention</p>
        <h2>What it will not answer</h2>
        <p>
          I am an AI that answers from these records. My answers are not records and are not kept as
          evidence.
        </p>
        <Exchange
          q="Was there something Mother always said when she saw you off?"
          a="She said, “Make sure you eat.”"
          note="This sentence comes from 2 records."
          sources={['Second daughter, March 2026', 'Youngest son, April 2026']}
        />
        <Exchange
          q="Was Mother hurt, back then?"
          a="There is not enough in the records to answer this. Would you like to ask your family?"
          note="2 records were read. None of their sentences answers this."
        />
        <p>Instead of making something up, it stops.</p>
      </section>

      <section id="authorship">
        <p>Authorship</p>
        <h2>Who wrote these sentences</h2>
        <p>
          Every sentence here was written by the family, or by the person themselves while they were
          alive. Nothing is scraped together from what someone left behind after they died.
        </p>
        <p>
          Today this service does not recreate the voice or face of someone who has died. If it ever
          does, that will follow the permission the person gave while they were alive. Without
          permission, it will not.
        </p>
      </section>

      <section id="keeping">
        <p>Keeping</p>
        <h2>Who sees it, and what remains</h2>
        <dl>
          <dt>Grounding</dt>
          <dd>It repeats only sentences the family wrote down. When there are none, it says so.</dd>
          <dt>Who sees</dt>
          <dd>
            Records open only to the people who belong to this archive. Knowing the link is not
            enough.
          </dd>
          <dt>Not for sale</dt>
          <dd>
            They do not appear in any search engine, and are never used for advertising or to train
            AI.
          </dd>
          <dt>Consent</dt>
          <dd>
            Each record says who may see it, and an edit never overwrites: the earlier version is
            kept.
          </dd>
          <dt>Export</dt>
          <dd>
            Records are plain text files that open in any text editor. Any record you can read, you
            can download at any time.
          </dd>
        </dl>
        <p>Even if we shut down, the files you downloaded still open.</p>
        <p>At that point, you do not need us.</p>
      </section>

      <section id="door">
        <p>Door</p>
        <h2>At the door</h2>
        <p>
          It is fine to start from a single photograph found while sorting through what was left.
        </p>
        <p>
          At the start we ask only two things: whose record it is, and which country’s law it
          follows.
        </p>
      </section>

      <footer>
        <p>fun-mem</p>
        <p>Terms · Privacy</p>
      </footer>
    </main>
  );
}

/** One question and its answer, as v1's page shows them. */
function Exchange({
  q,
  a,
  note,
  sources,
}: {
  q: string;
  a: string;
  note: string;
  sources?: string[];
}) {
  return (
    <dl>
      <dt>Ask</dt>
      <dd>{q}</dd>
      <dt>Answer</dt>
      <dd>
        <p>{a}</p>
        <p>{note}</p>
        {sources && (
          <ul>
            {sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
      </dd>
    </dl>
  );
}
