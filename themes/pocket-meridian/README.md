# Pocket Meridian

Pi Pocket's in-house theme for 0.15: a prototype in the planned theme format ([docs/design/theming.md](../../docs/design/theming.md)), written against its tokens and `data-part` names. [FINDINGS.md](FINDINGS.md) says what the prototype found out about that design.

## The idea

**One line through everything.** A thin rule, the meridian, runs down the conversation, and every turn hangs from it: your messages are stations with your initials, Pi's answers are marked π, and each tool call is a stop on the same line, so a turn reads from top to bottom as one route. While Pi works, the line takes the **signal**: Hyprland's active border, from the accent to green (Omarchy's default `#33ccff → #00ff99`). The signal marks only what has the focus or the action: the focused window, the open session, the message box, Send, the line while Pi works. All else is quiet: corners cut square, 1px rules, no soft shadows, one flat ink. The type is Mona Sans for words, in its wide cut for headings, and Mona Sans Mono for code, paths, numbers, and small labels.

## Layout: five changes that are more than colors

1. **The conversation on a meridian.** Messages are no longer cards. A gutter holds the line and a node for each turn: your initials, π, the tool calls' marks (the activity group moves out into the gutter so that its marks land on the line), and the live line's dot. More of the conversation fits on a phone.
2. **A docked command line.** The message box is not a floating card: it is a band across the whole pane, a rule on top, its column as wide as the conversation's, with a `❯` before the text. With the focus, the rule fills with the signal from its start. The status line is the band's last row, at its start, in mono.
3. **Inspector sheets.** On screens 700px wide or more, sheets stand at the right edge, the full height, beside the conversation (480px; wide sheets 640px at most), under a light scrim. Phones keep the bottom sheet, with the signal along its top edge.
4. **A drop-down launcher.** Ctrl/⌘+K drops a wide, flat console from the top edge, as a drop-down terminal does, with the signal along its foot.
5. **A departure board for home.** The fastfetch becomes the brand's π, large, over Omarchy's boot bar in the signal; the facts are a ruled spec sheet; the palette is one strip; Jump back in is a table with large numbers. The product site's grid paper fades in behind it.

Smaller ones: the session tabs are tabs on a rule with a signal underline; group heads are mono labels on a rule; the open session and the rail's open tool get a signal bar on their edge instead of a fill; linked sessions' branches are 1px with square elbows.

## Palette

Colors mix from the palette (the `--o-*` variables that Colors sets), so the layout works with every palette. Meridian's own:

| Role        | Night (`colors.toml`) | Day (`colors-light.toml`) |
| ----------- | --------------------- | ------------------------- |
| Desk        | `#06070a`             | `#dde1e7`                 |
| Sidebar     | `#0a0c11`             | `#eceef2`                 |
| Ground      | `#0e1117`             | `#f5f6f8`                 |
| Text        | `#eef2f7`             | `#0b0e14`                 |
| Body        | `#b4bdcc`             | `#2a303c`                 |
| Accent      | `#3cc8ff`             | `#0868a8`                 |
| Signal to   | `#2fe39b` (green)     | `--ok`, from `#0b7d52`    |
| π (brand)   | `#ff9e64`             | `#bf5a12`                 |
| Red, yellow | `#ff6b7f`, `#ffc65c`  | `#c42841`, `#a36b00`      |

Contrast, measured in the browser on the rendered tokens (WCAG 2): with both Meridian palettes, text, body, muted, and faint text are 4.5:1 or more on every surface (Night: text 15.0–17.4, body 9.5–10.0, muted 5.7–6.6, faint 4.8–5.6; Day: text 15.9–17.9, body 12.2–12.8, muted 7.1–8.0, faint 5.7–6.4); the accent is 9.8–10.2 (Night) and 5.1–5.5 (Day); the ink on the signal fill (Send, New session) is 9.8–11.3 (Night) and 5.9–6.4 (Day); the focus ring is 9.8 and 5.5. The theme raises `--muted` and `--faint`, which the soft tiles derive at 3.8 and 2.3 on Tokyo Night.

## Type

- **Mona Sans** (variable: width 75–125%, weight 200–900, optical size) and **Mona Sans Mono** (variable weight), by GitHub, v2.0.27, from [github.com/github/mona-sans](https://github.com/github/mona-sans). Licence: SIL Open Font License 1.1, in `fonts/MonaSans-OFL.txt`, with the Reserved Font Name "Mona".
- The files are the project's own web fonts, **unmodified** (only renamed: `MonaSansVF[wdth,opsz,wght].woff2` and `MonaSansMonoVF[wght].woff2`). A subset would be a Modified Version, which may not carry the name "Mona". The CSS calls them "Meridian Sans" and "Meridian Mono"; that is a family name for `@font-face`, not a change to the fonts.
- Sizes: 308 KB and 39 KB. SHA-256 (the same as the release's files):
    - `MonaSansVF.woff2`: `875ad1fab0c1f4854927fa8086963fb6ddd4608b04a58b267cddf8a9d78f80d3`
    - `MonaSansMonoVF.woff2`: `034552e40f30aab5d5b4ede4d4f29fd38c3b93d923fcec90775fd488276122ef`
- Glyphs they lack (block and box drawing, ✦, ⑂, ❯, ⌘) fall back to the app's own Geist and JetBrains Mono.
- Headings use the wide cut (`font-stretch` 112–125%) at weights 650–800. Small labels (group heads, authors, a code block's language) are mono, 10.5px, in capitals with wide spacing.

## Shapes, depth, motion

- Corners: 1–4px for marks, tags, rows, controls, and cards; 6px for windows and sheets; 8px for floats. Avatars and dots stay round.
- Depth: none at rest. What floats (sheets, the launcher, menus) gets a 1px rule and one hard shadow.
- Motion: short and crisp (`--t-in` 280ms): inspectors slide 28px, the launcher drops 36px, the band's rule fills from its start. One thing moves on its own: while Pi works, a light runs down the line to the live line. With reduced motion (the system's or Appearance's, both `data-motion="reduced"`), it holds still, and the app's own rule cuts every other animation.

## Files

| File                                                   | What                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `theme.json`                                           | The manifest                                                                                   |
| `theme.css`                                            | The entry: imports the rest                                                                    |
| `fonts.css`, `tokens.css`                              | The fonts; the tokens, dark and light                                                          |
| `frame.css`                                            | Windows, the rail, the session list, the top bar, the home screen                              |
| `conversation.css`, `composer.css`                     | The meridian; the docked command line                                                          |
| `layers.css`, `motion.css`                             | Sheets, the launcher, menus, notices; motion                                                   |
| `bridge.css`                                           | Prototype only: the planned `--focus-ring`, until the app reads it                             |
| `colors.toml`, `colors-light.toml`                     | Meridian Night and Meridian Day. The planned format reads only `colors.toml` (see FINDINGS.md) |
| `fonts/MonaSansVF.woff2`, `fonts/MonaSansMonoVF.woff2` | The fonts, and `fonts/MonaSans-OFL.txt`, their licence                                         |

All CSS together is 31 KB. It uses no JavaScript, loads nothing remote, and puts no words in `content:` (only `π` and `❯`, each with empty alternative text, so screen readers skip them).
