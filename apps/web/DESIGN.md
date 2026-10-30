---
name: Firepit
description: A life, kept in the voice that told it.
colors:
  paper: "#FFFFFF"
  canvas: "#F1F3F2"
  ink: "#15181A"
  graphite: "#585E64"
  rose: "#D6336C"
  marker: "#FFE14A"
typography:
  display:
    fontFamily: "Ronzino, system-ui, sans-serif"
    fontSize: "2.75rem"
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: "0em"
  title:
    fontFamily: "Ronzino, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "0em"
  heading:
    fontFamily: "Ronzino, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0em"
  body:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0em"
  small:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0em"
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  full: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
  "12": "48px"
  "16": "64px"
  "24": "96px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.small}"
    rounded: "{rounded.md}"
    padding: "12px 18px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.small}"
    rounded: "{rounded.md}"
    padding: "12px 18px"
    height: "44px"
  button-record:
    backgroundColor: "{colors.rose}"
    textColor: "{colors.paper}"
    typography: "{typography.small}"
    rounded: "{rounded.full}"
    padding: "16px 32px"
    height: "64px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
    height: "48px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.graphite}"
    typography: "{typography.small}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
    height: "44px"
  nav-item-selected:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    underline: "2px {colors.rose}"
    typography: "{typography.small}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
    height: "44px"
  chip:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.small}"
    rounded: "{rounded.sm}"
    padding: "4px 14px"
    height: "44px"
---

# Design System: Firepit

> **Status: foundation, brand and landing page built; app pages not yet.** Written on 2026-10-28;
> the foundation (tokens, type, the app shell, and the old look's effects removed) was built the
> same day, in `apps/web/src`. On 2026-10-29 the brand was chosen: black and white with Rose as the
> one point colour (it replaced Voice green), Ronzino for titles and the logo, and a strict scale of
> five type roles. On 2026-10-30 the new landing page (see Landing page) replaced the old one, in
> `src/pages/Landing.tsx` and `src/pages/landing/`. App page layouts are still the old ones inside
> the new system;
> `design-baseline/` shows the look this replaces and `design-after/` the foundation. Rules below
> that a page still breaks (dot-separated meta lines, large years, the voice line) are waiting for
> that page's rebuild.

## Overview

Firepit is made of voice. A relative talks; the talking becomes stories, people, places and dates.
The design shows that chain, so a reader can always see that a sentence came from someone's mouth.

**The signature is the voice line**: a horizontal trace of the interview that runs through the app.

- **While recording:** a live waveform from the microphone, the teller's voice in Rose and the
  interviewer's in a quiet grey. It replaces the current fire glow as the centre of the screen.
- **After recording:** the audio is gone (Firepit stores neither audio nor volume levels), so the line
  becomes a **turn strip**, drawn from the transcript's real timings: one bar per stretch of speech,
  coloured by who spoke. It is real data, never a decorative waveform.
- **On a story:** the strip of its source interview, with the stretches the story quotes marked in
  Marker yellow. The same yellow sits behind the quoted words in the story. A reader sees, at a
  glance, where in the conversation each part came from.

**Dates are real structure, never decoration.** The timeline is organised by year, and a story's
details give its place and date in plain words: "Duluth, 1959", or the place on its own line above
the year. Years are set large only in those two places, and only when the year is that story's
real date.

How the other materials take part:

- **Transcripts:** set like subtitles. Plain sans, speaker named in Label weight, generous line height.
  Never in a monospace or "terminal" style.
- **Places:** plain text with the date ("Duluth, 1959") or on their own line. No maps until there is
  real location data.
- **Family relationships:** the People page draws plain lines between names. It is a working tool, not
  a decorative motif, and the graph appears nowhere else.
- **Photos:** not built yet. When they come, they are content: shown large and uncropped in stories,
  like Are.na's image-first blocks. They are never textures, frames or backgrounds.

**Two modes, one world.**

- **App screens (Operate):** quiet and dense, with a light Canvas around a white Paper working
  surface, like a well-made messaging app.
- **Landing page (Persuade):** one interview, shown as objects (see Landing page). The chrome is as
  quiet as dmcg.co's: a small wordmark and links at the corners, and nothing else around the object.

## Colors

Black and white, with one point colour. Two neutral surfaces, one ink and one quiet grey carry
everything; Rose and Marker yellow each mean exactly one thing.

### Point colour

- **Rose `#D6336C`** is the teller's voice and anything live, and the brand's one accent: their part
  of the live waveform and the turn strip, the Start interview button, the current place in the nav
  (a 2px underline), the focus ring, and on the landing page the glow once it is lit. 4.6:1 on Paper,
  so it can carry Paper text. In CSS it is `--rose`, with `--voice` pointing at it.

### Secondary

- **Marker `#FFE14A`** sits behind the relative's verbatim words, quoted in a story or an answer, and
  nothing else. Ink on Marker is 13.7:1.

### Neutral

- **Paper `#FFFFFF`** is the working surface: content panels, inputs and dialogs, and the landing
  page's open field.
- **Canvas `#F1F3F2`** is the app's page ground: the top bar, the space around panels, and the tab
  bar. It is a cool, barely green grey, never cream.
- **Ink `#15181A`** is text, primary buttons, links, icons and the logo. 17.8:1 on Paper.
- **Graphite `#585E64`** is secondary text: meta lines, captions and the interviewer's voice. 6.6:1 on
  Paper and 5.9:1 on Canvas.

Derived values, which are the only allowed variations:

- **Line:** Ink at 12% opacity, for borders and dividers.
- **Edge:** Ink at 45% opacity, for the border of anything you type into or press (inputs, outline
  buttons): 3.2:1 on Paper, so a field can be found without its label.
- **Hover:** Ink at 6% over the surface.
- **Interviewer bars:** Graphite at 45%.

### State colours (outside the palette)

- **Recording and error:** `#C22F26`, 5.6:1 on Paper and 5.05:1 on Canvas. Use it for the recording
  dot, destructive actions and error text, and nowhere else. It sits near Rose in hue, so it never
  appears without its words ("Recording", "Delete").
- **Success:** Ink with a check icon.
- **Warning:** Ink text with a warning icon, on Canvas with a Line border.

### Named Rules

- **Black and white, one point.** The brand is Ink and Paper: buttons, links and the logo are Ink.
  Rose means the teller's voice, "this is live", or "you are here", and yellow means "they said these
  exact words". If a new use doesn't fit those meanings, use Ink.

## Typography

- **Ronzino** (titles, the logo) is a grotesk from Collletttivo, free under the SIL Open Font
  License and self-hosted in `public/fonts/ronzino/`. It keeps an information-led plainness without
  the coldness of the faces every generated site uses, and at Medium weight titles read as titles
  without shouting. Its zero carries a dot, which keeps years and dates unambiguous.
- **Atkinson Hyperlegible Next** (reading, the interface, transcripts, quotes) was drawn by the
  Braille Institute for low-vision readers. Its I, l and 1 can't be confused, and its open shapes
  stay clear at small sizes, which is what an 80-year-old reading their own story needs.
- **No serif and no monospace anywhere.** Timecodes and years use `font-variant-numeric:
  tabular-nums`.

### Hierarchy

Five roles, each exactly one family, size, weight and line height, set as `--type-*` tokens in
`src/styles.css`. Nothing else sets type: every rule takes a role (`font: var(--type-body)`) or
inherits one, and `apps/web/test/type-scale.test.ts` fails the build on anything else.

| Role | Size / line | Face / weight | Use |
|---|---|---|---|
| display | 44px / 1.05 | Ronzino 500 | Landing headlines only |
| title | 28px / 1.15 | Ronzino 500 | One per screen: the page's header ("Good morning, Kenneth", "Stories") |
| heading | 18px / 1.3 | Ronzino 500 | Sections, story titles in a story's page, dialog titles, the wordmark |
| body | 18px / 1.55 | Atkinson 400 | Reading: a story's own text (at most 65 characters a line), transcripts, answers, quotes |
| small | 14px / 1.4 | Atkinson 500 | The interface: project and list names, menu items, nav, buttons, labels, meta lines, hints |

The hierarchy comes from the steps: one title per screen, then the interface at 14px, so a page's
header is plainly the header. Reading stays at 18px, for older eyes.

**Nothing is set below 14px**, in any stylesheet or component: `apps/web/test/type-floor.test.ts`
fails the build on a smaller size. (On 2026-10-30 the floor moved from 16px to 14px, and reading
text from 20px to 18px, because everything sat at one size and the pages had no hierarchy.)

Labels are sentence case. Emphasis comes from weight and size, never from capitals or letter-spacing.

## Layout

The page ground is Canvas, with the working surface on Paper. Spacing uses a 4px base: 4, 8, 12, 16,
24, 32, 48, 64, 96. Leave more space above a heading than below it.

### Desktop and tablet (640px and up)

Inside a project, a rail down the left, like Supabase's. A family has one or two projects and five
places they go; the rail keeps them one click away without taking the page's width.

- **The rail, 64px, on Canvas, fixed.** The mark at the top, then the five places as icons:
  **Home, Stories, People, Timeline, Ask**, then the project's menu (its avatar) at the foot. The
  current place is Ink on Paper, its icon in Rose.
- **It widens to 232px over the page** while the pointer or the keyboard is in it, showing the five
  names, the wordmark and the project's name, with a floating shadow; it narrows again when they
  leave. The labels are always in the page for screen readers.
- **The project menu** opens beside the rail, from its foot: **Interviews**, **Add an interview**
  (for anyone who can add), **Members**, **Settings**, then **Switch project**, then the account
  and **Sign out**. Escape, a click outside, or choosing an item closes it.
- Content is centred to the right of the rail, up to 960px (1200px for wide pages). Reading pages
  (a story, a person, Ask) keep a 720px column.
- **The projects page** (signed in, before a project) keeps a slim top bar: the wordmark, the
  account, Sign out. Its projects are compact cards (avatar, name, your part in it), each with a
  ⋯ menu: Open, Members, Settings, and Delete (the owner, confirmed by typing the name) or Leave.
  "New project" is a small primary button above the list, on the right.

### Mobile (under 640px, designed at 390px)

The nav never stacks above content.

- **Slim top bar, 56px, on Canvas.** The project menu (avatar and name) is on the left, the Firepit
  mark on the right. The page's own title follows directly below, so the bar doesn't repeat it.
- **Bottom tab bar, 64px plus the safe area, on Canvas.** The same five places, each an icon with a
  visible 14px label; the current one is Ink with a Rose line along its top edge. Interviews, Members and Settings are in the project menu.
- Content scrolls between the two bars, full width with 16px side gutters.
- **During a live interview** the rail (or the bar and tabs) stays. The interview is Home's whole
  page, and it goes on while you look at any other page: it is kept above the pages
  (`components/LiveInterview.tsx`), so leaving Home never stops the microphone or the
  transcription. Elsewhere, a floating sign says so ("Recording 12:03", with Back to the
  interview), and Home carries a Rose dot in the rail and the tabs. Once it has ended, the sign
  offers the read-over until Home shows it.
- **Floating layers** (the live caption bar, menus, toasts) sit at least 16px from both screen edges.

### Full-height backgrounds

- `html` and `body` carry the Canvas background with `min-height: 100dvh`.
- No layer's background is sized to the viewport height, so scrolling never reveals an edge. The
  current fire-glow layer does exactly that, and it goes.

## Elevation & Depth

The app is flat. Depth comes from Canvas against Paper, not from shadows.

- **`--shadow-float`:** `0 1px 2px rgb(21 24 26 / 0.08), 0 8px 24px rgb(21 24 26 / 0.12)`. It goes on
  floating layers only: menus, popovers, dialogs, the caption bar and toasts.
- Nothing that sits in the flow of an app page has a shadow.
- **The landing page's objects** (the question slip, the transcript sheet, a story, an answer) are
  paper on paper, so they carry `--shadow-object`, `0 1px 2px rgb(21 24 26 / 0.06), 0 18px 40px
  -18px rgb(21 24 26 / 0.24)`, plus a 1px Line ring. Nowhere else.

## Shapes

- **`md` (10px)** for buttons, inputs and nav rows.
- **`lg` (16px)** for content panels and dialogs.
- **`sm` (6px)** for chips.
- **`full`** for the record button, avatars and the voice line's bar caps.
- Rows inside a panel are divided by Line, not boxed. A panel never holds another bordered panel.

## Components

### Buttons

- **Primary:** Ink with Paper text. One per view.
- **Secondary:** Paper with a 1px Line border.
- **Destructive:** recording-red text on Paper. Confirm by typing the name, as Settings already does.
- **Sizing:** every button and every other tap target is at least 44×44px. States: hover darkens 6%,
  focus shows a 2px Rose ring
  offset 2px, disabled is Graphite at 60% on Canvas, and loading shows a spinner in place of the label
  at the same width.

### Record button

- Rose, 64px tall, a full pill: "Start interview". Home is the project's name and this, and nothing
  else: the whole page is for interviewing.
- While recording, it gives way to the recording bar. The red dot, always beside the word
  "Recording", means "recording"; the Rose line means "who is speaking".

### Cards / Containers

- Panels are Paper on Canvas.
- Lists are rows. A story row is its title (item-title), then its place and date as plain text in
  caption Graphite ("Duluth, 1959"), with its kind ("Event", "Period") as a chip. It has a chevron
  only because the row opens a page.

### Inputs / Fields

- Paper, a 1px Edge border, `md` radius, 48px tall, label above in Label weight.
- Errors show red text below, and the field border turns red.

### Navigation

- The rail on a computer, the bottom tabs on a phone, and the project menu on both (see Layout).
- The current place is Ink on Paper with its icon in Rose in the rail, and Ink with a Rose line
  along the top of its tab on a phone. No coloured side bar.

### Voice line (signature)

- **Live:** bars 3px wide with a 2px gap, heights from the microphone level, full radius caps.
  The teller is Rose and the interviewer is interviewer-grey. The line scrolls right to left at a
  constant speed.
- **Turn strip:** one bar per segment, its width proportional to the segment's duration, at one
  height, coloured by speaker. It is clickable on a story and jumps to that place in the transcript.
- **Reduced motion:** the live line updates in steps once a second, with no scrolling.
- **Accessibility:** every voice line has a text equivalent, such as "Nell spoke for 41 of 52
  minutes".

### Quote

- The teller's words in the quote style, with Marker behind the exact quoted span
  (`box-decoration-break: clone`). It is followed by a caption naming the interview and the time,
  such as "From Her twenties in Duluth, at 12:40".

## Landing page

One interview, from the first question to the finished stories, shown one object at a time on an
open Paper field, after dmcg.co. The only chrome is small, in the top corners: the wordmark top
left, Sign in and Start top right. The bottom corners stay empty.

The stages, in order: the mark (the headline, and Start); the question, on a paper slip; two voices,
Theo's small and grey, Nell's large and Rose, taking turns over the turn strip; the words worth
keeping, marked on the transcript, the first of them rising off the sheet to become a story; the
timeline, where the stories drop onto their decades; asking later, with an answer and an honest "Not
in the records"; the people she named, linked; and Start.

**The mark is the thread.** The page opens on the logo at full size. As it begins, the glow lifts
out of the bowl and catches: an Ember grows from its middle until the glow is lit Rose, a clean
change, never a blend through a muddy dark red. It becomes Nell's voice. On the last screen it
settles back into the bowl, still lit, beside "Start with one afternoon."

The example (Theo and his grandmother Nell) is fiction, and the demonstration is silent: there is no
audio. Since 2026-10-30 the page no longer labels it as an example.

## Motion

- **GSAP** (with ScrollTrigger, SplitText, MorphSVG, DrawSVG and TextPlugin, all free) for anything
  more than a hover. No second animation library.
- **The motion follows the scroll.** Each landing stage is a tall section with a CSS
  `position: sticky` frame; its scene is scrubbed to the scroll (with a second of lag, so a fast
  scroll shows the motion catching up), and scrolling back plays it backwards. Never replace this
  with motion that plays by itself: the interaction is the point.
- **A still stretch after every scene.** Once a scene has finished, the next 60% of a screen of
  scrolling changes nothing, so the finished object can be looked at before the next one comes.
  The last stage has its still stretch first, so the lit glow is seen before it settles.
- **One speed control.** `PACE` in `src/pages/Landing.tsx` is how many screens of scrolling one
  beat of motion takes, and each stage's `hold` is how many beats its scene has (the two voices
  take about a screen per turn). Slow the page with PACE, a scene with its hold; never by
  intercepting the scroll.
- **Scrolling is the visitor's own: a nudge, never a hold.** Each stage has one resting point, in
  the middle of its still stretch, and proximity scroll snap (`scroll-snap-type: y proximity`) settles
  the page there when the visitor stops near it. A scroll of any speed or length goes where it was
  going. Nothing intercepts the wheel, touch or keyboard, and there is no smooth-scroll library.
- **One authored moment per object.** Each does its one thing while it holds the centre, arrives
  out of a blur and leaves into one. No identical entrance on every section, and no idle loops.
- **Organic shapes are hand-cut,** the same family as the logo's glow: smooth closed curves with the
  same number of points, so any two morph cleanly. They move only when something happens (someone
  talks, something is kept), never as decoration.
- **Ease out, never bounce.** Exponential or power ease-out; no `back` or elastic eases.
- **Reduced motion:** every scene is written in its finished state, and motion only runs when the
  visitor allows it. With reduced motion the stages simply stack, each finished.

## Do's and Don'ts

### Do:

- Show where words came from: a quote carries its interview and time.
- Set years with tabular figures, and set them large only on the timeline and in a story's details.
- Label every icon in navigation.
- Test every screen at 390px and 1440px before calling it done.

### Don't:

Each rule can be checked against the code or a screenshot.

1. **Don't use colours outside this file.** Any hex or `rgb()` in the CSS that isn't a token or a
   listed derivation is a bug. There are no cream, beige or warm-tinted surfaces: every surface is
   Paper or Canvas.
2. **Don't set type outside the five roles, or use a serif or monospace face,
   `text-transform: uppercase`, or `letter-spacing`.** Only Ronzino and Atkinson Hyperlegible Next,
   with system fallbacks, and no tracked-caps eyebrows.
3. **Don't use `linear-gradient`, `radial-gradient`, blur or glow on surfaces.** The voice line, the
   mark and photos are the only imagery. Blur appears only in motion, as a landing-page object
   arrives or leaves, never at rest. (The Marker sweep is a solid fill drawn as a gradient image.)
4. **Don't add depth in the page flow.** No `box-shadow` except `--shadow-float` on floating layers
   and `--shadow-object` on the landing page's objects, and no card inside a card (a bordered box
   inside a bordered panel fails).
5. **Don't add arrows (→, ›, ↗) to link or button text.** A chevron belongs only on a row that opens a
   page.
6. **Don't write dot-separated meta strings.** No `·`, `•` or `|` joining fields anywhere ("1959 ·
   Event · Duluth" fails). Put the place on its own line or in plain words ("Duluth, 1959"), and use
   a chip for a kind.
7. **Don't put Marker yellow behind anything but the relative's verbatim words.** Never in headlines,
   buttons, calls to action, marketing copy, or for emphasis.
8. **Don't set years large except as real data.** Only on the timeline and in a story's details,
   where the year is that story's date. Never as a decorative, hero or landing-page graphic.
9. **At 390px, don't stack navigation above content.** The page title sits within 72px of the top,
   the bottom tab bar is visible, nothing scrolls sideways, and floating layers are inset at least
   16px.
10. **Don't go below 14px text or 44×44px tap targets, and don't let colour carry meaning alone.**
    Speakers are also named, and the recording state also says "Recording".
