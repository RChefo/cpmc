# Dashboard design system

The web dashboard (`dashboard.html` + `dashboard.js`) is a coordination console for local Claude Code sessions. The tokens
live in `:root` in `dashboard.html`; that CSS is the source of truth and this file explains how to use it.

## Principles

- **The conversation is the work.** Navigation, panels and the details column frame it; none of them compete with it.
- **Who → whom, and did it arrive.** Every message shows its sender, its recipient and its real delivery state.
- **One accent.** Clay marks the primary action, the current selection and keyboard focus. Nothing else.
- **Colour carries meaning, never alone.** State colours always come with an icon or a word; identity hues sit on tiles and names.
- **Honest states.** Show only what the broker reported: no optimistic success, no invented progress, stale data labelled as such.

## Colour

Warm graphite surfaces in tonal layers, warm-tinted hairlines, no gradients, glass or glows.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--frame` | `#0d0c0b` | `#ebe8e3` | Top bar, rail |
| `--stage` | `#11100f` | `#faf9f7` | Conversation canvas |
| `--panel` | `#151413` | `#f3f1ed` | Section panel, details column |
| `--raised` / `--raised-2` | `#1c1b19` / `#252321` | `#ffffff` / `#ebe8e3` | Inputs, code, chips, counts |
| `--overlay` | `#1e1d1b` | `#ffffff` | Toasts, palette, dialogs, toolbars |
| `--line` / `-2` / `-3` | warm white at 7.5 / 13 / 20 % | warm black at 10 / 16 / 26 % | Hairlines, control borders |
| `--ink` / `--ink-body` / `--ink-2` / `--ink-3` | `#ede8e1` / `#d8d2c9` / `#b4ada3` / `#8f887e` | `#1d1a16` / `#2e2a25` / `#4f4a43` / `#6b655d` | Headings / message text / secondary / meta |
| `--accent` | `#d97757` (dark ink on fills) | `#b5532f` (white on fills) | Primary action, selection, focus |
| `--ok` `--warn` `--bad` `--info` `--violet` | `#74c48f` `#e3b456` `#f2798c` `#84ade9` `#b8a0e6` | darker equivalents | Success, attention, failure, delivered, decisions |

Every state colour has a `-soft` companion (13 % in dark, about 10 % in light) for badge and banner backgrounds. `--ink-3`
keeps at least 4.5:1 against every surface it is used on; `--ink-4` is decorative only (disabled controls, track outlines).

### Identity hues

Each peer gets a deterministic hue from its name (FNV-1a hash into `HUES` in `dashboard.js`), so a session keeps its
colour across reconnects. The hues are OKLCH angles 80–320 at fixed lightness and chroma per theme (`--peer-l`,
`--peer-c`, `--peer-tile-l`, `--peer-tile-a`); the red–orange band is skipped because it belongs to `--bad` and the
accent. Hues appear only on tiles (`.tile.hue`) and names (`.name.hue`), with an HSL fallback where OKLCH is unsupported.
"You" (the dashboard) and the CLI use neutral tiles (the CLI's with a terminal icon), so the accent keeps meaning
"action, selection, focus".

### State colours

| State | Colour | Paired with |
|---|---|---|
| Online / away / busy / idle | `--ok` / `--warn` / `--violet` / hollow ring | The status word in the roster and details |
| Delivery: sent / delivered / acknowledged / not delivered | `--ink-2` / `--info` / `--ok` / `--bad` | The step label, and the broker's reason under a failed message |
| Conflict, failure, refusal | `--bad` | An alert icon and a sentence |
| Needs attention (pending, awaiting your vote) | `--warn` | A count or a badge label |

## Typography

IBM Plex Sans for UI and messages, IBM Plex Mono for paths, ids, keys and code, IBM Plex Sans Arabic for translated
messages (loaded per glyph range, only when Arabic text appears). System fonts are the fallback when Google Fonts is
unreachable.

| Role | Size / line height | Weight |
|---|---|---|
| Message body | 14 / 1.6 (1.85 for Arabic) | 400 |
| Names, row titles | 13.5–14 | 500–600 |
| Secondary text | 12.5 | 400 |
| Meta, counts, timestamps | 11.5–12, tabular numerals | 400–500 |
| Code | 12.5 / 1.6 mono | 400 |

Prose in messages is capped at 72ch; tables and code blocks use the full message width and scroll horizontally.

## Space, shape, motion

- Spacing steps: 2, 4, 6, 8, 10, 12, 16, 20, 24 px. Rows use 8–11 px padding; sections separate with hairlines, not cards.
- Radii: 4–5 px for chips and badges, 6–8 px for controls and rows, 10–12 px for messages, popovers and dialogs.
- Shadows only on things that float: `--shadow-pop` for toasts, the palette, dialogs, drawers and the message toolbar.
- Motion is 120–260 ms with `--ease-out`, and only where it carries state: a new message eases in 6 px, a delivery step
  fills when the broker advances it, drawers slide, and a jumped-to message flashes once. `prefers-reduced-motion`
  removes all of it.

## Layout

A CSS grid: top bar (44 px) · optional connection banner · rail (56 px) | section panel (260–480 px, resizable, default
320) | conversation (`--measure` 768 px column) | details column (336 px, only with a selected peer).

| Width | Behaviour |
|---|---|
| ≥ 1360 px | Everything docked; selecting a peer opens its details column |
| 1100–1359 px | Details become a right-hand drawer opened with "Details" |
| 720–1099 px | The section panel also becomes an overlay over the conversation |
| < 720 px | Rail and panel slide in together from the menu button; message state wraps under the header |

With the details column docked, the conversation header shrinks to "Messages with X" (no tile or status, which the
column already shows). On touch screens (`hover: none`) a message's actions appear when the message is tapped; until then
they are visually hidden but still reachable by screen readers.

## Rail badges

A badge marks only what is waiting on someone: open tasks (neutral), file conflicts (`--bad`), pending verifications and
approvals (neutral), and open proposals the dashboard has not voted on (`--warn`). Totals such as peers, groups and
active decisions live in each tab's label and tooltip, never in a badge.

## Components

- **Tile** (`.tile`, `.tile.sm`): initials on the peer's hue; `.presence` dot at the corner (online, away, busy with a
  bar, idle hollow), always paired with a text status somewhere nearby.
- **Message** (`article.msg`): left-aligned log row; header = sender → recipient, time, kind badge, delivery track;
  consecutive messages between the same pair within 5 minutes drop the header and show the time on hover.
- **Delivery track** (`.track`): three dots for sent / delivered / acknowledged, or, when the broker reports a failed
  delivery (`failed_at`, `fail_reason`), an x-circle and "Not delivered" plus the reason under the message. Only for
  real recipients (never for messages to the dashboard or CLI).
- **Kind badge** (`.kind`): question, decision, context, review request, handoff; the fields render from the message
  metadata as a definition list (`.struct`).
- **Badges** (`.badge[data-tone]`), **segmented filters** (`.seg`), **buttons** (`.btn`, `.btn-primary`, `.btn-ghost`,
  `.btn-danger`, `.icon-btn`) and **rows** (`.row`, `.row-meta`, `.kv`) are shared by every section.
- **Destructive actions** confirm inline (`.confirm`) with focus on Cancel; there are no browser `confirm()` dialogs.
- **Consequential choices are staged.** Picking a group in a peer's details only stages it; the Move button sends it.
- **Busy controls** use `aria-disabled="true"` and `aria-busy`, never `disabled`, so keyboard focus stays on them. A
  succeeded action stays busy until the broker's next snapshot shows its effect (at most 3 s), which blocks a second
  submission in between.
- **Empty states** (`.empty`) say what fills the section and which MCP tool does it.
- **Icons** are one inline SVG sprite in `dashboard.html` (24 px grid, 1.75 px stroke, round caps). Emoji appear only as
  message content and reactions.

## Accessibility rules

- Every control is a native element with a visible label or an `aria-label` that contains its visible text.
- Roster rows are stretched buttons: the button's name is the peer name; status and summary are its description.
- The rail is a vertical tablist with roving focus; drawers that are off screen are `inert`; the palette and the
  session report are native `<dialog>`s that return focus to what opened them.
- The conversation is a `role="log"` with `aria-live="off"`: messages are rebuilt when their delivery state changes, and a
  live log would read them out again. New messages are announced through the polite `#announcer` region instead,
  batched (at most one announcement every 1.5 s).
- Toggle buttons keep one name and report their state with `aria-pressed` (pin, translate, reactions, filters).
- When a re-render replaces the focused control, focus moves to its replacement (`renderAll`, `keepFocus`).
- Visible focus everywhere: 2 px `--focus` outline.

## Identity across reconnects

A session that reconnects registers again from the same process and gets a new peer id. The selection and the composer's
recipient follow it by pid and directory, never by name: default names (claude-N) repeat across groups and pass to
new sessions. A message belongs to the selected peer when it carries one of the peer's ids, or an id the page saw
connected from the same process. For ids the page never saw, the stored sender or recipient name decides, and only when
no other process has used that name while the page was open and no other connected peer has it now. The details column
counts and lists by the same rule as the conversation scope.

## Performance limits

The conversation renders the newest 100 messages of the current view (scope and search) and adds 100 more per "Show
earlier" click; search counts every match. Real sessions send long messages, and all 500 that the broker returns came
to about 36,000 elements, which took most of a second to lay out on every search. While the reader is scrolled up, the
window keeps its first message, so new messages never remove text that is on screen. Jumping to an older message
extends the window down to it.

Messages are untrusted text (up to 64 KB). Inline markdown is parsed only on lines of up to 2,000 characters, and the
patterns are written so a worst-case line of that length takes about 10 ms. Nesting stops at 8 levels, and excerpts
(pins, notifications, announcements) work from the first few hundred characters only. `dashboard.test.ts` has timing
tests for the inputs that used to take seconds.

## Adding a section

1. Add a rail tab in `dashboard.html` (`role="tab"`, `data-section`, an icon from the sprite, a `.rail-count` if it has a count).
2. Add it to `SECTIONS`, `sectionSig`, `sectionSub` and `sectionBody` in `dashboard.js`, and to `railCounts` if it counts.
3. Build rows from the shared components above; reuse `who()` for any peer reference so identity stays consistent.
4. Add a test to `dashboard.test.ts` for what it renders and any request it sends.
