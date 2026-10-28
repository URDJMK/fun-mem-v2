---
name: Firepit
description: A life, kept in the voice that told it.
colors:
  paper: "#FFFFFF"
  canvas: "#F1F3F2"
  ink: "#15181A"
  graphite: "#585E64"
  voice: "#0A7A5A"
  marker: "#FFE14A"
typography:
  display:
    fontFamily: "Familjen Grotesk, system-ui, sans-serif"
    fontSize: "clamp(2.75rem, 6vw, 4.5rem)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.02em"
  page-title:
    fontFamily: "Familjen Grotesk, system-ui, sans-serif"
    fontSize: "2.1875rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  section-title:
    fontFamily: "Familjen Grotesk, system-ui, sans-serif"
    fontSize: "1.8125rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  item-title:
    fontFamily: "Familjen Grotesk, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0em"
  story:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.3125rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0em"
  quote:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0em"
  body:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0em"
  label:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0em"
  caption:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
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
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "12px 18px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "12px 18px"
    height: "44px"
  button-record:
    backgroundColor: "{colors.voice}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
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
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.graphite}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
    height: "44px"
  nav-item-selected:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
    height: "44px"
  chip:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: "4px 14px"
    height: "44px"
---

# Design System: Firepit

> **Status: foundation built, pages not yet.** Written on 2026-10-28; the foundation (tokens, type,
> the app shell, and the old look's effects removed) was built the same day, in `apps/web/src`.
> Page layouts are still the old ones inside the new system; `design-baseline/` shows the look this
> replaces and `design-after/` the foundation. Rules below that a page still breaks (dot-separated
> meta lines, large years, the voice line) are waiting for that page's rebuild.

## Overview

Firepit is made of voice. A relative talks; the talking becomes stories, people, places and dates.
The design shows that chain, so a reader can always see that a sentence came from someone's mouth.

**The signature is the voice line**: a horizontal trace of the interview that runs through the app.

- **While recording:** a live waveform from the microphone, the teller's voice in Voice green and the
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
- **Landing page (Persuade):** the same parts at full scale. The first viewport is a recording
  turning into a story: the voice line, the transcript beside it, a quoted line highlighted, and the
  story it became. This follows Google Recorder's way of showing the mechanism. The chrome is as quiet
  as dmcg.co's: a small wordmark and links at the edges, and nothing else above the demonstration.

## Colors

Restrained: two neutral surfaces, one ink, one quiet grey, and two colours that each mean exactly one
thing.

### Primary

- **Voice `#0A7A5A`** is the teller's voice: their part of the live waveform and the turn strip, the Start
  interview button, the current position in a recording, and the focus ring. 5.3:1 on Paper.

### Secondary

- **Marker `#FFE14A`** sits behind the relative's verbatim words, quoted in a story or an answer, and
  nothing else. Ink on Marker is 13.7:1.

### Neutral

- **Paper `#FFFFFF`** is the working surface: content panels, inputs and dialogs.
- **Canvas `#F1F3F2`** is the page ground: the top bar, the space around panels, and the tab bar. It is
  a cool, barely green grey, never cream.
- **Ink `#15181A`** is text, primary buttons and icons. 17.8:1 on Paper.
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
  dot, destructive actions and error text, and nowhere else.
- **Success:** Voice green with a check icon.
- **Warning:** Ink text with a warning icon, on Canvas with a Line border.

### Named Rules

- **One meaning per colour.** Green means the teller's voice or "this is live", and yellow means "they
  said these exact words". If a new use doesn't fit those meanings, use Ink.

## Typography

- **Atkinson Hyperlegible Next** (UI, body, transcripts, quotes) was drawn by the Braille Institute
  for low-vision readers. Its I, l and 1 can't be confused, and its open shapes stay clear at small
  sizes, which is what an 80-year-old reading their own story needs. It has a wide weight range and is
  free on Google Fonts.
- **Familjen Grotesk** (display, page and item titles, years) is a compact grotesk with a firm,
  slightly cut character, so titles read as titles, like a film's title card. It has good tabular
  figures for years, and it is not one of the faces every generated site uses.
- **No serif and no monospace anywhere.** Timecodes and years use `font-variant-numeric:
  tabular-nums`.

### Hierarchy

The scale is fixed rem on app screens, with a ratio of about 1.2. The landing page alone uses the fluid
display size.

| Token | Size | Face / weight | Use |
|---|---|---|---|
| display | 44–72px fluid | Familjen 700 | Landing headlines only |
| page-title | 35px | Familjen 600 | One per screen |
| section-title | 29px | Familjen 600 | Sections; years on the timeline |
| item-title | 24px | Familjen 600 | Story titles, person names |
| story | 21px | Atkinson 400 | A story's own text, at most 65 characters a line |
| quote | 20px | Atkinson 500 | The teller's words quoted in answers |
| body | 18px | Atkinson 400 | Everything else |
| label | 16px | Atkinson 600 | Buttons, nav, speaker names, field labels |
| caption | 16px | Atkinson 400 | Meta lines, timecodes, hints |

**Nothing is set below 16px**, in any stylesheet or component: `apps/web/test/type-floor.test.ts`
fails the build on a smaller size. On a phone the page title steps down to 29px.

Labels are sentence case. Emphasis comes from weight and size, never from capitals or letter-spacing.

## Layout

The page ground is Canvas, with the working surface on Paper. Spacing uses a 4px base: 4, 8, 12, 16,
24, 32, 48, 64, 96. Leave more space above a heading than below it.

### Desktop and tablet (640px and up)

No sidebar. A family has one or two projects and five places they go; the screen goes to the page.

- **Slim top bar, 56px, on Canvas, sticky.** The Firepit wordmark on the left, then the five places
  as text links: **Home, Stories, People, Timeline, Ask**. The current one is Paper on Canvas, in Ink.
- **The project menu** is on the right: the project's avatar and name, opening a floating menu with
  **Interviews**, **Add an interview** (for anyone who can add), **Members**, **Settings**, then
  **Switch project**, then the account and **Sign out**. Escape, a click outside, or choosing an
  item closes it.
- Content is centred on Canvas, up to 960px (1200px for wide pages). Reading pages (a story, a
  person, Ask) keep a 720px column.

### Mobile (under 640px, designed at 390px)

The nav never stacks above content.

- **Slim top bar, 56px, on Canvas.** The project menu (avatar and name) is on the left, the Firepit
  mark on the right. The page's own title follows directly below, so the bar doesn't repeat it.
- **Bottom tab bar, 64px plus the safe area, on Canvas.** The same five places, each an icon with a
  visible 16px label. Interviews, Members and Settings are in the project menu.
- Content scrolls between the two bars, full width with 16px side gutters.
- **During a live interview,** both bars give way to the recording bar (the voice line, time, Pause,
  End). Nothing else competes with the conversation.
- **Floating layers** (the live caption bar, menus, toasts) sit at least 16px from both screen edges.

### Full-height backgrounds

- `html` and `body` carry the Canvas background with `min-height: 100dvh`.
- No layer's background is sized to the viewport height, so scrolling never reveals an edge. The
  current fire-glow layer does exactly that, and it goes.

## Elevation & Depth

The app is flat. Depth comes from Canvas against Paper, not from shadows.

- **`--shadow-float`:** `0 1px 2px rgb(21 24 26 / 0.08), 0 8px 24px rgb(21 24 26 / 0.12)`. It goes on
  floating layers only: menus, popovers, dialogs, the caption bar and toasts.
- Nothing that sits in the flow of the page has a shadow.

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
  focus shows a 2px Voice ring
  offset 2px, disabled is Graphite at 60% on Canvas, and loading shows a spinner in place of the label
  at the same width.

### Record button

- Voice green, 64px tall, a full pill: "Start interview".
- While recording, it gives way to the recording bar. The red dot means "recording" and the
  green line means "who is speaking".

### Cards / Containers

- Panels are Paper on Canvas.
- Lists are rows. A story row is its title (item-title), then its place and date as plain text in
  caption Graphite ("Duluth, 1959"), with its kind ("Event", "Period") as a chip. It has a chevron
  only because the row opens a page.

### Inputs / Fields

- Paper, a 1px Edge border, `md` radius, 48px tall, label above in Label weight.
- Errors show red text below, and the field border turns red.

### Navigation

- The top bar's five links on a computer, the bottom tabs on a phone, and the project menu on both
  (see Layout).
- The current place is Paper on Canvas, in Ink at weight 600, with no coloured edge bar.

### Voice line (signature)

- **Live:** bars 3px wide with a 2px gap, heights from the microphone level, full radius caps.
  The teller is Voice and the interviewer is interviewer-grey. The line scrolls right to left at a
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
2. **Don't use a serif or monospace `font-family`, `text-transform: uppercase`, or positive
   `letter-spacing` on labels.** Only Atkinson Hyperlegible Next and Familjen Grotesk, with system
   fallbacks, and no tracked-caps eyebrows.
3. **Don't use `linear-gradient`, `radial-gradient`, blur or glow on surfaces.** The voice line and
   photos are the only imagery.
4. **Don't add depth in the page flow.** No `box-shadow` except `--shadow-float` on floating layers,
   and no card inside a card (a bordered box inside a bordered panel fails).
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
10. **Don't go below 16px text or 44×44px tap targets, and don't let colour carry meaning alone.**
    Speakers are also named, and the recording state also says "Recording".
