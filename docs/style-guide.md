# Detox — Style Guide

This is the positive design system for Detox. It says what the design *should* be. `anti-ai-design-decisions.md` is applied after it as a filter and is never overridden here. Where the two seem to conflict, the anti-AI document wins and this guide gets edited.

Design character in one line: **a quiet editorial instrument — a morning newspaper crossed with a lab notebook, on dark slate.** Content voice is a serif; the machinery around it is a small, calm sans. Hierarchy comes from type, tone, and whitespace. Nothing floats, nothing glows.

---

## 1. Palette

Dark only. One theme done well. The canvas is slate, not black, and the accent is muted gold — the anti-AI document's drift list warns off both the terracotta-on-cream cliché and near-black-with-neon.

| Token | Value | Use |
|---|---|---|
| `--canvas` | `#1A1D24` | Page background. Deep slate. |
| `--canvas-2` | `#21252E` | Table header tint, hover row tint. Used sparingly, never as a card fill. |
| `--ink` | `#EDE8DE` | Primary text. Warm off-white, not pure white. |
| `--ink-muted` | `#A9AFBA` | Secondary text: summaries, context lines. (7.6:1 on canvas) |
| `--ink-faint` | `#868D99` | Metadata: outlet, time, counts. (5.0:1 on canvas) |
| `--accent` | `#D6AC52` | Muted gold. Links on hover, consensus values, focus ring, primary button fill. (7.9:1 on canvas) |
| `--accent-ink` | `#1A1D24` | Text on gold fills. |
| `--good` | `#8AA98E` | Semantic positive: "probable", "on time". (6.5:1) |
| `--alert` | `#BC6F6A` | Semantic negative: "out", "failed source". Rare. (4.5:1) |
| `--line` | `rgba(237, 232, 222, 0.08)` | Hairlines. Exactly `--ink` at 8%. |

Rules:

- Gold is a signal, not a theme. It appears where the eye needs an answer (consensus values, the focused control, a link under the cursor) and nowhere else. Never as a background wash larger than a button.
- `--alert` and `--good` are status colours only. An item is never "good content"; it is at most "probable (knee)".
- No gradients anywhere. No colour used decoratively.
- If a new colour is needed, it must state what decision it encodes.

---

## 2. Typography

Two families, both self-hosted (Fontsource), both open licensed:

- **Newsreader** — the content voice. Item titles, headlines, summaries, the morning line, big numbers that are answers (the consensus high).
- **IBM Plex Sans** — the machinery. Controls, metadata, table numerals, labels inside data blocks.

Both are choices, not fallbacks; the system stack is fallback only. Weights used: 400 and 500, nothing else.

### Scale

| Token | Size / line-height | Family | Use |
|---|---|---|---|
| `--t-meta` | 12px / 1.4 | Plex | Outlet and time, counts, status lines, footer. |
| `--t-small` | 14px / 1.5 | Plex | Table cells, control labels, context lines. |
| `--t-body` | 16px / 1.55 | Newsreader | Summaries, the morning line. |
| `--t-title` | 20px / 1.3 | Newsreader | Item titles, block headings. |
| `--t-section` | 27px / 1.2 | Newsreader | Lane titles. |
| `--t-page` | 36px / 1.15 | Newsreader | Masthead wordmark only. |

Rules:

- Sentence case everywhere. **No all-caps labels. No tracked-out eyebrows.** Letter-spacing is 0.
- Emphasis is structural: a title is a title because of size, family, and position. **Never bold or italicise a single word inside a sentence.** Italics exist only for a source's own quoted dek, if ever.
- Numbers that get compared (temperatures, scores, times, counts) use `font-variant-numeric: tabular-nums` in Plex. **Monospace is not used as decoration** — if a value is tabular, it is tabular in the sans.
- Meta strings read as prose: "CBC News, 4 hours ago". Commas, never middle dots. Button labels state their destination in words; **no arrows appended to labels**.
- Body measure: summaries cap at ~68 characters; one-line summaries are 25 words maximum and clamp to two lines.

---

## 3. Space, radius, hairlines

Straight from `anti-ai-design-decisions.md`, no additions:

- **Spacing: 4 · 8 · 12 · 20 · 32 · 48 · 72 px.** Nothing else. 4px within a text group (title to summary), 8px (summary to meta), 12px (control internals), 20px (between items), 32px (lane internals, header to first content), 48px (between lanes and column gutters), 72px (page margins and the top of the page).
- **Radius: 0 by default.** 4px for buttons and inputs. 999px only for pills: tags and toggles. Content never sits in a rounded box.
- **Hairlines: 1px `--line`, one edge only.** Lane separation is a top hairline on each lane. Tables get a top hairline per row. Never a full boxed border around content. The one exception: interactive *controls* (a toggle pill, an input) may carry a full 1px `rgba(237,232,222,0.16)` border, because that is an affordance, not decoration — and it is never used to wrap content.
- **No shadows. No glows.** Depth is tone and whitespace only.

---

## 4. Layout

Desktop-first; the page degrades gracefully narrower but is not designed there first.

- Page: `max-width` 1240px, 72px outer margins, canvas behind everything.
- Masthead: wordmark left ("Detox" with a full stop set in gold), date and refresh status right, in `--t-meta`. A single hairline under it.
- Digest band: the morning line (Newsreader, `--t-body`, measure 68ch) on the left; the transparency line and a Refresh control on the right.
- Body: a three-track grid — two news columns and a 340px rail — with 48px gutters. News lanes stack in the left tracks; the rail holds weather, Raptors, coming up, and Reddit.
- **No cards.** A lane is: top hairline, 20px, lane title, optional 12px context line, then items. Lanes differ in rhythm and content, not in box styling. If a section feels like it needs a box, it needs better whitespace instead.
- Alignment is strictly left. Nothing is centred except values inside table columns where comparison demands it. There is no hero.
- Breakpoints: below 1100px the rail drops under the news columns; below 720px lanes stack single-column. (Mobile is functional, not designed-for.)

---

## 5. Components

**Lane.** As above. Lane title in `--t-section`; context line in `--t-small` `--ink-faint` ("Selected 4 of 61 items.").

**Item.** Title (`--t-title`, `--ink`, link) → summary (`--t-body`, `--ink-muted`) → meta (`--t-meta`, `--ink-faint`: "Reuters, 2 hours ago"). 4px/8px internal spacing, 20px between items. Hover: title turns `--accent` and gains a 1px gold underline at 3px offset. **No lift, no background change, no movement.**

**Data table** (weather, injuries). Column heads in `--t-small` `--ink-muted`; row labels left, values tabular-nums; a `--line` top hairline per row; no vertical rules, no zebra striping. The consensus row states its label in `--accent` and its values in `--accent` — the answer gets the gold.

**Tag / toggle pill.** 999px radius, 4px/8px padding, `--t-meta`, `--ink-muted`, 1px `rgba(237,232,222,0.16)` border. Toggle "on" state: gold text, gold border. Used for content tags ("spaceflight") and the discarded-items toggle. Nothing else is a pill.

**Button.** 4px radius, 12px/20px padding, `--t-small`. Primary: `--accent` fill with `--accent-ink` text. Secondary: plain `--ink-muted` text that turns `--ink` with an underline on hover. No icons in buttons; the label says what it does ("Refresh", "Show discarded items").

**Status line.** `--t-meta` `--ink-faint`, no spinner, no animation. "Updated 7:02 this morning." "Refreshing. Showing data from 7:02 yesterday." A stale source names itself: "Weather from 8:02 yesterday, Environment Canada did not respond."

**Sparkline** (weather strip, optional). Inline SVG, 1.5px stroke in `--ink-faint`, the "today" point a 3px gold dot. No axes, no grid, no chart library.

---

## 6. Motion

Almost none. The page is fully painted on load with no entrance animation of any kind — sections do not fade, slide, or stagger.

- Allowed: colour and underline transitions on hover and focus, 120ms, `ease-out`.
- Not allowed: transforms on hover (no lift), scroll-triggered anything, animated counters, shimmer skeletons.
- Content updates after a refresh swap in place; if a value changes, it simply changes.
- `prefers-reduced-motion` already has nothing to disable. Keep it that way.

---

## 7. Focus and accessibility

- Keyboard focus: `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible` only. It is a focus ring, not a glow, and it is never removed.
- Contrast floors: 4.5:1 for body and meta text, 3:1 for large text and controls. The palette table above records verified ratios; any new colour must record its ratio here.
- Colour never carries meaning alone: "out" is a word first and red second.
- Links are distinguishable by more than colour in body prose (underline on hover at minimum; item titles are links in context of a list with meta beneath).
- Semantic HTML: real headings per lane, real `<table>` for tabular data, real `<time>` elements for timestamps.

---

## 8. Voice of written and generated text

Applies equally to hand-written UI copy and LLM output. LLM output that violates this is a bug in the prompt.

- Sentence case, plain words, no marketing cadence.
- One-line summaries: ≤ 25 words, name the source of the claim, state uncertainty plainly ("Sources disagree on snowfall totals"). No throat-clearing openers, no "In a significant development".
- No rhetorical questions, no second person hype, no emoji.
- Attribution is mandatory: every summary traces to an outlet, every claim in the morning line traces to a lane item.
- Rationales ("why this is here") are factual and short: "Matches your infrastructure keywords; covered by three outlets."

---

## 9. Do and don't

| Do | Don't |
|---|---|
| Separate lanes with a top hairline and 48px of space. | Wrap a section in a bordered, rounded, shadowed card. |
| Set titles in Newsreader at real sizes. | Use a tracked-out all-caps eyebrow over a heading. |
| Write meta as prose: "The Verge, 4 hours ago". | Write meta as "The Verge · 4h · 12 comments". |
| Use gold for the consensus answer and the focused control. | Use gold as a background wash or a gradient. |
| Keep tabular figures aligned in Plex. | Set small labels in monospace to look technical. |
| Let hover change colour and underline. | Lift cards on hover, fade sections in. |
| Say "Refresh" and "Show discarded items". | Say "Explore →" or "Learn more →". |
| Clamp lane output to 3–5 strong items. | Fill the lane because the data exists. |

---

## 10. Project review checklist

Apply the anti-AI checklist (§6 of that document) first, then these:

- [ ] Does every colour used appear in §1 with a stated job?
- [ ] Are both type families used for their declared roles (content voice vs machinery)?
- [ ] Do all sizes come from the type scale and all spacing from 4/8/12/20/32/48/72?
- [ ] Are radii only 0, 4px, or 999px, and pills only for tags and toggles?
- [ ] Is any hairline on more than one edge of the same object?
- [ ] Does hover change only colour and underline, within 120ms?
- [ ] Is every claim in generated text attributed to a named outlet?
- [ ] Does each lane still hold 3–5 items?
- [ ] Is the transparency line (shown / collected / cost) present and honest?

`style-preview.html` is the reference implementation of this guide; when the two disagree, fix one of them deliberately and say which in the commit.
