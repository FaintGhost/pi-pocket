// Extensions' browser modules. An extension module can give the app one (`web.client` on the server): it loads here, in
// the tabs of the people it is for, and its default export gets `pocket`, the app's API for extensions. With it, it adds
// rail buttons, menu rows, launcher actions, pages in the conversation's place, and sheets, calls its own routes, and
// hears its module's events. What it added goes when it reloads or is turned off; one that fails says why, and the app
// goes on without it. A tab opened with `?noext=1` loads none of them (safe mode), for as long as the tab stays open.
import { Component, Fragment, h, options } from "preact";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "preact/hooks";
import { replaceAddress, useBack } from "./back.js";
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
const isId = (value) => typeof value === "string" && ID.test(value);
const LEVELS = new Set(["info", "warning", "error"]);

/**
 * Each browser module this tab loads, by module name: its address and title, whether it is `loading`, `ready`, or
 * `failed` (and why), what it added, its cleanups, the events it listens to, and its `pocket`. One that failed stays,
 * for the Extensions sheet, but adds nothing more (`dead`).
 */
const modules = new Map();

/** The modules' names in the order the server lists them: what they add shows in that order. */
let order = [];

const liveRecord = (record) =>
    record !== undefined && !record.gone && !record.dead && modules.get(record.module) === record;

// ─── Drawing again, within bounds ────────────────────────────────────────────

/**
 * How often a module may make the app draw again. What it adds, changes, or removes draws at the next frame, once for
 * every change since, so changes alone cost the app no more than a redraw a frame, at any refresh rate. What can go on
 * without end is a loop: a change made because the app drew the module's previous one, as a component draws, in an
 * effect of that drawing, or a few microtasks after either. Pages and sheets it opens and closes show at once, so they
 * have bounds of their own. Past these, the module stops, as one that failed to load does:
 *
 * - A loop: 20 changes in a row each made because the app drew the one before, or 5 or more over more than a second,
 *   however slowly it draws.
 * - Pages and sheets opened or closed: more than 300 within any second; or, with no task between them (they hold the
 *   page), more than 1000, or 5 or more over more than a second.
 * - Calls to `pocket` with no task between them (a loop of microtasks, which holds the page): more than 1000, over more
 *   than a second. Its calls then throw until the next task, so that such a loop ends.
 *
 * A loop that goes through a timer or a frame of its own (an effect that starts a timer, each time it runs) cannot be
 * told from an animation: it goes on, at a redraw a frame.
 */
const LOOP_COUNT = 20;
const SLOW_MIN = 5;
const SLOW_MS = 1000;
const OPENS_PER_SECOND = 300;
const HELD_COUNT = 1000;
const HELD_CALLS = 1000;
/** And how many notices a module may show, across its versions: past these, the rest are dropped. */
const NOTICES = 5;
const NOTICES_MS = 5000;
/** How many microtasks on a mark of what is drawn lasts: a change queued from a component or effect still counts. */
const MARK_HOPS = 4;
/** When a hidden tab draws no frames: its redraws wait this long at most (and longer, as such tabs' timers do). */
const FRAME_FALLBACK_MS = 100;

/**
 * The page's tasks, counted by a message that gets through only between them: a loop that holds the page lets none
 * through. A message rather than a timer: a hidden tab's timers wait up to a minute.
 */
let turn = 0;
let posted = false;
const tasks = new MessageChannel();

tasks.port1.onmessage = () => {
    posted = false;
    turn++;
};

function nextTurn() {
    if (!posted) {
        posted = true;
        tasks.port2.postMessage(null);
    }
}

/**
 * What a module spent lately: when it last opened or closed pages and sheets (for the second), how many in this task and
 * since when, and how many of its changes in a row the app's drawing of the one before made.
 */
const spending = () => ({
    calls: 0,
    callsTurn: -1,
    callsSince: 0,
    held: -1,
    opens: [],
    turn: -1,
    inTurn: 0,
    turnSince: 0,
    loops: 0,
    loopsSince: 0,
    lastCharge: 0,
    selfMade: false,
});

/**
 * Count a call a module makes to `pocket`. Past the bound with no task between them (a loop of microtasks holds the
 * page), the module stops, and its calls throw until the next task, so that the loop making them ends. Any version
 * counts, even one that went: its calls do nothing, but its loop would hold the page all the same.
 */
function tick(record) {
    const spent = record.spent;
    const now = performance.now();
    const stopped = () =>
        new Error(`${record.title} was stopped in this browser: it redraws without end`);

    if (spent.held === turn) {
        throw stopped();
    }

    if (spent.callsTurn !== turn) {
        spent.callsTurn = turn;
        spent.calls = 0;
        spent.callsSince = now;
        nextTurn();
    }

    spent.calls++;

    if (spent.calls > HELD_CALLS && now - spent.callsSince > SLOW_MS) {
        spent.held = turn;

        if (liveRecord(record)) {
            fail(record, new Error("it redraws without end"), "was stopped");
        }

        throw stopped();
    }
}

/**
 * Count a change a module made: `opened`, a page or sheet opened or closed; `selfMade`, made because the app drew its
 * previous change. False, once that stopped the module for going past its bounds.
 */
function charge(record, { opened = false, selfMade = false } = {}) {
    const now = performance.now();
    const spent = record.spent;

    if (selfMade) {
        if (spent.loops === 0) {
            spent.loopsSince = spent.lastCharge;
        }

        spent.loops++;
    } else {
        spent.loops = 0;
    }

    spent.lastCharge = now;

    let held = false;

    if (opened) {
        spent.opens.push(now);

        while (now - spent.opens[0] >= 1000) {
            spent.opens.shift();
        }

        if (spent.turn !== turn) {
            spent.turn = turn;
            spent.inTurn = 0;
            spent.turnSince = now;
        }

        spent.inTurn++;
        nextTurn();
        held =
            spent.opens.length > OPENS_PER_SECOND ||
            spent.inTurn > HELD_COUNT ||
            (spent.inTurn >= SLOW_MIN && now - spent.turnSince > SLOW_MS);
    }

    const looping =
        spent.loops >= LOOP_COUNT || (spent.loops >= SLOW_MIN && now - spent.loopsSince > SLOW_MS);

    if (held || looping) {
        fail(record, new Error("it redraws without end"), "was stopped");

        return false;
    }

    return true;
}

/**
 * The modules whose change the app draws now, or whose components' effects of that drawing run: what they change
 * meanwhile, or a few microtasks after, that drawing made. A mark lasts `MARK_HOPS` microtasks, and the newest one
 * counts.
 */
let causing = null;
let marks = 0;

function mark(records) {
    if (records === null || records.size === 0) {
        return;
    }

    causing = new Set([...(causing ?? []), ...records]);

    const mine = ++marks;
    const hop = (left) =>
        queueMicrotask(() => {
            if (mine !== marks) {
                return;
            }

            if (left > 0) {
                hop(left - 1);
            } else {
                causing = null;
            }
        });

    hop(MARK_HOPS);
}

/** Whether a module's change now is made by the app's drawing of its previous one. */
const selfMade = (record) => causing?.has(record) === true;

/** An effect a module's component runs, marked with what the drawing that asked for it was drawing. */
function markedEffect(effect) {
    const drawn = causing === null ? null : new Set(causing);

    if (typeof effect !== "function" || drawn === null) {
        return effect;
    }

    return function (...args) {
        mark(drawn);

        return effect.apply(this, args);
    };
}

/** The modules whose changes wait for the next redraw, which comes once for all of them; null when none is due. */
let due = null;

/** Draw what extensions add again at the next frame: every change until then goes in the same redraw. */
function redraw(record) {
    if (due === null) {
        due = new Set();
        // A hidden tab draws no frames: a timer then, whichever comes first.
        const frame = requestAnimationFrame(() => {
            clearTimeout(timer);
            flush();
        });
        const timer = setTimeout(() => {
            cancelAnimationFrame(frame);
            flush();
        }, FRAME_FALLBACK_MS);
    }

    if (record !== undefined) {
        due.add(record);

        if (selfMade(record)) {
            record.spent.selfMade = true;
        }
    }
}

function flush() {
    if (due === null) {
        return;
    }

    const records = [...due].filter(liveRecord);

    due = null;

    for (const record of records) {
        const made = record.spent.selfMade;

        record.spent.selfMade = false;
        charge(record, { selfMade: made });
    }

    // The app draws in a microtask queued as the store changes; the mark outlasts it by a few.
    store.set((state) => ({ extensionsRev: state.extensionsRev + 1 }));
    mark(new Set(records.filter(liveRecord)));
}

/** Each module's recent notices, by name, so that a new version does not start afresh: `{ times, droppedAt }`. */
const noticeBudgets = new Map();

/**
 * A notice from a module, as many as its bound lets through; the rest are dropped, with a word in the console. None from
 * a version that went or failed (an action of it that fails late): it would use up the next version's.
 */
function noticeFrom(record, level, message, action) {
    if (!liveRecord(record)) {
        return;
    }

    const now = performance.now();
    const budget = noticeBudgets.get(record.module) ?? { times: [], droppedAt: -Infinity };

    budget.times = budget.times.filter((at) => now - at < NOTICES_MS);
    noticeBudgets.set(record.module, budget);

    if (budget.times.length >= NOTICES) {
        // Once a burst: a drop soon after another is the same one.
        if (now - budget.droppedAt >= NOTICES_MS) {
            console.warn(`${record.title}: too many notices; dropping the rest for a few seconds`);
        }

        budget.droppedAt = now;

        return;
    }

    budget.times.push(now);
    notify(level, message, action);
}

/** What was thrown, as text for a notice or an error box: an Error's message, a string, or a word that it gave none. */
function reason(error) {
    let text = "";

    try {
        if (error instanceof Error) {
            text = error.message || error.name;
        } else if (typeof error?.message === "string") {
            text = error.message;
        } else if (error !== undefined && error !== null) {
            text = String(error);
        }
    } catch {
        text = "";
    }

    return text.trim() === "" ? "it gave no reason" : text;
}

/** Run a cleanup; one that fails says so in the console, and the rest still run. */
function cleanUp(record, dispose) {
    try {
        dispose();
    } catch (error) {
        console.error(`${record.title}: a cleanup failed`, error);
    }
}

// ─── Safe mode ───────────────────────────────────────────────────────────────

/** Where a tab keeps that it is in safe mode: in its session storage, so reloads and reconnects keep it. */
const SAFE_KEY = "pocket.noext";

/** What `?noext=` turns safe mode off with; any other value (`1`, or none) turns it on. */
const SAFE_OFF = new Set(["0", "false", "off", "no"]);

/**
 * Read `?noext=1` (safe mode on) or `?noext=0` (off) from the address, keep it for the tab, and take it out of the
 * address, so a link copied from here does not pass it on.
 */
function startSafeMode() {
    const query = new URLSearchParams(location.search);
    const asked = query.has("noext")
        ? !SAFE_OFF.has(query.get("noext").trim().toLowerCase())
        : null;
    let on = false;

    try {
        if (asked === true) {
            sessionStorage.setItem(SAFE_KEY, "1");
        } else if (asked === false) {
            sessionStorage.removeItem(SAFE_KEY);
        }

        on = sessionStorage.getItem(SAFE_KEY) === "1";
    } catch {
        // No session storage: safe mode holds for this page only.
        on = asked === true;
    }

    if (query.has("noext")) {
        query.delete("noext");
        const rest = query.toString();

        replaceAddress(`${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
    }

    return on;
}

let safe = startSafeMode();
/** Safe mode was told once in this page: a reconnect does not tell it again. */
let safeTold = false;

/** This tab loads no browser modules of extensions (it was opened with `?noext=1`). */
export const safeMode = () => safe;

/** Leave safe mode: the tab loads its browser modules again. */
export function leaveSafeMode() {
    safe = false;

    try {
        sessionStorage.removeItem(SAFE_KEY);
    } catch {
        // Nothing kept, nothing to take away.
    }

    follow(store.state);
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/** The list the tab loaded last, as a key: the server sends hello again for many reasons. */
let loadedKey = null;

/** Load what the server lists now, when it changed. */
function follow(state) {
    const listed = state.me ? state.server?.ui : [];
    const list = Array.isArray(listed) ? listed : [];
    // Signed in or not counts too: safe mode says so once someone is.
    const key = [
        safe ? "safe" : "",
        state.me ? "in" : "",
        ...list.map((each) => `${each.module}@${each.url}`),
    ].join("\n");

    if (key === loadedKey) {
        return;
    }

    loadedKey = key;
    // Not inside the store's own round of listeners: loading changes the store too.
    queueMicrotask(() => sync(list));
}

store.subscribe(follow);

/** Who hears which modules went: `sheets.js`, which takes their sheets out of the ones back goes through. */
const goneListeners = new Set();

/** Hear when modules go: `listener(gone)`, where `gone(module)` says whether that module went. */
export function onExtensionsGone(listener) {
    goneListeners.add(listener);

    return () => goneListeners.delete(listener);
}

/** Load what the server lists, and unload what it no longer does or lists at a new address (a new version). */
function sync(list) {
    order = list.map((each) => each.module);
    const wanted = new Map(safe ? [] : list.map((each) => [each.module, each]));

    for (const record of [...modules.values()]) {
        if (wanted.get(record.module)?.url !== record.url) {
            unload(record);
        }
    }

    for (const entry of wanted.values()) {
        if (!modules.has(entry.module)) {
            void load(entry);
        }
    }

    // A page or sheet of a module that went closes, and back does not bring back the sheets it had under the one open.
    // One of a module coming back in a new version waits for it.
    const { page, sheet } = store.state;
    const gone = (module) => !wanted.has(module);

    if (page && gone(page.module)) {
        closePage();
    }

    if (sheet?.type === "ext" && gone(sheet.module)) {
        closeSheet();
    }

    for (const listener of goneListeners) {
        listener(gone);
    }

    // A module the server no longer lists has no notices to count.
    for (const module of noticeBudgets.keys()) {
        if (!order.includes(module)) {
            noticeBudgets.delete(module);
        }
    }

    if (safe && !safeTold && store.state.me) {
        safeTold = true;
        notify(
            "warning",
            "Extensions' browser parts are off in this tab. Menu → Extensions turns them back on.",
            () => openSheet({ type: "extensions" }),
        );
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
        // Replaced or turned off.
        gone: false,
        // Failed, or stopped: what it set up went, and what it tries later (a timer) does nothing.
        dead: false,
        // How it failed, for its page and sheets: "failed to load", or "was stopped".
        how: null,
        // The redraws it caused lately (`charge`).
        spent: spending(),
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

        // Replaced or turned off while it started, or stopped already: what it set up goes.
        if (record.gone || record.dead) {
            teardown(record);

            return;
        }

        record.status = "ready";
    } catch (error) {
        if (!record.gone && !record.dead) {
            fail(record, error, "failed to load");
        }

        return;
    }

    redraw();
}

/**
 * A module failed, while it loaded or later (`how`): what it added goes, its cleanups run, what it tries next does
 * nothing, and a notice, its page or sheet, and the Extensions sheet say why.
 */
function fail(record, error, how) {
    record.dead = true;
    teardown(record);
    record.status = "failed";
    record.error = reason(error);
    record.how = how;
    console.error(`${record.title}'s browser module ${how}`, error);
    notify("error", `${record.title} ${how} in this browser: ${record.error}`);
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
        cleanUp(record, dispose);
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

/** A copy of what a module gives to add, once it holds: read once, so what is checked is what is kept. */
function specOf(kind, spec) {
    if (typeof spec !== "object" || spec === null) {
        throw new Error(`pocket.${kind}: give it an object`);
    }

    const copy = { ...spec };

    check(kind, copy);

    return copy;
}

/** What each kind needs besides its `id`, and the one thing it does when used, if it is used. */
function check(kind, spec) {
    const name = `pocket.${kind}`;

    if (!isId(spec.id)) {
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
        spec.badge !== false &&
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

    // A page can keep Esc and sideways swipes for itself; a sheet can be wide.
    const flags = { page: ["escape", "swipe"], sheet: ["wide"] }[kind] ?? [];

    for (const field of flags) {
        if (spec[field] !== undefined && typeof spec[field] !== "boolean") {
            throw new Error(`${name} ${spec.id}: ${field} is true or false`);
        }
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

    for (const field of ["page", "sheet"]) {
        if (spec[field] !== undefined && !isId(spec[field])) {
            throw new Error(`${name} ${spec.id}: ${field} is the id of one of its ${field}s`);
        }
    }
}

/** Two specs that would show the same: the same fields, each the very same value. */
function sameSpec(a, b) {
    if (a === undefined || b === undefined) {
        return false;
    }

    const keys = Object.keys(a);

    return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
    );
}

/**
 * A route's path under the module's own address (`/api/x/<module>/`): no `.` or `..` parts, no address of its own (a
 * leading `//`, or a scheme such as `https:`), so a call never reaches anything else.
 */
function routeOf(module, path) {
    const given = String(path);
    const refuse = (why) => new Error(`pocket.api: ${JSON.stringify(given)} ${why}`);

    if (/^[\\/]{2}/.test(given) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(given)) {
        throw refuse('is not one of its routes: give a path such as "status"');
    }

    const relative = given.replace(/^[\\/]/, "");
    const parts = relative.split(/[?#]/, 1)[0].split(/[\\/]/);

    if (parts.some((part) => /^(\.|%2e){1,2}$/i.test(part))) {
        throw refuse("has a . or .. part: give the route's own path");
    }

    const prefix = `/api/x/${module}/`;
    const url = new URL(`${prefix}${relative}`, location.origin);

    if (url.origin !== location.origin || !url.pathname.startsWith(prefix)) {
        throw refuse("leads out of the module's routes");
    }

    return `x/${module}/${relative}`;
}

function pocketFor(record) {
    const live = () => liveRecord(record);

    // A page or sheet opened or closed shows at once: it counts toward its bounds, and what draws next is its doing.
    const change = () => {
        if (!live() || !charge(record, { opened: true, selfMade: selfMade(record) })) {
            return false;
        }

        mark(new Set([record]));

        return true;
    };

    /** Add something, or replace what has its id; what comes back changes or removes it. */
    const add = (kind, spec) => {
        tick(record);
        let current = specOf(kind, spec);

        if (live()) {
            const before = record.adds[kind].get(current.id);

            record.adds[kind].set(current.id, current);

            // The same again (a component that adds as it draws) draws nothing again.
            if (!sameSpec(before, current)) {
                redraw(record);
            }
        }

        return Object.freeze({
            update(patch) {
                tick(record);

                if (typeof patch !== "object" || patch === null) {
                    throw new Error(`pocket.${kind} ${current.id}: update takes an object`);
                }

                if (!live() || record.adds[kind].get(current.id) !== current) {
                    return;
                }

                const next = { ...current, ...patch, id: current.id };

                // Nothing changed (an update on every draw): nothing draws again.
                if (sameSpec(current, next)) {
                    return;
                }

                check(kind, next);
                current = next;
                record.adds[kind].set(current.id, current);
                redraw(record);
            },
            remove() {
                tick(record);

                if (live() && record.adds[kind].get(current.id) === current) {
                    record.adds[kind].delete(current.id);
                    redraw(record);
                }
            },
        });
    };

    /** Its own folder's address, `/x/<module>/<version>/`, where its stylesheets are. */
    const folder = () => new URL(".", new URL(record.url, location.href));

    return Object.freeze({
        version: POCKET_API,
        module: record.module,
        title: record.title,
        // Drawing: the app's own Preact and htm, so components and hooks work with its renderer.
        h,
        html,
        Fragment,
        useState,
        // Effects that know which drawing asked for them, so a change they make because of it counts as a loop's.
        useEffect: (effect, deps) => useEffect(markedEffect(effect), deps),
        useLayoutEffect: (effect, deps) => useLayoutEffect(markedEffect(effect), deps),
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
         * `api("items/3", undefined, { method: "DELETE" })` deletes. Rejects with an error with the server's words, or
         * for a path that would lead out of the module's routes.
         */
        api: async (path, body, options) => api(routeOf(record.module, path), body, options),
        /** Hear an event the module sends (`web.send` on the server); returns how to stop. */
        on(event, run) {
            tick(record);

            if (typeof event !== "string" || typeof run !== "function") {
                throw new Error("pocket.on: give it an event name and a function");
            }

            const listener = { event, run };

            if (live()) {
                record.listeners.add(listener);
            }

            return () => record.listeners.delete(listener);
        },
        /** A short notice, as the app's own: `info`, `warning`, or `error`. A few at a time (`NOTICES`). */
        notify(level, message) {
            tick(record);

            if (live()) {
                noticeFrom(record, LEVELS.has(level) ? level : "info", String(message));
            }
        },
        rail: (spec) => add("rail", spec),
        menu: (spec) => add("menu", spec),
        launcher: (spec) => add("launcher", spec),
        page: (spec) => add("page", spec),
        sheet: (spec) => add("sheet", spec),
        // Its own page and sheet only, and only while this version is loaded: a timer that outlived it opens or closes
        // nothing, not even the page of the version after it.
        openPage(id) {
            tick(record);

            if (!isId(id)) {
                throw new Error("pocket.openPage: give it the id of one of its pages");
            }

            if (change()) {
                openPage(record.module, id);
            }
        },
        closePage() {
            tick(record);

            if (live() && store.state.page?.module === record.module && change()) {
                closePage();
            }
        },
        openSheet(id, props) {
            tick(record);

            if (!isId(id)) {
                throw new Error("pocket.openSheet: give it the id of one of its sheets");
            }

            if (props !== undefined && (typeof props !== "object" || props === null)) {
                throw new Error("pocket.openSheet: its props are an object");
            }

            if (change()) {
                openExtensionSheet(record.module, id, props);
            }
        },
        closeSheet() {
            tick(record);

            const sheet = store.state.sheet;

            if (live() && sheet?.type === "ext" && sheet.module === record.module && change()) {
                closeSheet();
            }
        },
        /**
         * Load a stylesheet from the browser module's folder (`look.css`); it goes with this version. One that does
         * not load says so in a notice.
         */
        style(path) {
            tick(record);

            if (!live()) {
                return;
            }

            const base = folder();
            let href;

            try {
                href = new URL(String(path), base);
            } catch {
                href = null;
            }

            if (
                href === null ||
                href.origin !== base.origin ||
                !href.pathname.startsWith(base.pathname)
            ) {
                throw new Error(
                    `pocket.style: ${JSON.stringify(String(path))} is not in the module's own folder`,
                );
            }

            const link = document.createElement("link");

            link.rel = "stylesheet";
            link.href = href.href;
            link.dataset.extension = record.module;
            link.addEventListener("error", () => {
                if (live() && link.isConnected) {
                    console.warn(`${record.title}: ${href.href} did not load`);
                    noticeFrom(
                        record,
                        "warning",
                        `${record.title}: its stylesheet ${String(path)} did not load`,
                    );
                }
            });
            document.head.append(link);
            record.disposers.push(() => link.remove());
        },
        /** Run `dispose` when this version goes: an edit, or the module turned off. Gone or failed already: now. */
        onDispose(dispose) {
            if (typeof dispose !== "function") {
                throw new Error("pocket.onDispose: give it a function");
            }

            if (!live()) {
                cleanUp(record, dispose);

                return;
            }

            record.disposers.push(dispose);
        },
    });
}

// ─── Opening what extensions added ───────────────────────────────────────────

/**
 * Show a module's page in the conversation's place, where the subagents board shows. What is over that place (a sheet,
 * the launcher) closes, so that back closes first what shows on top.
 */
export function openPage(module, id) {
    if (!isId(id)) {
        return;
    }

    store.set({
        page: { module, id },
        sheet: null,
        launcher: false,
        board: false,
        boardAgents: null,
        drawer: false,
    });
}

export const closePage = () => store.set({ page: null });

/**
 * The `close` a page's component gets: it closes that page, of that version of its module, while it shows, and nothing
 * else (another page, the next version's) when called later.
 */
function pageCloser(record, id) {
    return () => {
        const { page } = store.state;

        if (liveRecord(record) && page?.module === record.module && page.id === id) {
            closePage();
        }
    };
}

/** The `close` a sheet's component gets: it closes that sheet of that version while it shows, and no other sheet. */
function sheetCloser(record, id) {
    return () => {
        const { sheet } = store.state;

        if (
            liveRecord(record) &&
            sheet?.type === "ext" &&
            sheet.module === record.module &&
            sheet.sheetId === id
        ) {
            closeSheet();
        }
    };
}

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
        noticeFrom(record, "error", `${record.title}: ${reason(error)}`);
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

/** What every loaded module added of a kind: modules in the order the server lists them, each's in the order added. */
function added(kind) {
    const at = (record) => {
        const index = order.indexOf(record.module);

        return index === -1 ? order.length : index;
    };

    return [...modules.values()]
        .sort((a, b) => at(a) - at(b))
        .flatMap((record) => [...record.adds[kind].values()].map((spec) => ({ record, spec })));
}

/** An extension's icon: its own path, one of the app's by name, or a square of four when it gave none it knows. */
const pathOf = (spec) => spec.iconPath ?? (iconPath(spec.icon ?? "") || iconPath("grid"));

/** The most of a badge's text kept (its button shows less, cut with an ellipsis), for its button's label. */
const BADGE_TEXT = 24;

/** Text in the pieces a reader sees as one character (an emoji with its joiners, a letter with its accent). */
const graphemes =
    typeof Intl.Segmenter === "function"
        ? (text) =>
              [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
                  (each) => each.segment,
              )
        : (text) => [...text];

/**
 * A rail button's badge as it shows: as the app's own counts, none at 0 and "99+" above 99 (Infinity too); NaN and
 * -Infinity show nothing, other numbers as they are; text, trimmed, with "" and "0" as nothing, and long text cut whole
 * characters at a time.
 */
function badgeOf(badge) {
    if (typeof badge === "number") {
        if (Number.isNaN(badge) || badge === 0 || badge === -Infinity) {
            return "";
        }

        return badge > 99 ? "99+" : String(badge);
    }

    const text = typeof badge === "string" ? badge.trim() : "";

    if (text === "" || text === "0") {
        return "";
    }

    const characters = graphemes(text);

    return characters.length > BADGE_TEXT
        ? `${characters.slice(0, BADGE_TEXT - 1).join("")}…`
        : text;
}

/**
 * How this tab's copy of a module's browser module stands, for the Extensions sheet: `loading`, `ready`, `failed` (with
 * its `error`), or `off` in safe mode; undefined when this tab loads none.
 */
export function browserModuleState(module) {
    const record = modules.get(module);

    if (record === undefined) {
        return safe && order.includes(module) ? { status: "off", error: null } : undefined;
    }

    return { status: record.status, error: record.error };
}

// ─── Where they show ─────────────────────────────────────────────────────────

/**
 * The rail's buttons that extensions added, after the app's own tools: a group that scrolls when they are many, so the
 * folded rail's sessions keep their room.
 */
export function ExtensionRailButtons() {
    const { page } = store.state;
    const buttons = added("rail");

    if (buttons.length === 0) {
        return null;
    }

    return html`<div class="rail-exts">
        ${buttons.map(({ record, spec }) => {
            const open =
                spec.page !== undefined && page?.module === record.module && page.id === spec.page;
            const badge = badgeOf(spec.badge);

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
        })}
    </div>`;
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

/**
 * Something an extension draws, which may fail: it says so in its place, and the rest of the app goes on. Whatever was
 * thrown (an empty string, nothing at all) counts.
 */
class Guard extends Component {
    state = { failed: false, message: "" };

    constructor(props) {
        super(props);
        guards++;
    }

    componentWillUnmount() {
        guards--;
    }

    componentDidCatch(error) {
        console.error(`${this.props.name} failed`, error);
        this.setState({ failed: true, message: reason(error) });
    }

    render({ children, name }, { failed, message }) {
        return failed ? html`<div class="error-box">${name} failed: ${message}</div>` : children;
    }
}

// Preact reads `.then` of whatever a component throws while it draws, to tell a pause from a failure, so a thrown `null`
// or `undefined` breaks Preact itself, past every boundary (and, from a component that drew again alone, out of its
// queue, which then drops what else waited to draw). So under a Guard, what Preact calls of a component while it draws
// turns those into an Error first: its render and the lifecycle methods called with it, its class's
// getDerivedStateFromProps, and the effects hooks run before it draws again. Checked again each time it draws, so a
// method it replaces is covered too. A method given by a getter is left as it is, and so is a class's constructor, which
// Preact calls only when its parent draws: what that throws stays under the Guard, in Preact's own words.
//
// Preact's hooks (`_diff`, `_render`) and a vnode's component and parent go by these short names in its build, as
// preact/hooks uses them; the app's own components are left as they are. Should the names change, this does nothing,
// and `Drawn` still keeps such a failure under the Guard, in Preact's own words.
const DIFF_HOOK = "__b";
const RENDER_HOOK = "__r";
const COMPONENT = "__c";
const PARENT = "__";
const NO_REASON = "it gave no reason";
/** What Preact calls of a component while it draws, besides its class's getDerivedStateFromProps. */
const DRAWING = [
    "render",
    "componentWillMount",
    "componentWillReceiveProps",
    "shouldComponentUpdate",
    "componentWillUpdate",
    "getChildContext",
    "getSnapshotBeforeUpdate",
];
/** The wrappers made here, so none is wrapped again. */
const wrappers = new WeakSet();
/** Each component instance, and each class, once known: whether it draws under a Guard. */
const guardedComponents = new WeakMap();
const guardedClasses = new WeakSet();
/** The instances whose inherited methods were checked too, at their first draw: after it, only their own change. */
const scanned = new WeakSet();
/** How many Guards there are: with none, nothing draws under one, and no vnode's parents need a look. */
let guards = 0;
/** The instance whose own methods were checked as its vnode began to draw, so not again right before it draws. */
let checkedNow = null;

/** `run`, but what it throws is never `null` or `undefined`. */
function throwsSomething(run) {
    const wrapped = function (...args) {
        try {
            return run.apply(this, args);
        } catch (error) {
            throw error ?? new Error(NO_REASON);
        }
    };

    wrappers.add(wrapped);

    return wrapped;
}

/**
 * Wrap the methods `names` of `target`, its own, or inherited too, where they are plain functions that can be
 * replaced.
 */
function wrapMethods(target, names, inherited = true) {
    for (const name of names) {
        let owner = target;
        let found = Object.getOwnPropertyDescriptor(owner, name);

        while (found === undefined && inherited) {
            owner = Object.getPrototypeOf(owner);

            if (owner === null || owner === Object.prototype) {
                break;
            }

            found = Object.getOwnPropertyDescriptor(owner, name);
        }

        // None; a getter (left as it is); or one wrapped already.
        if (found === undefined || !("value" in found)) {
            continue;
        }

        if (typeof found.value !== "function" || wrappers.has(found.value)) {
            continue;
        }

        try {
            Object.defineProperty(target, name, {
                value: throwsSomething(found.value),
                writable: true,
                configurable: true,
                enumerable: owner === target ? found.enumerable : false,
            });
        } catch {
            // Frozen, or a property that cannot change: left as it is.
        }
    }
}

const isClass = (type) =>
    typeof type === "function" && typeof type.prototype?.render === "function";

/** Whether a vnode draws under a Guard (not counting a Guard itself). */
function underGuard(vnode) {
    if (guards === 0) {
        return false;
    }

    for (let above = vnode?.[PARENT]; above; above = above[PARENT]) {
        if (above.type === Guard) {
            return true;
        }
    }

    return false;
}

/** Whether a component instance draws under a Guard, worked out once. */
function guarded(component, vnode) {
    if (typeof component !== "object" || component === null) {
        return false;
    }

    let inside = guardedComponents.get(component);

    if (inside === undefined) {
        inside = underGuard(vnode);
        guardedComponents.set(component, inside);
    }

    return inside;
}

/** A class drawn under a Guard: its methods, and its getDerivedStateFromProps, before any of its instances draws. */
function guardClass(type) {
    if (guardedClasses.has(type)) {
        return;
    }

    guardedClasses.add(type);
    wrapMethods(type.prototype, DRAWING);
    wrapMethods(type, ["getDerivedStateFromProps"]);
}

const beforeDiff = options[DIFF_HOOK];
const beforeRender = options[RENDER_HOOK];

// Before a vnode draws: a class under a Guard is guarded before its first instance is made, and its
// getDerivedStateFromProps again if it was replaced since; a component drawing again alone (its own state changed) has
// the methods it may have replaced since wrapped again.
options[DIFF_HOOK] = (vnode) => {
    if (typeof beforeDiff === "function") {
        beforeDiff(vnode);
    }

    checkedNow = null;

    const type = vnode?.type;

    if (isClass(type)) {
        if (guardedClasses.has(type)) {
            wrapMethods(type, ["getDerivedStateFromProps"]);
        } else if (underGuard(vnode)) {
            guardClass(type);
        }
    }

    const component = vnode?.[COMPONENT];

    if (component && guardedComponents.get(component) === true) {
        wrapMethods(component, DRAWING, false);
        checkedNow = component;
    }
};

// Right before a component draws: its methods, and the effects hooks run first when it draws again before they ran.
options[RENDER_HOOK] = (vnode) => {
    const component = vnode?.[COMPONENT];

    if (!guarded(component, vnode)) {
        if (typeof beforeRender === "function") {
            beforeRender(vnode);
        }

        return;
    }

    if (checkedNow !== component) {
        wrapMethods(component, DRAWING, !scanned.has(component));
        scanned.add(component);
    }

    checkedNow = null;

    if (isClass(component.constructor)) {
        guardClass(component.constructor);
    }

    if (typeof beforeRender === "function") {
        try {
            beforeRender(vnode);
        } catch (error) {
            throw error ?? new Error(NO_REASON);
        }
    }
};

/** Between the Guard and an extension's component: what goes wrong in it, however Preact takes it, stays under the Guard. */
function Drawn({ component, props }) {
    return h(component, props);
}

/** Each extension component's number, for its Guard's key: a new component starts with a new Guard. */
const componentIds = new WeakMap();
let nextComponentId = 1;

function componentId(component) {
    if (!componentIds.has(component)) {
        componentIds.set(component, nextComponentId++);
    }

    return componentIds.get(component);
}

/** What a page or sheet shows: its component once its module is ready, else why not. */
function Body({ record, spec, title, props, close }) {
    if (record === undefined) {
        return html`<p class="muted">This extension is off.</p>`;
    }

    if (record.status === "failed") {
        return html`<div class="error-box">
            ${record.title} ${record.how ?? "failed to load"} in this browser: ${record.error}
        </div>`;
    }

    if (spec === undefined) {
        return record.status === "ready"
            ? html`<p class="muted">${record.title} no longer has this.</p>`
            : html`<${Loader} label=${`Loading ${title}`} />`;
    }

    // A Guard that caught a failure stays with it until its component changes (the page added again, or updated).
    return html`<${Guard} key=${`${record.url}#${componentId(spec.component)}`} name=${title}>
        <${Drawn}
            component=${spec.component}
            props=${{ ...props, pocket: record.pocket, close }}
        />
    <//>`;
}

/** An extension's page in the conversation's place: its title, a close button, and what it draws. */
export function ExtensionPage() {
    const target = store.state.page;
    const record = modules.get(target?.module);
    const spec = record?.adds.page.get(target?.id);
    const title = spec?.title ?? record?.title ?? "Extension";
    // A page that keeps Esc for itself (`escape: false`): read as the key comes, as it may change.
    const keepsEscape = useRef(false);
    const close = useMemo(() => pageCloser(record, target?.id), [record, target?.id]);

    keepsEscape.current = spec?.escape === false;
    useBack(true, closePage);

    // Esc closes it, as it does the subagents board, unless something over it takes Esc first, or the page keeps Esc.
    // Heard before the others (capturing): a sheet over it closes on the same key, and would be gone by the time this
    // heard it. Not while a character is being composed (an input method's Esc cancels that).
    useEffect(() => {
        const onKey = (event) => {
            const { sheet, launcher, pipOpen } = store.state;

            if (
                event.key === "Escape" &&
                !event.isComposing &&
                event.keyCode !== 229 &&
                !event.defaultPrevented &&
                !sheet &&
                !launcher &&
                !pipOpen &&
                !keepsEscape.current
            ) {
                event.preventDefault();
                closePage();
            }
        };

        addEventListener("keydown", onKey, true);

        return () => removeEventListener("keydown", onKey, true);
    }, []);

    // A page that keeps sideways swipes (`swipe: false`) starts no swipe back anywhere on it (`gestures.js`).
    return html`<section
        class="ext-page"
        aria-label=${title}
        data-module=${target?.module}
        data-no-swipe=${spec?.swipe === false ? "" : undefined}
    >
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
            <${Body} record=${record} spec=${spec} title=${title} props=${{}} close=${close} />
        </div>
    </section>`;
}

/** An extension's sheet (`{ type: "ext", module, sheetId, props }`). */
export function ExtensionSheet({ sheet }) {
    const record = modules.get(sheet.module);
    const spec = record?.adds.sheet.get(sheet.sheetId);
    const title = spec?.title ?? record?.title ?? "Extension";
    const close = useMemo(() => sheetCloser(record, sheet.sheetId), [record, sheet.sheetId]);

    return html`<${Sheet} title=${title} onClose=${closeSheet} wide=${spec?.wide === true}>
        <${Body}
            record=${record}
            spec=${spec}
            title=${title}
            props=${sheet.props ?? {}}
            close=${close}
        />
    <//>`;
}
