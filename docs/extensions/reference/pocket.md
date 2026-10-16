# pocket

The app imports it and calls its default export with `pocket`. What that returns, if a function, runs when the module goes, as `pocket.onDispose` does.

## Members

### `version`, `module`, `title`

Since 0.14.0 · Stable

The API's version (1); the module's name; its title

### `html`, `h`, `Fragment`, `useState`, `useEffect`, and the hooks

Since 0.14.0 · Stable

The app's own Preact and htm: a component of the module's renders as the app's do

### `Icon`, `Loader`, `Spinner`, `Markdown`, `Switch`

Since 0.14.0 · Stable

The app's pieces, so the module looks like the rest of the app. `Markdown` cleans the HTML it makes, as replies' does

The pieces take what the app's own do: `Icon({ name or path, size })`, `Loader({ label })`, `Spinner({ label })`, `Markdown({ text })`, `Switch({ on, label, onChange, disabled })`.

### `api`

Since 0.14.0 · Stable

`api(path, body?, { method, signal })`: Call one of the module's routes: a GET without `body`, a POST with one; a query string in `path` reaches `query`. `signal` stops it. Rejects with an error with the server's words (and its `status`), or at once for a path that would leave the module's routes: a `.` or `..` part, a leading `//`, or a scheme

### `on`

Since 0.14.0 · Stable

`on(event, run)`: Hear an event the module sends; returns how to stop

### `rail`, `menu`, `launcher`, `page`, `sheet`

Since 0.14.0 · Stable

Add a button on the rail, a row in the menu, a launcher action, a page, or a sheet (below). Each returns `{ update(patch), remove() }`

- `rail({ id, title, icon or iconPath, badge, … })`: a button on the rail after the app's own tools, in the sidebar, the drawer, and a phone's home screen. They take at most four buttons' height, and scroll past that. `icon` is one of the app's (`pulse`, `grid`, `globe`, `key`, `chat`, `folder`, `search`, …; an unknown name shows `grid`); `iconPath` is a 24×24 stroked SVG path of its own. `badge` is a short count or word on it: `0`, `NaN`, `-Infinity`, `""`, `"0"`, `null`, and `false` show none, as the app's own counts hide at 0; a count past 99 (and `Infinity`) shows "99+", other numbers (negative, or with decimals) show as they are, and text past 24 characters is cut to 23 and "…", in its label too, without cutting a character in two.
- `menu({ id, label, hint, … })` is a row in the menu's App group; `launcher({ id, label, detail, icon or iconPath, keywords, … })` an action in the launcher (Ctrl/⌘+K).
- Each of those three does one thing when used: `page: "id"` opens a page, `sheet: "id"` a sheet (the id of one the module adds), `run: () => …` runs a function. A rail button that opens a page shows it is open, and closes it on a second tap. Modules' buttons, rows, and actions show in the order the server lists the modules, and an edit keeps a module's place.
- `page({ id, title, component, escape, swipe })` shows in the conversation's place, as the subagents board does, with its title and a close button; Esc and back close it, and on a phone it fills the screen. On a touch screen up to 699 px wide a swipe to the right on it goes back (not in a field or a sideways scroller), and in an app added to an iPhone's or iPad's home screen so does a swipe in from the left edge. `escape: false` keeps Esc for the page (Esc still closes a sheet, the launcher, or PiP over it; the close button and back still close the page). `swipe: false` starts no back swipe anywhere on the page, the edge's included, and a `data-no-swipe` attribute on an element starts none on it or in it (a slider, a canvas you draw on). Esc never closes it while an input method composes a character.
- `sheet({ id, title, component, wide })` is a sheet like the app's. Their components get `pocket` and `close`, and a sheet's the `props` it was opened with. `close` closes only that page or sheet, of that version, while it shows: kept for later, it closes nothing else (`pocket.closePage()` closes whichever page of the module shows). A page or sheet whose module never added that id says the module no longer has it.

Each thing it adds has an `id` of its own (up to 64 letters, digits, and `. _ : -`, starting with a letter or digit), and adding one with the same `id` again replaces it. `update(patch)` takes an object.

### `toolCall`

Since 0.14.0 · Stable

`toolCall({ tool, icon or iconPath, label, subject, summary })`: Say how calls of one of the module's tools show in transcripts and peek tiles (below). Returns `{ remove() }`

- `toolCall({ tool, icon or iconPath, label, subject, summary })` says how calls of one of the module's own tools show, by their arguments. Without it, a tool's call shows as its name and its arguments as JSON. `label(args)` gives the call's line its words (`"start session"`), `subject(args)` what it acts on, and `summary(args)` how a group of calls counts it, as `{ verb, noun, by }`: calls count by the value of their `by` argument, so `{ verb: "messaged", noun: "session", by: "to" }` makes "messaged 2 sessions" for calls to two addresses, however many there are; a kind without `noun` is only its verb ("checked linked sessions"). `icon` or `iconPath` is its icon in peek tiles, as a rail button's. Each gets a copy of the arguments, and what it gives shows as one line of text, never HTML. One that throws, or gives something else than text (or such a kind), leaves the call to the default display; its error is in the browser's console. `tool` must be one the module's own extensions install, by the exact name Pi runs it by (the server lists them with the browser module): any other is refused, so no module changes how another's calls show. From a server older than that list, it does nothing, and calls show the default way. It goes with the version that added it.

### `openPage`, `closePage`, `openSheet`, `closeSheet`

Since 0.14.0 · Stable

`openPage(id)`, `closePage()`, `openSheet(id, props)`, `closeSheet()`: Show or close the module's own page or sheet; a sheet's component gets `props` (an object). Opening a page closes the sheet or launcher over it. A version that is gone or failed opens and closes nothing

### `notify`

Since 0.14.0 · Stable

`notify(level, message)`: A notice, as the app's own: `info`, `warning`, or `error`. At most 5 every 5 s for a module, its versions together (its failing actions and stylesheets count too); the rest are dropped. A version that is gone or failed sends none

### `me`, `conversationId`

Since 0.14.0 · Stable

`me()`, `conversationId()`: Who uses this tab (`{ id, name, role }`); the session it shows, or null

### `style`

Since 0.14.0 · Stable

`style(path)`: Load a stylesheet from the browser module's folder; it goes with this version. A path outside the folder throws; one that does not load says so in a notice. A browser module of one file has no folder for it

### `onDispose`

Since 0.14.0 · Stable

`onDispose(run)`: Run `run` when this version goes: an edit, or the module turned off. Once it is gone or failed, at once

## CSS names Pi Pocket keeps

To look like the app, use its colors, `var(--text)`, `var(--muted)`, `var(--accent)`, `var(--bg)`, `var(--card)`, `var(--line)`, `var(--err)`, `var(--warn)`, and `var(--ok)`, which follow the theme, and these classes: `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting` (a row with a label and a control). Pi Pocket keeps those names; the rest of its CSS may change.
