# Fjord

**Direction: Slate.** Cool blue-grey with a soft teal accent: a little cooler and more modern, with your messages as bubbles.

One of three calm directions for Pi Pocket's in-house theme, for the owner to choose from; the one chosen ships in Pi Pocket 0.14.0. It is in the planned theme format ([docs/design/theming.md](../../docs/design/theming.md)). It is written with the planned tokens and part names; where the plan has no part, a rule names today's class, marked "No part:".

## The idea

A professional dark tool for reading for hours: soft off-white text on a dim surface, never pure black or pure white. One soft teal accent, used sparingly (New session, Send, the focus ring). 1px borders and tonal surfaces instead of shadows, with modest corners (6 to 12px). No gradients, no glow.

## Easy to digest

- **One readable column**, about 72 characters a line at any text size (`--transcript-width: 36 × --text-size`), centered. The message box has the same width.
- **Turns:** **Your messages** are bubbles on the right, with only the time inside; **other people's** are on the left, with their name and avatar. **Pi's answers** are plain prose across the column. Who said what shows by place, not by color.
- **Tool calls are one quiet line** in muted text ("Thought, read 1 file, ran 2 commands · 18s"), with no card. Opened, they become a tonal panel. A call that worked has a grey check; only failures, approvals, and running calls have color.
- **Three steps of type:** titles in the text color at weight 600, body in the body color, meta (times, counts, the status line) in muted or faint text, smaller.
- **Spacing:** lines at the app's 1.65, paragraphs 14px apart, turns a little more. The densities in Appearance still apply.
- **The composer** is one plain field with a 1px border. Focus makes the border one step stronger; there is no glow.
- **Quiet frame:** no accent ring on the focused window, only a stronger hairline. The sidebar is a step darker than the conversation, and the open session a step lighter. The home screen keeps its layout, with a toned-down π.

## Palette (`colors.toml`)

| Role                  | Color                           |
| --------------------- | ------------------------------- |
| Desk, sidebar, ground | `#151a20`, `#181d24`, `#1d232b` |
| Titles (`--text`)     | `#dfe5ec`                       |
| Body (`--body`)       | `#c8d1dc`                       |
| Accent                | `#6db5b5`                       |
| Red, yellow, green    | `#e08585`, `#d8b56e`, `#8dc29a` |

Muted and faint text mix from the body color toward the ground (`--muted` 74%, `--faint` 72% in oklab).

## Contrast

Measured in the browser on the rendered tokens (WCAG 2 contrast ratios), on the ground, the sidebar, and cards:

| Text                    | Ratio                                                        |
| ----------------------- | ------------------------------------------------------------ |
| Titles (`--text`)       | 12.5:1 on the ground, 11.3:1 on a card                       |
| Body (`--body`)         | 10.3:1 on the ground, 11.0:1 in the sidebar, 9.3:1 on a card |
| Muted (`--muted`)       | 4.9:1 to 6.3:1                                               |
| Faint (`--faint`)       | 4.7:1 to 6.1:1                                               |
| Accent as text          | 6.7:1 to 7.2:1                                               |
| Ink on the accent fill  | 6.7:1                                                        |
| Error, success, warning | 5.9:1, 7.8:1, 8.1:1                                          |
| Code colors             | 6.8:1 to 8.7:1 on the code ground                            |

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
