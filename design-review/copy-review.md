# Helper and explanatory copy: keep or cut

Every helper, hint, lede, empty-state and explanatory sentence in `apps/web/src`, as of `9d937b6`.
Not included: error messages, button and field labels, headings, questions, the landing page's
marketing copy and demo conversation, and code comments.

**Keep** = it prevents a real mistake: something irreversible, lost or misattributed words, a
privacy or legal consequence, an input that fails without it, or why a control is missing or
disabled. **Cut** = everything else (restates the label, reassures, explains a concept, fills an
empty space).

**Totals: 101 sentences. Keep 59, cut 42.** Applied on 2026-10-30: every cut is made (a few short states stay where a sentence was, e.g. "Kept", "None yet"), along with later wordy lines ("Press it again to carry on", the reading-status explanations). Line numbers below are from before.

## Starting a project (`pages/NewArchive.tsx`, `components/ProfileInputs.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 1 | NewArchive:74 | A project holds the interviews, stories, people and places, all in one spot. You can invite family to help once it's made. | cut | Explains the concept; no wrong move to prevent |
| 2 | NewArchive:14 | One person's life: a grandparent, a parent, an old friend, or you. | keep | Personal vs family can't be undone later (Settings) |
| 3 | NewArchive:19 | Everyone in a family. Each person is added the first time you interview them. | keep | Same choice |
| 4 | NewArchive:123 | The name of the project. The people in it are added as you interview them. | cut | Restates the field |
| 5 | NewArchive:124 | This is how their name shows up around the project. You can change it later. | cut | Restates the field; changeable |
| 6 | ProfileInputs:93 | A year is enough, and every field can wait. With a birth year, "when I was seven" in their stories becomes a year. | cut | Encouragement; leaving it empty isn't a mistake |
| 7 | NewArchive:162–163 | Usually where the family lives. / Usually where they live. | keep | Country is set once and decides the privacy law |
| 8 | NewArchive:171 | Private to you and the people you invite. | cut | Reassurance, and the same kind of promise as the banned "Members only" |

## Projects and Home (`pages/Archives.tsx`, `pages/Home.tsx`, `lib/interview.ts`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 9 | Archives:92 | Whose stories would you like to spend time with? | cut | Greeting |
| 10 | Archives:198 | For one person, or a whole family | cut | Restates "Start a new project" |
| 11 | Archives:13 | Your project / You can add memories / to help look after it / to read it | keep | Tells a viewer why they can't add anything |
| 12 | Home:495 | Nobody is in this project yet. Add the first person you are talking with. | keep | Empty state with the only next step |
| 13 | Home:178 | Pick up or discard the unfinished interview first | keep | Explains why Start interview is disabled |
| 14 | interview:425–426 | For a call in the browser, share its tab and tick "Also share tab audio"… / Share the call's browser tab and tick "Also share tab audio"… | keep | Without it a call records only one side |

## The live interview (`components/Studio.tsx`, `Coach.tsx`, `Notes.tsx`, `lib/questions.ts`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 15 | Studio:597 | Nothing in particular: a life story, from childhood on. Tap a topic to choose one. | cut | Describes the default |
| 16 | Studio:608 | Read this aloud to begin | keep | The step fails if it isn't read aloud |
| 17 | Studio:613 | Oral historians start every recording this way: who is speaking, when, and who is being interviewed, said by you, so they are not quizzed for it. | cut | Justification |
| 18 | Coach:414 | Read it out, then let them take it wherever they like. | cut | Coaching the obvious |
| 19 | Coach:493 | Suggestions use AI: the recent words go to NVIDIA to write them, and are not stored. | keep | Privacy disclosure: their words leave the app (could move to setup, shown once) |
| 20 | Coach:202 | From the question bank (AI suggestions unavailable) | keep | Says why the suggestion is generic |
| 21 | Coach:523 | Things they mention in passing collect here. | cut | Empty-space filler |
| 22 | Coach:531 | An hour in. Watch for tiredness: sixty to ninety minutes is a good length. | keep | Protects an older narrator from a too-long session |
| 23 | Notes:43 | Names you write here are spelled right. | keep | Without it nobody uses notes to fix misheard names |
| 24 | questions:68 | Let a silence sit for a few seconds. The best part often comes after it. | cut | Craft advice |
| 25 | questions:69 | Follow the story they want to tell, even if it leaves your topics. | cut | Craft advice |
| 26 | questions:70 | Ask roughly when it happened. A year puts the memory on the timeline. | keep | Undated stories never reach the timeline |
| 27 | questions:71 | Ask who else was there. Each name becomes a person in the project. | cut | Craft advice |
| 28 | questions:72 | Keep your "mm-hm"s quiet: a nod records nothing over their voice. | keep | Talking over them spoils the recording |
| 29 | questions:73 | If something is hard to talk about, let it go. You can come back another day. | cut | Craft advice |

## After the interview (`components/InterviewReview.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 30 | InterviewReview:210 | 0:08 recorded. Next, Firepit writes its stories for you to read over. | cut | Narrates the flow |
| 31 | InterviewReview:219 | Transcribing the whole recording once more, for cleaner words and voices told apart. The live transcript is below until it is done. | keep | Explains the wait and the disabled button |
| 32 | InterviewReview:234 | Transcribed again from the full recording. | cut | Success notice nobody acts on |
| 33 | InterviewReview:236 | The full recording couldn't be transcribed again, so this is the live transcript. | keep | Warns that voices and words may need checking |
| 34 | InterviewReview:289 | The introductions didn't say who every voice is. Say who said each line below; the stories are written from what Nell said. One person heard as two can be named twice. | keep | Prevents misattributed stories |
| 35 | InterviewReview:325 | Shown under each memory it adds. | cut | Restates the field |
| 36 | InterviewReview:355–356 | Say who is speaking above first (2 left). / Choose which voice is Nell above… | keep | Explains the disabled button |

## Bringing in a transcript (`pages/ImportInterview.tsx`, `components/ImportRun.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 37 | ImportInterview:135 | Bring in the transcript of a conversation with Nell. It becomes memories in their own words, and you read every one before it joins the project. | cut | Page lede |
| 38 | ImportInterview:163 | Paste it here, or open the file. Plain text, subtitles (SRT, VTT) and WhisperX JSON all work. A name before each line helps tell who is speaking. | keep | The import fails or mislabels without it |
| 39 | ImportInterview:198 | The person whose memories these are, as the transcript names them. Left empty, Firepit asks after reading it. | keep | A wrong name here makes the wrong person the teller |
| 40 | ImportInterview:199 | The person whose memories these are. | keep | Same |
| 41 | ImportInterview:210 | Written under each memory, so you know where it came from. | cut | Restates the field |
| 42 | ImportRun:191 | A long conversation takes a few minutes. You can leave this page — it keeps going… nothing is saved until you've read it over. | keep | Stops people abandoning or re-running it |
| 43 | ImportRun:240 | It wasn't clear whose memories these are. Choose the people whose words should be kept as testimony; the others are the ones asking. | keep | Prevents the interviewer's words becoming stories |
| 44 | ImportRun:328 | The transcript is kept with the interview, so nothing is lost. You can write its stories again from here, or later from Interviews. | keep | Prevents a duplicate re-import |
| 45 | ImportRun:347 | Nothing in the transcript could be kept as a memory. Nothing was saved. | keep | Says nothing was saved |
| 46 | ImportRun:405 | 5 stories from this interview. Nothing joins Nell's project until you save it. | keep | Prevents leaving without saving |
| 47 | ImportRun:443 | Written by Firepit from what was said, checked that nothing is made up | keep | Says a story is AI-written |
| 48 | ImportRun:448 | Tidied up by Firepit, checked against what was said | keep | Same |
| 49 | ImportRun:480 | This one will be kept. | cut | Repeats the control's state |
| 50 | ImportRun:481 | Left out. You can change your mind until you save. | cut | Repeats the control's state |
| 51 | ImportRun:596 | That says "…". Both will be kept, and marked. | keep | Explains a conflict before saving |
| 52 | ImportRun:639 | If they weren't sure, leave it empty or write ~ for "around". | keep | Prevents invented exact dates |

## Interviews (`pages/Interviews.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 53 | Interviews:101 | Every conversation brought into Nell | cut | Page lede |
| 54 | Interviews:72 | Take it back out of the project? Its memories are erased, except any someone has worked on since. | keep | Irreversible |

## Stories and writing a memory (`pages/Stories.tsx`, `NewNote.tsx`, `NotePage.tsx`, `components/NoteForm.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 55 | Stories:52 | 5 stories, in the order they happened | cut | The order is evident |
| 56 | Stories:88 | No stories yet. Add an interview, or write down a memory yourself. | keep | Empty state with the next step |
| 57 | NewNote:27–28 | Something you remember about Nell, or something they told you. | cut | Page lede |
| 58 | NoteForm:94 | A year alone is fine, and ~ means "around". If you don't know, leave it empty: a date is never made up. | keep | Date format, and no guessed dates |
| 59 | NoteForm:128 | Put a name in double brackets, like [[Mother]], to link it to their page. | keep | The only way to link, until the editor changes |
| 60 | NotePage:72 | Delete "…"? A deleted memory cannot be brought back. | keep | Irreversible |
| 61 | NotePage:306 | We keep both. No one has to be right. | cut | Reassurance |
| 62 | NotePage:339 | No page for "…" yet. Write one. | keep | Says the link is empty and what to do |
| 63 | NotePage:352 | No other memory links here yet. | cut | Empty-space filler |
| 64 | NotePage:374 | Showing 12 of 30 mentions. | keep | Says the list is cut short |

## People and places (`pages/People.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 65 | People:136 | Nobody and nowhere has a page yet. When an interview or a memory names someone, they can get one. | keep | Explains how pages appear |
| 66 | People:109 | Not mentioned elsewhere yet | cut | Filler |
| 67 | People:235 | Nothing written about Agnes yet. | cut | Filler |
| 68 | People:260 | No memory links here yet. | cut | Filler |

## Timeline (`pages/Timeline.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 69 | Timeline:34 | Exact years when we know them, "around" when we don't. A date is never made up. | keep | Stops "~1946" being read as exact |
| 70 | Timeline:55 | No dated memories yet. When a memory says when it happened — even just "around 1950" — it shows up here. | keep | Explains how the timeline fills |
| 71 | Timeline:66 | Each dot is a memory. The dashed decades haven't come up yet. | cut | Legend for what's visible, and the dashed decades don't appear |
| 72 | Timeline:94 | Nothing here yet. These years might be a lovely next conversation. | cut | Filler |

## Ask (`pages/Ask.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 73 | Ask:69 | Answers use only what Nell and the family have shared — never guesses. | keep | Stops "not in the records" reading as a bug |
| 74 | Ask:165 | There is not enough in the records to answer this. | keep | The honest no-answer |
| 75 | Ask:169 | No record spoke to this. | cut | Repeats 74 |
| 76 | Ask:170 | 3 records were read. None of their sentences answers this. | cut | Repeats 74 |
| 77 | Ask:211 | Part of an answer was left out because the records didn't bear it out. | keep | Says the answer is partial |

## Members (`pages/Members.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 78 | Members:56 | The people who can open Nell. The people it records don't need an account. | keep | Stops people inviting Nell to be recorded |
| 79 | Members:21–24 | Started the project and decides who is in it / Records interviews and adds memories / Reads the stories, the timeline and the people | keep | A role grants permissions |
| 80 | Members:129 | Only the owner or a steward can invite people. | keep | Explains the missing control |
| 81 | Members:230 | They'll find the invitation in Firepit and choose whether to join. | keep | No email is sent; the inviter must tell them |
| 82 | Members:236 | Invited Carol. It's waiting for them next time they open Firepit, so let them know. | keep | Same |
| 83 | Members:249, 317 | Not on Firepit yet. The invitation waits for them to sign in with this email. | keep | They must sign in with that exact email |
| 84 | Members:272 | Keep typing: three letters at least. | keep | Search returns nothing before that |

## Settings (`pages/ProjectSettings.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 85 | Settings:41–42 | The project's name and kind. Who's in it is on the Members page. | cut | Page lede |
| 86 | Settings:55 | Family: everyone in it. Each person is added the first time they are interviewed. | cut | Describes the current kind |
| 87 | Settings:65 | United States. Its privacy law applies to everything here, so it's set once, when the project is made. | keep | Says why it can't be changed |
| 88 | Settings:121 | What the family is called, e.g. The Marsh family. | cut | Restates the field |
| 89 | Settings:122 | How their name shows up around the project. | cut | Restates the field |
| 90 | Settings:197 | Every story is written knowing this. | keep | Changing it changes how stories are dated |
| 91 | Settings:197 | Nobody outside the project sees it. | cut | Reassurance, the same kind of promise as "Members only" |
| 92 | Settings:239 | Interviews will start by asking who you're talking with, and anyone new joins the project's people. You can't make it personal again. | keep | Irreversible |
| 93 | Settings:281 | What you added stays in the project. To come back you'll need a new invite. | keep | Leaving can't be undone alone |
| 94 | Settings:330 | Every interview, story, person and place in it is erased, for everyone in it. This can't be undone. | keep | Irreversible |

## Signing in (`pages/SignIn.tsx`, `ResetPassword.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 95 | SignIn:142 | Sign in or create an account. It only takes a moment. | cut | Filler |
| 96 | SignIn:139 | Create an account. It only takes a moment. | cut | Filler |
| 97 | SignIn:141 | We'll email you a link to reset it. | cut | The button says it |
| 98 | SignIn:146 | You have been signed out. Sign in again to come back to the page you were on. | keep | Explains an unexpected sign-in screen |
| 99 | SignIn:84, 90 | Check your email for a link to confirm your account. / …to reset your password. | keep | The required next step |
| 100 | ResetPassword:76 | It may have expired. Ask for a new one from the sign-in page. | keep | The only way out |

## The app shell (`components/ArchiveLayout.tsx`)

| # | Where | Sentence | Verdict | Why |
|---|---|---|---|---|
| 101 | ArchiveLayout:141 | Demo mode: sign-in skipped, sample data. | keep | Dev only: says the data is sample data |
