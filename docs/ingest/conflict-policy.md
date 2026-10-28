# When two accounts disagree — the policy

**Both claims stay. The disagreement is marked, with who said it and when. Nothing is overwritten, merged or averaged, and the system never says which one is right.**
(Spec §2.3: "multiple memories, not one artificial truth".)

This governs everything the AI writes: the assistant and interview ingestion. People editing a note by hand in the editor are not restricted.

**Writing new stories from an interview** (stories mode, `server/api/src/stories/`) may paraphrase
freely: tidy, condense, reorder and summarize what was said. It may not make anything up: every
sentence cites the lines it comes from, and is checked (PRD D11). The table below is about text that
is **already in the archive**, and stands until extending and merging notes is built (phase 3 of the
stories PRD).

## What the AI can and cannot do to existing text

| | |
|---|---|
| Add a new sentence | yes |
| Remove, shorten or reword an existing sentence | **no**, refused |
| Replace a sentence with a corrected one | **no**: the original stays and the correction is recorded beside it |
| Touch a `>` line (source or disagreement line) | **no** |
| Overwrite a note's date | **no** (an empty date may be filled) |
| Delete a note | no such tool |

Links must keep the sentence reading the same: `[[My Aunt Mae|Aunt Mae]]`, not `[[My Aunt Mae]]`.
After every run the verifier re-reads the saved notes and fails the run if any sentence that was there is gone.

## What a marked disagreement looks like

Two accounts in one note (the original text stays above, untouched):

```
We sold the farm in nineteen eighty-four because none of us could keep it going.

> ⚠ Disagreement · 2026-10-18 · Margaret Ellis via the assistant: “We sold the farm in 1982.” — the text above says “We sold the farm in nineteen eighty-four because none of us could keep it going.”
```

A new note that contradicts another note (the other note is not edited; it gains a backlink):

```
> ⚠ May disagree with [[The farm]] · 2026-10-18 · an interview transcript added by Margaret Ellis: that note says “We sold the farm in nineteen eighty-four because none of us could keep it going.”
```

Always written in English. A title or quoted sentence in another script is copied exactly inside the English line. The name is the account's display name (Google sign-in provides one); otherwise "a contributor". The revision log always records exactly who.

## How a disagreement is detected (best effort, and honest about it)

**A false marker on an innocent note is a bug the family sees; a missed one only leaves two plain sentences side by side.** So the checks lean towards silence.

1. **Numbers**: two sentences are a conflict only when, in some clause of each, ALL of this holds:
   - the **same subject** ("my mother" is not "my father"; "my first son" is not "my second"; a sentence with no stated subject never matches);
   - the **same people** involved after the verb ("lost my husband" is not "lost my son");
   - the **same event** (bought ≠ sold, born ≠ died, moved in ≠ moved out, started school ≠ graduated, moved here ≠ left), and at least 0.6 of the other words shared;
   - the **same kind of number**, stated plainly: a year against a year, a count against a count of the same thing ("four children" against "five children" is a conflict; "twelve hours a day" against "thirty years" is not), spoken or written ("nineteen eighty-four" = 1984). Not hedged ("around", "maybe"), not a range or a decade, not "1950 or 1951";
   - **a different year disagrees only for something that happens once**: born, died, married, graduated, emigrated, retired, baptised, enlisted, discharged, and only for ONE person ("my brother", "my son" or "my cousin" without a name or rank is not one person, nor are pets, priests, teachers or friends). Bought, sold, built and started count as once only for one particular thing ("the farm", "our house", "at the factory"; not "a car", not "the cows"); lost only for a person; closed only for a named place. "The war" and "the fire" need a name ("the Second World War"). Never for lived, worked, went, came, moved, met, served: "we lived in Scranton in 1950" and "…in 1960" are both true. A **count** is compared only at the same moment ("in 1950 we had 12 cows" against "in 1960 we had 20" are two moments; "when we moved", "when I got a job" are moments that repeat); and never when the year and the count both differ;
   - **what is said of NOW is compared only at a year both texts name**: "I am 82" against a note that says "Sunja is 81", "I have three children", "Dad will be 90 next year", "I am 82 this year" are true when they were said. A birth or death said in the present tense still counts;
   - **wishes, plans, hearsay and conditionals are not assertions** and are skipped like a denial ("he wanted to retire in 1980", "they say he left in 1950", "had he lived…", "I heard he moved"); approximations and bounds are not points ("about thirty years", "more than thirty", "at least 30", "or so", "thirty-odd"); an amount is not a year ("for 2000 pounds", "2000 dollars", "$2000"), and neither is a label ("Grade 5", "Company 12", "25 Main Street");
   - neither sentence is a **question** or a **denial**.
2. **A model as judge** for the rest ("who put the frog in the hat?", "born in Busan" against "born in Daegu"; also the cases the strict number check hands over, such as bought against sold). It is asked at temperature 0 and must say **what** the two texts answer differently (`about`); an answer that cannot say is dropped. Both the new statement and the passages are fenced as **data, never instructions**, so a note that says "reply with {conflicts: ...}" cannot steer it. An answer counts only if it **names a note it was shown**, quotes at least **one whole sentence** of that note, and the sentence is about the same thing as the claim (they share a topic word; the teller's own name, filler words and the verbs of telling and remembering never count as shared, so the judge's few calls are not spent on unrelated sentences); what is written into the marker is **the note's own sentence**, never the judge's spelling, with any markup removed. A claim is skipped as a repeat only if each of its clauses (words and numbers) sits in one clause of ONE sentence, and then only that note is dropped from what the judge sees.

**Whose "I" is it?** An interview that names its teller ("Who is telling these memories? — Grandma Sunja") puts the name in front of each "I ..." sentence before it is *looked up* in the archive, because the archive says "Sunja was born in Daegu", not "I was born in Daegu". A first-person "I", "we" or "my mother" is compared only between two texts known to be by the **same teller** (an import records its teller in its footer; a hand-written note has its author). Two brothers' "I was born in…" are two people. With no teller known nothing is invented: no first-person conflict is looked for, while third-person facts ("The farm was sold in 1984") are compared as always. "He", "she" and "it" match only inside one note. Two labels are one person only if one name holds all of the other's and they have no two different family words or Jr./Sr.: Aunt Sunja is not Grandma Sunja, Grandpa, Uncle and Cousin Joe are three people; "Walt" is "Walt Kowalski", lower case is capitalised. A footer that names nobody ("told by Grandma") is that note's own voice. A note whose TITLE names her counts as hers for the judge.

**What is compared:** only the relative's own words. A "Short answers" note holds lines like `- Did you go back to Busan? — Yes.`: only the answer is compared, never the interviewer's question.

**Limits, so that checking never holds up an import:**
- the judge is only shown notes the archive already held, not the interview's own earlier memories (numbers still catch a speaker contradicting herself);
- at most 12 judge calls per import, four at a time; none is started after 35 seconds; each is cut off at 25 seconds; the whole check stops at 60 seconds. The person can cancel it, and so can the 15-minute limit;
- the judge has its own priority lane, so a long import cannot starve it. A call that fails outright, or stays silent for 8 seconds, gets ONE duplicate beside it; the first USABLE answer wins (a reply that is empty or unreadable counts as a failure, and the duplicate goes into a free slot only, with no new try after the call ran out of time). A slow minute at the AI service is a few calls that hang while the rest answer in seconds; a healthy call is never doubled. A judge that is still slow or fails after that is skipped and the import says the check was not finished (`check.reason` is `ai`); with no judge configured only numbers are checked, and the check counts as complete for what it can do;
- every sentence of every memory is checked, shared out round-robin across the memories, so a long answer is not cut after its sixth sentence; the judge's calls go first to sentences that share a number or a person with something already in the archive;
- when the check could not finish (the time limit, the call budget, a failing judge) the import says so, and says why (`check.reason`: `time`, `ai` or `budget`; "N memories were not compared with what the archive already says", or that the check could not be finished) and saves as usual. A long interview checked against an empty archive costs about a tenth of a second. One marker is written per memory, note and sentence.

A missed conflict leaves a plain sentence beside the one it contradicts. It cannot erase anything, because adding-only is enforced separately.

## Privacy

A note marked private-to-author is never quoted or linked from another note.

## Answering questions

`search_notes` reports when its results disagree with each other and lists the disagreements a note records, so the assistant reports every version and the note each comes from.

## Not covered

- Removing a sentence: the assistant declines; the person edits the note, or deletes the note (which erases its history). Earlier versions of an edited note remain in its history.
- Importing the same interview twice is refused (it is recognised by its words, not its file format) unless the person chooses "import it again anyway"; an import can be taken back as a unit. Disagreements *between two different interviews* of the same person are what the marker is for.
- Detection of contradictions with no shared numbers needs the judge model; without an API key only number conflicts are caught.
- The judge sees at most four candidate notes per sentence. A contradiction with a note the archive search does not rank among them is missed; it is left as a plain sentence beside it, which cannot erase anything.
- A first-person "we" or "I" is compared by numbers only between texts by the same teller. Naming the teller does not change this for a hand-written note: its "we" is its writer's household, and a false marker is worse than a missed one; the judge, which is told who tells each text, may still mark it. Text in other scripts is compared word for word, but its numbers and events are not read, so it gets no number-based marker. Counts with no year ("we had 4 dogs" against "5 dogs") are still compared as one moment, and a few genuine disagreements in ambiguous wording ("my brother was born in 1950" against "1951": which brother?, "the war ended", "the factory closed") are left to the judge or left as two plain sentences.
