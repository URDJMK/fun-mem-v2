# Transcript format — what to send us

**Easiest: one JSON file per interview, exactly as WhisperX writes it.** No conversion script is
needed, and you can add two optional fields.

```json
{
  "language": "en",
  "interviewee": "SPEAKER_00",
  "segments": [
    { "start": 0.0,  "end": 4.6,  "text": " What was your father like?", "speaker": "SPEAKER_01" },
    { "start": 4.6,  "end": 21.3, "text": " He repaired boats. He had big hands.", "speaker": "SPEAKER_00" }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `segments[].text` | **yes** | The words (`content` and `transcript` are read too). Punctuation and sentence capitals help a lot (Whisper does this by default). |
| `segments[].speaker` | **strongly** | Any string or number (`SPEAKER_00`, `"Anna"`, `0`). A number, or a string of digits, becomes `SPEAKER_nn` (`0` → `SPEAKER_00`). This is how we separate the person being remembered from the interviewer. Without it we guess, and a person confirms the guess. |
| `segments[].start` / `end` | recommended | Seconds. Shown as the time on each memory (`0:05–0:45`). Milliseconds are recognised when every time is a whole number and speech would be impossibly slow in seconds (more than 10 seconds a character); `start_time`/`end_time` are read the same way. |
| `interviewee` | recommended | The speaker id of the person being remembered, written as the speakers are (`"SPEAKER_00"`, `0`, `"0"`; any case). If it names nobody in the file, the import stops and asks who is telling. If omitted, we guess (see below). |
| `language` | optional | Detected from the text anyway. The notes come out in the speaker's language. |
| `words`, `score`, per-word `speaker`, … | ignored | The raw output of WhisperX with word timings (a 1–2 MB file for an hour) is fine as it is. |

## Everything we accept

The format is recognised from the content; nothing needs to be declared.

| What you send | How it is read |
|---|---|
| **WhisperX / Whisper JSON** (`segments`) | as above |
| **Other JSON**: `utterances` (AssemblyAI, Deepgram), `results.utterances`, `transcription` (whisper.cpp), `chunks` (Hugging Face), only `word_segments` / `words`, Deepgram `results.channels[0].alternatives[0].words`, Rev.ai `monologues`, Speechmatics `results` | `text`, `content` or `transcript`, a speaker as a string or a number, `start`/`end` in seconds or `offsets` in milliseconds. Words with no sentence text are gathered into turns by speaker, at pauses of 1.5 s, and at a sentence end once a turn is long. |
| **OpenAI Whisper's default JSON** (`{ "text": "…" }`) | the words, as plain text with no speakers |
| **SRT / VTT subtitles** | each cue is a segment; a speaker is read from `<v Name>` or a leading `[SPEAKER_00]:` / `Name:`. A cue holding two voices (two `<v>` tags, two labelled lines, two speakers on one line, or `- ` dialogue dashes) is split, its time shared by length. Times with no milliseconds (`00:00:01 --> 00:00:04`) or a colon before them (`00:00:01:000`) are fine. |
| **Otter / Zoom / Teams text** | `Speaker Name  0:05` on its own line (or Zoom's `[Name] 00:00:05`), the words on the lines after it |
| **Labelled text** | `Name: words`, optionally with a time before or after (`[00:12] Grandma: …`, `Grandma (00:12): …`, `00:12 Grandma: …`, `Speaker 1 00:05: …`). A name may be in any script and have accents (`Zoë:`, `김 선생님:`), a note in brackets (`Interviewer (Noah):`, `Anna Lee (she/her):`), or be `Family, Given:`. `[화자1] …` needs no colon. Markdown and list styles are read too: `**Noah:** …`, `**Noah**: …`, `- Noah: …`; and, when a whole document is written that way (the same name at least twice, plus a second name or a role), `<Noah> …`, `Noah said: …` and `Noah - …`. Names are compared in any case (`grandma:` is `Grandma:`), and `Grandma 2:` beside `Grandma:` is one more speaker. A colon INSIDE a sentence never makes a speaker in a file whose labels start the lines (`할머니: …생선을 파셨어요: 힘들다고…`, `Grandma: Why did we leave? Hunger: that was the reason`); a bulleted `- Name:` is a label only when it is the whole document's style. `Q. …` / `A. …` are labels when both recur; `[할머니] …` without a colon is a label when a few such names start most lines. A line with no label continues the previous speaker, except: when only the interviewer is labelled (`Q: …` then the answer on its own line), unlabelled lines are the answers (shown as the speaker `ANSWERS`). |
| **A paste that lost its line breaks** | `Interviewer: … Grandma: … Interviewer: …` on one line is split back into turns. The labels are decided once for the whole text (a name that recurs, starts a line, is a bracketed id, or comes right after a question), and the text is cut before every occurrence of those labels, so a short sentence just before a label ("Very poor. Interviewer: …") is never swallowed into it. A speaker who appears only once, right after a full stop, is not cut (it could be a sentence with a colon): that one stays inside the previous turn. |
| **Timestamped text** | `[00:12] words`, no speakers |
| **Plain text** | one turn per line, or paragraphs. Works, but questions and answers get mixed: send speakers if at all possible. |

A JSON file that cannot be read (damaged, cut off, or in a layout not listed above) is refused with
a message saying so; it is never read as text, so its keys and braces never become anyone's words.

Text files may be UTF-8, UTF-16 (Notepad's "Unicode") or Korean EUC-KR/CP949; v1's upload page
detected which in the browser (`apps/web/src/lib/decode.ts` in v1). The API itself takes text, so a
client in v2 sends UTF-8 (or brings that decoder over). A byte-order mark, Windows or old-Mac line endings, decomposed (NFD) Hangul,
zero-width and direction marks, no-break and full-width spaces, full-width brackets and colons
(`［화자1］`, `：`) and control characters are all normalised before anything is read. An email
reply in which most lines start with `>` loses those quote marks first.

## What we do to the text before anything else (in code, not by AI)

Nothing the relative said is removed, and nothing is added. In detail:

- Remove fillers and stammers: "um", "uh", "I, I", ", you know," (and 음, 어). A stammer is the same word in the same case ("so so" without a comma, "Grade A, a" stay), and across a comma only for "I/we/he/she/they/the/a/and/but/so/my/just" ("you, you" and "it, it" stay). "Um" and "Uh" stay when they are a name ("Mr. Um", "Um Jae-sun"), and ", I mean," stays when it introduces a correction ("1950, I mean, 1951"). A turn that is only "Mm-hm." stays "Mm-hm.": it is often the answer "yes".
- Remove **known** sound notes only: `[Music]`, `[laughter]`, `(inaudible)`, `[crosstalk]`, `[BLANK_AUDIO]`, Rev's `[inaudible 00:01:23]`, machine tags such as `[APPLAUSE]` or `[BLANK_AUDIO]` (an all-capital tag of two words or with an underscore; a single all-capital word such as `[UN]` or `[KBS]` is a name and stays), Korean notes such as `(웃음)`, `♪ … ♪`, `[Note: …]`, and times in brackets. Every other bracketed word stays (`[Busan]`, `[sic]`, `[그 당시에는]`), and a speaker label is never a sound note (`[SPEAKER_00]`, `[INTERVIEWER]`). The warning counts each note.
- Drop a transcriber's note on its own line (`Note: …`, `Transcriber's note: …`, `편집자 주: …`) and the **lead block**: the lines above the first speaker label. In it, header fields (`Date:`, `Title:`, `Location:`, `제목:`, `일시:`, `장소:`), phrases such as `Interview with…`, `Recorded March 1…`, `Transcribed by…`, a date, weekday, time or duration on its own line (`45m 12s`, `Tue, 5/12 9:15AM • 45:30`), e-mail attribution (`On Mon, May 4, 2026 at 9:12 AM Noah Kim <…> wrote:`, `…님이 작성:`), `From:/Sent:/To:/Cc:/Subject:`, `-----Original Message-----`, Otter `SUMMARY KEYWORDS` / `SPEAKERS` blocks, `Tape 2, side A`, and a leading `Interviewee: Sunja Kim` / `Interviewer: Noah Kim` block are not anyone's words: they are left out and the page says how many (`lines_dropped`). `Speaker 1 = Noah Kim, Speaker 2 = Sunja Kim` lines are used as the names. **Below the first speaker label nothing is dropped as a "header"**: an answer that begins with a date ("March 3rd, 1946, in Busan", "1950년 6월 25일에 전쟁이 났어요"), or a speaker called `Translator:` or `Subject:`, is speech.
- What is left in the lead block is speech with no speaker (`unlabelled_start`). A greeting, thanks, "testing, one two three", "today is…", or the interviewer calling her "Grandma," stays with the interviewer side. A sentence that looks like a tape cut mid-answer (it starts with and/but/so/because, "…", 그래서/그리고/그런데, or lower-case) is kept as the relative's, but the page then ASKS who is telling (`unlabelled_to_teller`) instead of filing it silently. Anything else is held back and asked about.
- Remove `>` quote marks, `#` headings, code fences and `---` rules from the start of every line: they are structure, not words.
- Collapse a speech-recogniser loop: the SAME speaker saying the same sentence four times in a row (eight times for a sentence of three words or fewer). "I miss her." said four times, or "No. No. No. No.", is testimony and stays.
- Drop known recogniser inventions such as "Thanks for watching!".
- Gather speech-to-text fragments of one voice into paragraphs, cut only at a sentence end or a pause of 1.5 s. A capital goes at the start of each turn and after each sentence end, never where a fragment happened to start.
- Split a very long turn (over 2,500 characters) at a sentence break, so one model call can handle it; the last piece is never a scrap shorter than 80 characters.
- When **nobody** is labelled and the file clearly alternates (a quarter of the lines are short questions, most of them followed by an answer), the questions are set apart as the interviewer's. A monologue with a few questions of its own stays one voice.
- Read spoken years when they are years: "nineteen sixty-six", "two thousand and twenty-one", "nineteen hundred and twelve" → 1966, 2021, 1912. A price or a quantity stays words ("we paid nineteen fifty for that cow", "two thousand people").
- A speaker in a file called `QUESTIONS`, `UNKNOWN` or `ANSWERS` (names we use ourselves), or `constructor`, `toString` and the like, gets ` (speaker)` after the name.

Only after the roles are known is a short "mm-hm" from the **interviewer**, between two parts of
one answer, folded into that answer. A one-word answer from the relative is never folded away
after a question, and a word of agreement ("Yes.", "맞아요.") from the relative always stays.

Every AI rewrite is then checked against the speaker's own words: if it adds anything that was not
said, it is thrown away and the speaker's words are shown instead.

## Who is telling the memories

If you name the interviewee (in the file, or in the request's `teller` / `interviewees`), that decides. Otherwise we guess, and
the guess says how sure it is. **Only a sure guess is saved without asking**; anything else stops at
"Who is telling these memories?" for a person to confirm. A guess is sure when:

- the labels say who asks (`Interviewer`, `Q`, `Host`, `질문자`, `인터뷰어`, `진행자`, `면접관`, `면담자`, `조사자`, `채록자`…; `면접자` only when its turns do ask) or who tells (`Interviewee`, `Narrator`, `구술자`, `제보자`), and the turns do not contradict them, and exactly one other person speaks; or
- one person speaks at least twice as much as the next, and their turns read as telling while the other's read as asking (a question mark, a question word, "Tell me about…", "…말씀해 주세요"); or
- only one person speaks, and they are not asking questions.

It asks when two people speak about equally, when the person who talks most is the one asking,
when a second person also tells at length (a second relative: a speaker who is not the teller and
makes a statement of a dozen words or more, or a third voice that answers), when labels could not be
read, when the only speaker is labelled as the interviewer, when an unlabelled opening might be hers, or when
the interviewee you named is not in the file. A header that names ONE interviewee is a hint, not a verdict: a
second relative who tells at length still makes it ask. Questions are recognised without a question mark too (Korean speech-to-text output has none:
`-나요`, `-ㄴ가요`, `어떻게`, `왜`, `어머니는요`…), and full-width `？` counts.

## How to produce it (collaborator)

```
whisperx interview.wav \
  --model large-v3 --language en \
  --diarize --min_speakers 2 --max_speakers 2 \
  --output_format json
```

(`--diarize` needs a Hugging Face token with the pyannote speaker-diarization model accepted.)
Optionally add `"interviewee": "<the speaker id of the person being interviewed>"` to the JSON
(`"SPEAKER_00"`, or the number `0`).

## Things that make the notes noticeably better

1. **Fix the number of speakers.** `--min_speakers 2 --max_speakers 2` for a one-on-one interview. Free-running diarization invents a third speaker for a cough, and each invented speaker splits a story.
2. **If you can record two separate channels** (interviewer on one, relative on the other), transcribe each channel on its own and merge by timestamp. Speaker attribution is then exact instead of estimated.
3. **Sentence-level segments** (WhisperX's default) — not one segment per word, not one segment for the whole hour.
4. **Names.** Pass the family's names through Whisper's initial prompt (e.g. "Names: Sunja Kim, Okja, Busan.") so they are spelled consistently. v1's page also had a "Who is telling these memories?" box (the request's `teller`); the name is written under each memory and is how an import notices that it disagrees with an existing note about the same person.
5. **16 kHz mono audio**, as little background noise as possible. Far more important than the model size.
6. **Do not edit or "clean" the text.** Pre-edited text is fine, but invented text would be treated as testimony.

## Warnings an import reports (`outcome.warnings`)

| Code | Meaning |
|---|---|
| `no_speakers` | the file says nothing about who speaks |
| `questions_guessed` | with no speakers, short questions were set apart as the interviewer's |
| `unlabelled_filled` | lines with no speaker were given to the speaker just before |
| `annotations_removed` | sound notes removed (counted one by one) |
| `repeats_collapsed` | a recogniser loop was collapsed |
| `backchannels_merged` | the interviewer's "mm-hm" was folded into the answer around it |
| `long_turns_split` | a very long turn was split |
| `labels_unclear` | lines look labelled but the labels could not be read; who is speaking must be confirmed |
| `unlabelled_start` | speech before the first speaker label was kept, with no speaker named for it (a greeting stays with the interviewer; a tape cut mid-answer goes to the relative with an ask) |
| `lines_dropped` | title or header lines (`Date: …`, `Interview with …`) were left out; the count is shown |
| `unlabelled_to_teller` | passages with no speaker label (before the first label, or an answer right after a question) were read as the relative's words; check them in the preview |
| `speaker_left_out` | you chose who is telling; the count of turns by other voices that may be testimony and were left out |
| `labels_merged` | one person's name written in different ways (case, accents, punctuation) was read as one speaker |

## How a memory's date is chosen

A memory is filed under a date only when the relative's own words give one, and a wrong date is
treated as worse than none. The words are read sentence by sentence; the result is a year
(`1946`), a month (`1946-03`), a day (`1946-03-15`), or an approximate one with a tilde (`~1946`),
or nothing.

- **Said in words or digits.** "nineteen forty-six", "1946", "1946년", "June of nineteen sixty-seven".
- **A hedge right beside the year makes it approximate** ("maybe 1958", "about nineteen sixty-two",
  "I think we moved in 1960", "1960 or so", 아마 1946년쯤). A hedge elsewhere in the sentence does not:
  "I was about ten in 1950" is a sure 1950.
- **Not dates:** prices and counts ("nineteen fifty for that cow", "1946 chickens"), addresses,
  phone numbers, and numbers that name a thing ("Room 1912", "Flight 1946", "jersey number 1984",
  1912호, 1946번 버스); today's date ("it is 2026 now"), the date of the recording, and years that have
  not happened yet.
- **A year the speaker takes back is ignored:** "No, not 1950. It was 1951." is 1951. So is a year
  they only report as other people's ("everyone says 1950").
- **Spans, ranges and decades are not events** ("since 1934", "between 1950 and 1953", "1950–53",
  "the 1960s", 1990년대, 1953년부터). They never become the date, and when another year is named too,
  the memory has no single date.
- **A person described in passing does not date the story:** "my mother, born 1920, raised us
  alone. In 1950 she lost the farm" is 1950.
- **Several different years:** the year in the first sentence that says something, if that sentence
  names exactly one; otherwise no date. The person can always type one in the review step.

## Limits

| | |
|---|---|
| Speech after cleaning | 400,000 characters (many hours) |
| A JSON file | about 6 MB (the word timings do not count towards the 400,000) |
| Any other text | 800,000 characters before cleaning |
| Segments | 50,000 (300,000 words in a word-level file) |
| Upload page (v1's) | 6 MB per file |

Reading is linear in the size of the file: 400,000 characters of anything, however odd, takes a
moment.

Longer interviews: split them (one file per hour is ideal) and import each.
