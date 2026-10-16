# Browser modules

A browser module adds rail buttons, pages, sheets, menu rows, and launcher actions to the app.

`web.client(entry, { access })`. `entry` is the name of a file or folder right beside the module (letters, digits, `.`, `_`, and `-`, starting with a letter, a digit, or `_`), not a link: a `.js` or `.mjs` file, served alone, or a folder, whose `index.js` loads first and may import the folder's other files. A folder serves its `.js`, `.mjs`, `.css`, `.json`, images, and fonts, never `.ts` files, hidden files, `node_modules`, or anything reached through a link (a link could lead to any of those, or out of the folder). A stylesheet or any other file needs a folder: a file alone serves only itself. A file is served up to 8 MB. When the file or folder goes, or becomes a link, the owner is told: tabs cannot load it until it is back. Everyone the browser module is for can read every file of those types in its folder: keep nothing secret there, and keep a module's own data (a cache, settings) elsewhere, such as beside the module or in its own folder under the data folder.

Saving a file the folder serves, in it or in a folder made in it later, gives the browser module a new address, and tabs load it again. Files of other types (`.log`, `.txt`) do not count, so writing one loads nothing again; a `.json` or an image does count. The version in the address is only for that: any version serves the files as they are now. The first 2000 files it serves, in up to 500 folders, count; an edit past those gives no new address, so open tabs keep the version they loaded until the page reloads. Its first 64 folders are watched; an edit deeper is seen at the next look, when something watched changes or the module loads again.

The app imports it and calls its default export with `pocket`. What that returns, if a function, runs when the module goes, as `pocket.onDispose` does.

```javascript
export const pocketApi = 1;

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    function Usage() {
        const [usage, setUsage] = useState(null);
        const [error, setError] = useState(null);

        useEffect(() => {
            const stop = new AbortController();

            pocket.api("usage", undefined, { signal: stop.signal }).then(setUsage, (failure) => {
                if (!stop.signal.aborted) {
                    setError(failure.message);
                }
            });

            return () => stop.abort();
        }, []);

        if (error) {
            return html`<div class="error-box">${error}</div>`;
        }

        return usage ? html`<p>${usage.total} tokens today</p>` : html`<${pocket.Loader} />`;
    }

    pocket.page({ id: "usage", title: "Usage", component: Usage });
    pocket.rail({ id: "usage", title: "Usage", icon: "pulse", page: "usage" });
}
```

The members of `pocket` are in [the reference](reference/pocket.md).

Each thing it adds has an `id` of its own (up to 64 letters, digits, and `. _ : -`, starting with a letter or digit), and adding one with the same `id` again replaces it. `update(patch)` takes an object. Adding the same again, or an update that changes nothing, draws nothing again; values count as the same only when they are the very same (a new array or function is a change), and many changes at once draw once. What a module changes draws at the next frame, once for all its changes since, so its changes cost the app at most one redraw a frame, at any refresh rate, as an animation does; a hidden tab, which draws no frames, draws them by a 100 ms timer, which the browser may slow there. Change what it added from an event, a timer, or an effect, not while a component draws, and give effects their dependencies: a module that changes what it added each time it draws, or each time an effect of its drawing runs, is not stopped, and redraws the app every frame until it is turned off. A module is stopped in that browser as one that failed ("was stopped in this browser: it redraws without end"), until the page reloads or the module is edited, when:

- one task makes more than 1000 calls to `pocket` (any of it but `h`, `html`, `Fragment`, the hooks, and the components) over more than a second: a loop of microtasks, which holds the page, and a long batch with heavy work between its calls alike. Its calls then throw until the next task, `pocket.api` too, so an `await` loop rejects and a `.then` chain stops;
- it opens and closes its pages or sheets more than 300 times in a second, or over and over with no task between (more than 1000 times, or 5 or more over more than a second).

A new function or array given each time counts as a change each time. A loop that never yields and calls nothing of `pocket` holds the tab, as does one that catches the error a stopped module's calls throw, and nothing outside it can stop either.

- `rail({ id, title, icon or iconPath, badge, … })`: a button on the rail after the app's own tools, in the sidebar, the drawer, and a phone's home screen. They take at most four buttons' height, and scroll past that. `icon` is one of the app's (`pulse`, `grid`, `globe`, `key`, `chat`, `folder`, `search`, …; an unknown name shows `grid`); `iconPath` is a 24×24 stroked SVG path of its own. `badge` is a short count or word on it: `0`, `NaN`, `-Infinity`, `""`, `"0"`, `null`, and `false` show none, as the app's own counts hide at 0; a count past 99 (and `Infinity`) shows "99+", other numbers (negative, or with decimals) show as they are, and text past 24 characters is cut to 23 and "…", in its label too, without cutting a character in two.
- `menu({ id, label, hint, … })` is a row in the menu's App group; `launcher({ id, label, detail, icon or iconPath, keywords, … })` an action in the launcher (Ctrl/⌘+K).
- Each of those three does one thing when used: `page: "id"` opens a page, `sheet: "id"` a sheet (the id of one the module adds), `run: () => …` runs a function. A rail button that opens a page shows it is open, and closes it on a second tap. Modules' buttons, rows, and actions show in the order the server lists the modules, and an edit keeps a module's place.
- `page({ id, title, component, escape, swipe })` shows in the conversation's place, as the subagents board does, with its title and a close button; Esc and back close it, and on a phone it fills the screen. On a touch screen up to 699 px wide a swipe to the right on it goes back (not in a field or a sideways scroller), and in an app added to an iPhone's or iPad's home screen so does a swipe in from the left edge. `escape: false` keeps Esc for the page (Esc still closes a sheet, the launcher, or PiP over it; the close button and back still close the page). `swipe: false` starts no back swipe anywhere on the page, the edge's included, and a `data-no-swipe` attribute on an element starts none on it or in it (a slider, a canvas you draw on). Esc never closes it while an input method composes a character.
- `sheet({ id, title, component, wide })` is a sheet like the app's. Their components get `pocket` and `close`, and a sheet's the `props` it was opened with. `close` closes only that page or sheet, of that version, while it shows: kept for later, it closes nothing else (`pocket.closePage()` closes whichever page of the module shows). A page or sheet whose module never added that id says the module no longer has it.

The pieces take what the app's own do: `Icon({ name or path, size })`, `Loader({ label })`, `Spinner({ label })`, `Markdown({ text })`, `Switch({ on, label, onChange, disabled })`. To look like the app, use its colors, `var(--text)`, `var(--muted)`, `var(--accent)`, `var(--bg)`, `var(--card)`, `var(--line)`, `var(--err)`, `var(--warn)`, and `var(--ok)`, which follow the theme, and these classes: `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting` (a row with a label and a control). Pi Pocket keeps those names; the rest of its CSS may change.

It fails alone. A module that throws while it loads or sets up says so in a notice and in Menu → Extensions ("In this browser: …"), and what it added goes; what it tries later (a timer it left) adds and opens nothing, and its `onDispose` runs at once. A page or sheet whose component, or a component in it, throws, whatever it throws (nothing at all shows "it gave no reason"; throw an `Error` all the same: nothing thrown from a class's constructor, a method that is a getter, or an effect's cleanup when it goes may escape that, and from a lifecycle method that is a class field, such as `componentWillMount = () => …`, as the component first draws, the box shows Preact's own words), shows "… failed:" and why in its place until it is closed or its component is replaced (added again, or `update({ component })`), and a `run` that throws or rejects says so in a notice. What an event handler in a component throws is caught by nothing but the browser's console: catch it there, and show what went wrong. The rest of the app goes on. An edit loads it again; a module that failed to import for another reason (the network) loads again when the page reloads. Turning a module off closes its page and sheet, and back does not bring its sheets back.

**Safe mode.** A browser module that hangs or breaks the tab would keep you from the Extensions sheet, where you turn it off. Open the app with `?noext=1` on its address (any of its pages: `https://…/?noext=1`; on a sign-in link, as where to go next: `/login?token=…&next=/?noext=1`) and that tab loads no browser modules: a notice says so, and the Extensions sheet, where each module this tab would load says "off in this tab", has a button to load them again. The tab keeps it through reloads (in its session storage, `pocket.noext`), other tabs do not, and `?noext=0` (or `false`, `off`, `no`) ends it. An app added to a home screen has no address bar: open the address in the browser instead. The server part of each module still runs: turn the bad one off there, then leave safe mode.

The page allows nothing from another site (the app's content security policy: scripts and requests only to the app itself). To show what another service knows, fetch it in a route, on the server, where its key stays.
