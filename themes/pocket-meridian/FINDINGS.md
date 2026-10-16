# What Pocket Meridian found out about the theming design

Pocket Meridian was written against the planned surface in [docs/design/theming.md](../../docs/design/theming.md) before that surface existed. These are the gaps it found, for the people who build theming.

**How it was tried.** On a copy (`node test/serve.ts`), with changes that were not committed: `index.html` imported `style.css` into layer `pocket` and the theme into layer `theme`, with `document.write`, as the design plans; a small script put the planned `data-part` names and states on today's markup (the map is in section 1); and Meridian's two palettes were added to the palette list. The palette stayed inline on `<html>`; the theme sets no `--o-*` variable, so that made no difference.

**The main result is good.** With the layers, no rule needed `!important` or extra specificity, and the theme moved whole regions (sheets to the right edge, the launcher to the top, the message box into a band, messages into a gutter) with plain rules. The problems are below.

## 1. Where each planned part sits today

The script tagged these. When the parts are built, a different place for one of them moves the theme's rules with it.

| Part                                | Today                                     | State the theme reads                                            |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `app`                               | `.layout`                                 |                                                                  |
| `rail`, `rail-button`               | `.rail`; `.rail-button`, `.rail-brand`    | lit: `.on`, `.open` (see section 2)                              |
| `sidebar`, `pane`                   | `.sidebar`, `.pane`                       | `data-focus` on `<html>`                                         |
| `session-list`                      | `.sessions` (sidebar, drawer, phone home) |                                                                  |
| `session-search`                    | `.sessions > .search`                     |                                                                  |
| `session-tabs`                      | `.session-tabs`                           |                                                                  |
| `session-group`                     | `.session-group`                          |                                                                  |
| `session-row`                       | `.session-row`                            | `aria-current="page"` (today `.active`); `data-state`            |
| `home`                              | `.splash`                                 |                                                                  |
| `topbar`                            | `.topbar`                                 |                                                                  |
| `transcript`                        | `.transcript`                             |                                                                  |
| `prompt`                            | `.user-row > .prompt`                     | `data-from` (today read from the avatar's color)                 |
| `reply`, `reply-actions`            | `.reply`, `.answer-actions`               |                                                                  |
| `thinking`                          | `.live-thought`, `.activity-thought`      |                                                                  |
| `activity`, `tool-call`             | `.activity`, `.step`                      | `data-state` (today `data-status` and `.step-mark`'s class)      |
| `approval`, `live-line`             | `.approval`, `.live-line`                 |                                                                  |
| `code-block`                        | `.code`                                   |                                                                  |
| `composer`, `dock`                  | `.composer-wrap`, `.dock`                 |                                                                  |
| `subagents-bar`                     | `.agents-bar`                             |                                                                  |
| `message-box`                       | `.composer`                               |                                                                  |
| `composer-tools`                    | `.composer-row`                           |                                                                  |
| `send-button`, `model-chip`         | `.send-button`, `.model-chip`             | ready: `.ready` (see section 2)                                  |
| `status-line`                       | `.status-line`                            |                                                                  |
| `sheet`, `sheet-head`, `sheet-body` | `.sheet`, `.sheet-head`, `.sheet-body`    | `data-sheet` (today the extra class, such as `appearance-sheet`) |
| `menu`                              | `.menu-pop`, `.places`                    |                                                                  |
| `launcher`                          | `.launcher`                               |                                                                  |
| `notices`, `notice`                 | `.notices`, `.notice`                     |                                                                  |

## 2. Parts and states the design lacks

The theme's rules mark each of these "No part:". Each is a class today, so each breaks when its class changes. A short list of additions would cover most of them:

| The theme needed                                   | Today                                                                                                                            | Proposal                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The π mark (rail, boot screen)                     | `.rail-brand`, `.boot-mark`                                                                                                      | part `brand-mark` (also empty states)                                                         |
| A rail button that is lit                          | `.on` (the list shows), `.open` (its window is open), `.lit`                                                                     | `aria-pressed`, or `data-state="open"`                                                        |
| The segment that slides in a segmented control     | `.slide-x` (sessions.js sets its place and width)                                                                                | part `segment-thumb`                                                                          |
| A group's head, and its count                      | `.group-head`, `.group-count`                                                                                                    | part `session-group-head`                                                                     |
| A row's button, its square, its branch lines       | `.session`, `.state-mark`, `.session-branches`                                                                                   | parts `session-mark`, `session-branches`; style the row through `session-row`                 |
| The title and the line under it in the top bar     | `.title-main`, `.title-sub`                                                                                                      | parts `topbar-title`, `topbar-sub`                                                            |
| The home screen's pieces                           | `.fetch`, `.fetch-logo`, `.fetch-info`, `.fetch-row`, `.splash-actions`, `.splash-row`, … (12 classes)                           | parts `home-facts`, `home-fact`, `home-actions`, `home-recent`, `home-recent-row`             |
| A turn, for space between turns                    | `.user-row`                                                                                                                      | part `turn`, or put `prompt` on the row                                                       |
| Who sent a message, and when                       | `.prompt-head`, `.prompt-avatar`, `.prompt-author`, `.user-text`                                                                 | parts `prompt-head`, `author-mark` (the avatar, used in more places), `prompt-text`           |
| A message that is not from a person                | `data-from` has `me` and `person`; a linked session's or scheduled message takes the accent, as yours does                       | a third value, `data-from="pi"`                                                               |
| An activity group's head, open or closed           | `.activity-head`, `.open`                                                                                                        | part `activity-head`, with `aria-expanded` as its documented state                            |
| A tool call's mark and its input and output        | `.step-mark`, `.step-head`, `.step-label`, `.step-extras`, `.step-body`                                                          | parts `tool-call-mark`, `tool-call-detail`                                                    |
| The live line's dot                                | `.live-dot`                                                                                                                      | part `live-mark`                                                                              |
| A code block's bar                                 | `.code-head`                                                                                                                     | part `code-head`                                                                              |
| The message box's own buttons                      | `.plan-chip`, `.attach-button`, `.composer-mic`, `.places-button`, `.mode-switch`, `.stop-button`                                | one part, `composer-button`; `stop-button` and `mode-switch` if themes may restyle them alone |
| Send ready to send                                 | `.ready`                                                                                                                         | `data-state="ready"`, or `aria-disabled` on the empty one                                     |
| The scrim a sheet or the launcher sits in          | `.overlay` (with `:has()`), `.launcher-overlay`                                                                                  | part `scrim`, with `data-for="sheet"` or `"launcher"`                                         |
| A sheet or the launcher closing                    | `.leaving` on the host                                                                                                           | `data-state="closing"` on the part                                                            |
| A wide sheet                                       | `.wide`                                                                                                                          | `data-size="wide"`                                                                            |
| The launcher's input, filters, rows, and selection | `.launcher-input`, `.launcher-types`, `.launcher-item.on`, `.launcher-group`                                                     | parts `launcher-input`, `launcher-row` with `aria-selected`                                   |
| Which window has the focus                         | `<html data-focus>` is documented, its values are not: `pane` (or absent), `sidebar`, `browser`, `files-tile`, `people`, `peeks` | document the values, or put `data-focused` on the window itself                               |

## 3. Tokens the design lacks

- **The focused window's border.** It is not a token: `border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft)` on a selector of five `:not()`s. Meridian had to copy the focus logic to draw Hyprland's gradient border. Proposal: `--window-border`, `--window-border-active`, and `--window-ring`, set on the focused window by the app. A gradient cannot be a `border-color`, so `--window-border-active` would take an image (drawn with the padding-box/border-box background trick, as Meridian does).
- **A gradient accent.** Omarchy's identity is a two-color active border; the app has `--accent` and `--spark` but no pair for gradients. Meridian made `--signal-from`, `--signal-to`, and `--signal`; a built-in `--accent-2` (or the theme's own, documented as allowed) would do.
- **The timeline's geometry.** To put the tool calls' marks on the meridian, the theme must know that the rule is 22px in, the marks 19px wide, the label gap 10px, and the details 42px in. These are numbers in `style.css`. Proposal: `--timeline-x` (where the marks' centers are) and `--step-mark-size`, read by the app's own timeline rules.
- **The conversation's gutter.** `--transcript-width` is planned; an inline-start gutter (`--transcript-gutter`, 0 by default) would let a theme add a column without overriding the transcript's padding.
- **Heading type.** Titles and labels set their own weight: `style.css` has about 70 bold weights (600 to 700). Meridian wanted a wide cut for headings: it set `font-stretch` in seven places, and surely missed some. Proposal: `--heading-weight` and `--heading-stretch` (or `--display`, a third family), read by the app's titles. This can wait for the phase 2 type scale.
- **`--muted` and `--faint` are not enough for AA** with the app's own mixes (on Tokyo Night: 3.8:1 and 2.3:1). Meridian raised them (on Tokyo Night: muted 4.8–5.8, faint 4.1–5.1; on its own palettes, 4.8 or more everywhere). The app's defaults may want the same.

## 4. Overrides that fought the app

- **Palette variables used directly.** Outside the token block, `style.css` uses `var(--o-*)` 70 times instead of a named token (29 of them `--o-bg`): the launcher's background, the tool marks' knockout and ring, `::selection`, the primary button's hover. A theme that moves `--bg` or `--panel` gets rings and backgrounds of the old color. Meridian kept `--bg` at `--o-bg` and restyled the marks. Phase 1, step 2 (derive from named tokens) should cover these too, not only the soft fills.
- **The app's pseudo-elements.** About 77 of the app's rules draw `::before` or `::after`: hit areas, marks, rules. On phones, `.group-head::after` is the head's tap area, absolutely placed; Meridian's rule line on the same pseudo-element took the app's position and vanished, on phones only. A theme cannot know which are free. Proposal: document which parts use their pseudo-elements, or move the app's hit areas to a child of their own.
- **A theme's rule wins in every condition.** A layer beats the app's media queries, hover, and touch rules for that property too. Meridian set the message box's text to 15px and, so, had to say 16px again for touch screens, or iOS would zoom into the field. The docs should say it: "a rule you write replaces the app's rule for that property on phones, on touch screens, and on hover too".
- **`!important` in the app.** `* { font-variant-ligatures: none !important }` turns off contextual alternates too, so no theme can use a font's `calt` (Monaspace's texture healing, for example). `.drawer-overlay` sets its alignment with `!important`, so the drawer can never move to the right. The reduced-motion rule is right as it is, but it cuts an endless animation to its last frame, so a theme must still choose a still frame (Meridian does, for its running light).
- **Fonts.** `index.html` preloads Geist and JetBrains Mono. With a theme that brings its own fonts, those 183 KB load first, and the theme's fonts are not preloaded. Proposal: the loader preloads the fonts the theme's `@font-face` rules name, and the app preloads its own only for Pocket.

## 5. JavaScript that assumes where things are

Meridian moved no region that a script measures, on purpose. What it did touch:

- **The segment that slides** (`.slide-x`): the script sets its `transform` and `width` inline. Meridian turned it into an underline by setting `top`, `bottom`, and `height`. If the script ever sets those, the underline breaks.
- **Inspector sheets.** Wide screens have no swipe to close, so moving sheets to the right broke nothing. Phones keep the bottom sheet, where the drag down to close lives. A theme that put phone sheets at the side would fight the swipe.
- **The message box** (`fitBox`) and the status line (`fitStatus`) measure what they get, so the band and the mono status line work. The dock (`dock.js`) looks for `.agents-bar` as a direct child; CSS cannot move it, so it is safe.
- **PiP** sits 16px from the bottom right corner, over the right end of the band, as it covers the message box today.

## 6. What breaks when the app changes

- Every "No part:" rule (section 2): a renamed class silently drops the rule. The theme still loads; that part goes back to the soft tiles' look.
- The meridian's alignment depends on the timeline's internal numbers (section 3). A change to the timeline's padding moves the marks off the line.
- The home screen's facts close square because the last one takes its own row (`:last-of-type`). A new fact can leave a gap in the sheet.
- `content: "π" / ""` needs the alternative-text syntax (Chrome 77, Safari 17.4, Firefox 128). An older browser drops the declaration, so the node is not drawn; nothing else changes.

## 7. The format

- **A light and a dark palette in one theme.** A folder holds one `colors.toml`, and its `mode` decides light or dark. The flagship needs a pair. Proposal: `colors-light.toml` beside `colors.toml` (this folder has both); Colors shows them as one entry with two halves; choosing the theme picks the half that matches the system (`prefers-color-scheme`), or the one the person chose. That is also a rule the design needs anyway: "when you choose a theme that has its own colors, Colors changes to them" does not say which, when there are two.
- **Fonts with a Reserved Font Name cannot be subset.** Mona Sans, Geist, JetBrains Mono, Inter, and many others are OFL with an RFN: a subset is a Modified Version and must be renamed. So themes will ship whole variable fonts (Meridian: 308 KB and 39 KB). The 4 MB file limit is fine; the docs should say why the files are big and that renaming the family in CSS is not a modification.
- **Caching.** Theme files are planned at `/themes/<id>/<rev>/…`, but `serveFile` today sends `no-cache` without an `ETag`, so each page load downloads every file again: 350 KB of fonts on each load over a tunnel. With the `rev` in the path, the theme route can send `cache-control: public, max-age=31536000, immutable`.
- **Files the server ignores.** `README.md`, `FINDINGS.md`, the licence's `.txt`, and `colors-light.toml` are ignored, as the design says. The licence must still travel with the fonts, so the gallery (phase 3) should keep `.txt` files.

## 8. Accessibility

- With Meridian Night and Day, text, muted text, faint text, the accent, and the ink on the signal fill are 4.5:1 or more on every surface (README.md has the numbers). With other palettes, Meridian is as good as the soft tiles or better; faint text on a raised card falls to about 4.1:1 on Tokyo Night, Gruvbox, and Rosé Pine Dawn, and Catppuccin Latte fails in many places, as it does with the soft tiles.
- Focus rings are 2px in `--focus-ring`, where the app draws 1px.
- Labels in capitals use `text-transform`, so the words stay as written for screen readers and translations; but Chrome passes the capitals to its accessibility tree for some names ("TODAY 8"). A built-in theme may want capitals only on labels that are not names.
