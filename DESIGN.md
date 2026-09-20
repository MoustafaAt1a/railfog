---
version: alpha
name: RailFog
description: "Design system for the RailFog marketing site and docs. RailFog is a minimal application-infrastructure platform: Functions, KV, Objects and Queues on one runtime. Rails draw the contract, porous dither fog stands for the infrastructure it absorbs, and one green lamp marks what is live."
colors:
  primary: "#0B2340"      # Ink. Enamel blue, not near-black.
  ink-soft: "#16335C"     # Ink hover fill, raised panel on ink
  paper: "#F7F9FA"        # Lit surface, text on ink
  canvas: "#EBF0F3"       # Page background
  mist: "#DFE6EB"         # Tinted cells, inline code, neutral badges
  line: "#C9D3DB"         # Hairlines, ruler ticks
  haze: "#B4C2CD"         # Rails, fog dots
  steel: "#6C8194"        # Perceivable component boundaries, junction marks
  slate: "#3D5266"        # Body copy, nav links
  mute: "#4E6274"         # Metadata, captions, comments, placeholders
  lamp: "#0FB88E"         # Signal green, the "clear" aspect. Fills and markers.
  lamp-press: "#0A9E7A"   # Pressed lamp fill
  lamp-deep: "#0A6B50"    # Text-safe green
  lamp-tint: "#C6F0E0"    # Highlight background
  ink-line: "#2C4A75"     # Rules and fog dots on ink
  on-ink-mute: "#9FB3C8"  # Secondary text on ink
  stop: "#B3261E"         # Failed, error, destructive
  stop-tint: "#FBE4E1"
  caution: "#8A5300"      # Suspended, degraded. Status text only.
  caution-tint: "#FFF0C7"
typography:
  display-xl:
    fontFamily: Archivo
    fontSize: 84px
    fontWeight: 700
    lineHeight: 0.96
    letterSpacing: -0.035em
    fontVariation: "'wdth' 82"
  display-lg:
    fontFamily: Archivo
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: -0.03em
    fontVariation: "'wdth' 84"
  heading-xl:
    fontFamily: Archivo
    fontSize: 46px
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: -0.025em
    fontVariation: "'wdth' 86"
  heading-lg:
    fontFamily: Archivo
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: -0.02em
    fontVariation: "'wdth' 92"
  heading-md:
    fontFamily: Archivo
    fontSize: 21px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.01em
    fontVariation: "'wdth' 100"
  heading-sm:
    fontFamily: Archivo
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.005em
    fontVariation: "'wdth' 100"
  body-lg:
    fontFamily: Archivo
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0em
    fontVariation: "'wdth' 100"
  body-md:
    fontFamily: Archivo
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0em
    fontVariation: "'wdth' 100"
  body-sm:
    fontFamily: Archivo
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0em
    fontVariation: "'wdth' 100"
  label-lg:
    fontFamily: Archivo
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.005em
    fontVariation: "'wdth' 100"
  label-md:
    fontFamily: Archivo
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0em
    fontVariation: "'wdth' 100"
  label-sm:
    fontFamily: Archivo
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.01em
    fontVariation: "'wdth' 100"
  caption:
    fontFamily: Archivo
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0.005em
    fontVariation: "'wdth' 100"
  code-md:
    fontFamily: "IBM Plex Mono"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: 0em
  code-sm:
    fontFamily: "IBM Plex Mono"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0em
  wordmark:
    fontFamily: Archivo
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: -0.02em
    fontVariation: "'wdth' 100"
rounded:
  none: 0px
  sm: 2px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  xxxl: 48px
  jumbo: 64px
  section: 96px
  track: 1120px
  track-pad: 48px
  gutter: 24px
  columns: 12
  tick: 8px
  control: 44px
components:
  nav:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.slate}"
    typography: "{typography.label-md}"
    height: 64px
    padding: 0 48px
  nav-link-active:
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
  wordmark:
    textColor: "{colors.primary}"
    typography: "{typography.wordmark}"
  button-lamp:
    backgroundColor: "{colors.lamp}"
    textColor: "{colors.primary}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.sm}"
    height: 44px
    padding: 0 18px
  button-lamp-pressed:
    backgroundColor: "{colors.lamp-press}"
    textColor: "{colors.primary}"
  button-ink:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.sm}"
    height: 44px
    padding: 0 18px
  button-ink-hover:
    backgroundColor: "{colors.ink-soft}"
    textColor: "{colors.paper}"
  button-disabled:
    backgroundColor: "{colors.mist}"
    textColor: "{colors.mute}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.sm}"
    height: 44px
    padding: 0 18px
  link-inline:
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
  link-inline-hover:
    textColor: "{colors.lamp-deep}"
  hero-headline:
    textColor: "{colors.primary}"
    typography: "{typography.display-xl}"
  section-headline:
    textColor: "{colors.primary}"
    typography: "{typography.heading-xl}"
  text-lede:
    textColor: "{colors.slate}"
    typography: "{typography.body-lg}"
  text-body:
    textColor: "{colors.slate}"
    typography: "{typography.body-md}"
  text-meta:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.mute}"
    typography: "{typography.caption}"
  rail:
    backgroundColor: "{colors.haze}"
    width: 1px
  hairline:
    backgroundColor: "{colors.line}"
    height: 1px
  hairline-strong:
    backgroundColor: "{colors.steel}"
    height: 1px
  fog-cell:
    backgroundColor: "{colors.haze}"
    size: 2px
  fog-cell-on-ink:
    backgroundColor: "{colors.ink-line}"
    size: 2px
  hero-fog-panel:
    backgroundColor: "{colors.canvas}"
    height: 400px
  code-block:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    typography: "{typography.code-md}"
    padding: 16px 18px
  code-inline:
    backgroundColor: "{colors.mist}"
    textColor: "{colors.primary}"
    typography: "{typography.code-sm}"
    rounded: "{rounded.sm}"
    padding: 2px 6px
  code-mark:
    backgroundColor: "{colors.lamp-tint}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: 0 2px
  command-chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    typography: "{typography.code-md}"
    rounded: "{rounded.sm}"
    height: 44px
    padding: 0 6px 0 14px
  command-chip-on-ink:
    backgroundColor: "{colors.ink-soft}"
    textColor: "{colors.paper}"
    typography: "{typography.code-md}"
    rounded: "{rounded.sm}"
    height: 44px
    padding: 0 6px 0 14px
  route-node:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    height: 40px
    width: 120px
  route-node-current:
    backgroundColor: "{colors.lamp}"
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    height: 40px
    width: 144px
  route-rail:
    backgroundColor: "{colors.primary}"
    height: 2px
  layer-plate:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: 4px 8px
  layer-row:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
    height: 56px
  marker-solid:
    backgroundColor: "{colors.primary}"
    size: 14px
  marker-current:
    backgroundColor: "{colors.lamp}"
    size: 14px
  marker-hollow:
    backgroundColor: "{colors.paper}"
    size: 14px
  step-row:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.primary}"
    typography: "{typography.heading-md}"
    padding: 24px 0
  cell:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.slate}"
    typography: "{typography.body-md}"
    padding: 32px
  cell-tint:
    backgroundColor: "{colors.mist}"
    textColor: "{colors.slate}"
    typography: "{typography.body-md}"
    padding: 32px
  cell-title:
    textColor: "{colors.primary}"
    typography: "{typography.heading-lg}"
  guarantee-term:
    textColor: "{colors.primary}"
    typography: "{typography.display-lg}"
  contract-table-head:
    backgroundColor: "{colors.mist}"
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
    padding: 12px 16px
  contract-table-row:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.slate}"
    typography: "{typography.body-sm}"
    padding: 12px 16px
  faq-row:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.primary}"
    typography: "{typography.heading-sm}"
    padding: 20px 0
  faq-toggle:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    size: 28px
  faq-toggle-open:
    backgroundColor: "{colors.lamp}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    size: 28px
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    height: 44px
    padding: 0 14px
  input-error:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.stop}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    height: 44px
    padding: 0 14px
  badge-neutral:
    backgroundColor: "{colors.mist}"
    textColor: "{colors.slate}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: 4px 8px
  badge-active:
    backgroundColor: "{colors.lamp-tint}"
    textColor: "{colors.lamp-deep}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: 4px 8px
  badge-caution:
    backgroundColor: "{colors.caution-tint}"
    textColor: "{colors.caution}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: 4px 8px
  badge-stop:
    backgroundColor: "{colors.stop-tint}"
    textColor: "{colors.stop}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: 4px 8px
  closing-band:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    typography: "{typography.heading-xl}"
    padding: 96px 48px
  closing-band-meta:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-ink-mute}"
    typography: "{typography.body-lg}"
  footer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.slate}"
    typography: "{typography.body-sm}"
    padding: 48px
---

# RailFog Design System

## Overview

RailFog is a minimal application-infrastructure platform. It gives a developer four composable primitives on one runtime: **Functions** run code, **KV** holds small state, **Objects** hold large data, and **Queues** move work asynchronously. It runs on proven infrastructure and does not try to become a cloud provider. Its promise is that it hides infrastructure complexity without hiding infrastructure behavior.

This system covers the marketing site and the docs. The audience is developers who distrust marketing. The site has one job: get a developer from the first screen to `rail init` in under a minute, with every guarantee stated precisely enough to check.

The identity is built from the name and the promise.

| Device | Stands for | Rules |
| --- | --- | --- |
| Rails | The contract: the four primitives, the one path from trigger to Function to primitive, and the guarantees. | Drawn sharp. 1px frame rails, 2px route rails, squares, exact labels, right angles only. Nothing on a rail is ever obscured. |
| Fog | The infrastructure RailFog absorbs: providers, sandboxes, schedulers, the pile of config files. | Porous ordered dither in one pale color. It sits behind and beneath the contract, never in front of text, and never hides a guarantee, a limit or a price. |
| Lamp | What is live: the active revision, the event in flight, the one primary action. | One green, the railway's "clear" aspect. A solid square marker or a single fill. At most one lamp fill per viewport. |

**The rule is sharp above, fog below.** Whatever a developer touches or depends on is drawn crisp. Whatever RailFog handles for them is drawn as fog, and the fog stays porous so the layer underneath is still visible to anyone who looks.

**Small on purpose.** The brand follows the engineering philosophy: small primitives, clear contracts, strong composition, minimal machinery. In design terms that means two type families (one only for code), two radii, three marker states, three lamp aspects, and no effect that the product does not have. The site should feel smaller than its competitors. That is the advantage.

**Lineage.** The palette and the signage-first type take cues from railway wayfinding and signal-lamp convention: clear, caution, stop. Signal glass for the clear aspect has historically leaned slightly bluish, which is why the lamp sits at a bluish green.

**Brand proximity.** RailFog launches on Cloudflare, is Deno-first, and shares a name stem with Railway. To avoid reading as any of them: no orange or yellow accents, no violet or indigo, no light mint, and no train or locomotive imagery.

**Reading this file.** Names in braces, such as `{colors.lamp}`, point to the front matter, which holds the normative values. The prose says why and when. Rules are phrased so they can be checked; the Slop audit lists the checks and the Implementation snippets include a script that runs the mechanical ones.

## Colors

The palette is one blue hue at several visibilities, one green lamp, and two status colors. Every neutral is tinted, so pure gray, pure black and pure white appear nowhere. Ink (`{colors.primary}`) is a deep enamel blue rather than a near-black.

### Fog and structure

| Token | Hex | Role |
| --- | --- | --- |
| `{colors.canvas}` | `#EBF0F3` | Page background. The only page-level background. |
| `{colors.paper}` | `#F7F9FA` | Lit surfaces: code, inputs, route nodes, command chips, text on ink. |
| `{colors.mist}` | `#DFE6EB` | Tinted cells, inline code, table heads, neutral badges, disabled fills. |
| `{colors.line}` | `#C9D3DB` | Hairlines between rows and sections, short ruler ticks. |
| `{colors.haze}` | `#B4C2CD` | Frame rails, long ruler ticks, fog dots. |
| `{colors.steel}` | `#6C8194` | Boundaries that must be perceivable: input, chip and node outlines, junction marks, hollow markers. 3.5:1 on canvas, 3.8:1 on paper. |

### Ink and text

| Token | Hex | Role |
| --- | --- | --- |
| `{colors.primary}` | `#0B2340` | Ink. Headlines, primary text, ink button fill, route rails, focus outline, the closing band. |
| `{colors.ink-soft}` | `#16335C` | Hover fill for ink buttons, command chip on ink. |
| `{colors.slate}` | `#3D5266` | Body copy, lede, nav links. |
| `{colors.mute}` | `#4E6274` | Captions, code comments, placeholders, disabled text. |

### Lamp and status

A railway signal head shows one of three aspects. RailFog does the same. **Clear** (the lamp, green) means live, healthy or done, and it is also the brand's resting color. **Caution** (amber) means suspended or degraded. **Stop** (red) means failed or destructive. Caution and stop appear only as status, never as accents.

| Token | Hex | Role |
| --- | --- | --- |
| `{colors.lamp}` | `#0FB88E` | Clear. Solid fills and markers, always paired with ink. Never text or a lone icon on a light surface (2.2:1 on canvas). |
| `{colors.lamp-press}` | `#0A9E7A` | Pressed and hover state of a lamp fill. |
| `{colors.lamp-deep}` | `#0A6B50` | Text-safe green: link hover, active badge text, `ok` in terminal output. 5.7:1 on canvas. |
| `{colors.lamp-tint}` | `#C6F0E0` | Highlight: active badge background and the code mark. |
| `{colors.caution}` on `{colors.caution-tint}` | `#8A5300` on `#FFF0C7` | Suspended, degraded. 5.6:1. Status text only. |
| `{colors.stop}` on `{colors.stop-tint}` | `#B3261E` on `#FBE4E1` | Failed, error, destructive confirmation. 5.4:1. |

Status maps to the resource lifecycle as follows.

| Lifecycle state | Treatment |
| --- | --- |
| Created, Building, Ready, Deployed | `{components.badge-neutral}` |
| Active, healthy, passed | `{components.badge-active}` |
| Suspended, degraded | `{components.badge-caution}` |
| Failed | `{components.badge-stop}` |

### On ink

| Token | Hex | Role |
| --- | --- | --- |
| `{colors.ink-line}` | `#2C4A75` | Rules and fog dots on the closing band. |
| `{colors.on-ink-mute}` | `#9FB3C8` | Secondary text on ink, 7.3:1 on `{colors.primary}`. Primary text on ink is `{colors.paper}`. |

### Contrast reference

| Pair | Ratio | Use |
| --- | --- | --- |
| `{colors.primary}` on `{colors.canvas}` | 13.8:1 | Headlines |
| `{colors.slate}` on `{colors.canvas}` | 7.0:1 | Body |
| `{colors.mute}` on `{colors.canvas}` / `{colors.mist}` | 5.5:1 / 5.0:1 | Metadata, comments |
| `{colors.primary}` on `{colors.lamp}` | 6.2:1 | Lamp buttons and current route node |
| `{colors.primary}` on `{colors.lamp-press}` | 4.7:1 | Pressed lamp button |
| `{colors.paper}` on `{colors.primary}` | 15.0:1 | Text on ink |
| `{colors.on-ink-mute}` on `{colors.primary}` | 7.3:1 | Secondary text on ink |

### Color rules

- One lamp fill per viewport (a button or the current route node), plus small markers. If two things are green, neither is the signal.
- Amber and red are status only. They never fill a button, a marker or a decoration.
- No purple, violet or indigo, in any tint. No orange or yellow accent. No light mint.
- No gradients of any kind. Depth comes from the four surface levels and from fog.
- Text sits on `{colors.canvas}`, `{colors.paper}`, `{colors.mist}` or `{colors.primary}` only. Never on light fog above 8% density. On ink, the low-contrast fog may sit under text.
- One theme ships: light. The closing band is the only dark surface, used once per page. A dark theme is a planned extension (see Known gaps).

## Typography

Two families, with strict jobs.

**Archivo** carries every text role except code. It is a variable grotesque with a width axis (wdth 62 to 125) and a weight axis (wght 100 to 900), open-licensed (OFL), available from Google Fonts and as `@fontsource-variable/archivo` (family name `Archivo Variable`). The width axis gives two voices from one file: sizes from 30px up are set condensed (wdth 76 to 92), which gives headlines the strength of a platform sign, and everything at 21px and below is set at normal width (wdth 100) for reading. It ships tabular figures (`tnum`).

**IBM Plex Mono** carries code only: code blocks, terminal output, command chips, inline code, and identifiers such as request IDs and hashes. It is open-licensed (OFL) and available as `@fontsource/ibm-plex-mono`. It was chosen over other monospaced candidates for its dotted zero and distinct `1`, `l` and `I`, which matter when a reader copies `rf_req_01J8Z` or a `sha256` value. Ligatures stay off so the page shows exactly what a person types.

Mono is never used for labels, navigation, eyebrows, badges or decoration.

### Scale

| Token | Size / line | Weight | Width | Tracking | Use |
| --- | --- | --- | --- | --- | --- |
| `{typography.display-xl}` | 84 / 0.96 | 700 | 82 | -0.035em | Hero headline. One per page. |
| `{typography.display-lg}` | 64 / 1.0 | 700 | 84 | -0.03em | Guarantee terms. |
| `{typography.heading-xl}` | 46 / 1.05 | 700 | 86 | -0.025em | Section headlines, closing band. |
| `{typography.heading-lg}` | 30 / 1.15 | 700 | 92 | -0.02em | Primitive names in cells. |
| `{typography.heading-md}` | 21 / 1.25 | 600 | 100 | -0.01em | Step titles. |
| `{typography.heading-sm}` | 18 / 1.3 | 600 | 100 | -0.005em | Question rows. |
| `{typography.body-lg}` | 19 / 1.55 | 400 | 100 | 0 | Lede under the hero headline. |
| `{typography.body-md}` | 16 / 1.6 | 400 | 100 | 0 | Default text. |
| `{typography.body-sm}` | 14 / 1.5 | 400 | 100 | 0 | Footer, table rows. |
| `{typography.label-lg}` | 15 / 1.2 | 600 | 100 | 0.005em | Buttons. |
| `{typography.label-md}` | 14 / 1.2 | 500 | 100 | 0 | Nav links, tabs, route nodes. |
| `{typography.label-sm}` | 13 / 1.2 | 500 | 100 | 0.01em | Badges, provider plates. |
| `{typography.caption}` | 13 / 1.45 | 400 | 100 | 0.005em | Figure captions, source lines. |
| `{typography.code-md}` | 14 / 1.65 | 400 | n/a | 0 | Code blocks, command chips. |
| `{typography.code-sm}` | 13 / 1.6 | 400 | n/a | 0 | Inline code, code inside cells. |
| `{typography.wordmark}` | 22 / 1 | 700 | 100 | -0.02em | Nav and footer wordmark. |

### Rules

- Sentence case everywhere. No all-caps labels, no letterspaced eyebrows, no italics.
- Headlines are one color and one weight. Never emphasize a single word by color, italic or bold.
- Measure: body copy stops at 66 characters. Section headlines run at most two lines at full track width. Code samples stay within 72 columns and never wrap; they scroll.
- Working weights are 400, 500, 600 and 700. No screen needs all four.
- Display sizes have tight leading. Give a headline `padding-bottom: 0.08em` so descenders are not clipped.
- Tables and version numbers use `font-feature-settings: 'tnum' 1`.
- Syntax uses tokens already in the palette, and nothing else: comments `{colors.mute}`, keywords weight 600, strings `{colors.lamp-deep}`, everything else `{colors.primary}`. RailFog API identifiers (`kv.set`, `queue.send`, `objects.put` and configuration table names) get the code mark: `{colors.lamp-tint}` background and weight 600. The mark shows how little of any program is RailFog. There is no rainbow syntax theme.
- In terminal samples the prompt `$` is `{colors.mute}`, commands are `{colors.primary}`, status words such as `ok` are `{colors.lamp-deep}`, and errors are `{colors.stop}`.
- Fallback stacks: `"Archivo Variable", Archivo, "Helvetica Neue", Arial, sans-serif` and `"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace`. Fallback faces have no width axis, so drop `{typography.display-xl}` to 72px when Archivo has not loaded.

## Layout

### The track

Content lives in a **track**: a column 1120px wide (`{spacing.track}`) between two 1px rails (`{components.rail}`), centered. Inside the rails, 48px of horizontal padding (`{spacing.track-pad}`) leaves a 1024px content width on a 12-column grid with 24px gutters (`{spacing.gutter}`). A column is about 63px.

Outside the rails the gutters flex to fill the viewport, at least 40px wide at 1200px and up. Each gutter carries a **ruler**: an 8px tick every 8px (`{spacing.tick}`) hanging off the rail in `{colors.line}`, and a 20px tick every 64px in `{colors.haze}`. The ruler is a CSS background tile marked `aria-hidden`. It is the only texture on the page besides fog, and it never carries information.

Sections are divided by a 1px hairline (`{components.hairline}`) that runs the full viewport width across the rails. Where it crosses each rail, a 9px `+` in `{colors.steel}` marks the junction. There are no gap bands and no double rules.

Vertical rhythm is 96px (`{spacing.section}`) of padding above and below every section on desktop. Inside a section, spacing comes from the scale below.

### Section head

Every section opens with the same head: the headline (`{components.section-headline}`) in columns 1 to 7, a short intro in columns 9 to 12 aligned to the headline's last baseline, and 56px of space below. There is no eyebrow above the headline. Body text uses `{components.text-body}`. Headlines, paragraphs and cells are left-aligned; nothing is center-aligned except a short label set under a marker, as in the roadmap.

### Page sequence

| # | Section | Layout | Notes |
| --- | --- | --- | --- |
| 1 | Navigation | 64px bar inside the track | Wordmark left, links right, one ink button. |
| 2 | Hero | Headline in columns 1 to 8. Lede, one lamp button and one command chip in columns 9 to 12. Fog panel with the code sheet below. | The only `{typography.display-xl}` on the page. |
| 3 | Commands | Three step rows, each with a terminal sample | `init`, `dev`, `deploy`. The only numbered content. |
| 4 | Primitives | 2×2 cells with checkerboard tint | Functions, KV, Objects, Queues. |
| 5 | Model | Route diagram, then the substrate band | Trigger, Router, Function, primitives, then providers in fog. |
| 6 | Guarantees | Staggered bento, 7/5 then 5/7 | Four plain-language guarantees. |
| 7 | Isolation | Six layer rows | Marked "Design target" until shipped. |
| 8 | Scope and roadmap | Scope list left, roadmap line right | What RailFog is not, and where the release stands. |
| 9 | Closing band | Ink surface, sparse fog | Once per page. |
| 10 | Footer | Wordmark, one sentence, two link columns | Stays on canvas so the closing band is the only dark surface. |

Optional, only when true: a "Built on" strip after the hero naming the open technologies RailFog uses (text names in `{colors.mute}`, no logos), and a Questions section of `{components.faq-row}` rows before the closing band.

### Cells

Cells share 1px `{colors.line}` borders with no gaps, no radius and no shadow. Padding is 32px (`{spacing.xxl}`), 24px 16px below 480px. Tint alternates only in grids, always as a checkerboard so no two tinted cells touch on a side.

### Spacing scale

Spacing follows a 4px base. Use only these values.

| Token | Value | Use |
| --- | --- | --- |
| `{spacing.xs}` | 4px | Badge vertical padding, tight gaps |
| `{spacing.sm}` | 8px | Button-group gap, ruler pitch, list marker gap |
| `{spacing.md}` | 12px | Stacked action gap, nav link gap, list row padding |
| `{spacing.lg}` | 16px | Code padding, small internal gaps |
| `{spacing.xl}` | 24px | Grid gutter, step-row padding, vertical route rails |
| `{spacing.xxl}` | 32px | Cell padding |
| `{spacing.xxxl}` | 48px | Track padding, band and footer padding |
| `{spacing.jumbo}` | 64px | Section padding on tablet, large internal breaks |
| `{spacing.section}` | 96px | Section padding on desktop |
| `{spacing.columns}` | 12 | Grid column count |
| `{spacing.control}` | 44px | Minimum height of any control |

## Elevation & Depth

Nothing casts a shadow. Hierarchy comes from four surface levels and from fog.

| Level | Treatment | Use |
| --- | --- | --- |
| 0 Flat | `{colors.canvas}`, no border | Page, rows |
| 1 Tint | `{colors.mist}` fill, hairline edges | Tinted cells, inline code, table heads |
| 2 Lit | `{colors.paper}` fill with a 1px `{colors.steel}` or `{colors.line}` outline | Code sheet, route nodes, chips, inputs |
| 3 Ink | `{colors.primary}` fill | Closing band |

**Fog is the depth cue.** The provider layer underneath the contract is fog. Nothing else is. Fog never sits in front of text and never covers a rail, a label, a limit or a guarantee.

**Focus** is a 2px solid `{colors.primary}` outline with a 2px offset (`{colors.paper}` on ink surfaces). No glow, no ring shadow. The stylesheet contains no `box-shadow`.

## Shapes

The shape language is orthogonal, flat and ruled, softened only where a person touches the interface.

| Token | Value | Use |
| --- | --- | --- |
| `{rounded.none}` | 0px | Every container: cells, sheets, code blocks, bands, images, rails |
| `{rounded.sm}` | 2px | Interactive plates: buttons, inputs, chips, toggles, badges, route nodes, plates |

There are two radii and nothing is a pill or a circle. The lamp is always a square.

### Markers

One square vocabulary carries state everywhere: diagrams, lists, roadmap, isolation stack.

| Marker | Look | Means |
| --- | --- | --- |
| `{components.marker-solid}` | 14px ink square | Done, included, controlled, in scope |
| `{components.marker-current}` | 14px lamp square with a 2px ink outline | Live, active, event in flight, current stage |
| `{components.marker-hollow}` | 14px paper square with a 2px `{colors.steel}` outline | Not yet, excluded, untrusted, planned |

Inside lists the markers scale to 8px (a 1px outline for hollow). On a light surface the lamp marker always carries its ink outline, because the lamp alone is only 2.2:1 against canvas.

### Mark and wordmark

The mark is a signal at the edge of the fog: a rail runs into a green lamp, and beyond the lamp the line dissolves into dither. It says rails, lamp and fog with one horizontal gesture, and it does not use a train, a track in perspective or any other stock railway pictogram.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24">
  <rect x="0" y="11" width="21" height="2" fill="#0B2340"/>
  <rect x="21" y="8" width="8" height="8" fill="#0FB88E"/>
  <path fill="#B4C2CD" d="M32 4h2v2h-2zM36 4h2v2h-2zM30 6h2v2h-2zM30 8h2v2h-2zM32 8h2v2h-2zM34 8h2v2h-2zM36 8h2v2h-2zM40 8h2v2h-2zM30 10h2v2h-2zM32 10h2v2h-2zM34 10h2v2h-2zM38 10h2v2h-2zM30 12h2v2h-2zM32 12h2v2h-2zM36 12h2v2h-2zM40 12h2v2h-2zM44 12h2v2h-2zM30 14h2v2h-2zM34 14h2v2h-2zM32 16h2v2h-2zM36 16h2v2h-2zM40 16h2v2h-2zM30 18h2v2h-2z"/>
</svg>
```

- **Lockup.** The mark at 52px wide, 12px gap, then the wordmark `{components.wordmark}`: the word RailFog, one color, no two-tone split. Always written RailFog, never "Railfog", "Rail Fog" or all caps.
- **Sizes.** The full mark is at least 48px wide. Below that, use the reduced mark (rail and lamp only, no fog cells), down to 20px wide.
- **Clear space.** Equal to the lamp's width (8 units) on every side.
- **On ink.** The rail becomes `{colors.paper}`, the fog cells become `{colors.ink-line}`, the lamp is unchanged (6.2:1 on ink).
- **App icon.** The reduced mark, inverted, on a `{colors.primary}` square tile.

## Components

Token-backed values live in the front matter. Borders, states and behavior, which the token schema cannot express, are specified here.

### Navigation

`{components.nav}` is 64px tall on `{colors.canvas}` with a full-width 1px `{colors.line}` rule below. It is sticky and opaque, with no blur and no shadow. Inside the track: the mark and wordmark at the left, then links in `{typography.label-md}` and `{colors.slate}`, each with 8px of horizontal padding and a 44px hit height, then one `{components.button-ink}` reading "Read the docs". The current page uses `{components.nav-link-active}`: ink text with a 2px ink underline at a 6px offset. Below 768px the links and button collapse into a text button labelled "Menu" that opens a full-height canvas sheet with the ink button at its top.

### Buttons

All buttons are 44px tall (`{spacing.control}`), 18px horizontal padding, 2px radius, `{typography.label-lg}`. Labels are one to three words, verb first, and name exactly what happens: "Read the quickstart", "Read the docs". No icons and no trailing arrows.

- `{components.button-lamp}` is the primary action. One per viewport.
- `{components.button-ink}` is the default solid button.
- There is no third style. Secondary actions are `{components.link-inline}`.
- Hover moves the fill one step: ink to `{colors.ink-soft}` (`{components.button-ink-hover}`), lamp to `{colors.lamp-press}` (`{components.button-lamp-pressed}`). Pressed looks the same as hover. Transition `background-color` only, 120ms.
- `{components.button-disabled}` has no pointer events and carries `aria-disabled`.

### Links

`{components.link-inline}` is ink text with a 1px ink underline at a 3px offset. Hover changes text and underline to `{colors.lamp-deep}` (`{components.link-inline-hover}`). Links are never blue and never green at rest. Captions and source lines use `{components.text-meta}`.

### Command chip

`{components.command-chip}` is the init and install affordance: 44px tall, paper fill, 1px `{colors.steel}` border, 2px radius, `{typography.code-md}`. It shows a `$` in `{colors.mute}`, the command, and a Copy button at the right end. The button is visibly 32px tall on a `{colors.mist}` fill, and its hit area extends to 44px through padding on a pseudo-element. On click the label swaps to "Copied" for 1.5 seconds with no animation, and the change is announced through `aria-live="polite"`. The copied string is the command alone, without the `$`. On ink, use `{components.command-chip-on-ink}` with a 1px `{colors.ink-line}` border.

### Code block and terminal

`{components.code-block}` is a paper surface with square corners, `{typography.code-md}`, and 16px 18px of padding. It never wraps and scrolls horizontally. It is always `tabindex="0"` with `role="region"` and an `aria-label` naming the file or command. Inside a cell or row it takes a 1px `{colors.line}` border; inside the hero sheet the sheet's outline is enough. Inline code is `{components.code-inline}`. RailFog API identifiers take `{components.code-mark}`.

The only framing is a filename tab or a `$` prompt. There is no window chrome, no traffic-light dots, no typing animation.

Samples are real. They use only documented API names (`kv.get`, `kv.set`, `kv.delete`, `kv.list`, `objects.put`, `objects.get`, `objects.presign`, `queue.send`, `queue.sendBatch`, the Web `Request` and `Response`), and terminal output must match what the shipped CLI prints. Until the CLI exists, the caption says "Sample output".

### Hero and fog panel

The headline (`{components.hero-headline}`) sits in columns 1 to 8 on plain canvas, 72px below the nav rule. Beside it, in columns 9 to 12 (about 325px), are the lede (`{components.text-lede}`), one `{components.button-lamp}` and one `{components.command-chip}`, stacked with 24px after the lede and 12px between actions, aligned to the headline's last baseline.

Below sits the fog panel (`{components.hero-fog-panel}`): full track width, at least 400px tall, with a 1px `{colors.line}` rule on top. Fog cells (`{components.fog-cell}`) run from about 2% density at the top to about 85% at the bottom (density = min(0.85, y^1.25 + 0.02)).

The **sheet** sits inside the panel. It is inset 96px from each side (24px below 1024px, and stacked and inset 16px below 768px), starts 56px below the panel's top edge, and bleeds off the bottom. It holds two panes side by side: a Function and the `railfog.toml` that declares it, so the first screen shows a complete application in two files. Each pane has a 40px tab bar with the filename in `{typography.label-md}`, a 1px `{colors.line}` divider, and a code block. The sheet has a paper fill and a 1px `{colors.steel}` outline. The panel grows with the sheet, and a pane is only as tall as its code.

### Step row

`{components.step-row}` is a two-column row (5fr and 6fr) separated by 1px `{colors.line}` hairlines, with 24px vertical padding. Left: a step number in `{colors.mute}` with tabular figures in a 32px column, the title in `{typography.heading-md}`, and one sentence in `{typography.body-md}` and `{colors.slate}` indented to the title. Right: a terminal sample in a code block. Below 1024px the columns stack.

Numbers appear here because the content is a real sequence: `rail init`, `rail dev`, `rail deploy`. Nowhere else on the page uses numbered markers. Five rows at most.

### Primitive cell

Four cells in a 2×2 grid, `{components.cell}` and `{components.cell-tint}` in a checkerboard. Each holds, in order: the primitive's plural name in `{components.cell-title}` (Functions, KV, Objects, Queues), one line of role in `{typography.body-md}`, a code block at `{typography.code-sm}` showing the core API in two to four lines with code marks, and a contract line. The contract line is an 8px `{components.marker-solid}` and one sentence in `{typography.label-md}` that states the guarantee exactly. There are no icons. Below 768px the grid is one column.

### Guarantee cell

A staggered bento: row one splits 7/5, row two splits 5/7. The narrower cell in each row is `{components.cell-tint}` and the wider one is `{components.cell}`. Each cell is at least 220px tall and holds a term in `{components.guarantee-term}`, one sentence in `{typography.body-md}` and `{colors.slate}` (at most 44 characters wide) that says what the guarantee means and what it does not, and a `{components.link-inline}` to the spec. Terms are plain-language guarantee names: "At-least-once", "Immutable", "Exportable", "Deny by default".

### Route diagram

The route diagram is the signature illustration and it carries real information: how every event reaches code.

- Flow runs left to right. Five trigger nodes (HTTP, Queue, Schedule, Object, Webhook) join a bus, then one Router node, then the Function node, then the line splits to KV, Object and Queue.
- Nodes are `{components.route-node}`: 120×40, paper fill, 1px `{colors.steel}` outline, 2px radius, `{typography.label-md}` label. The Function is `{components.route-node-current}`: 144×40, lamp fill, 2px ink outline.
- Rails are `{components.route-rail}`: 2px ink, right angles only, on the 8px grid. No arrowheads, no curves, no icons inside nodes.
- Labels are real text, and the figure has a text alternative. Diagram nodes use the singular (Function, KV, Object, Queue); category headings use the plural.
- Below 768px the diagram rotates: trigger nodes wrap in a row, then Router, Function and the three primitives, joined by 24px vertical rails.

### Substrate band

Under the route diagram sits the provider layer. A 2px ink rail marks the contract line, then a 150px band of fog (`{components.fog-cell}`, density 30% at the top to 65% at the bottom) carries provider plates. Plates are `{components.layer-plate}`: paper fill, 1px `{colors.steel}` outline, `{typography.label-sm}`. They name what RailFog runs on: Local (SQLite and filesystem), then each hosted provider. A provider that is not supported today carries "(planned)" in its label. A caption in `{components.text-meta}` says: same API, different provider.

This band is the one place where fog carries meaning. The plates stay legible because the fog is porous.

### Layer row

`{components.layer-row}` is at least 56px tall with a hairline between rows. Its grid holds a 24px marker column, the layer name in `{typography.label-md}`, and a note in `{typography.body-sm}` and `{colors.mute}`. The customer-code row carries `{components.marker-hollow}` (untrusted) and every other row `{components.marker-solid}`. Six rows: Your code, RailFog runtime API, Permissions and policy, Deno execution, OS sandbox, MicroVM or VM. There is no fog here. Isolation is behavior, so it stays sharp. The section is labelled "Design target" until the layers ship.

### Scope list and roadmap

The scope list is rows with 12px vertical padding and a hairline between them. Each row has an 8px `{components.marker-hollow}` and a "Not ..." statement in `{typography.body-md}`, taken from the exclusions the product commits to.

The roadmap is a line of stations: 14px markers on a 2px ink line, with the release number below each in `{typography.label-sm}`. Finished releases are `{components.marker-solid}`, the current one `{components.marker-current}`, later ones `{components.marker-hollow}`. Below 768px the line runs vertically. Show real release numbers and the real current stage. Never mark a stage current before it is.

### Contract table

For docs and pricing. `{components.contract-table-head}` is `{colors.mist}` with `{typography.label-md}`. `{components.contract-table-row}` is `{colors.canvas}` with `{typography.body-sm}` and hairlines between rows. Columns: Primitive, Guarantee, Consistency, Limits, Export. Identifiers use `{components.code-inline}`. Every limit is a hard limit or is marked "example". Below 768px each row becomes a stacked list with the column name as a label, so the table never scrolls sideways.

### Status badges

Badges are `{typography.label-sm}` in sentence case with 4px 8px padding and a 2px radius. Variants: `{components.badge-neutral}`, `{components.badge-active}`, `{components.badge-caution}` and `{components.badge-stop}`. They express the lifecycle mapping in the Colors section. They appear in status views and in the roadmap header, never above a headline.

### Question row

`{components.faq-row}` has 20px vertical padding and a 1px `{colors.line}` bottom rule. The question is `{typography.heading-sm}`. At the right sits a 28px toggle: `{components.faq-toggle}` has a 1px `{colors.steel}` border and a `+` in ink. Open, it becomes `{components.faq-toggle-open}`: lamp fill, 1px ink border, and a `−`. The answer is `{typography.body-md}` in `{colors.slate}`, at most 66 characters wide, aligned to the question's left edge. The height change runs 200ms. Build it as `<button aria-expanded>` controlling a region.

### Forms

`{components.input}` is 44px tall with a 1px `{colors.steel}` border, 14px horizontal padding and a placeholder in `{colors.mute}`. Labels sit above the field in `{typography.label-md}` and are always visible. Helper text is `{components.text-meta}`. Focus draws the standard outline and the border stays. `{components.input-error}` swaps the border to `{colors.stop}` and adds a message below in `{typography.label-sm}` that starts with the word "Error" and says what to change.

### Closing band

`{components.closing-band}` is a full-track ink surface with 96px 48px of padding. It holds the headline in `{typography.heading-xl}` and `{colors.paper}` (at most 14em wide), one sentence in `{components.closing-band-meta}`, one `{components.button-lamp}` and one `{components.command-chip-on-ink}`. Sparse fog (`{components.fog-cell-on-ink}`) runs from about 30% density at the left edge to 0% by 60% of the width and may sit under text because its contrast against ink is low by design. One band per page.

### Footer

`{components.footer}` sits on canvas with a hairline above and 48px of padding. Left: the mark and wordmark, and one sentence in `{typography.body-sm}`, at most 32 characters wide. Right: link columns with a title in `{typography.label-md}` and `{colors.primary}` and links in `{colors.slate}`, each with a 44px hit height. Below, a hairline, the copyright at the left, and the real release stage (for example "Preview 0.2") at the right. A `{components.hairline-strong}` may separate the footer from the closing band.

## Do's and Don'ts

### Do

- Draw contracts sharp and put fog only behind and beneath them.
- Show real code. A complete application in two files beats any screenshot.
- State every guarantee exactly, including what it does not cover.
- Use the four primitive names exactly: plural for categories, singular for resources and diagram nodes.
- Spend the lamp once per viewport.
- Build cells on shared 1px hairlines with no gaps, no radius and no shadow.
- Number only real sequences.
- Label targets as targets, samples as samples, and unshipped providers as planned.
- Keep sections left-aligned, with the headline on the left and the intro on the right.
- Hold 4.5:1 for text, 3:1 for component boundaries, 44px hit areas and a visible 2px focus outline.

### Don't

- Don't use purple, violet or indigo, orange or yellow accents, light mint, gradients, glows, blurred orbs or glassmorphism.
- Don't add drop shadows or `backdrop-filter`.
- Don't show trains, locomotives, tracks in perspective, or clouds.
- Don't put an eyebrow chip, a sparkle icon or any AI wording on the site. RailFog 1.0.0 excludes AI features.
- Don't fake terminal chrome: no traffic-light dots, no typing animation, no neon on black, no rainbow syntax theme.
- Don't put an icon above a heading, and don't use icon tiles.
- Don't use rounded cards, pills, colored left borders or cards nested in cards.
- Don't use all-caps labels, letterspaced small text, italics, or monospace for labels.
- Don't animate on scroll or on hover.
- Don't invent proof: no logos, customer counts, star rows, benchmark numbers, uptime figures or compliance badges.
- Don't claim a release stage, provider or feature before it ships.
- Don't ship a dark-mode toggle until the ink theme is tokenized and audited.

## Imagery, diagrams and the fog field

### Imagery

- Visuals are code, terminal output, and diagrams built from rails, markers and fog. There are no photographs, illustrations, stock images, device mockups or 3D shapes.
- Product UI screenshots appear only when a UI exists. RailFog 1.0.0 excludes a complex dashboard, so the CLI and code are the product surface. A real screenshot sits on `{colors.paper}` with a 1px `{colors.steel}` outline, cropped to the 8px grid.
- Portraits, if ever used, are 40px squares in grayscale.
- Icons are functional only: plus, minus, close, menu, external link, check and copy. Draw them on a 20px grid with a 1.5px stroke, square caps and joins, no fill, in `{colors.primary}` or `{colors.mute}`.

### Diagram grammar

Every diagram uses one grammar.

1. Rails are 2px ink lines, orthogonal, on the 8px grid.
2. Nodes are paper plates with a 1px `{colors.steel}` outline.
3. State is carried by the marker squares: solid, current, hollow.
4. The lamp sits on exactly one thing: the current node or station.
5. Fog appears only beneath the contract line and never over a label.
6. Labels are real text, and every diagram has a text alternative.

### The fog field

The fog field is a static ordered-dither texture. Each cell is a 2 CSS pixel square (`{components.fog-cell}`), either painted or empty, so the texture is always two-tone and never anti-aliased. Painting uses the standard 8×8 Bayer matrix: a cell is painted when the local density exceeds its matrix threshold.

| Use | Density | Dot color |
| --- | --- | --- |
| Hero panel | 2% at the top to 85% at the bottom | `{colors.haze}` |
| Substrate band | 30% at the top to 65% at the bottom | `{colors.haze}` |
| Closing band | 30% at the left edge to 0% by 60% of the width | `{colors.ink-line}` |

- Density never exceeds 85%. At least 15% of cells stay empty, which is what keeps the fog porous.
- It is static. Never animate the dither itself, which flickers.
- It is decorative: the canvas gets `aria-hidden="true"`.
- Paint at integer device pixels, one canvas pixel per cell, with `image-rendering: pixelated`, so cells stay crisp at 1×, 2× and 3×.
- Paint once per element on first paint and again on resize, debounced to 120ms. Or pre-render at build time.

## Motion

Motion is rare and only explains something.

- Nothing animates on load or on scroll.
- Button and link color changes take 120ms. A question row opens in 200ms. Focus outlines appear immediately. The Copy label swaps to "Copied" instantly and swaps back after 1.5 seconds.
- Not allowed: scroll reveals, parallax, typing or replaying terminals, animated dither, pulsing or blinking lamps, looping loaders, and hover transforms of any kind.
- With `prefers-reduced-motion: reduce`, the question-row change takes 0ms.

## Voice and content

The voice is terse, exact and plain, in the second person and the present tense. It says what the product does and stops. It should read like a good man page.

**Fixed vocabulary.** Project, Function, KV, Object, Queue, Deployment, Revision, Secret, Domain. Capitalize them as product nouns. Never invent compound service names such as "FunctionExecutionService". The CLI is `rail`, the config file is `railfog.toml`, and the product is always written RailFog.

**Approved lines** (from the product brief):

- "Build applications, not infrastructure."
- "Four primitives. One runtime. Zero infrastructure ceremony."
- "RailFog hides infrastructure complexity without hiding infrastructure behavior."
- "Use the smallest system that can safely do the job."

**Claims policy.** A developer will check every claim, so every claim must survive the check.

| Claim type | Rule |
| --- | --- |
| Guarantees | State the exact semantics ("at-least-once", "strong within a logical region"). Never advertise a guarantee stronger than the underlying provider gives. |
| Performance | No superlatives and no "faster than". A number appears only when measured, with method, region and date. |
| Targets | Label them "Target". A target such as time from `rail init` to production is not a result. |
| Availability and recovery | No percentages until measured. Recovery objectives are targets. |
| Compliance and security | No certifications or badges. Encryption is not compliance. Isolation layers are "Design target" until shipped. |
| Providers | Name only providers that work today. Everything else says "(planned)". |
| Customers | No logos, counts or quotes without written permission. |
| Code and CLI output | Must match the shipped API and CLI. Until then the caption says "Sample output". |
| Release stage | Show the real stage in the footer. Never imply 1.0.0 before it ships. |

**Banned phrases.** "The next AWS", "Cloudflare but cheaper", "a new serverless cloud", "enterprise-grade", "AI-powered", supercharge, unlock, seamless, effortless, revolutionize, leverage, empower, elevate, unleash, next-gen, cutting-edge, game-changing, world-class, robust, delve.

**Mechanics.** Sentence case for headlines, buttons and labels. Headlines are eight words or fewer. No em dashes in interface copy, no exclamation marks, and no headline built from a row of three verbs. Errors say what happened and what to do next; they do not apologize or joke.

**Calibration copy** (placeholders to replace with shipped facts):

| Role | Sample |
| --- | --- |
| Hero headline | Build applications, not infrastructure. |
| Lede | Four primitives on one runtime: Functions, KV, Objects and Queues. RailFog hides the infrastructure, not how it behaves. |
| Primary action | Read the quickstart |
| Section headline | init, dev, deploy. |
| Section headline | One model: a trigger runs a Function. |
| Guarantee sentence | Queues deliver each message one or more times. Use an idempotency key so a repeat does no harm. |
| Empty state | No projects yet. Run `rail init` to create one. |
| Error | That token has expired. Run `rail login` and try again. |

## Accessibility

- **Contrast.** Text meets 4.5:1 and large text 3:1 (see the contrast reference). Component boundaries meet 3:1 through `{colors.steel}`. The lamp is never text on a light surface.
- **Focus.** Every interactive element shows the 2px outline. Tab order follows reading order.
- **Hit areas.** Every link and button has a 44px hit area in both dimensions, even when its visible box is smaller. The one composite case is the Copy button inside a command chip: 32px visible, 44px hit.
- **Code.** Every code block is a focusable, labelled scroll region. Syntax never carries meaning by color alone: keywords are weight 600 and the code mark is weight 600.
- **Diagrams.** Labels are real text, and each figure has a text alternative.
- **Not by color alone.** The current marker has an outline ring, badges carry text, and errors begin with the word "Error".
- **Decorative layers.** Fog canvases and ruler gutters are `aria-hidden`.
- **Structure.** One `h1` per page, headings in order, landmarks for nav, main and footer, and a skip link that becomes visible on focus.
- **Zoom.** The layout holds at 200% zoom and at 320px width with no horizontal page scrolling.

## Responsive behavior

| Width | Frame | Changes |
| --- | --- | --- |
| 1440px and up | Full frame: 1120px track, ruler gutters | Default |
| 1200 to 1439px | Same track, gutters at least 40px | None |
| 1024 to 1199px | Gutters fixed at 24px, ruler kept | `{typography.display-xl}` drops to 72px |
| 768 to 1023px | Gutters 24px, ruler hidden | Hero side column moves under the headline. Section heads stack with the intro under the headline. Step rows stack. `{typography.heading-xl}` drops to 40px. |
| 480 to 767px | Gutters 12px | Nav collapses to "Menu". Primitive and guarantee grids become one column. The route diagram rotates. The code sheet stacks its panes. Layer notes move under the name. The roadmap runs vertically. Section padding 64px. `{typography.display-xl}` 56px. |
| Below 480px | Rails hidden, hairlines run edge to edge, junction marks hidden | Section padding 48px. `{typography.display-xl}` 44px, `{typography.heading-xl}` 32px, `{typography.display-lg}` 44px. Cell padding 24px 16px. |

Code blocks scroll horizontally at every width. Fog cell size stays at 2px at every width.

## Slop audit

Run these before a page ships. Checks 1 to 9 are mechanical and the script under Implementation snippets runs them. Checks 10 to 19 need a person.

| # | Check | Method |
| --- | --- | --- |
| 1 | No color at a hue between 250° and 320° above 20% saturation | Script |
| 2 | Computed font families are only Archivo and IBM Plex Mono | Script |
| 3 | Zero gradients in any background | Script |
| 4 | Zero `box-shadow`, `text-shadow`, `filter` and `backdrop-filter` | Script |
| 5 | Only 0 and 2px radii | Script |
| 6 | Zero CSS animations | Script |
| 7 | No horizontal page scroll from 320px up | Script |
| 8 | Every link and button has a 44px hit area (Copy inside a chip excepted) | Script |
| 9 | No text under 13px | Script |
| 10 | No small label sits above a section or hero headline | Review |
| 11 | No icon sits above a heading or inside a tile | Review |
| 12 | No card combines a border, a radius above 2px and a shadow; no colored left borders; no nested cards | Review |
| 13 | No headline, paragraph or cell is center-aligned (labels centered under a marker excepted) | Review |
| 14 | No banned phrase, em dash, exclamation mark or triple-verb headline; no repeated cell copy | Review |
| 15 | No stock imagery, device mockups, 3D shapes, trains, clouds or emoji | Review |
| 16 | Every claim, sample and provider is labelled according to the claims policy | Review |
| 17 | At most one lamp fill per viewport | Review |
| 18 | Squint test: blur the page and the rails, the fog and the lamp still say RailFog | Review |
| 19 | Nothing reads as Cloudflare, Deno or Railway: no orange or yellow accent, no violet, no light mint, no train imagery; name and mark cleared | Review |

## Implementation snippets

**Fonts and frame.**

```css
@import "@fontsource-variable/archivo/wdth.css";   /* family: "Archivo Variable", wght 100-900, wdth 62-125 */
@import "@fontsource/ibm-plex-mono/400.css";       /* family: "IBM Plex Mono" */
@import "@fontsource/ibm-plex-mono/500.css";

:root {
  --font: "Archivo Variable", Archivo, "Helvetica Neue", Arial, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  --g: max(40px, calc((100vw - 1120px) / 2));      /* gutter beside the track */
}
@media (max-width: 1199px) { :root { --g: 24px; } }
@media (max-width: 767px)  { :root { --g: 12px; } }
@media (max-width: 479px)  { :root { --g: 0px; } }

.track { margin: 0 var(--g); max-width: 1120px; border-inline: 1px solid var(--haze); }
@media (min-width: 1200px) { .track { margin: 0 auto; width: 1120px; } }
.hr    { height: 1px; background: var(--line); margin: 0 calc(-1 * var(--g)); }
.display-xl { font-size: 84px; font-weight: 700; font-stretch: 82%; letter-spacing: -0.035em; line-height: 0.96; }
.rf    { background: var(--lamp-tint); font-weight: 600; border-radius: 2px; padding: 0 2px; }
pre, code { font-variant-ligatures: none; }
```

**Ruler gutter.** Anchor the tile to the rail with `background-position: right top` on the left gutter and mirror the right gutter with `transform: scaleX(-1)`. Inline the SVG as a data URI and hide the gutter below 1024px.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="64">
  <g fill="#C9D3DB">
    <rect x="16" y="8"  width="8" height="1"/><rect x="16" y="16" width="8" height="1"/>
    <rect x="16" y="24" width="8" height="1"/><rect x="16" y="32" width="8" height="1"/>
    <rect x="16" y="40" width="8" height="1"/><rect x="16" y="48" width="8" height="1"/>
    <rect x="16" y="56" width="8" height="1"/>
  </g>
  <rect x="4" y="0" width="20" height="1" fill="#B4C2CD"/>
</svg>
```

**Fog painter.** `density(x, y)` receives coordinates normalized to 0 to 1 and returns 0 to 1.

```js
function bayer(n) {
  if (n === 2) return [[0, 2], [3, 1]];
  const m = bayer(n / 2), h = n / 2, o = Array.from({ length: n }, () => Array(n));
  for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) {
    const v = 4 * m[y][x];
    o[y][x] = v; o[y][x + h] = v + 2; o[y + h][x] = v + 3; o[y + h][x + h] = v + 1;
  }
  return o;
}
const B = bayer(8);

function paintFog(canvas, { cell = 2, color = "#B4C2CD", density }) {
  const box = canvas.parentElement.getBoundingClientRect();
  const w = Math.ceil(box.width / cell), h = Math.ceil(box.height / cell);
  canvas.width = w; canvas.height = h;              // one canvas pixel per fog cell
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (density(x / w, y / h) > B[y % 8][x % 8] / 64) ctx.fillRect(x, y, 1, 1);
}

// Hero panel: thin at the top, dense at the bottom, never above 85%
paintFog(document.querySelector("#hero-fog"), { density: (x, y) => Math.min(0.85, y ** 1.25 + 0.02) });
```

**Mechanical slop audit.** Paste into the browser console on any page, at 1440px and again at 390px. Expected flags: the Copy buttons inside command chips (see Accessibility).

```js
(() => {
  const r = { shadow: 0, gradient: 0, blur: 0, anim: 0, fonts: new Set(), radii: new Set(),
              hue: [], small: [], tiny: [], hscroll: document.documentElement.scrollWidth > innerWidth };
  const rgb = s => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
  const hsl = ([R, G, B]) => {
    R /= 255; G /= 255; B /= 255;
    const M = Math.max(R, G, B), m = Math.min(R, G, B), l = (M + m) / 2;
    if (M === m) return [0, 0, l];
    const d = M - m, s = l > .5 ? d / (2 - M - m) : d / (M + m);
    const h = (M === R ? (G - B) / d + (G < B ? 6 : 0) : M === G ? (B - R) / d + 2 : (R - G) / d + 4) * 60;
    return [h, s, l];
  };
  document.querySelectorAll("body *").forEach(el => {
    const cs = getComputedStyle(el); if (cs.display === "none") return;
    if (cs.boxShadow !== "none" || cs.textShadow !== "none") r.shadow++;
    if (/gradient/.test(cs.backgroundImage)) r.gradient++;
    if (cs.filter !== "none" || (cs.backdropFilter || "none") !== "none") r.blur++;
    if (cs.animationName !== "none") r.anim++;
    if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) {
      r.fonts.add(cs.fontFamily.split(",")[0].replace(/["']/g, "").trim());
      if (parseFloat(cs.fontSize) < 13) r.tiny.push(el.tagName + " " + cs.fontSize);
    }
    for (const k of ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"])
      if (cs[k] !== "0px") r.radii.add(cs[k]);
    for (const k of ["color", "backgroundColor", "borderTopColor", "fill", "stroke"]) {
      const c = rgb(cs[k] || ""); if (c.length < 3 || c[3] === 0) continue;
      const [h, s] = hsl(c); if (s > .2 && h >= 250 && h <= 320) r.hue.push(el.tagName + " " + k);
    }
    if (el.matches("a,button,input,select,textarea")) {
      const b = el.getBoundingClientRect();
      if (b.width && (b.width < 44 || b.height < 44)) r.small.push(el.tagName + " " + Math.round(b.width) + "x" + Math.round(b.height));
    }
  });
  r.fonts = [...r.fonts]; r.radii = [...r.radii];
  return r;
})();
```

## Iteration guide

1. Work on one component at a time. Change its front-matter entry first, then its prose.
2. Refer to tokens by name (`{colors.lamp}`, `{components.button-ink}`, `{rounded.sm}`) and never paraphrase a value.
3. Run `npx @google/design.md lint DESIGN.md` after every edit and keep it at zero errors and zero warnings. `npx @google/design.md export --format css-vars DESIGN.md` (also `css-tailwind`, `json-tailwind`, `dtcg`) turns the tokens into code.
4. Add states as separate component entries (`-hover`, `-pressed`, `-disabled`) rather than burying them in prose. Every entry in the front matter must also be specified in the Components section.
5. Before adding a color, name the state it encodes. If it encodes none, do not add it.
6. Keep the lamp and the ink surface scarce: one lamp fill per viewport, one ink band per page.
7. Before inventing a device, ask whether rails, fog or the lamp can express the idea.
8. Re-run the Slop audit after any new section or component.

## Known gaps

- **Name and mark are not cleared.** RailFog shares a name stem with Railway (railway.com), a developer cloud. Run a trademark and domain search before launch, and compare the mark against Railway and other rail-themed developer brands. This file is not legal advice.
- **No dark theme.** Developers often expect one in docs. Tokens for on-ink surfaces exist (`{colors.ink-soft}`, `{colors.ink-line}`, `{colors.on-ink-mute}`), but a full theme needs at least five more tokens (boundary, body text, and status text on ink). Tokenize it when needed; do not derive it by inverting.
- **No dashboard or status UI.** RailFog 1.0.0 excludes a complex dashboard. If a console ships, it needs its own density and table rules.
- **No docs templates.** API reference, long-form article, tabbed code and search are not covered.
- **No pricing components.** Pricing is undecided. When it exists, present it with the contract table and hard limits rather than tier cards.
- **Samples are illustrative.** Every code and CLI sample is a placeholder until the API and CLI it depicts exist.
- **Rendering coverage.** The fog painter and layout rules were exercised in Chromium only.
- **No usability testing.** Nothing here has been tested with developers.
