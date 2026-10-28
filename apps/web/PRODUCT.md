# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

For the MVP, two groups, both primary:

- **Older relatives** (the person whose life is being kept). They are interviewed, and may read their
  own stories, browse, and ask questions. Older eyes and hands set the floor for legibility, target
  size and plain language.
- **Their sons and daughters.** They run the interviews (in the same room, or over a call), review
  what the interview became, and invite the rest of the family.

Other family members join a project by invitation, as contributors (record and add memories) or
viewers.

## Product Purpose

Firepit is an oral history app. A family records interviews with a relative; each interview
becomes stories in the relative's own words, connected to the people and places in them, laid out
on a timeline, and open to questions. Success is a family that can read, and ask about, a life told
by the person who lived it.

## Positioning

What is kept is what was said. The AI may tidy and condense, but every event, person, place and date
in a story was told in an interview, and a question with no answer in the records gets "Not in the
records", never a guess.

## Operating Context

- **Live interview:** in the room (one microphone; voices told apart automatically) or on a call
  (the microphone plus a shared browser tab's audio). A coach suggests the next question. Words
  appear as they are spoken.
- **Bring in a transcript:** plain text, subtitles (SRT, VTT) or WhisperX JSON.
- **Projects:** personal (one person's life) or family (each person is added the first time they are
  interviewed). Roles: owner, contributor, viewer.
- **Pages:** Home (start an interview), Interviews, Stories, People & places, Timeline, Ask,
  Members, Settings.

## Capabilities and Constraints

- English only (docs/adr/0003).
- Audio is never stored: live audio goes to Deepgram, which keeps neither audio nor transcript; the
  whole recording is held in browser memory only, for a second transcription at the end. The
  transcript and its timings are kept; volume levels are not.
- The interview coach sends recent words to NVIDIA's model; they are not stored.
- Projects are visible to their members only; all data access goes through the API (docs/adr/0002).
- Not built yet: photo upload, markdown export.

## Brand Commitments

- Name: **Firepit**. Logo: `apps/web/public/favicon.svg`.
- Voice: direct, story-focused, a little cinematic.
- No promise claims: the site does not say "Members only", "Never sold or trained on" or "Nothing
  overwritten" (all three are on the current landing page and go in the redesign), and does not
  replace them with other claims.

## Evidence on Hand

- The demo archive (Grandma Nell, Grandpa Walter, the Okafor family) is synthetic sample data; label
  it as an example wherever it appears.
- No customers, testimonials, usage numbers or press exist. Do not invent them.

## Product Principles

1. The teller's own words come first; everything else points back to them.
2. Never invent. Show where a fact came from, and say so when nothing was said.
3. Every screen works for the oldest person in the family.
4. One afternoon of talking should already give something worth reading.

## Accessibility & Inclusion

Older users are primary: large, high-contrast text, generous tap targets, plain language, no
meaning carried by colour alone, and reduced motion respected.
