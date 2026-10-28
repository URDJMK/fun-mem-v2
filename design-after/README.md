# After the foundation

The same 17 pages as [`design-baseline/`](../design-baseline/README.md), at 1440px (desktop, 1x)
and 390px (mobile, 2x), after DESIGN.md's foundation was built: its tokens, the 16px type floor, the
top bar and phone tabs, and the old look's effects removed. Taken 2026-10-28 from `main` at
`656c07d` with [`capture.mjs`](../design-baseline/capture.mjs), same names and numbering; the
baseline README maps each number to its route.

Page layouts were not rebuilt yet, so a page can still break a DESIGN.md rule of its own (for
example the dot-separated meta lines on Stories and the story page).

One difference in how they were taken: `capture.mjs` now sizes the window to the whole page before
each shot, so fixed bars (the phone's tabs, the floating transcript) sit at the end of the page,
where scrolling down shows them. The baseline shots were taken before that change, as plain
full-page captures.
