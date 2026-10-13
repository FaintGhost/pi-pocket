// Extensions' browser modules in a real Chromium: what they add shows in the app (the rail, the menu, the launcher, a
// page in the conversation's place, a sheet), hears its module's events, fails alone, and goes when turned off.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import type { ExtensionWeb } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const dropIns = join(root, "data", "extensions");
const seen = globalThis as unknown as { meterWeb?: ExtensionWeb };

/** The owner's meter: a route, events, and a browser module with a rail button, a page, a menu row, and a sheet. */
const METER = `/** Meter: a reading on a page of its own. */
export default function (_host, web) {
	let reading = 41;
	web.route("GET", "reading", () => ({ reading: ++reading }));
	web.client("meter.js");
	globalThis.meterWeb = web;
}
`;

const METER_JS = `export const pocketApi = 1;

export default function (pocket) {
	const { html, useEffect, useState } = pocket;

	function Meter({ close }) {
		// The tests call the close it was given later, from outside, and see which version drew it.
		globalThis.meterClose = close;
		globalThis.meterDrawnBy = pocket;
		const [reading, setReading] = useState(null);
		const [error, setError] = useState(null);

		useEffect(() => {
			pocket.api("reading").then((answer) => setReading(answer.reading), (failure) => setError(failure.message));

			return pocket.on("reading", (value) => setReading(value));
		}, []);

		return error ? html\`<div class="meter-error">\${error}</div>\` : html\`<p class="meter">Reading: \${reading ?? "…"}</p>\`;
	}

	pocket.page({ id: "meter", title: "Meter", component: Meter });
	const rail = pocket.rail({ id: "meter", title: "Meter", icon: "pulse", page: "meter" });
	pocket.sheet({ id: "about", title: "About the meter", component: ({ who, close }) =>
		html\`<p class="about">For \${who}</p><button class="button about-close" onClick=\${close}>Done</button>\` });
	pocket.menu({ id: "about", label: "About the meter", hint: "an extension's row", sheet: "about" });
	pocket.launcher({ id: "ping", label: "Ping the meter", run: () => pocket.notify("info", "meter pinged") });
	pocket.launcher({ id: "badge", label: "Badge the meter", run: () => rail.update({ badge: 3 }) });
	pocket.launcher({ id: "late", label: "Fail the meter later", run: async () => { await null; throw new Error("meter failed later"); } });
	pocket.launcher({ id: "about", label: "About the meter, here", sheet: "about" });
	pocket.page({ id: "throws", title: "Throws", component: () => { throw new Error("boom while drawing"); } });
	pocket.launcher({ id: "throws", label: "Open the page that throws", page: "throws" });
	// The tests reach this version's pocket, and its rail button, through these.
	globalThis.meterPocket = pocket;
	globalThis.meterRail = rail;
}
`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string, on: BrowserPage = page): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

/**
 * Wait for the page's own finite animations (sheets rising, the page fading in), so clicks land where they aim. Not
 * the notices': their countdown runs for seconds.
 */
async function settled(on: BrowserPage = page): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.getAnimations().every((each) => each.effect?.getComputedTiming().endTime === Infinity || each.playState !== "running" || each.effect?.target?.closest?.(".notices")))`,
                on,
            ),
        "animations to finish",
    );
    // A click soon after a layer opened is let go (back.js): wait it out.
    await new Promise((resolve) => setTimeout(resolve, 450));
}

const has = (selector: string, on: BrowserPage = page) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
        on,
    );

const text = (selector: string) =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? "")`,
    );

/** Run a launcher action by typing its label. */
async function launch(label: string): Promise<void> {
    await settled();
    await page.press("Control+k");
    await until(() => has(".launcher input"), "the launcher");
    await page.type(undefined, label, { submit: true });
    await until(async () => !(await has(".launcher")), "the launcher closes");
}

const notices = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".notice")].map((each) => each.textContent.trim()))`,
    );

/** Run `script` in the page with the meter's `pocket` (the version loaded now) and `html`; what it returns. */
const withMeter = <T>(script: string) =>
    inPage<T>(`const pocket = globalThis.meterPocket; const { html } = pocket; ${script}`);

/** A finger's swipe right across what `selector` finds, as a phone sends it, from `from` pixels in from the left. */
async function swipeRight(selector: string, from = 80): Promise<void> {
    await inPage<null>(`
        const target = document.querySelector(${JSON.stringify(selector)});
        const box = target.getBoundingClientRect();
        const y = box.top + Math.min(box.height / 2, 40);
        const touch = (x) => new Touch({ identifier: 1, target, clientX: x, clientY: y });
        const fire = (type, x) =>
            target.dispatchEvent(
                new TouchEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    touches: type === "touchend" ? [] : [touch(x)],
                    changedTouches: [touch(x)],
                }),
            );

        fire("touchstart", ${from});

        for (let x = ${from} + 20; x <= ${from} + 180; x += 20) {
            fire("touchmove", x);
        }

        fire("touchend", ${from} + 180);

        return "null";
    `);
}

/** Press Esc as an input method does to end what is being composed, not as a key of its own. */
const composingEscape = () =>
    inPage<null>(
        `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })); return "null";`,
    );

/** The type of the sheet open now, as the app has it: one closing still shows a moment while it slides away. */
const sheetType = () =>
    inPage<string | null>(
        `return JSON.stringify((await import("/store.js")).store.state.sheet?.type ?? null)`,
    );

/** How this tab's copy of a module's browser module stands, as the Extensions sheet reads it. */
const stateOf = (module: string) =>
    inPage<unknown>(
        `return JSON.stringify((await import("/extension-ui.js")).browserModuleState(${JSON.stringify(module)}) ?? null)`,
    );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, "meter.ts"), METER);
    writeFileSync(join(dropIns, "meter.js"), METER_JS);
    // For everyone who sees every session: a viewer's tabs load it too.
    // A folder, with a stylesheet it loads.
    writeFileSync(
        join(dropIns, "shared.ts"),
        `/** Shared: a rail button for everyone. */\nexport default (_host, web) => { web.client("shared", { access: "view" }); };\n`,
    );
    mkdirSync(join(dropIns, "shared"));
    writeFileSync(
        join(dropIns, "shared", "index.js"),
        `export default (pocket) => { pocket.style("look.css"); pocket.rail({ id: "hi", title: "Shared", run: () => pocket.notify("info", "hi from shared") }); };\n`,
    );
    writeFileSync(
        join(dropIns, "shared", "look.css"),
        `.rail-ext[title="Shared"] { outline: 3px solid rgb(1, 2, 3); }\n`,
    );
    // Fails while it sets up: the app goes on without it.
    writeFileSync(
        join(dropIns, "broken.ts"),
        `/** Broken: a browser module that throws. */\nexport default (_host, web) => { web.client("broken.js"); };\n`,
    );
    // A timer it left running tries to add more after it failed: a rail button, a stylesheet, a listener, a cleanup.
    writeFileSync(
        join(dropIns, "broken.js"),
        `export default (pocket) => {
	pocket.rail({ id: "x", title: "Broken", run() {} });
	setTimeout(() => {
		try {
			pocket.rail({ id: "late", title: "Late", run() {} });
			pocket.style("late.css");
			pocket.on("tick", () => {});
			pocket.onDispose(() => { globalThis.brokenLateDisposed = true; });
		} finally {
			globalThis.brokenLateRan = true;
		}
	}, 200);
	throw new Error("broken on purpose");
};
`,
    );
    app = await openApp(scriptedModel());

    // Broken is turned on in its own test: its notice would cover the top bar's buttons in the others.
    for (const file of ["meter.ts", "shared.ts"]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }

    session = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "extension-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const rail = (title: string) => `.sidebar .rail-ext[title="${title}"]`;

test(
    "a browser module's rail button opens its page, which calls its route and hears its events",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await settled();
        // Pi's subagents button stays where it was, and the extension's come after it.
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".sidebar .rail-button")].map((each) => each.getAttribute("aria-label")).filter((label) => ["Subagents", "Meter", "Shared", "People"].includes(label)))`,
            ),
            ["Subagents", "Meter", "Shared", "People"],
        );

        await page.click({ selector: rail("Meter") });
        await until(
            async () => (await text(".ext-page .meter")) === "Reading: 42",
            "the reading from its route",
        );
        assert.equal(await text(".ext-page .board-title h2"), "Meter");
        assert.equal(await has(".composer"), false, "the page takes the conversation's place");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(rail("Meter"))}).getAttribute("aria-pressed"))`,
            ),
            "true",
        );

        seen.meterWeb!.send("reading", 7);
        await until(
            async () => (await text(".ext-page .meter")) === "Reading: 7",
            "the reading the server sent",
        );

        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".ext-page")), "Esc closes the page");
        await until(() => has(".composer"), "the conversation is back");
    },
);

test(
    "its menu row opens its sheet with what it was given, and its launcher action runs",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(".topbar"), "the conversation");
        await settled();
        await page.click({ selector: '.topbar [aria-label="Menu"]' });
        await until(() => has(".sheet"), "the menu");
        await settled();
        await page.click({ label: "About the meter" });
        await until(
            async () => (await text(".sheet h2")) === "About the meter",
            "the extension's sheet",
        );
        // The menu's row opens the sheet with no props: `who` is missing, and the sheet still draws.
        assert.equal(await text(".sheet .about"), "For");
        await settled();
        await page.click({ selector: ".sheet .about-close" });
        await until(async () => !(await has(".sheet")), "its close button closes it");

        await launch("ping the meter");
        await until(async () => (await notices()).includes("meter pinged"), "the action ran");
    },
);

test(
    "an action that fails later says so, a rail button's badge changes, and a stylesheet loads",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await launch("fail the meter later");
        await until(
            async () => (await notices()).includes("meter: meter failed later"),
            "the async action's failure",
        );
        await launch("badge the meter");
        await until(async () => (await text(`${rail("Meter")} .rail-count`)) === "3", "the badge");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(rail("Meter"))}).getAttribute("aria-label"))`,
            ),
            "Meter, 3",
        );
        await until(
            async () =>
                (await inPage<string>(
                    `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(rail("Shared"))})).outlineColor)`,
                )) === "rgb(1, 2, 3)",
            "the shared module's stylesheet",
        );
    },
);

test(
    "Esc closes a sheet over a page first, and a page that throws while drawing says why",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await settled();
        await page.click({ selector: rail("Meter") });
        await until(() => has(".ext-page .meter"), "the page");
        await launch("about the meter, here");
        await until(() => has(".sheet .about"), "the sheet over the page");
        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".sheet")), "Esc closes the sheet");
        assert.equal(await has(".ext-page .meter"), true, "and leaves the page");
        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".ext-page")), "a second Esc closes the page");

        await launch("open the page that throws");
        await until(
            async () =>
                (await text(".ext-page .error-box")) === "Throws failed: boom while drawing",
            "the error in the page's place",
        );
        assert.equal(await has(".sidebar .rail"), true, "the rest of the app goes on");
        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".ext-page")), "Esc still closes it");
    },
);

test(
    "what a browser module adds is checked: pages and sheets it names, route paths, stylesheets, and icons",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        const refused = await withMeter<string[]>(`
            const tries = [
                () => pocket.rail({ id: "bad", title: "Bad", page: Object.create(null) }),
                () => pocket.rail({ id: "bad", title: "Bad", page: 123 }),
                () => pocket.menu({ id: "bad", label: "Bad", sheet: "../about" }),
                () => pocket.launcher({ id: "bad", label: "Bad", page: "" }),
                () => pocket.page({ id: "bad", title: "Bad", component: () => null, escape: "no" }),
                () => pocket.openPage(123),
                () => pocket.openPage(Object.create(null)),
                () => pocket.openSheet({}),
                () => pocket.openSheet("about", "props"),
                () => pocket.style("//evil.example/look.css"),
                () => pocket.style("https://evil.example/look.css"),
                () => pocket.style("../other/look.css"),
                () => globalThis.meterRail.update("badge"),
            ];
            const out = [];

            for (const each of tries) {
                try {
                    each();
                    out.push("accepted");
                } catch (error) {
                    out.push(error.message);
                }
            }

            const paths = [
                "../reading",
                "a/../reading",
                "./reading",
                "..",
                "%2e%2E/reading",
                "a\\\\..\\\\reading",
                "//evil.example/reading",
                "https://evil.example/reading",
                "javascript:alert(1)",
            ];

            for (const path of paths) {
                out.push(await pocket.api(path).then(() => "accepted", (error) => error.message));
            }

            return JSON.stringify(out);
        `);

        assert.equal(refused.length, 22);

        for (const [index, message] of refused.entries()) {
            assert.match(message, /^pocket\./, `try ${index} refused: ${message}`);
        }

        // Its own routes still answer, with a leading slash too; nothing it was refused shows.
        assert.ok(
            (
                await withMeter<{ reading: number }>(
                    `return JSON.stringify(await pocket.api("/reading"))`,
                )
            ).reading > 0,
        );
        assert.equal(await has(rail("Bad")), false);
        assert.equal(await has(".ext-page"), false);
        assert.equal(await has(".sheet"), false);

        // A page it never added, once it is ready: it says so, rather than loading for ever.
        await withMeter<null>(`pocket.openPage("nowhere"); return "null";`);
        await until(
            async () => /no longer has this/.test(await text(".ext-page .ext-page-body")),
            "the page it does not have",
        );
        await withMeter<null>(`pocket.closePage(); return "null";`);
        await until(async () => !(await has(".ext-page")), "the page closes");

        // Icon names that are not the app's icons, inherited ones too, show the square of four.
        const icons = await withMeter<{ title: string; d: string | null }[]>(`
            const handles = ["__proto__", "constructor", "toString", "nope"].map((icon, index) =>
                pocket.rail({ id: "icon" + index, title: "Icon " + icon, icon, run() {} }),
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            const out = [...document.querySelectorAll('.sidebar .rail-ext[title^="Icon "] path')].map((each) => ({
                title: each.closest("button").title,
                d: each.getAttribute("d"),
            }));

            handles.forEach((handle) => handle.remove());

            return JSON.stringify(out);
        `);
        const grid = await inPage<string>(
            `return JSON.stringify((await import("/ui.js")).iconPath("grid"))`,
        );

        assert.equal(icons.length, 4);
        assert.ok(grid.length > 0);

        for (const icon of icons) {
            assert.equal(icon.d, grid, `${icon.title} shows the square of four`);
        }
    },
);

test("adding or updating what is already there draws nothing again", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");
    // Redraws come once for all the changes before them: each step waits for its own.
    const revs = await withMeter<number[]>(`
        const { store } = await import("/store.js");
        const out = [];
        const step = async (change) => {
            change();
            await new Promise((resolve) => setTimeout(resolve));
            out.push(store.state.extensionsRev);
        };
        const run = () => {};
        let first;
        let second;
        let many;

        await step(() => globalThis.meterRail.update({ badge: 5 }));
        await step(() => {
            globalThis.meterRail.update({ badge: 5 });
            globalThis.meterRail.update({});
        });
        await step(() => (first = pocket.rail({ id: "same", title: "Same", run })));
        await step(() => (second = pocket.rail({ id: "same", title: "Same", run })));
        // The newer one changes it; the one it replaced changes nothing.
        await step(() => first.update({ badge: 9 }));
        await step(() => second.update({ badge: 1 }));
        // Many changes at once draw once.
        await step(() => {
            many = Array.from({ length: 300 }, (_, index) =>
                pocket.rail({ id: "at-once" + index, title: "At once " + index, run }),
            );
        });
        await step(() => {
            many.forEach((each) => each.remove());
            second.remove();
            globalThis.meterRail.update({ badge: undefined });
        });

        return JSON.stringify(out);
    `);

    assert.equal(revs[1], revs[0], "an update that changes nothing");
    assert.equal(revs[3], revs[2], "the same spec added again");
    assert.equal(revs[4], revs[3], "an update through a handle that was replaced");
    assert.equal(revs[5], revs[4]! + 1, "an update that changes something");
    assert.equal(revs[6], revs[5]! + 1, "300 added at once draw once");
    assert.equal(revs[7], revs[6]! + 1, "and go at once");
    assert.equal(await has(rail("At once 0")), false);

    // A page that updates its rail button each time it draws, as an effect without deps would, settles.
    await withMeter<null>(`
        pocket.page({
            id: "busy",
            title: "Busy",
            component: () => {
                pocket.useEffect(() => globalThis.meterRail.update({ badge: 1 }));

                return html\`<p class="busy">Busy</p>\`;
            },
        });
        pocket.openPage("busy");

        return "null";
    `);
    await until(() => has(".ext-page .busy"), "the busy page");
    await sleep(300);
    const rev = () =>
        inPage<number>(
            `return JSON.stringify((await import("/store.js")).store.state.extensionsRev)`,
        );
    const before = await rev();

    await sleep(500);
    assert.equal(await rev(), before, "the app does not draw again and again");
    await withMeter<null>(
        `pocket.closePage(); globalThis.meterRail.update({ badge: undefined }); return "null";`,
    );
    await until(async () => !(await has(".ext-page")), "the page closes");
});

test(
    "a page that throws something other than an error says so as text, and a stylesheet that does not load says so",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");

        for (const [thrown, says] of [
            [`""`, "Thrown failed: it gave no reason"],
            ["null", "Thrown failed: it gave no reason"],
            ["undefined", "Thrown failed: it gave no reason"],
            ["0", "Thrown failed: 0"],
            [
                `new Error('<img class="injected" src="x">')`,
                'Thrown failed: <img class="injected" src="x">',
            ],
        ]) {
            await withMeter<null>(`
                pocket.page({ id: "thrown", title: "Thrown", component: () => { throw ${thrown}; } });
                pocket.closePage();
                await new Promise((resolve) => setTimeout(resolve, 50));
                pocket.openPage("thrown");

                return "null";
            `);
            await until(
                async () => (await text(".ext-page .error-box")) === says,
                `the error box for ${thrown}`,
            );
            assert.equal(await has(".ext-page .injected"), false, "text, not markup");
        }

        await withMeter<null>(`pocket.closePage(); return "null";`);
        await until(async () => !(await has(".ext-page")), "the page closes");

        // The meter is a file alone: it has no folder, so a stylesheet beside it is not served.
        await withMeter<null>(`pocket.style("missing.css"); return "null";`);
        await until(
            async () =>
                (await notices()).some((each) =>
                    /its stylesheet missing\.css did not load/.test(each),
                ),
            "the stylesheet's notice",
        );
    },
);

test(
    "a page whose component failed draws again once its component is replaced, and only then",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await withMeter<null>(`
            globalThis.healPage = pocket.page({
                id: "heal",
                title: "Heal",
                component: () => {
                    throw new Error("sick");
                },
            });
            pocket.openPage("heal");

            return "null";
        `);
        await until(
            async () => (await text(".ext-page .error-box")) === "Heal failed: sick",
            "sick",
        );
        // Drawn again for another reason, it stays as it was.
        await inPage<null>(`globalThis.meterRail.update({ badge: 7 }); return "null"`);
        await until(async () => (await text(`${rail("Meter")} .rail-count`)) === "7", "the badge");
        assert.equal(await text(".ext-page .error-box"), "Heal failed: sick");

        // Added again with a component that works, it shows.
        await withMeter<null>(`
            pocket.page({ id: "heal", title: "Heal", component: () => html\`<p class="healed">Well</p>\` });

            return "null";
        `);
        await until(() => has(".ext-page .healed"), "the page added again");

        // Or updated with one.
        await withMeter<null>(`
            globalThis.healPage = pocket.page({
                id: "heal",
                title: "Heal",
                component: () => {
                    throw new Error("sick again");
                },
            });

            return "null";
        `);
        await until(
            async () => (await text(".ext-page .error-box")) === "Heal failed: sick again",
            "sick again",
        );
        await inPage<null>(
            `globalThis.healPage.update({ component: () => globalThis.meterPocket.html\`<p class="healed">Well again</p>\` }); return "null"`,
        );
        await until(async () => (await text(".ext-page .healed")) === "Well again", "updated");
        await withMeter<null>(
            `pocket.closePage(); globalThis.meterRail.update({ badge: undefined }); return "null";`,
        );
    },
);

test(
    "nothing at all thrown, by a class or by a component inside that draws again alone, shows in the error box",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await withMeter<null>(`
            const { Component } = await import("/vendor/preact.mjs");

            class Classy extends Component {
                render() {
                    throw null;
                }
            }

            pocket.page({ id: "classy", title: "Classy", component: Classy });
            pocket.openPage("classy");

            return "null";
        `);
        await until(
            async () => (await text(".ext-page .error-box")) === "Classy failed: it gave no reason",
            "the class's error box",
        );

        await withMeter<null>(`
            function Inner() {
                const [broken, setBroken] = pocket.useState(false);

                if (broken) {
                    throw undefined;
                }

                return html\`<button class="button break-inner" onClick=\${() => setBroken(true)}>
                    Break
                </button>\`;
            }

            pocket.page({ id: "nested", title: "Nested", component: () => html\`<div><\${Inner} /></div>\` });
            pocket.openPage("nested");

            return "null";
        `);
        await until(() => has(".ext-page .break-inner"), "the page with a component inside");
        await settled();
        await page.click({ selector: ".ext-page .break-inner" });
        await until(
            async () => (await text(".ext-page .error-box")) === "Nested failed: it gave no reason",
            "the inner component's error box, at once",
            3000,
        );
        assert.equal(await has(".sidebar .rail"), true, "the app goes on");

        // A component is drawn as it is: what Preact reads from it, such as its contextType, holds.
        await withMeter<null>(`
            const { createContext } = await import("/vendor/preact.mjs");
            const Said = createContext("from its context");

            function Context(props, context) {
                return html\`<p class="context">\${context}</p>\`;
            }

            Context.contextType = Said;
            pocket.page({ id: "context", title: "Context", component: Context });
            pocket.openPage("context");

            return "null";
        `);
        await until(
            async () => (await text(".ext-page .context")) === "from its context",
            "its context",
        );
        await withMeter<null>(`pocket.closePage(); return "null";`);
        await until(async () => !(await has(".ext-page")), "the page closes");
    },
);

test(
    "Esc: not while composing, and a page can keep it, while a layer over it still closes",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await settled();
        await page.click({ selector: rail("Meter") });
        await until(() => has(".ext-page .meter"), "the page");
        await inPage<null>(
            `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })); return "null";`,
        );
        await sleep(200);
        assert.equal(await has(".ext-page .meter"), true, "an input method's Esc leaves it open");

        await withMeter<null>(`
            pocket.page({
                id: "keeps",
                title: "Keeps",
                escape: false,
                component: () => html\`<input class="keeps-input" aria-label="Keeps" />\`,
            });
            pocket.launcher({ id: "keeps", label: "Open the page that keeps Esc", page: "keeps" });

            return "null";
        `);
        await launch("open the page that keeps esc");
        await until(() => has(".ext-page .keeps-input"), "the page that keeps Esc");
        await settled();
        await page.click({ selector: ".ext-page .keeps-input" });
        await page.press("Escape");
        await sleep(200);
        assert.equal(await has(".ext-page .keeps-input"), true, "Esc is the page's");

        await page.press("Control+k");
        await until(() => has(".launcher input"), "the launcher over it");
        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".launcher")), "Esc closes the launcher");
        assert.equal(await has(".ext-page .keeps-input"), true, "and leaves the page");
        await settled();
        await page.click({ selector: '.ext-page [aria-label="Close"]' });
        await until(async () => !(await has(".ext-page")), "its × closes it");
    },
);

test("a sheet stays open on the Esc that ends composing, and closes on Esc", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");
    await launch("about the meter, here");
    await until(() => has(".sheet .about"), "the meter's sheet");
    await settled();
    await composingEscape();
    await sleep(200);
    assert.equal(await sheetType(), "ext", "an input method's Esc leaves it open");
    await page.press("Escape");
    await until(async () => !(await has(".sheet")), "Esc closes it");
});

test("a rail button's badge hides at 0, empty, or none, as the app's counts do", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");

    const shown = async (badge: string) => {
        await inPage<null>(`globalThis.meterRail.update({ badge: ${badge} }); return "null"`);
        await sleep(100);

        return {
            count: await text(`${rail("Meter")} .rail-count`),
            label: await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(rail("Meter"))}).getAttribute("aria-label"))`,
            ),
        };
    };

    assert.deepEqual(await shown("2"), { count: "2", label: "Meter, 2" });

    for (const badge of ["0", `""`, `"  "`, "null", "false", "undefined"]) {
        assert.deepEqual(await shown(badge), { count: "", label: "Meter" }, `badge ${badge}`);
    }
});

test("a sheet that opens a page closes first, so back closes the page", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");
    await withMeter<null>(`
        pocket.sheet({
            id: "opener",
            title: "Opener",
            component: () =>
                html\`<button class="button open-meter" onClick=\${() => pocket.openPage("meter")}>
                    Open the meter
                </button>\`,
        });
        pocket.launcher({ id: "opener", label: "Show the opener sheet", sheet: "opener" });

        return "null";
    `);
    await launch("show the opener sheet");
    await until(() => has(".sheet .open-meter"), "the sheet");
    await settled();
    await page.click({ selector: ".sheet .open-meter" });
    await until(() => has(".ext-page .meter"), "the page");
    await until(async () => !(await has(".sheet")), "the sheet closed");
    await settled();
    assert.equal(
        await inPage<number>(`return JSON.stringify(history.state?.pocket?.layers ?? 0)`),
        1,
        "one step back: the page",
    );
    await inPage<null>(`history.back(); return "null"`);
    await until(async () => !(await has(".ext-page")), "back closes the page");
    await sleep(300);
    assert.equal(await has(".sheet"), false, "and no sheet comes back");
});

test(
    "the close a page or sheet is given closes that one only: not a sheet over it, nor another page",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await withMeter<null>(`
            pocket.sheet({
                id: "keeper",
                title: "Keeper",
                component: ({ close }) => {
                    globalThis.keptSheetClose = close;

                    return html\`<p class="keeper">Keeper</p>\`;
                },
            });
            pocket.page({
                id: "other",
                title: "Other",
                component: ({ close }) => {
                    globalThis.otherClose = close;

                    return html\`<p class="other">Other</p>\`;
                },
            });
            pocket.openSheet("keeper");

            return "null";
        `);
        await until(() => has(".sheet .keeper"), "the sheet that keeps its close");
        await launch("appearance");
        await until(
            async () => (await text(".sheet h2")) === "Appearance",
            "the app's sheet in its place",
        );
        await inPage<null>(`globalThis.keptSheetClose(); return "null"`);
        await sleep(200);
        assert.equal(await sheetType(), "appearance", "the kept close left the app's sheet");
        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".sheet")), "Esc closes it");

        await settled();
        await page.click({ selector: rail("Meter") });
        await until(() => has(".ext-page .meter"), "the meter's page");
        await inPage<null>(`globalThis.firstClose = globalThis.meterClose; return "null"`);
        await withMeter<null>(`pocket.openPage("other"); return "null";`);
        await until(() => has(".ext-page .other"), "another page in its place");
        await inPage<null>(`globalThis.firstClose(); return "null"`);
        await sleep(200);
        assert.equal(await has(".ext-page .other"), true, "the first page's close left it open");
        await inPage<null>(`globalThis.otherClose(); return "null"`);
        await until(async () => !(await has(".ext-page")), "its own close closes it");
    },
);

test("a browser module that fails says so, and the rest of the app goes on", real, async () => {
    await app.setExtensionEnabled(owner(app), "broken.ts", true);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            (await notices()).some((each) =>
                each.includes("broken failed to load in this browser: broken on purpose"),
            ),
        "the failure's notice",
    );
    // What it added before it threw is gone; the others' stay.
    assert.equal(await has(rail("Broken")), false);
    assert.equal(await has(rail("Meter")), true);
    assert.equal(await has(".composer"), true);
    // What its timer tries after that adds nothing, and a cleanup it gives then runs at once.
    await until(
        () => inPage<boolean>(`return JSON.stringify(globalThis.brokenLateRan === true)`),
        "its timer",
    );
    await sleep(100);
    assert.equal(await has(rail("Late")), false);
    assert.equal(await has('link[data-extension="broken"]'), false);
    assert.equal(
        await inPage<boolean>(`return JSON.stringify(globalThis.brokenLateDisposed === true)`),
        true,
    );
    // Its row in the Extensions sheet still says why.
    assert.deepEqual(
        await inPage<unknown>(
            `return JSON.stringify((await import("/extension-ui.js")).browserModuleState("broken"))`,
        ),
        { status: "failed", error: "broken on purpose" },
    );
    await app.setExtensionEnabled(owner(app), "broken.ts", false);
});

test("a viewer's tabs load only what is for them", real, async () => {
    const { token } = app.config.addUser("Vee", "viewer");
    const viewer = await browsers.open(2);

    try {
        await viewer.setViewport(DESKTOP);
        await viewer.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await until(() => has(rail("Shared"), viewer), "the shared rail button", 20_000);
        assert.equal(await has(rail("Meter"), viewer), false);
    } finally {
        await browsers.close(2);
    }
});

test("on a phone the page fills the screen, and back closes it", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/`);
    await until(
        () => has(`.home-list .rail-ext[title="Meter"]`),
        "the rail on the phone's home screen",
    );
    await settled();
    await page.click({ selector: `.home-list .rail-ext[title="Meter"]` });
    await until(() => has(".ext-page .meter"), "the page");
    const box = await inPage<{ width: number; height: number }>(
        `const box = document.querySelector(".ext-page").getBoundingClientRect(); return JSON.stringify({ width: box.width, height: box.height })`,
    );

    assert.ok(
        box.width >= 380 && box.height >= 800,
        `the page fills the screen: ${JSON.stringify(box)}`,
    );
    await settled();
    await inPage<null>(`history.back(); return "null"`);
    await until(async () => !(await has(".ext-page")), "back closes the page");
    await page.setViewport(DESKTOP);
});

test(
    "on a phone a page can keep its sideways swipes: all of it, or what is marked",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.mobile);

        try {
            await page.navigate(`${base}/`);
            await until(
                () => has(`.home-list .rail-ext[title="Meter"]`),
                "the rail on the phone's home screen",
            );
            await withMeter<null>(`
                pocket.page({
                    id: "zones",
                    title: "Zones",
                    component: () => html\`<div class="no-swipe-zone" data-no-swipe>A map</div>
                        <p class="swipe-zone">Words</p>\`,
                });
                pocket.page({
                    id: "still",
                    title: "Still",
                    swipe: false,
                    component: () => html\`<p class="still-zone">A canvas</p>\`,
                });
                pocket.rail({ id: "zones", title: "Zones", page: "zones" });
                pocket.rail({ id: "still", title: "Still", page: "still" });

                return "null";
            `);
            await settled();
            await page.click({ selector: `.home-list .rail-ext[title="Zones"]` });
            await until(() => has(".ext-page .swipe-zone"), "the page with a marked part");
            await settled();
            await swipeRight(".ext-page .no-swipe-zone");
            await sleep(400);
            assert.equal(await has(".ext-page .swipe-zone"), true, "the marked part keeps it");
            await swipeRight(".ext-page .swipe-zone");
            await until(async () => !(await has(".ext-page")), "the rest of it goes back");

            await settled();
            await page.click({ selector: `.home-list .rail-ext[title="Still"]` });
            await until(() => has(".ext-page .still-zone"), "the page that keeps them all");
            await settled();
            await swipeRight(".ext-page .still-zone");
            await sleep(400);
            assert.equal(await has(".ext-page .still-zone"), true, "no swipe goes back on it");
            await swipeRight(".ext-page .board-head");
            await sleep(400);
            assert.equal(await has(".ext-page .still-zone"), true, "not even on its title");
            await inPage<null>(`history.back(); return "null"`);
            await until(async () => !(await has(".ext-page")), "back still closes it");

            // Many buttons scroll in their group: the app's own stay in reach.
            await withMeter<null>(`
                globalThis.manyButtons = Array.from({ length: 16 }, (_, index) =>
                    pocket.rail({ id: "many" + index, title: "Many " + index, run() {} }),
                );

                return "null";
            `);
            await until(() => has(`.home-list .rail-ext[title="Many 15"]`), "the many buttons");
            const fits = await inPage<{ me: boolean; scrolls: boolean }>(`
                const rail = document.querySelector(".home-list .rail").getBoundingClientRect();
                const me = document.querySelector(".home-list .rail-me").getBoundingClientRect();
                const group = document.querySelector(".home-list .rail-exts");

                return JSON.stringify({
                    me: me.top >= rail.top && me.bottom <= rail.bottom + 1 && me.bottom <= innerHeight + 1,
                    scrolls: group.scrollHeight > group.clientHeight,
                });
            `);

            assert.deepEqual(fits, { me: true, scrolls: true });
        } finally {
            await withMeter<null>(`
                for (const each of globalThis.manyButtons ?? []) {
                    each.remove();
                }

                return "null";
            `).catch(() => null);
            await page.setViewport(DESKTOP);
        }
    },
);

test(
    "a page swipes back only at a phone's width, and the edge's swipe back keeps out of what keeps its swipes",
    real,
    async () => {
        try {
            // A tablet, touch and narrow, wider than a phone: the page keeps its sideways swipes, as the board does.
            await page.setViewport(VIEWPORTS.tablet);
            await page.navigate(`${base}/s/${session}`);
            await until(() => has(".composer"), "the conversation");
            await withMeter<null>(`pocket.openPage("meter"); return "null";`);
            await until(() => has(".ext-page .meter"), "the page");
            await settled();
            await swipeRight(".ext-page .meter");
            await sleep(400);
            assert.equal(await has(".ext-page .meter"), true, "no swipe back on a tablet");
            await withMeter<null>(`pocket.closePage(); return "null";`);

            // An iPhone's home screen app: a swipe in from the left edge goes back.
            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/`);
            await until(() => has(`.home-list .rail-ext[title="Meter"]`), "the phone's rail");
            await inPage<null>(`
                Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
                (await import("/gestures.js")).startEdgeBack();

                return "null";
            `);
            await withMeter<null>(`
                pocket.page({
                    id: "zones",
                    title: "Zones",
                    component: () => html\`<div class="no-swipe-zone" data-no-swipe>A map</div>
                        <p class="swipe-zone">Words</p>\`,
                });
                pocket.page({
                    id: "still",
                    title: "Still",
                    swipe: false,
                    component: () => html\`<p class="still-zone">A canvas</p>\`,
                });
                pocket.openPage("still");

                return "null";
            `);
            await until(() => has(".ext-page .still-zone"), "the page that keeps its swipes");
            await settled();
            await swipeRight(".ext-page .still-zone", 5);
            await sleep(400);
            assert.equal(await has(".ext-page .still-zone"), true, "not from the edge either");

            await withMeter<null>(`pocket.openPage("zones"); return "null";`);
            await until(() => has(".ext-page .swipe-zone"), "the page with a marked part");
            await settled();
            await swipeRight(".ext-page .no-swipe-zone", 5);
            await sleep(400);
            assert.equal(await has(".ext-page .swipe-zone"), true, "the marked part keeps it");
            await swipeRight(".ext-page .swipe-zone", 5);
            await until(async () => !(await has(".ext-page")), "the rest goes back from the edge");
        } finally {
            await page.setViewport(DESKTOP);
        }
    },
);

test("in the folded sidebar, many rail buttons leave the sessions their room", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");
    await inPage<null>(`(await import("/theme.js")).setPrefs({ sidebar: "rail" }); return "null"`);

    try {
        await until(() => has(".sidebar .rail-items .ws"), "the folded rail's sessions");
        await withMeter<null>(`
            globalThis.manyButtons = Array.from({ length: 16 }, (_, index) =>
                pocket.rail({ id: "many" + index, title: "Many " + index, run() {} }),
            );

            return "null";
        `);
        await until(() => has(rail("Many 15")), "the many buttons");
        await settled();
        const room = await inPage<{
            sessions: number;
            tile: boolean;
            me: boolean;
            scrolls: boolean;
        }>(`
            const items = document.querySelector(".sidebar .rail-items");
            const tile = document.querySelector(".sidebar .rail-items .ws").getBoundingClientRect();
            const box = items.getBoundingClientRect();
            const me = document.querySelector(".sidebar .rail-me").getBoundingClientRect();
            const group = document.querySelector(".sidebar .rail-exts");

            return JSON.stringify({
                sessions: Math.round(box.height),
                tile: tile.top >= box.top && tile.bottom <= box.bottom + 1,
                me: me.bottom <= innerHeight + 1,
                scrolls: group.scrollHeight > group.clientHeight,
            });
        `);

        assert.ok(room.sessions >= 120, `the sessions keep their room: ${room.sessions}px`);
        assert.deepEqual(
            { tile: room.tile, me: room.me, scrolls: room.scrolls },
            { tile: true, me: true, scrolls: true },
        );
    } finally {
        await withMeter<null>(`
            for (const each of globalThis.manyButtons ?? []) {
                each.remove();
            }

            (await import("/theme.js")).setPrefs({ sidebar: "open" });

            return "null";
        `);
    }
});

test(
    "beside the session list, many rail buttons keep four buttons' room and scroll; a short window scrolls the rail",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await withMeter<null>(`
            globalThis.manyButtons = Array.from({ length: 16 }, (_, index) =>
                pocket.rail({ id: "many" + index, title: "Many " + index, run() {} }),
            );

            return "null";
        `);
        await until(() => has(rail("Many 15")), "the many buttons");

        try {
            const measure = () =>
                inPage<{ group: number; scrolls: boolean; me: boolean }>(`
                    const group = document.querySelector(".sidebar .rail-exts");
                    const nav = document.querySelector(".sidebar .rail");
                    const me = document.querySelector(".sidebar .rail-me");

                    me.scrollIntoView({ block: "nearest" });
                    const box = me.getBoundingClientRect();
                    const rail = nav.getBoundingClientRect();

                    return JSON.stringify({
                        group: Math.round(group.getBoundingClientRect().height),
                        scrolls: group.scrollHeight > group.clientHeight,
                        me: box.top >= rail.top - 1 && box.bottom <= rail.bottom + 1,
                    });
                `);

            assert.deepEqual(await measure(), { group: 188, scrolls: true, me: true });
            await page.setViewport({ ...DESKTOP, height: 520 });
            await sleep(300);
            assert.deepEqual(await measure(), { group: 188, scrolls: true, me: true });
        } finally {
            await page.setViewport(DESKTOP);
            await withMeter<null>(`
                for (const each of globalThis.manyButtons ?? []) {
                    each.remove();
                }

                return "null";
            `);
        }
    },
);

test(
    "an edited module keeps its place on the rail, and its old version closes nothing of the new one",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await settled();
        await page.click({ selector: rail("Meter") });
        await until(() => has(".ext-page .meter"), "the old version's page");
        await inPage<null>(
            `globalThis.oldMeterPocket = globalThis.meterPocket; globalThis.oldMeterClose = globalThis.meterClose; return "null"`,
        );
        writeFileSync(join(dropIns, "meter.js"), `${METER_JS}\n// Edited.\n`);
        await app.loader.reload("meter.ts");
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(globalThis.meterPocket !== globalThis.oldMeterPocket && globalThis.meterDrawnBy === globalThis.meterPocket && document.querySelector(${JSON.stringify(rail("Meter"))}) !== null && document.querySelector(".ext-page .meter") !== null)`,
                ),
            "the new version, its page in the old one's place",
        );
        // The close the old version's page was given closes nothing of the new one's.
        await inPage<null>(`globalThis.oldMeterClose(); return "null"`);
        await sleep(200);
        assert.equal(await has(".ext-page .meter"), true, "the old page's close left it open");
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".sidebar .rail-button")].map((each) => each.getAttribute("aria-label")).filter((label) => ["Subagents", "Meter", "Shared", "People"].includes(label)))`,
            ),
            ["Subagents", "Meter", "Shared", "People"],
        );

        await inPage<null>(
            `globalThis.oldMeterPocket.closePage(); globalThis.oldMeterPocket.openPage("throws"); return "null"`,
        );
        await sleep(200);
        assert.equal(await has(".ext-page .meter"), true, "the old version left it open");

        await launch("about the meter, here");
        await until(() => has(".sheet .about"), "the new version's sheet");
        await inPage<null>(`globalThis.oldMeterPocket.closeSheet(); return "null"`);
        await sleep(200);
        assert.equal(await sheetType(), "ext", "the old version left it open too");
        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".sheet")), "Esc closes the sheet");
        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".ext-page")), "and then the page");
    },
);

test(
    "a component that changes what it added each time it draws is stopped, and the tab goes on",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await withMeter<null>(`
            let count = 0;

            pocket.page({
                id: "loop",
                title: "Loop",
                component: () => {
                    globalThis.meterRail.update({ badge: ++count });

                    return html\`<p class="loop">\${count}</p>\`;
                },
            });
            pocket.openPage("loop");

            return "null";
        `);
        await until(
            async () =>
                (await text(".ext-page .error-box")) ===
                "meter was stopped in this browser: it redraws without end",
            "the page says why",
        );
        assert.equal(await has(rail("Meter")), false, "what it added goes");
        assert.ok(
            (await notices()).includes("meter was stopped in this browser: it redraws without end"),
        );
        assert.deepEqual(await stateOf("meter"), {
            status: "failed",
            error: "it redraws without end",
        });
        // The tab answers: Esc closes the page (its notice covers the page's ×).
        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".ext-page")), "the page closes");
    },
);

test(
    "a loop that draws slowly is stopped too, and so are tasks that redraw too often",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        // Each draw takes 15 ms, fewer than the redraws a second allows: it still never lets the page answer.
        await withMeter<null>(`
            let count = 0;

            pocket.page({
                id: "slow",
                title: "Slow",
                component: () => {
                    const until = performance.now() + 15;

                    while (performance.now() < until) {
                        // Drawing slowly.
                    }

                    globalThis.meterRail.update({ badge: ++count });

                    return html\`<p class="slow">\${count}</p>\`;
                },
            });
            pocket.openPage("slow");

            return "null";
        `);
        await until(
            async () => /redraws without end/.test(await text(".ext-page .error-box")),
            "the slow loop stopped",
            20_000,
        );

        // Its own tasks, one after another, letting the page answer between them, but far more than 100 a second.
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter, loaded again");
        await withMeter<null>(`
            let count = 0;
            let stopped = false;
            const tasks = new MessageChannel();

            tasks.port1.onmessage = () => {
                globalThis.meterRail.update({ badge: ++count });

                if (!stopped) {
                    tasks.port2.postMessage(null);
                }
            };
            pocket.onDispose(() => (stopped = true));
            tasks.port2.postMessage(null);

            return "null";
        `);
        await until(async () => !(await has(rail("Meter"))), "the busy module stopped");
        assert.deepEqual(await stateOf("meter"), {
            status: "failed",
            error: "it redraws without end",
        });
    },
);

test("a module's notices come a few at a time, and the rest are dropped", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");
    // A component that says something each time it draws, which a notice makes it do again.
    await withMeter<null>(`
        const { store } = await import("/store.js");
        let count = 0;

        globalThis.floodSeen = new Set();
        store.subscribe((state) => {
            for (const notice of state.notices) {
                if (notice.message.startsWith("flood ")) {
                    globalThis.floodSeen.add(notice.id);
                }
            }
        });
        pocket.page({
            id: "flood",
            title: "Flood",
            component: () => {
                pocket.notify("info", "flood " + ++count);

                return html\`<p class="flood">\${count}</p>\`;
            },
        });
        pocket.openPage("flood");

        return "null";
    `);
    await until(() => has(".ext-page .flood"), "the page");
    await sleep(1000);
    assert.equal(await inPage<number>(`return JSON.stringify(globalThis.floodSeen.size)`), 5);
    assert.equal(await has(rail("Meter")), true, "notices alone do not stop it");
    await withMeter<null>(`pocket.closePage(); return "null";`);
    await until(async () => !(await has(".ext-page")), "the page closes");
});

test(
    "safe mode: ?noext=1 loads no browser modules in the tab until it is turned off",
    real,
    async () => {
        try {
            // Words that mean no leave it off, and out of the address too.
            await page.navigate(`${base}/s/${session}?noext=false`);
            await until(() => has(rail("Meter")), "the meter's rail button");
            assert.equal(await inPage<string>(`return JSON.stringify(location.search)`), "");

            await page.navigate(`${base}/s/${session}?noext=1`);
            await until(() => has(".composer"), "the conversation");
            await until(
                async () =>
                    (await notices()).some((each) =>
                        each.includes("Extensions' browser parts are off in this tab"),
                    ),
                "the notice",
            );
            assert.equal(await has(".rail-ext"), false);
            assert.equal(
                await inPage<string>(`return JSON.stringify(location.search)`),
                "",
                "the address no longer has it",
            );

            // A reload in the same tab keeps it, and "off" turns it off.
            await page.navigate(`${base}/s/${session}`);
            await until(() => has(".composer"), "the conversation again");
            await sleep(500);
            assert.equal(await has(".rail-ext"), false);
            await page.navigate(`${base}/s/${session}?noext=Off`);
            await until(() => has(rail("Meter")), "the meter's rail button, safe mode off");
            assert.equal(
                await inPage<string | null>(
                    `return JSON.stringify(sessionStorage.getItem("pocket.noext"))`,
                ),
                null,
            );
            await page.navigate(`${base}/s/${session}?noext=1`);
            await until(() => has(".composer"), "the conversation, safe again");
            await sleep(500);
            assert.equal(await has(".rail-ext"), false);

            // The Extensions sheet says so, and turns them back on.
            await launch("extensions");
            await until(() => has(".sheet .safe-mode"), "the Extensions sheet says so");
            await until(
                async () => /off in this tab/.test(await text(".sheet")),
                "the meter's row says so",
            );
            await settled();
            await page.click({ label: "Turn them back on" });
            await until(() => has(rail("Meter")), "the meter's rail button");
            assert.equal(await has(".sheet .safe-mode"), false);
            assert.equal(
                await inPage<string | null>(
                    `return JSON.stringify(sessionStorage.getItem("pocket.noext"))`,
                ),
                null,
            );
            await settled();
            await page.press("Escape");
            await until(async () => !(await has(".sheet")), "the sheet closes");
        } finally {
            await inPage<null>(`sessionStorage.removeItem("pocket.noext"); return "null"`);
        }
    },
);

test(
    "turned off, its sheets come out of the way back: back from the sheet over one shows none",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await launch("about the meter, here");
        await until(() => has(".sheet .about"), "the meter's sheet");
        await launch("extensions");
        await until(async () => (await text(".sheet h2")) === "Extensions", "Extensions over it");
        await settled();
        await app.setExtensionEnabled(owner(app), "meter.ts", false);

        try {
            await until(async () => !(await has(rail("Meter"))), "the button gone");
            assert.equal(await text(".sheet h2"), "Extensions", "the sheet on top stays");
            await settled();
            assert.equal(
                await inPage<number>(`return JSON.stringify(history.state?.pocket?.layers ?? 0)`),
                1,
                "one step back: the Extensions sheet",
            );
            await inPage<null>(`history.back(); return "null"`);
            await until(async () => !(await has(".sheet")), "back closes it");
            await sleep(400);
            assert.equal(await has(".sheet"), false, "and shows no sheet of the module that went");
        } finally {
            await app.setExtensionEnabled(owner(app), "meter.ts", true);
            await until(() => has(rail("Meter")), "the meter back");
        }
    },
);

test("turning the module off takes away its button and closes its page", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");
    await settled();
    await page.click({ selector: rail("Meter") });
    await until(() => has(".ext-page .meter"), "the page");
    await app.setExtensionEnabled(owner(app), "meter.ts", false);
    await until(
        async () => !(await has(".ext-page")) && !(await has(rail("Meter"))),
        "the page and button gone",
    );
    assert.equal(await has(rail("Shared")), true);
});
