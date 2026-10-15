// Live thought selection, follow-scroll, and hidden/timer isolation in the real UI, using deterministic view updates.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium" : false } as const;
const THOUGHT = "A line of thinking to read while Pi works.\n".repeat(50);
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;

async function read<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string) =>
    until(() => read<boolean>(`return JSON.stringify(${script})`), script);
const text = () =>
    read<string>(
        `return JSON.stringify(document.querySelector(".live-thought-text")?.textContent)`,
    );

/** Project a response or tool phase without a model racing the assertion. Nothing is written to stored history. */
async function project(generation: unknown, saved: unknown[] = []): Promise<void> {
    await page.evaluate(`
        const { store } = await import("/store.js");
        const base = window.thinkingBase;
        const entries = new Map(base.entries);
        const order = [...base.order];

        ${JSON.stringify(saved)}.forEach((message, index) => {
            const id = 90002 + index;
            entries.set(id, { id, kind: "assistant", ...message });
            order.push(id);
        });

        store.set({ view: { ...base, entries, order, live: { busy: true, generation: ${JSON.stringify(generation)} } } });
        await new Promise(requestAnimationFrame);
    `);
}

const thinking = (value: string) => ({
    attempt: 0,
    message: { blocks: [{ type: "thinking", text: value }] },
});

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const session = await newSession(app);

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "thinking-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`(await import("/store.js")).store.state.me?.role === "owner"`);
    await page.navigate(`${base}/s/${session}`);
    await see(`document.querySelector("textarea") !== null`);
    await page.evaluate(`
        await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity).map(a => a.finished.catch(() => {})));
        const { store } = await import("/store.js");
        const view = store.state.view;
        const entries = new Map(view.entries);

        entries.set(90001, { id: 90001, kind: "user", text: "Think", images: 0 });
        window.thinkingBase = { ...view, entries, order: [...view.order, 90001] };
    `);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "off or folded skips thought work; open thoughts do not redraw on timer ticks",
    real,
    async () => {
        await page.press("Alt+T");
        await see(
            `document.querySelector(".notices")?.textContent.includes("Show thinking: on.") === true && (await import("/theme.js")).prefs().showThinking === true`,
        );
        await page.press("Alt+T");
        await see(
            `document.querySelector(".notices")?.textContent.includes("Show thinking: off.") === true && (await import("/theme.js")).prefs().showThinking === false`,
        );
        await project(thinking("First words"));
        await see(`document.querySelector(".live-line") !== null`);
        assert.equal(
            await read(`return JSON.stringify(!!document.querySelector(".live-fold"))`),
            false,
        );
        await page.evaluate(`
        const { options } = await import("preact");
        const render = options.__r;
        window.thoughtRenders = 0;
        options.__r = vnode => {
            if (vnode.type?.name === "LiveThought") window.thoughtRenders++;
            render?.(vnode);
        };
    `);
        await project(thinking("More words while off"));
        await page.evaluate(`(await import("/theme.js")).setPrefs({ showThinking: true })`);
        await see(`document.querySelector(".live-fold") !== null`);
        await project(thinking("More words while folded"));
        assert.equal(await read(`return JSON.stringify(window.thoughtRenders)`), 0);
        assert.equal(
            await read(`return JSON.stringify(!!document.querySelector(".live-thought"))`),
            false,
        );
        await page.evaluate(`document.querySelector(".live-fold").click()`);
        await see(`window.thoughtRenders > 0`);
        const renders = await read<number>(`return JSON.stringify(window.thoughtRenders)`);
        const timer = await read<string>(
            `return JSON.stringify(document.querySelector(".live-line").textContent)`,
        );

        await see(`document.querySelector(".live-line").textContent !== ${JSON.stringify(timer)}`);
        assert.equal(await read(`return JSON.stringify(window.thoughtRenders)`), renders);
    },
);

test(
    "follow pauses for reading, survives tool handoff, resets for a new response, and never revives an old thought",
    real,
    async () => {
        await page.evaluate(`(await import("/theme.js")).setPrefs({ showThinking: true })`);
        await project(thinking(THOUGHT));
        await page.evaluate(`
            if (document.querySelector(".live-fold").getAttribute("aria-expanded") !== "true") {
                document.querySelector(".live-fold").click();
            }
        `);
        await see(`document.querySelector(".live-thought-text")?.scrollTop > 0`);
        await page.evaluate(`document.querySelector(".live-thought-text").scrollTop = 0`);
        await see(`document.querySelector(".live-thought-text").scrollTop === 0`);
        // Allow the scroll event to reach the follow handler before more words arrive.
        await page.evaluate(
            `await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
        );
        await project(thinking(THOUGHT + "More words"));
        assert.equal(
            await read(
                `return JSON.stringify(document.querySelector(".live-thought-text").scrollTop)`,
            ),
            0,
        );
        const first = thinking(THOUGHT).message;

        await project(undefined, [first]);
        assert.equal(await text(), THOUGHT);
        assert.equal(
            await read(
                `return JSON.stringify(document.querySelector(".live-thought-text").scrollTop)`,
            ),
            0,
        );
        await project(thinking(THOUGHT + "New response, same prefix"), [first]);
        await see(`document.querySelector(".live-thought-text").scrollTop > 0`);
        await page.evaluate(`
            document.querySelector(".live-thought-text").scrollTop = 0;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        `);
        // A room update can skip a whole fast response: this is not the displayed thought's handoff.
        await project(undefined, [
            first,
            thinking(THOUGHT + "Second").message,
            thinking(THOUGHT + "Third").message,
        ]);
        await see(`document.querySelector(".live-thought-text").scrollTop > 0`);
        await project({ attempt: 0 }, [first]);
        assert.notEqual(await text(), THOUGHT);
        await project(undefined, [
            first,
            { blocks: [{ type: "text", text: "Calling a tool without thinking" }] },
        ]);
        assert.notEqual(
            await text(),
            THOUGHT,
            "a saved text-only response must not revive the earlier thought during tools",
        );
    },
);
