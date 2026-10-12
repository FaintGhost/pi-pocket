// Extensions' browser modules. An extension module can give the app one (`web.client` on the server): it loads here, in
// the tabs of the people it is for, and its default export gets `pocket`, the app's API for extensions. With it, it adds
// rail buttons, menu rows, launcher actions, pages in the conversation's place, and sheets, calls its own routes, and
// hears its module's events. What it added goes when it reloads or is turned off; one that fails says why, and the app
// goes on without it.
import { Component, Fragment, h } from "preact";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "preact/hooks";
import { useBack } from "./back.js";
import { api, closeSheet, notify, onExtensionEvent, openSheet, store } from "./store.js";
import { html, Icon, iconPath, Loader, Markdown, Sheet, Spinner, Switch } from "./ui.js";

/**
 * The version of `pocket`. It goes up only when something extensions use changes in a way that breaks them; additions
 * keep it. The server's `web.api` is the same number.
 */
export const POCKET_API = 1;

/** What a browser module can add, each kept by its id. */
const KINDS = ["rail", "menu", "launcher", "page", "sheet"];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const LEVELS = new Set(["info", "warning", "error"]);

/**
 * Each browser module this tab loads, by module name: its address and title, whether it is `loading`, `ready`, or
 * `failed` (and why), what it added, its cleanups, the events it listens to, and its `pocket`.
 */
const modules = new Map();

const redraw = () => store.set((state) => ({ extensionsRev: state.extensionsRev + 1 }));

// ─── Loading ─────────────────────────────────────────────────────────────────

/** The list the tab loaded last, as a key: the server sends hello again for many reasons. */
let loadedKey = null;

store.subscribe((state) => {
    const list = state.me ? (state.server?.ui ?? []) : [];
    const key = list.map((each) => `${each.module}@${each.url}`).join("\n");

    if (key === loadedKey) {
        return;
    }

    loadedKey = key;
    // Not inside the store's own round of listeners: loading changes the store too.
    queueMicrotask(() => sync(list));
});

/** Load what the server lists, and unload what it no longer does or lists at a new address (a new version). */
function sync(list) {
    const wanted = new Map(list.map((each) => [each.module, each]));

    for (const record of [...modules.values()]) {
        if (wanted.get(record.module)?.url !== record.url) {
            unload(record);
        }
    }

    for (const entry of list) {
        if (!modules.has(entry.module)) {
            void load(entry);
        }
    }

    // A page or sheet of a module that went closes; one of a module coming back in a new version waits for it.
    const { page, sheet } = store.state;

    if (page && !wanted.has(page.module)) {
        store.set({ page: null });
    }

    if (sheet?.type === "ext" && !wanted.has(sheet.module)) {
        closeSheet();
    }

    redraw();
}

async function load(entry) {
    const record = {
        module: entry.module,
        title: entry.title,
        url: entry.url,
        status: "loading",
        error: null,
        adds: Object.fromEntries(KINDS.map((kind) => [kind, new Map()])),
        disposers: [],
        listeners: new Set(),
        gone: false,
    };

    record.pocket = pocketFor(record);
    modules.set(entry.module, record);
    redraw();

    try {
        const loaded = await import(entry.url);

        if (record.gone) {
            return;
        }

        const needs = loaded.pocketApi;

        if (needs !== undefined && !(typeof needs === "number" && needs <= POCKET_API)) {
            throw new Error(
                `it needs version ${needs} of the app's extension API, and this app has ${POCKET_API}`,
            );
        }

        if (typeof loaded.default !== "function") {
            throw new Error("it has no default export function");
        }

        const dispose = await loaded.default(record.pocket);

        if (typeof dispose === "function") {
            record.disposers.push(dispose);
        }

        // Replaced or turned off while it started: what it set up goes.
        if (record.gone) {
            teardown(record);

            return;
        }

        record.status = "ready";
    } catch (error) {
        if (record.gone) {
            return;
        }

        teardown(record);
        record.status = "failed";
        record.error = error?.message ?? String(error);
        console.error(`${entry.title}'s browser module failed to load`, error);
        notify("error", `${entry.title} failed to load in this browser: ${record.error}`);
    }

    redraw();
}

function unload(record) {
    record.gone = true;
    modules.delete(record.module);
    teardown(record);
}

/** Take away what a browser module added, and run its cleanups, last first. */
function teardown(record) {
    for (const kind of KINDS) {
        record.adds[kind].clear();
    }

    record.listeners.clear();

    for (const dispose of record.disposers.splice(0).reverse()) {
        try {
            dispose();
        } catch (error) {
            console.error(`${record.title}: a cleanup failed`, error);
        }
    }
}

// Events from the server: to the listeners of the module that sent them.
onExtensionEvent(({ module, event, data }) => {
    const record = modules.get(module);

    for (const listener of [...(record?.listeners ?? [])]) {
        if (listener.event !== event) {
            continue;
        }

        try {
            listener.run(data);
        } catch (error) {
            console.error(`${record.title}: a listener for ${event} failed`, error);
        }
    }
});

// ─── pocket: the app's API for a browser module ──────────────────────────────

/** What each kind needs besides its `id`, and the one thing it does when used, if it is used. */
function check(kind, spec) {
    const name = `pocket.${kind}`;

    if (typeof spec !== "object" || spec === null) {
        throw new Error(`${name}: give it an object`);
    }

    if (typeof spec.id !== "string" || !ID.test(spec.id)) {
        throw new Error(`${name}: an id is up to 64 letters, digits, and . _ : -`);
    }

    const text = (field) => {
        if (typeof spec[field] !== "string" || spec[field].trim() === "") {
            throw new Error(`${name} ${spec.id}: give it a ${field}`);
        }
    };

    if (kind === "rail" || kind === "page" || kind === "sheet") {
        text("title");
    } else {
        text("label");
    }

    // What the app's own screens draw must be what they expect: a wrong type would fail where no boundary catches it.
    for (const field of ["hint", "detail", "icon", "iconPath"]) {
        if (spec[field] !== undefined && typeof spec[field] !== "string") {
            throw new Error(`${name} ${spec.id}: ${field} is text`);
        }
    }

    if (
        spec.badge !== undefined &&
        spec.badge !== null &&
        typeof spec.badge !== "string" &&
        typeof spec.badge !== "number"
    ) {
        throw new Error(`${name} ${spec.id}: a badge is a number or short text`);
    }

    if (
        spec.keywords !== undefined &&
        !(Array.isArray(spec.keywords) && spec.keywords.every((each) => typeof each === "string"))
    ) {
        throw new Error(`${name} ${spec.id}: keywords are a list of words`);
    }

    if (kind === "page" || kind === "sheet") {
        if (typeof spec.component !== "function") {
            throw new Error(`${name} ${spec.id}: give it a component to show`);
        }

        return;
    }

    const does = ["page", "sheet", "run"].filter((field) => spec[field] !== undefined);

    if (does.length !== 1 || (spec.run !== undefined && typeof spec.run !== "function")) {
        throw new Error(`${name} ${spec.id}: say what it does: page, sheet, or a run function`);
    }
}

function pocketFor(record) {
    const live = () => !record.gone && modules.get(record.module) === record;

    /** Add something, or replace what has its id; what comes back changes or removes it. */
    const add = (kind, spec) => {
        check(kind, spec);
        let current = { ...spec };

        if (live()) {
            record.adds[kind].set(current.id, current);
            redraw();
        }

        return Object.freeze({
            update(patch) {
                if (!live() || record.adds[kind].get(current.id) !== current) {
                    return;
                }

                const next = { ...current, ...patch, id: current.id };

                check(kind, next);
                current = next;
                record.adds[kind].set(current.id, current);
                redraw();
            },
            remove() {
                if (live() && record.adds[kind].get(current.id) === current) {
                    record.adds[kind].delete(current.id);
                    redraw();
                }
            },
        });
    };

    return Object.freeze({
        version: POCKET_API,
        module: record.module,
        title: record.title,
        // Drawing: the app's own Preact and htm, so components and hooks work with its renderer.
        h,
        html,
        Fragment,
        useState,
        useEffect,
        useLayoutEffect,
        useRef,
        useMemo,
        useCallback,
        useReducer,
        // The app's pieces, so an extension looks like the rest of the app.
        Icon,
        Spinner,
        Loader,
        Markdown,
        Switch,
        /** Who uses this tab. */
        me: () => {
            const me = store.state.me;

            return me ? { id: me.id, name: me.name, role: me.role } : null;
        },
        /** The session open in this tab, or null. */
        conversationId: () => store.state.conversationId,
        /**
         * Call one of the module's routes: `api("status")` gets, `api("items", { name })` posts, and
         * `api("items/3", undefined, { method: "DELETE" })` deletes. Throws an error with the server's words.
         */
        api: (path, body, options) =>
            api(`x/${record.module}/${String(path).replace(/^\/+/, "")}`, body, options),
        /** Hear an event the module sends (`web.send` on the server); returns how to stop. */
        on(event, run) {
            if (typeof event !== "string" || typeof run !== "function") {
                throw new Error("pocket.on: give it an event name and a function");
            }

            const listener = { event, run };

            if (live()) {
                record.listeners.add(listener);
            }

            return () => record.listeners.delete(listener);
        },
        /** A short notice, as the app's own: `info`, `warning`, or `error`. */
        notify: (level, message) => notify(LEVELS.has(level) ? level : "info", String(message)),
        rail: (spec) => add("rail", spec),
        menu: (spec) => add("menu", spec),
        launcher: (spec) => add("launcher", spec),
        page: (spec) => add("page", spec),
        sheet: (spec) => add("sheet", spec),
        // Its own page and sheet only, and only while this version is loaded: a timer that outlived it opens nothing.
        openPage: (id) => live() && openPage(record.module, id),
        closePage: () => {
            if (store.state.page?.module === record.module) {
                closePage();
            }
        },
        openSheet: (id, props) => live() && openExtensionSheet(record.module, id, props),
        closeSheet: () => {
            const sheet = store.state.sheet;

            if (sheet?.type === "ext" && sheet.module === record.module) {
                closeSheet();
            }
        },
        /** Load a stylesheet from beside the browser module (`look.css`); it goes with this version. */
        style(path) {
            if (!live()) {
                return;
            }

            const link = document.createElement("link");

            link.rel = "stylesheet";
            link.href = new URL(String(path), new URL(record.url, location.href)).href;
            link.dataset.extension = record.module;
            document.head.append(link);
            record.disposers.push(() => link.remove());
        },
        /** Run `dispose` when this version goes: an edit, or the module turned off. */
        onDispose(dispose) {
            if (typeof dispose !== "function") {
                throw new Error("pocket.onDispose: give it a function");
            }

            if (record.gone) {
                dispose();

                return;
            }

            record.disposers.push(dispose);
        },
    });
}

// ─── Opening what extensions added ───────────────────────────────────────────

/** Show a module's page in the conversation's place, where the subagents board shows. */
export function openPage(module, id) {
    store.set({ page: { module, id }, board: false, boardAgents: null, drawer: false });
}

export const closePage = () => store.set({ page: null });

function openExtensionSheet(module, id, props = {}) {
    openSheet({ type: "ext", module, sheetId: id, id: `${module}:${id}`, props });
}

/**
 * Do what a rail button, menu row, or launcher action says: open its page or sheet, or run its function. A function that
 * fails, at once or later (an async one), says so in a notice.
 */
function activate(record, spec) {
    const failed = (error) => {
        console.error(`${record.title}: ${spec.id} failed`, error);
        notify("error", `${record.title}: ${error?.message ?? error}`);
    };

    try {
        if (spec.page !== undefined) {
            openPage(record.module, spec.page);
        } else if (spec.sheet !== undefined) {
            openExtensionSheet(record.module, spec.sheet);
        } else {
            Promise.resolve(spec.run()).catch(failed);
        }
    } catch (error) {
        failed(error);
    }
}

/** What every loaded module added of a kind, in the order modules loaded and added them. */
function added(kind) {
    return [...modules.values()].flatMap((record) =>
        [...record.adds[kind].values()].map((spec) => ({ record, spec })),
    );
}

/** An extension's icon: one of the app's by name, its own path, or a square of four when it gave none. */
const pathOf = (spec) => spec.iconPath ?? (iconPath(spec.icon ?? "") || iconPath("grid"));

/** How this tab's copy of a module's browser module stands, for the Extensions sheet; undefined when it loads none. */
export function browserModuleState(module) {
    const record = modules.get(module);

    return record === undefined ? undefined : { status: record.status, error: record.error };
}

// ─── Where they show ─────────────────────────────────────────────────────────

/** The rail's buttons that extensions added, after the app's own tools. */
export function ExtensionRailButtons() {
    const { page } = store.state;

    return added("rail").map(({ record, spec }) => {
        const open =
            spec.page !== undefined && page?.module === record.module && page.id === spec.page;
        const badge = spec.badge === undefined || spec.badge === null ? "" : String(spec.badge);

        return html`<button
            key=${`${record.module}:${spec.id}`}
            class=${`rail-button rail-ext ${open ? "open" : ""}`}
            title=${spec.title}
            aria-label=${badge === "" ? spec.title : `${spec.title}, ${badge}`}
            aria-pressed=${spec.page === undefined ? undefined : open}
            onClick=${() => (open ? closePage() : activate(record, spec))}
        >
            <${Icon} path=${pathOf(spec)} size=${18} />
            ${badge !== "" && html`<span class="rail-count">${badge}</span>`}
        </button>`;
    });
}

/** The menu's rows that extensions added: `{ key, label, hint, run }`, run closing the menu first. */
export function extensionMenuItems() {
    return added("menu").map(({ record, spec }) => ({
        key: `${record.module}:${spec.id}`,
        label: spec.label,
        hint: spec.hint ?? "",
        run: () => {
            // A page shows under the menu, which closes; a sheet takes the menu's place.
            if (spec.sheet === undefined) {
                closeSheet();
            }

            activate(record, spec);
        },
    }));
}

/** The launcher's actions that extensions added, as launcher items. */
export function extensionLauncherItems() {
    return added("launcher").map(({ record, spec }) => ({
        key: `action:ext:${record.module}:${spec.id}`,
        label: spec.label,
        detail: spec.detail ?? record.title,
        iconPath: pathOf(spec),
        keywords: Array.isArray(spec.keywords) ? spec.keywords.join(" ") : "",
        run: () => activate(record, spec),
    }));
}

/** Something an extension draws, which may fail: it says so in its place, and the rest of the app goes on. */
class Guard extends Component {
    state = { error: null };

    componentDidCatch(error) {
        console.error(`${this.props.name} failed`, error);
        this.setState({ error });
    }

    render({ children, name }, { error }) {
        return error
            ? html`<div class="error-box">${name} failed: ${error?.message ?? String(error)}</div>`
            : children;
    }
}

/** What a page or sheet shows: its component once its module is ready, else why not. */
function Body({ record, spec, title, props }) {
    if (record === undefined) {
        return html`<p class="muted">This extension is off.</p>`;
    }

    if (record.status === "failed") {
        return html`<div class="error-box">
            ${record.title} failed to load in this browser: ${record.error}
        </div>`;
    }

    if (spec === undefined) {
        return record.status === "ready"
            ? html`<p class="muted">${record.title} no longer has this.</p>`
            : html`<${Loader} label=${`Loading ${title}`} />`;
    }

    return html`<${Guard} key=${record.url} name=${title}>
        <${spec.component} pocket=${record.pocket} ...${props} />
    <//>`;
}

/** An extension's page in the conversation's place: its title, a close button, and what it draws. */
export function ExtensionPage() {
    const target = store.state.page;
    const record = modules.get(target?.module);
    const spec = record?.adds.page.get(target?.id);
    const title = spec?.title ?? record?.title ?? "Extension";

    useBack(true, closePage);

    // Esc closes it, as it does the subagents board, unless something over it takes Esc first. Heard before the others
    // (capturing): a sheet over it closes on the same key, and would be gone by the time this heard it.
    useEffect(() => {
        const onKey = (event) => {
            const { sheet, launcher, pipOpen } = store.state;

            if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                !sheet &&
                !launcher &&
                !pipOpen
            ) {
                event.preventDefault();
                closePage();
            }
        };

        addEventListener("keydown", onKey, true);

        return () => removeEventListener("keydown", onKey, true);
    }, []);

    return html`<section class="ext-page" aria-label=${title} data-module=${target?.module}>
        <header class="board-head">
            <div class="board-title">
                <h2>${title}</h2>
                ${
                    record &&
                    record.title !== title &&
                    html`<div class="board-sub">${record.title}</div>`
                }
            </div>
            <button
                class="icon-button"
                title="Back to the conversation (Esc)"
                aria-label="Close"
                onClick=${closePage}
            >
                <${Icon} name="close" />
            </button>
        </header>
        <div class="ext-page-body">
            <${Body} record=${record} spec=${spec} title=${title} props=${{ close: closePage }} />
        </div>
    </section>`;
}

/** An extension's sheet (`{ type: "ext", module, sheetId, props }`). */
export function ExtensionSheet({ sheet }) {
    const record = modules.get(sheet.module);
    const spec = record?.adds.sheet.get(sheet.sheetId);
    const title = spec?.title ?? record?.title ?? "Extension";

    return html`<${Sheet} title=${title} onClose=${closeSheet} wide=${spec?.wide === true}>
        <${Body}
            record=${record}
            spec=${spec}
            title=${title}
            props=${{ ...(sheet.props ?? {}), close: closeSheet }}
        />
    <//>`;
}
