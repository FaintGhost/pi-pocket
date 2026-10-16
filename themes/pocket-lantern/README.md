# Lantern

**Direction: Dusk.** Warm brown-grey with warm off-white text and a muted amber accent: the gentlest, for long reading at night.

One of three calm directions for Pi Pocket's in-house theme, for the owner to choose from; the one chosen ships in Pi Pocket 0.14.0. It is in the planned theme format ([docs/design/theming.md](../../docs/design/theming.md)). It is written with the planned tokens and part names; where the plan has no part, a rule names today's class, marked "No part:".

## The idea

A professional dark tool for reading for hours: soft off-white text on a dim surface, never pure black or pure white. One muted amber accent, used sparingly (New session, Send, the focus ring). 1px borders and tonal surfaces instead of shadows, with modest corners (6 to 12px). No gradients, no glow.

## Easy to digest

- **One readable column**, about 72 characters a line at any text size (`--transcript-width: 36 × --text-size`), centered. The message box has the same width.
- **Turns:** **No cards at all.** Your messages are set off by a quiet amber bar at their start and the brighter text color, with who and when above. **Pi's answers** are plain prose, with a little more space between the lines than the app's.
- **Tool calls are one quiet line** in muted text ("Thought, read 1 file, ran 2 commands · 18s"), with no card. Opened, they become a tonal panel. A call that worked has a grey check; only failures, approvals, and running calls have color.
- **Three steps of type:** titles in the text color at weight 600, body in the body color, meta (times, counts, the status line) in muted or faint text, smaller.
- **Spacing:** lines at the app's 1.65, paragraphs 14px apart, turns a little more. The densities in Appearance still apply.
- **The composer** is one plain field with a 1px border. Focus makes the border one step stronger; there is no glow.
- **Quiet frame:** no accent ring on the focused window, only a stronger hairline. The sidebar is a step darker than the conversation, and the open session a step lighter. The home screen keeps its layout, with a toned-down π.

## Palette (`colors.toml`)

| Role                  | Color                           |
| --------------------- | ------------------------------- |
| Desk, sidebar, ground | `#171412`, `#1b1816`, `#211e1b` |
| Titles (`--text`)     | `#ebe3d6`                       |
| Body (`--body`)       | `#ddd3c4`                       |
| Accent                | `#d0a463`                       |
| Red, yellow, green    | `#d98a7c`, `#d8b46a`, `#a3b58c` |

Muted and faint text mix from the body color toward the ground (`--muted` 74%, `--faint` 70% in oklab).

## Contrast

Measured in the browser on the rendered tokens (WCAG 2 contrast ratios), on the ground, the sidebar, and cards:

| Text                    | Ratio                                                         |
| ----------------------- | ------------------------------------------------------------- |
| Titles (`--text`)       | 13.0:1 on the ground, 11.9:1 on a card                        |
| Body (`--body`)         | 11.2:1 on the ground, 11.9:1 in the sidebar, 10.3:1 on a card |
| Muted (`--muted`)       | 5.3:1 to 6.8:1                                                |
| Faint (`--faint`)       | 4.8:1 to 6.1:1                                                |
| Accent as text          | 7.2:1 to 7.7:1                                                |
| Ink on the accent fill  | 7.2:1                                                         |
| Error, success, warning | 6.2:1, 7.5:1, 8.4:1                                           |
| Code colors             | 7.2:1 to 9.0:1 on the code ground                             |

Every text color is 4.5:1 or more on every surface checked.

## Type

Geist for words and JetBrains Mono for code, paths, and numbers: the app's own fonts, already bundled, so nothing new downloads. Sentence case throughout.

## Files

| File           | What                                                   |
| -------------- | ------------------------------------------------------ |
| `theme.json`   | The manifest                                           |
| `theme.css`    | The entry; imports the rest                            |
| `tokens.css`   | Surfaces, lines, text, the accent, corners, the column |
| `calm.css`     | The frame shared by the three directions               |
| `messages.css` | This direction's turns                                 |
| `colors.toml`  | The palette, in Omarchy's format                       |

No JavaScript, no remote loads, no words in `content:`, and no animations of its own: its one transition (a tool-call group's panel) is cut by the app's reduced-motion rule. It does not change hit areas, so touch and keyboard work as in the app.
