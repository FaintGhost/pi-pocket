// The launcher's visible search modes, keyboard, theme previews, and focus in a real mouse browser and on a phone.
// Focus regressions include #62, reported by @arunsathiya: reopening must focus the native search input, and an
// action's new sheet must keep its focus when the old launcher finishes leaving.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const INPUT = ".launcher input";
const TITLES = [
    "Alpha notes",
    "Alpha release",
    "Alpine review",
    "Beta experiments",
    "Gamma project",
    "Delta planning",
    "Alpha N o t e s",
    "Zeta backlog",
    "Archived notebook",
];

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const sessions: ConversationId[] = [];
let pathMatch = "";

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string) =>
    until(async () => await inPage<boolean>(script), what);
const focused = () =>
    inPage<boolean>(
        `return JSON.stringify(document.activeElement === document.querySelector(${JSON.stringify(INPUT)}))`,
    );
const value = () =>
    inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(INPUT)}).value)`);

const settle = () =>
    page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished.catch(() => {})));
        for (let frame = 0; frame < 3; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);

async function home(viewport: Viewport = VIEWPORTS.desktop, session = false): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/${session ? `s/${sessions[0]}` : ""}`);
    await see(
        `
        const { store } = await import("/store.js");

        return JSON.stringify(store.state.sessions.length === ${TITLES.length} &&
            ( ${session} ? document.querySelector(".composer textarea") !== null :
                document.querySelector(".home-list") !== null));
    `,
        "the isolated session list",
    );
    await settle();
}

async function open(): Promise<void> {
    await page.press("Control+K");
    await until(focused, "the launcher's native input focused");
    await settle();
}

/** Use an input event for replacement, not key aliases which the launcher intentionally intercepts. */
async function search(text: string): Promise<void> {
    await page.evaluate(`
        const input = document.querySelector(${JSON.stringify(INPUT)});

        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await see(
        `return JSON.stringify(document.querySelector(${JSON.stringify(INPUT)}).value === ${JSON.stringify(text)})`,
        "the new query rendered",
    );
    await settle();
}

async function button(label: string): Promise<void> {
    // Real mouse/touch events: a mode button must not take the caret away from the native input.
    if (["All", "Sessions", "Actions", "Themes"].includes(label)) {
        // BrowserPage's label locator uses visible text, including the desktop's aria-hidden prefix hint.
        const index = await inPage<number>(`
            return JSON.stringify([...document.querySelectorAll('.launcher [aria-label="Search type"] button')].findIndex((button) => {
                const name = button.cloneNode(true);

                name.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());

                return name.textContent.trim() === ${JSON.stringify(label)};
            }));
        `);

        assert.ok(index >= 0, `the ${label} mode button exists`);
        await page.click({
            selector: `.launcher [aria-label="Search type"] button:nth-of-type(${index + 1})`,
        });
    } else {
        await page.click({ label });
    }

    await settle();
}

/** The options in a named semantic group, independently of how headings are styled. */
const GROUPS = `
    const groups = [...document.querySelectorAll('#launcher-results [role="group"]')];
    const groupName = (group) => group.getAttribute("aria-label") ??
        (group.getAttribute("aria-labelledby") ?? "").split(/\\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
`;
const options = (group?: string) =>
    inPage<string[]>(`
        ${GROUPS}
        const container = ${group === undefined ? 'document.querySelector(".launcher")' : `groups.find((group) => groupName(group) === ${JSON.stringify(group)})`};

        return JSON.stringify([...container?.querySelectorAll('[role="option"]') ?? []]
            .map((item) => item.querySelector(".launcher-title")?.textContent ?? item.textContent.trim()));
    `);
const mode = () =>
    inPage<string[]>(`
        return JSON.stringify([...document.querySelectorAll('.launcher [aria-label="Search type"] button[aria-pressed="true"]')].map((button) => {
            const label = button.cloneNode(true);

            label.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());

            return label.textContent.trim();
        }));
    `);
const selectedIndex = () =>
    inPage<number>(
        `return JSON.stringify([...document.querySelectorAll('.launcher-item')].findIndex((item) => item.classList.contains("on")))`,
    );

async function closed(): Promise<void> {
    await see(
        `return JSON.stringify(document.querySelector(".launcher") === null)`,
        "the launcher removed",
    );
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());

    for (const [index, title] of TITLES.entries()) {
        const cwd = join(work, index === 3 ? "uniquepathneedle" : `project-${index}`);

        mkdirSync(cwd);
        const id = await newSession(app, cwd);

        sessions.push(id);
        await app.commands.updateSession(id, owner(app), {
            title,
            ...(index === TITLES.length - 1 ? { archived: true } : {}),
        });

        if (index === 3) {
            pathMatch = cwd;
        }
    }

    server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "launcher-ui-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

for (const [device, viewport] of [
    ["desktop", VIEWPORTS.desktop],
    ["mobile", VIEWPORTS.mobile],
] as const) {
    test(
        `${device}: visible modes retain the query, prefixes stay in sync, and all sessions are reachable`,
        real,
        async () => {
            await home(viewport);
            await open();
            assert.deepEqual(await mode(), ["All"]);
            assert.equal(
                (await options("Recent sessions")).length,
                6,
                "All starts with six recent sessions",
            );
            assert.ok(
                (await options("Actions")).length > 0,
                "contextual actions exist, without assuming their count",
            );
            assert.ok((await options("Themes")).length > 0);
            assert.equal(
                await inPage<boolean>(`
            const button = document.querySelector('.launcher button[aria-label="Show all sessions"]');
            const list = document.querySelector('[id="launcher-results"]');

            return JSON.stringify(button !== null && button.closest('[role="dialog"]') === document.querySelector('.launcher') &&
                button.closest('[role="listbox"]') === null &&
                Boolean(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING));
        `),
                true,
                "Show all sessions is within the dialog and above, not inside, the listbox",
            );
            await button("Show all sessions");
            assert.deepEqual(await mode(), ["Sessions"]);
            assert.equal((await options("Sessions")).length, TITLES.length);
            assert.ok((await options("Sessions")).includes("Archived notebook"));
            assert.deepEqual(await options("Actions"), []);
            await search("alpha");

            for (const label of ["Actions", "Themes", "Sessions", "All"]) {
                await button(label);
                assert.deepEqual(await mode(), [label]);
                assert.equal(
                    (await value()).replace(/^[>@#]\s*/, ""),
                    "alpha",
                    "changing modes keeps the needle",
                );
                assert.equal(await focused(), true, "mode changes keep the native input focused");
            }

            for (const [prefix, label] of [
                [">", "Actions"],
                ["@", "Sessions"],
                ["#", "Themes"],
            ]) {
                await search(`${prefix} alpha`);
                assert.deepEqual(await mode(), [label]);
                await button("All");
                assert.equal(
                    await value(),
                    " alpha",
                    "All removes only the typed prefix and preserves its search text",
                );
                assert.deepEqual(await mode(), ["All"]);
            }

            await search("zzzzzzzzzz-no-result");
            assert.equal((await options()).length, 0);
            await page.press("Enter");
            assert.equal(
                await focused(),
                true,
                "Enter with no result does not close or run anything",
            );
            await button("Clear search");
            assert.equal(await value(), "");
            assert.equal(await focused(), true);
            assert.ok((await options()).length > 0);
            const fits = await inPage<boolean>(`
            const launcher = document.querySelector(".launcher").getBoundingClientRect();

            return JSON.stringify(launcher.left >= 0 && launcher.right <= innerWidth &&
                launcher.top >= 0 && launcher.bottom <= innerHeight + 1);
        `);

            assert.equal(fits, true, "the launcher fits the viewport");
            await button("Close launcher");
            await closed();
        },
    );
}

test(
    "combobox, groups, and stable selected option IDs describe what the input controls",
    real,
    async () => {
        await home();
        await open();
        const semantics = await inPage<{
            role: string;
            label: string;
            controls: string;
            autocomplete: string;
            expanded: string;
            groupNames: string[];
            tabStops: number[];
            ids: string[];
            selected: string;
        }>(`
        ${GROUPS}
        const input = document.querySelector(".launcher input");
        const options = [...document.querySelectorAll('.launcher [role="option"]')];

        return JSON.stringify({
            role: input.getAttribute("role"), label: input.getAttribute("aria-label"),
            controls: input.getAttribute("aria-controls"), autocomplete: input.getAttribute("aria-autocomplete"),
            expanded: input.getAttribute("aria-expanded"), groupNames: groups.map(groupName),
            tabStops: options.map((option) => option.tabIndex), ids: options.map((option) => option.id),
            selected: input.getAttribute("aria-activedescendant"),
        });
    `);

        assert.equal(semantics.role, "combobox");
        assert.equal(semantics.label, "Search sessions, actions, and themes");
        assert.equal(semantics.controls, "launcher-results");
        assert.equal(semantics.autocomplete, "list");
        assert.equal(semantics.expanded, "true");
        assert.deepEqual(semantics.groupNames, ["Recent sessions", "Actions", "Themes"]);
        assert.ok(semantics.tabStops.every((tabIndex) => tabIndex === -1));
        assert.ok(semantics.ids.every(Boolean));
        assert.equal(new Set(semantics.ids).size, semantics.ids.length);
        assert.ok(semantics.ids.includes(semantics.selected));
        await search("@ alpha");
        const before = await inPage<string>(`
            const item = [...document.querySelectorAll('.launcher-item')].find((item) =>
                item.querySelector('.launcher-title')?.textContent === 'Alpha notes');

            return JSON.stringify(item.id);
        `);

        await search("@ alpha notes");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('.launcher-item.on').id)`,
            ),
            before,
            "the same result keeps its ID across filtering",
        );
        await page.press("ArrowDown");
        assert.equal(
            await inPage<boolean>(`
        const input = document.querySelector(".launcher input");

        return JSON.stringify(document.getElementById(input.getAttribute("aria-activedescendant")) === document.querySelector(".launcher-item.on"));
    `),
            true,
        );
        await search("zzzzzzzz-no-result");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(!document.querySelector('.launcher input').getAttribute('aria-activedescendant'))`,
            ),
            true,
        );
    },
);

test(
    "fuzzy scores order matches and groups, and local title, path, action detail, and theme hits are highlighted",
    real,
    async () => {
        await home();
        await open();
        await search("@ alpha");
        const ranked = await inPage<string[]>(`
            const { workspaceOrder } = await import('/sessions.js');

            return JSON.stringify(workspaceOrder().filter((session) => session.title.startsWith('Alpha '))
                .map((session) => session.title));
        `);

        const alphaResults = await options("Sessions");

        // Full temporary paths can supply extra weak subsequences; all exact Alpha prefixes must still lead,
        // in precisely the workspace order used to break their equal scores.
        assert.deepEqual(
            alphaResults.slice(0, ranked.length),
            ranked,
            "equal fuzzy scores retain workspace rank ahead of weaker title/path matches",
        );
        assert.deepEqual(
            alphaResults.filter((title) => title.startsWith("Alpha ")),
            ranked,
            "every equally scored Alpha result is present in the correct order",
        );
        await search("@ alpha notes");
        const exactAndFuzzy = await options("Sessions");

        assert.ok(exactAndFuzzy.includes("Alpha N o t e s"), "the weaker subsequence also matches");
        assert.equal(
            exactAndFuzzy[0],
            "Alpha notes",
            "an exact title wins over a weaker subsequence",
        );
        await search("@ alpn");
        assert.ok(
            (await options("Sessions")).includes("Alpha notes"),
            "subsequence matching is preserved",
        );
        await search("appearance");
        assert.equal(
            await inPage<string>(`${GROUPS} return JSON.stringify(groupName(groups[0]))`),
            "Actions",
            "best matching group first",
        );
        await search("theme");
        assert.equal(
            await inPage<string>(`${GROUPS} return JSON.stringify(groupName(groups[0]))`),
            "Themes",
            "the highest-scoring group comes first even with action matches present",
        );
        assert.ok((await options("Actions")).length > 0);
        await search("@ uniquepathneedle");
        assert.deepEqual(await options("Sessions"), ["Beta experiments"]);
        assert.equal(
            await inPage<string>(
                `return JSON.stringify([...document.querySelectorAll('.launcher-item.on .launcher-path mark')].map((mark) => mark.textContent).join(''))`,
            ),
            "uniquepathneedle",
        );
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll('.launcher-item.on .launcher-title mark').length)`,
            ),
            0,
            "path matches do not mark unrelated title letters",
        );
        await search("> tiling");
        const detailHits = await inPage<string[]>(
            `return JSON.stringify([...document.querySelectorAll('.launcher-item .launcher-path mark')].map((mark) => mark.textContent))`,
        );

        assert.ok(detailHits.includes("tiling"), "an action's local detail is highlighted");
        await search("# nord");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify([...document.querySelectorAll('.launcher-item.on .launcher-title mark')].map((mark) => mark.textContent).join(''))`,
            ),
            "Nord",
            "theme's synthetic search prefix does not offset visible title hits",
        );
        await page.press("Escape");
        await closed();
    },
);

test(
    "session status is separate from its path, with complete accessible names and titles",
    real,
    async () => {
        await home(VIEWPORTS.desktop, true);
        await page.evaluate(`
        const { store } = await import("/store.js");

        store.set({ sessions: store.state.sessions.map((session) => ({
            ...session,
            busy: session.id === ${sessions[1]},
            waiting: session.id === ${sessions[2]},
        })) });
    `);
        await open();
        await search("@");

        for (const [index, status] of [
            [0, "Current"],
            [1, "Working"],
            [2, "Waiting"],
            [8, "Archived"],
        ] as const) {
            const found = await inPage<{
                detail: string;
                shown: string;
                label: string;
                title: string;
            }>(`
            const item = [...document.querySelectorAll('.launcher-item')].find((item) => item.querySelector('.launcher-title')?.textContent === ${JSON.stringify(TITLES[index])});

            return JSON.stringify({ detail: item.querySelector('.launcher-path').textContent,
                shown: item.querySelector('.launcher-state')?.textContent ?? '',
                label: item.getAttribute('aria-label'), title: item.title });
        `);

            assert.match(found.shown, new RegExp(status));
            assert.doesNotMatch(
                found.detail,
                /Current|Working|Waiting|Archived/,
                "status is not concatenated into the path",
            );
            assert.ok(found.label.includes(TITLES[index]!) && found.label.includes(status));
            assert.ok(found.title.includes(TITLES[index]!) && found.title.includes(status));
            assert.ok(
                found.label.includes(join(work, `project-${index}`)),
                "accessible name keeps the full path",
            );
            assert.ok(
                found.title.includes(join(work, `project-${index}`)),
                "title keeps the full path",
            );
        }

        await search("@ uniquepathneedle");
        assert.ok(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.launcher-item.on').title.includes(${JSON.stringify(pathMatch)}))`,
            ),
        );
        await page.press("Escape");
        await closed();
    },
);

test(
    "arrows, delivered Ctrl aliases, Tab, and Page keys wrap while the native input keeps focus; IME keys do nothing",
    real,
    async () => {
        await home();
        await open();
        await search("@");
        const count = (await options()).length;
        let index = 0;

        for (const [key, delta] of [
            ["ArrowDown", 1],
            ["ArrowUp", -1],
            ["Control+n", 1],
            ["Control+j", 1],
            ["Control+p", -1],
            ["Tab", 1],
            ["Shift+Tab", -1],
            ["PageDown", 8],
            ["PageUp", -8],
        ] as const) {
            if (key.startsWith("Control+")) {
                // Ctrl+N is a browser shortcut: deliver its DOM event to test the app, not Chromium's new-window binding.
                await page.evaluate(
                    `document.querySelector('.launcher input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key.slice(-1))}, ctrlKey: true, bubbles: true, cancelable: true }))`,
                );
            } else {
                await page.press(key);
            }

            index = (index + delta + count) % count;
            await until(
                async () => (await selectedIndex()) === index,
                `${key} selects result ${index}`,
            );
            assert.equal(await focused(), true, `${key} keeps native input focus`);
        }

        const composing = await inPage<boolean[]>(`
        const input = document.querySelector('.launcher input');

        return JSON.stringify(['ArrowDown', 'Enter', 'Escape', 'Tab', 'PageDown'].map((key) => {
            const event = new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true });

            input.dispatchEvent(event);

            return event.defaultPrevented;
        }));
    `);

        assert.deepEqual(composing, [false, false, false, false, false]);
        assert.equal(
            await selectedIndex(),
            index,
            "composition does not navigate, choose, or close",
        );
        assert.equal(await focused(), true);
        await page.type(undefined, " native typing", { append: true });
        assert.equal(await value(), "@ native typing", "text reaches the real native input");
        await page.press("Escape");
        await closed();
    },
);

test(
    "every logical open resets query, mode, selection, and focus, including leaving and same-task reopen",
    real,
    async () => {
        await home(VIEWPORTS.desktop, true);
        await page.evaluate(`document.querySelector('.composer textarea').focus()`);
        await open();

        for (const coalesced of [false, true]) {
            await search("@ alpha");
            await page.press("ArrowDown");
            const reopened = await inPage<boolean>(`
                const { store } = await import('/store.js');

                store.set({ launcher: false });

                if (${coalesced}) {
                    // Both state transitions happen in this one task: there is no intervening render.
                    store.set({ launcher: true });

                    return JSON.stringify(true);
                }

                // Observe the inert leaving node and reopen within the page, not over two CDP round trips.
                for (let frame = 0; frame < 10; frame++) {
                    await new Promise((resolve) => requestAnimationFrame(resolve));

                    if (document.querySelector('.launcher-overlay')?.inert === true) {
                        store.set({ launcher: true });

                        return JSON.stringify(true);
                    }
                }

                return JSON.stringify(false);
            `);

            assert.equal(reopened, true, "the leaving state was observed before reopening");

            await until(focused, "reopened launcher focused");
            await settle();
            assert.equal(
                await value(),
                "",
                coalesced ? "same-task close/open resets query" : "leaving reopen resets query",
            );
            assert.deepEqual(await mode(), ["All"]);
            assert.equal(await selectedIndex(), 0);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.launcher-overlay').inert)`,
                ),
                false,
            );
        }

        await page.press("Escape");
        await closed();
        await see(
            `return JSON.stringify(document.activeElement === document.querySelector('.composer textarea'))`,
            "Escape restores composer focus after launcher cleanup",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.activeElement === document.querySelector('.composer textarea'))`,
            ),
            true,
            "Escape returns to the previous input",
        );
        await open();
        assert.equal(await value(), "");
        await page.press("Escape");
        await closed();
    },
);

test(
    "choosing Nord survives a rapid reopen; a Tokyo preview cancels back to Nord in rendered CSS",
    real,
    async () => {
        await home();
        await open();
        await search("# nord");
        const css = () =>
            inPage<string>(
                `return JSON.stringify(getComputedStyle(document.documentElement).getPropertyValue('--o-bg').trim())`,
            );
        const nord = await css();

        await page.evaluate(`
        const { store } = await import('/store.js');

        document.querySelector('.launcher input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        store.set({ launcher: true });
    `);
        await until(focused, "rapidly reopened after choosing Nord");
        await settle();
        assert.equal(await value(), "");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(JSON.parse(localStorage.getItem('pocket.appearance')).theme)`,
            ),
            "nord",
        );
        assert.equal(await css(), nord, "the previous launcher's cleanup does not undo the choice");
        await search("# tokyo");
        assert.notEqual(await css(), nord, "the selected Tokyo theme is visibly previewed");
        await page.press("Escape");
        await closed();
        assert.equal(await css(), nord, "cancel restores the saved Nord CSS");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(JSON.parse(localStorage.getItem('pocket.appearance')).theme)`,
            ),
            "nord",
        );
    },
);

test(
    "clearing a query after scrolling to the bottom keeps the selected result in view",
    real,
    async () => {
        await home(VIEWPORTS.mobile);
        await open();
        await search("@");
        await page.press("ArrowUp");
        await settle();
        assert.equal(await selectedIndex(), TITLES.length - 1);
        await search("");
        await see(
            `
        const item = document.querySelector('.launcher-item.on').getBoundingClientRect();
        const list = document.querySelector('[role="listbox"]').getBoundingClientRect();

        return JSON.stringify(item.top >= list.top - 1 && item.bottom <= list.bottom + 1);
    `,
            "the reset selection is visible above the old scroll position",
        );
        assert.equal(await selectedIndex(), 0);
    },
);

test(
    "New session opens the folder sheet and its final focus is not stolen by launcher cleanup",
    real,
    async () => {
        await home(VIEWPORTS.desktop, true);
        await page.evaluate(`document.querySelector('.composer textarea').focus()`);
        await open();
        await search("> new session");
        await page.press("Enter");
        await see(
            `return JSON.stringify((await import('/store.js')).store.state.sheet?.type === 'cwd' && document.querySelector('.sheet-host:not(.leaving) .sheet') !== null)`,
            "the New session folder sheet",
        );
        await closed();
        await settle();
        assert.equal(
            await inPage<boolean>(`
        const sheet = document.querySelector('.sheet-host:not(.leaving) .sheet');

        return JSON.stringify(sheet === document.activeElement || sheet.contains(document.activeElement));
    `),
            true,
            "the folder sheet retains focus after the leaving launcher unmounts",
        );
        // Reopen over a sheet: Escape must return to that sheet, not to the composer behind it.
        await open();
        await page.press("Escape");
        await closed();
        await see(
            `
            const sheet = document.querySelector('.sheet-host:not(.leaving) .sheet');

            return JSON.stringify(sheet === document.activeElement || sheet.contains(document.activeElement));
        `,
            "Escape restores sheet focus after launcher cleanup",
        );
        assert.equal(
            await inPage<boolean>(`
        const sheet = document.querySelector('.sheet-host:not(.leaving) .sheet');

        return JSON.stringify(sheet === document.activeElement || sheet.contains(document.activeElement));
    `),
            true,
        );
        await page.evaluate(`(await import('/store.js')).closeSheet()`);
        await settle();
    },
);

test(
    "a retained sheet reopened under the launcher stays inert until the launcher restores its owner's current intent",
    real,
    async () => {
        await home(VIEWPORTS.desktop, true);
        await page.evaluate(`(await import('/store.js')).openSheet({ type: 'cwd', mode: 'new' })`);
        await see(
            `return JSON.stringify(document.querySelector('.sheet-host:not(.leaving) .sheet') !== null)`,
            "the underlying folder sheet",
        );
        await settle();
        const transition = await inPage<{
            retained: boolean;
            leavingInert: boolean;
            openedBeforeRemoval: boolean;
            ownerRemovedInert: boolean;
            backgroundInert: boolean;
            launcherFocused: boolean;
        }>(`
            const { store, closeSheet, openSheet } = await import('/store.js');
            const host = document.querySelector('.sheet-host');
            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            const waitFor = async (check) => {
                for (let at = 0; at < 10; at++) {
                    await frame();

                    if (check()) {
                        return true;
                    }
                }

                return false;
            };

            closeSheet();
            const leavingInert = await waitFor(() => host.isConnected && host.classList.contains('leaving') && host.inert);

            // These transitions remain within the page: CDP's key settling would let the old sheet unmount.
            store.set({ launcher: true });
            const openedBeforeRemoval = await waitFor(() => host.isConnected &&
                document.activeElement === document.querySelector('.launcher input'));
            const changes = [];
            const observeOwner = new MutationObserver((records) => changes.push(...records));

            observeOwner.observe(host, { attributes: true, attributeFilter: ['inert'], attributeOldValue: true });
            openSheet({ type: 'cwd', mode: 'new' });
            await waitFor(() => host.isConnected && !host.classList.contains('leaving'));
            await frame();
            changes.push(...observeOwner.takeRecords());
            observeOwner.disconnect();

            return JSON.stringify({
                retained: document.querySelector('.sheet-host') === host,
                leavingInert,
                openedBeforeRemoval,
                ownerRemovedInert: changes.some((record) => record.oldValue !== null),
                backgroundInert: host.closest('[inert]') !== null,
                launcherFocused: document.activeElement === document.querySelector('.launcher input'),
            });
        `);

        assert.equal(
            transition.leavingInert,
            true,
            "the owner's retained leaving sheet starts inert",
        );
        assert.equal(
            transition.openedBeforeRemoval,
            true,
            "the launcher opens before the retained sheet is removed",
        );
        assert.equal(
            transition.retained,
            true,
            "reopening uses the same sheet host, not a replacement",
        );
        assert.equal(
            transition.ownerRemovedInert,
            true,
            "the sheet owner writes inert=false when it reopens",
        );
        assert.equal(
            transition.backgroundInert,
            true,
            "the launcher still blocks the reopened background sheet",
        );
        assert.equal(transition.launcherFocused, true);
        await page.evaluate(`(await import('/store.js')).store.set({ launcher: false })`);
        await closed();
        await settle();
        const restored = await inPage<{ inert: boolean; open: boolean; focusUsable: boolean }>(`
            const host = document.querySelector('.sheet-host');
            const target = host.querySelector('.sheet button:not([disabled])');

            target.focus({ preventScroll: true });

            return JSON.stringify({ inert: host.inert, open: !host.classList.contains('leaving'),
                focusUsable: document.activeElement === target });
        `);

        assert.equal(restored.open, true);
        assert.equal(
            restored.inert,
            false,
            "cleanup restores the owner's latest non-inert intent, not the captured leaving state",
        );
        assert.equal(
            restored.focusUsable,
            true,
            "the reopened sheet accepts native focus after the launcher closes",
        );
        await page.evaluate(`(await import('/store.js')).closeSheet()`);
        await settle();
    },
);

test(
    "large primary windows use aria-hidden, reject outside focus, and restore each owner's current attributes",
    real,
    async () => {
        await home(VIEWPORTS.desktop, true);
        const original = await inPage<(string | null)[]>(`
            const sidebar = document.querySelector('.sidebar');
            const pane = document.querySelector('.pane');
            const fixture = document.createElement('div');
            const controls = document.createDocumentFragment();

            fixture.dataset.launcherTestLarge = '';

            for (let index = 0; index < 5000; index++) {
                const button = document.createElement('button');

                button.textContent = 'Background control ' + index;
                controls.append(button);
            }

            fixture.append(controls);
            sidebar.append(fixture);

            return JSON.stringify([sidebar, pane].map((node) => node.getAttribute('aria-hidden')));
        `);
        const attributes = () =>
            inPage<(string | null)[]>(`
            return JSON.stringify(['.sidebar', '.pane'].map((selector) =>
                document.querySelector(selector).getAttribute('aria-hidden')));
        `);
        const setAttributes = (values: (string | null)[]) =>
            page.evaluate(`
            ['.sidebar', '.pane'].forEach((selector, index) => {
                const node = document.querySelector(selector);
                const value = ${JSON.stringify(values)}[index];

                if (value === null) {
                    node.removeAttribute('aria-hidden');
                } else {
                    node.setAttribute('aria-hidden', value);
                }
            });
        `);

        const isolated = async () => {
            assert.deepEqual(
                await attributes(),
                ["true", "true"],
                "both primary windows are hidden from AT",
            );
            const guarded = await inPage<{
                nativeInert: boolean;
                composerBlocked: boolean;
                redirected: boolean;
            }>(`
                const sidebar = document.querySelector('.sidebar');
                const pane = document.querySelector('.pane');
                const composer = document.querySelector('.composer textarea');
                const composerBlocked = composer.closest('[inert]') !== null;

                composer.focus({ preventScroll: true });

                return JSON.stringify({ nativeInert: sidebar.inert || pane.inert, composerBlocked,
                    redirected: document.activeElement === document.querySelector('.launcher input') });
            `);

            assert.equal(
                guarded.nativeInert,
                false,
                "large primary windows do not incur native inert updates",
            );
            assert.equal(
                guarded.composerBlocked,
                false,
                "the native focus attempt exercises the focus guard, not inert",
            );
            assert.equal(
                guarded.redirected,
                true,
                "native outside focus returns immediately to the launcher input",
            );
        };

        const dismiss = async () => {
            await page.evaluate(`(await import('/store.js')).store.set({ launcher: false })`);
            await closed();
            await settle();
        };

        try {
            await open();
            await isolated();
            await dismiss();
            assert.deepEqual(
                await attributes(),
                original,
                "the first close restores original values, including absent attributes",
            );

            // A source owner can change its attributes between logical opens; no prior snapshot may leak.
            await setAttributes(["false", "true"]);
            await open();
            await isolated();
            await dismiss();
            assert.deepEqual(
                await attributes(),
                ["false", "true"],
                "pre-existing false and true values survive a subsequent open",
            );

            await open();
            await isolated();
            await setAttributes([null, "false"]);
            await page.evaluate(`
                for (let frame = 0; frame < 3; frame++) {
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                }
            `);
            await isolated();
            await dismiss();
            assert.deepEqual(
                await attributes(),
                [null, "false"],
                "owner changes while blocked are restored, not the values captured at open",
            );
        } finally {
            await page.evaluate(`(await import('/store.js')).store.set({ launcher: false })`);
            await closed();
            await setAttributes(original);
            await page.evaluate(`document.querySelector('[data-launcher-test-large]')?.remove()`);
        }
    },
);
