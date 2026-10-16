# The theme surface

What a theme may rely on, at theme API version 1: the tokens (CSS variables), the parts (`data-part` names), their states, and the page's own attributes. [../themes.md](../themes.md) is the guide. `web/theme-surface.js` lists the tokens and parts, and `test/theme-surface.test.ts` checks that each one is still there.

This page is the one full list of the CSS names Pi Pocket keeps. Everything else in the app's CSS and markup (class names, the order of elements) may change in any release.

## Extensions' CSS names

The CSS names extensions may use are a subset of this page: the tokens `--text`, `--muted`, `--accent`, `--bg`, `--card`, `--line`, `--err`, `--warn`, and `--ok`, and the classes `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting`. A theme that changes those tokens changes extensions' pages with the app.

## Tokens

Set them on `:root` in a theme. Most are made from others: a theme that sets `--bg`, `--body`, or `--accent` moves the ones made from them too.

### The palette

Set by Colors (`colors.toml`, an Omarchy palette, or the desktop's). A theme reads them, and may set them, though a `colors.toml` is the better place.

| Token                                                                                     | `colors.toml` key                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `--o-bg`, `--o-bg-dark`, `--o-bg-darker`, `--o-bg-light`                                  | `background`, `dark_background`, `darker_background`, `lighter_background`            |
| `--o-fg`, `--o-fg-dim`, `--o-fg-light`, `--o-fg-bright`                                   | `foreground`, `dark_foreground` (or `muted`), `light_foreground`, `bright_foreground` |
| `--o-accent`, `--o-selection`                                                             | `accent`, `selection`                                                                 |
| `--o-red`, `--o-yellow`, `--o-orange`, `--o-green`, `--o-cyan`, `--o-blue`, `--o-magenta` | the same names                                                                        |

### Surfaces, lines, and text

| Token                     | What                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| `--desk`                  | Behind the tiled windows (`--o-bg-darker`)                             |
| `--bg`, `--panel`         | The windows' ground, and the sidebar's (`--o-bg`)                      |
| `--card`, `--card-2`      | Cards and fields, a little and a little more raised from `--bg`        |
| `--raised`                | A selected segment in its track                                        |
| `--hover`, `--pressed`    | Laid over a control under the pointer, and while it is pressed         |
| `--scrim`                 | Behind a sheet                                                         |
| `--code-bg`               | Code blocks (`--o-bg-dark`)                                            |
| `--line`, `--line-strong` | Lines between things                                                   |
| `--edge`                  | A see-through line                                                     |
| `--hair`, `--hair-2`      | The 1px hairlines, and the stronger one of fields and a switch's track |
| `--text`                  | Titles and strong text (`--o-fg-bright`)                               |
| `--body`                  | Running text (`--o-fg`); the surfaces and lines mix from it            |
| `--muted`, `--faint`      | Quieter text, and quieter still                                        |

### Accent and status

| Token                                                                            | What                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `--accent`                                                                       | The accent (`--o-accent`)                                                    |
| `--accent-fill`, `--accent-ink`                                                  | The accent under text (buttons, badges), and the text on it                  |
| `--accent-soft`, `--accent-line`                                                 | The accent as a soft fill, and as a line                                     |
| `--focus-ring`                                                                   | The keyboard's focus ring (`--accent`). Change its color; keep the ring      |
| `--spark`, `--brand`                                                             | The second color of loaders and thoughts; the π mark                         |
| `--ok`, `--ok-soft`                                                              | Done, worked                                                                 |
| `--warn`, `--warn-soft`, `--warn-line`                                           | Waits for you, needs a look                                                  |
| `--err`, `--err-soft`, `--err-line`                                              | Failed                                                                       |
| `--hl-kw`, `--hl-str`, `--hl-num`, `--hl-fn`, `--hl-type`, `--hl-op`, `--hl-tag` | Code's colors: keywords, strings, numbers, functions, types, operators, tags |

### Type, corners, space, shadows, motion

| Token                                                          | Default                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--sans`, `--mono`                                             | Geist for words; JetBrains Mono for code, paths, counts, keys                                               |
| `--r-mark`, `--r-tag`, `--r-seg`, `--r-row`, `--r-control`     | 3, 5, 7, 9, 10 px: state squares, tags, segments, rows, fields                                              |
| `--r-card`, `--r-window`, `--r-sheet`, `--r-float`, `--r-pill` | 12, 14, 18, 20, 999 px: cards, windows, sheets, PiP, pills                                                  |
| `--radius`                                                     | A control's corner that names none (`--r-control`)                                                          |
| `--gap-out`, `--gap-in`, `--border`                            | 8, 4, 1 px: the tiled windows' gaps and border                                                              |
| `--space-x`, `--space-y`, `--leading`                          | Density's scale of room (1, 1) and the conversation's line height (1.65)                                    |
| `--transcript-width`, `--composer-width`                       | 720 px and 768 px: the conversation and the message box at their widest                                     |
| `--wallpaper`                                                  | `none`: what shows in the gaps between tiled windows. The desktop's wallpaper wins when Appearance shows it |
| `--sh`, `--shadow`, `--pop`                                    | The shadow color; a soft lift; what floats (sheets, menus, the launcher)                                    |
| `--ease-out`, `--ease-in-out`, `--ease-almost`                 | Hyprland's curves                                                                                           |
| `--t-in`, `--t-out`, `--t-fade`, `--t-border`, `--t-hover`     | 410, 150, 175, 540, 140 ms                                                                                  |

Most corners in the app are these tokens, some a pixel or two from one (`calc(var(--r-row) - 1px)`), so they follow when a theme changes the scale.

### Set by the person

Read them; a theme cannot change them, as they are each person's choice in Appearance.

| Token         | What                                      |
| ------------- | ----------------------------------------- |
| `--text-size` | The conversation's text size, 13 to 17 px |
| `--sidebar-w` | The open sidebar's width, as dragged      |

## Parts

Each is a `data-part` attribute. Select one with `[data-part="name"]`.

### The frame

| Part             | What                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| `app`            | The whole layout: the sidebar, the conversation, and the panels beside it, in a row |
| `sidebar`        | The rail and the session list, on wide screens                                      |
| `rail`           | The column of buttons: Pi, the tools, you                                           |
| `rail-button`    | Each of its buttons, an extension's too                                             |
| `session-list`   | The session list: its head, search, tabs, and rows                                  |
| `session-search` | The search field                                                                    |
| `session-tabs`   | Recent, Folders, Archived                                                           |
| `session-group`  | A group of rows (a day, a folder)                                                   |
| `session-row`    | One session's line                                                                  |
| `home`           | The home screen on wide screens                                                     |
| `home-list`      | The session list as a phone's home screen                                           |
| `pane`           | The conversation's window (or the subagents board, or an extension's page)          |
| `topbar`         | The conversation's title bar                                                        |

### The conversation

| Part            | What                                                |
| --------------- | --------------------------------------------------- |
| `transcript`    | The column of turns                                 |
| `prompt`        | A person's message                                  |
| `reply`         | Pi's answer                                         |
| `reply-actions` | The row under an answer: react, discuss, pin, copy  |
| `activity`      | A group of what Pi did: its thoughts and tool calls |
| `thinking`      | A thought, in the group                             |
| `tool-call`     | A tool call, in the group                           |
| `approval`      | A call that waits for someone to allow it           |
| `live-line`     | The line that says what Pi does now                 |
| `code-block`    | A code block in a reply                             |

### The composer

| Part             | What                                                    |
| ---------------- | ------------------------------------------------------- |
| `composer`       | All of it, under the conversation                       |
| `dock`           | What sits above the message box: the queue and the bars |
| `subagents-bar`  | The subagents' bar                                      |
| `message-box`    | The box you type in, with its buttons                   |
| `composer-tools` | The row of buttons in it                                |
| `model-chip`     | The model's button                                      |
| `send-button`    | Send                                                    |
| `status-line`    | The line under the box: who is here, context, cost      |

### Layers over the app

| Part                       | What                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sheet`                    | A sheet: a bottom sheet on phones, a window on wide screens. `data-sheet` says which (`appearance`, `menu`, `model`, …; `ext` for an extension's) |
| `sheet-head`, `sheet-body` | Its title bar, and what it holds                                                                                                                  |
| `menu`                     | The menu, on wide screens (it is the sheet `menu` on phones)                                                                                      |
| `launcher`                 | The launcher (Ctrl/⌘+K)                                                                                                                           |
| `notices`, `notice`        | The notices, and each one                                                                                                                         |

## States

| Where                               | Attribute                                        | Values                                                                                   |
| ----------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `session-row`                       | `data-state`                                     | `working`, `waiting` (for you), `failed`, `done` (since you looked), `idle`              |
| The open session's row (its button) | `aria-current`                                   | `page`                                                                                   |
| `tool-call`                         | `data-state`                                     | `running`, `ok`, `failed`, `waiting` (for approval), `denied`, `stopped`                 |
| `prompt`                            | `data-from`                                      | `me`, `person` (someone else), `other` (Pi's schedule, a linked session, the main agent) |
| `sheet`                             | `data-sheet`                                     | The sheet's type                                                                         |
| Buttons and tabs                    | `aria-pressed`, `aria-expanded`, `aria-selected` | As accessibility needs them                                                              |

## The page

On `<html>`:

| Attribute      | Values                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `data-mode`    | `dark` or `light`: the colors' mode                                                                |
| `data-theme`   | The theme in use: `pocket`, or a theme folder's id                                                 |
| `data-colors`  | The colors in use: `desktop`, a palette's id, or a folder's                                        |
| `data-tiling`  | `on` or `off`: tiled windows on wide screens                                                       |
| `data-rail`    | `on` when the sidebar is folded to the rail                                                        |
| `data-density` | `comfortable`, `compact`, or `tight`                                                               |
| `data-motion`  | `full` or `reduced`                                                                                |
| `data-focus`   | The window in focus on wide screens: `sidebar`, `pane`, `peeks`, `people`, `browser`, `files-tile` |

Widths: below 700 px is the phone layout (sheets from the bottom, one screen at a time); the sidebar shows from 960 px; from 1100 px the Files tile and the Browser panel sit beside the conversation.

## Layers

`@layer pocket, palette, theme;`: the app's CSS and extensions' stylesheets, then the colors, then the theme. Later layers win over earlier ones, whatever the selectors' specificity. `!important` reverses that: the app's `!important` rules win over a theme's. Inline values win over all of them: the text size and the widths people drag.

## Changes

These names change by the deprecation rules of [the API policy](../policies/api-stability.md#deprecation):

- **Additions** (a new token, part, state, or value) come in any minor release, with no change to `themeApi`. A theme that needs one sets `minPocket` to the release that added it.
- **A rename or a removal** first keeps the old name as an alias: `--old: var(--new)` in the app's CSS, or both names in `data-part` (`data-part="new old"`). The alias stays for at least one minor release and at least 90 days, from the first stable release that deprecates it, whichever is later. This page and the release notes mark it deprecated, with its replacement and its earliest removal.
- **The removal** comes only in a minor release after that time, and raises `themeApi` by one. The release notes list it under "Removed", with what to use instead.
