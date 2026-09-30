# Anti-AI Design Decisions

> **This is not a style guide.** It does not tell you what your design should look like. It is a list of things *not* to do: the defaults, tics, and templates that make an interface read as machine-generated. Avoiding them won't make a design good. It only removes the most recognizable failure modes.
>
> A real style guide (your own brand system, or an established one) is strongly recommended alongside this document. Use this as a filter applied after those decisions are made, and as a reminder when changes start drifting back toward the defaults.

---

## 1. The core goal

Avoid AI-like design decisions wherever possible. The tells are almost never one single choice. They are a *cluster* of safe, smooth, symmetrical defaults that appear together: a safe sans-serif, a vivid gradient, a row of identical rounded cards with soft shadows, a big centred hero with two buttons.

When in doubt, pick the choice that required a decision over the choice that required none.

---

## 2. Explicitly banned

These are off the table by default.

| Banned | Why it reads as AI |
|---|---|
| Safe/default sans-serif as the main voice (Inter, Roboto, Open Sans, `system-ui` used as a *design choice*) | It is the path of least resistance. Using it signals that no typographic decision was made. |
| Vivid or multi-stop gradients | Shorthand for "modern" with no underlying idea. |
| Uniform "bento-box" grid cards | Every section becomes the same box with the same padding. Hierarchy disappears. |
| Soft box shadows | The generic depth cue applied to everything. |
| Glowing drop shadows | Same problem, louder. |
| Oversized rounded corners (the 12–16px "SaaS card" radius) | Friendly by default, distinctive never. |
| Big centred marketing "hero" sections with a CTA button pair | The template of every generated landing page. |

Note on typefaces: a system font stack is fine as a *fallback*. The ban is on treating it as the intentional voice of the design.

---

## 3. Typographic tics to avoid

These small habits are among the most reliable tells.

- **All-caps labels**
- **Tracked-out eyebrow text above headings** (the small letter-spaced line sitting over an `h1` or `h2`)
- **Bolding or italicizing a single word inside a sentence for "punch"**
- **Middle-dot separated meta strings** (`A · B · C`)
- **Arrows appended to button labels** (`View →`)
- **Monospace for small data labels** used purely as a "technical" garnish

If a heading needs context, put it in the heading or in a normal sentence beneath it. If a button needs to say where it goes, the label should say so in words.

---

## 4. Constraints instead of defaults

Bans alone leave a vacuum, and the vacuum gets filled with the defaults again. These constraints replace them.

### Spacing scale

```
4 · 8 · 12 · 20 · 32 · 48 · 72 px
```

Nothing outside this scale. No 16, 24, 40, or 64 just because they feel round.

### Radius scale

| Value | Use |
|---|---|
| `0` | Default. Most things have square corners. |
| `4px` | Small interactive elements. |
| `999px` | Pills only: toggle switches, tags. |

Nothing gets an arbitrary 12–16px "SaaS card" radius.

### Structure: no card grid

Content lives directly on the canvas, separated by **whitespace and tone**, not by boxes with borders and shadows around every section.

### Hairlines

Use rarely, and only where genuinely useful:

- Color: `--ink` at 8% opacity
- Weight: 1px
- Only on **one edge**. Never a full boxed border.

---

## 5. Drift watch-list

Keep this list visible so future changes don't drift back toward it. These are the recurring AI-design compositions to check against in every review.

1. **Warm cream background + high-contrast serif headline + terracotta accent** (`#D97757`-adjacent). This is now its own cliché. This guide deliberately favors a cooler grey canvas and gold instead of clay/terracotta.
2. **Near-black background with one neon accent.**
3. **Identical rounded cards, all with the same soft grey shadow.**
4. **Tracked-out ALL-CAPS eyebrows, middle-dot meta strings, `→` on every button, monospace for small data labels.**
5. **Fade-and-slide-up entrance on every section, hover-lift on every card.**

Notice that #1 is the "anti-default" look that has itself become a default. Avoiding one template by adopting the *other* popular template is not a decision either.

---

## 6. Review checklist

Before shipping a change, ask:

- [ ] Is the typeface a deliberate choice, or just the safe one?
- [ ] Is there any gradient? If so, does it exist for a reason beyond looking "modern"?
- [ ] Are there boxes around content that whitespace and tone could separate?
- [ ] Do all corner radii come from the scale (`0`, `4px`, `999px`)?
- [ ] Do all spacing values come from the scale (4, 8, 12, 20, 32, 48, 72)?
- [ ] Is there any shadow or glow?
- [ ] Are there eyebrows, all-caps labels, middle-dot strings, or `→` on buttons?
- [ ] Is a single word bolded or italicized mid-sentence for emphasis?
- [ ] Is the top of the page a centred hero with two buttons?
- [ ] Does the palette match any of the five drift patterns above?
- [ ] Does every section animate in the same way? Does every card lift on hover?

If several of these come back "yes, this is present," the design is drifting.

---

## 7. What this document is not

- It is **not** a positive design system. It says nothing about which typeface, palette, or layout you *should* use.
- It is **not** a guarantee of quality. A design can avoid every item here and still be poor.
- It is **not** permanent. As these patterns get avoided, new defaults will emerge. Update the watch-list when they do.

Pair it with a proper style guide.
