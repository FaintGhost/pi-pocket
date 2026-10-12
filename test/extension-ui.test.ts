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

	function Meter() {
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
    writeFileSync(
        join(dropIns, "broken.js"),
        `export default (pocket) => { pocket.rail({ id: "x", title: "Broken", run() {} }); throw new Error("broken on purpose"); };\n`,
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
