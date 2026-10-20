# 0003 — the MVP is English only

Date: 2026-10-19 · Status: accepted

## Context

fun_mem v1 was Korean-first and bilingual. Korean was not a translation layer: its rules were
woven into the transcript reader (labels, question endings, backchannels), the grounding check
(stems, particles, endings, numerals, negation, tense and mood), claims and dates, title rules, the
drafts composer and the persona's messages. Every one of those had to be built, tested and reviewed
twice, and the MVP's users, demo and transcripts are English.

## Decision

v2 works in English only, with no assumption about Korean anywhere: no Korean rules, word lists,
messages, prompts, samples or test data, and no Korean defaults (the time zone of a "may disagree"
date is UTC unless FUNMEM_TZ says otherwise; no jurisdiction, currency or web address is Korean by
default). Names of people and places in English examples ("born in Busan") are only names.

Removing the rules was done so that English behaviour did not move: for each part, v1 and v2 were
run on the same English inputs (thousands per part, real and generated) and their outputs compared
in full; the commits that removed them give the numbers. One change is deliberate: "won" is no
longer read as a currency, because in English it is a verb ("My father won the race in nineteen
sixty" lost its date). Two v1 crashes on English input were fixed on the way; the commit that
removed the rules names them.

What the checks do with text in another script: they treat it as opaque words, compared exactly.
An AI rewrite cannot slip unchecked words past the grounding check because no rule covers them.

## Consequences

- One language to reason about, test and explain.
- A non-English interview is read with English rules only. It is not refused, and its words are kept
  as they were, but the reader and the checks understand it poorly (expect "who is telling?" to be
  asked, and memories kept in the speaker's own words).
- Multilingual support is a later phase, designed for it from the start (language as data, not
  branches in every rule). v1's Korean rules remain in v1's repository for reference.
