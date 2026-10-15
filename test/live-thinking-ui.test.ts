// The optional live-thinking disclosure, in real Chromium: no thought work while hidden, words arriving before the
// response finishes, tool handoff and a new thought (even with the same prefix), honest empty states, and no timer work.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxThinking,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium on this machine" : false } as const;
const THOUGHT = Array.from(
    { length: 24 },
    (_, n) => `Line ${n + 1} of my thinking, about what to look at next and why it matters.`,
).join("\n");
// Intentionally begins with the entire first thought: identity must not depend on text prefixes.
const SECOND = `${THOUGHT}\nThis is a new thought after the command, with more to check before answering.`;
const ANSWER = "Now I write the answer, without any thinking text in this response. ".repeat(12);
let multiple = false;

const route: FauxResponseStep = async (request) => {
    const last = lastText(request as never);

    if (last.role !== "toolResult") {
        return fauxAssistantMessage(
            [fauxThinking(THOUGHT), fauxToolCall("bash", { command: "sleep 2; echo first" })],
            { stopReason: "toolUse" },
        );
    }

    if (!multiple) {
        return fauxAssistantMessage([fauxText("Done.")]);
    }

    if (last.text.includes("first")) {
        return fauxAssistantMessage(
            [fauxThinking(SECOND), fauxToolCall("bash", { command: "sleep 2; echo second" })],
            { stopReason: "toolUse" },
        );
    }

    // The next generation exists before it has a partial message. The old thought must already be gone.
    await new Promise((resolve) => setTimeout(resolve, 600));

    return fauxAssistantMessage([fauxText(ANSWER)]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs?: number) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

const live = () =>
    inPage<{
        fold: { open: boolean; before: string; expanded: string; controls: string } | null;
        thought: {
            text: string;
            label: string;
            streaming: boolean;
            above: boolean;
            overflows: boolean;
            top: number;
            gap: number;
            id: string;
        } | null;
    }>(`
        const line = document.querySelector(".live-line");
        const fold = document.querySelector(".live-fold");
        const thought = document.querySelector(".live-thought");
        const text = thought?.querySelector(".live-thought-text");

        return JSON.stringify({
            fold: fold && {
                open: fold.classList.contains("open"),
                before: fold.nextElementSibling?.className ?? "",
                expanded: fold.getAttribute("aria-expanded"),
                controls: fold.getAttribute("aria-controls"),
            },
            thought: thought && {
                text: text.textContent,
                label: thought.querySelector(".live-thought-label").textContent,
                streaming: text.classList.contains("streaming"),
                above: thought.nextElementSibling === line,
                overflows: text.scrollHeight > text.clientHeight + 20,
                top: text.scrollTop,
                gap: text.scrollHeight - text.scrollTop - text.clientHeight,
                id: thought.id,
            },
        });
    `);

/** Observe both actual DOM mutations and renders of the component that selects and draws the thought. */
const watchLine = (ms: number) =>
    inPage<{ changed: string[]; renders: number; drawn: boolean }>(`
        const { options } = await import("preact");
        const render = options.__r;
        let renders = 0;
        const line = document.querySelector(".live-line");
        const changed = new Set();
        let drawn = document.querySelector(".live-thought") !== null;
        const watch = new MutationObserver((records) => {
            for (const record of records) {
                const element = record.target.nodeType === 3 ? record.target.parentElement : record.target;

                if (line.contains(element)) changed.add(element.className || element.tagName);
                drawn ||= [...record.addedNodes].some((node) => node.classList?.contains("live-thought"));
            }
        });

        options.__r = (vnode) => {
            if (vnode.type?.name === "LiveThought") renders++;
            render?.(vnode);
        };
        watch.observe(line.parentElement, { subtree: true, childList: true, characterData: true, attributes: true });

        try {
            await new Promise((resolve) => setTimeout(resolve, ${ms}));
        } finally {
            options.__r = render;
            watch.disconnect();
        }

        return JSON.stringify({ changed: [...changed], renders, drawn });
    `);

const says = (words: string) =>
    `return JSON.stringify(document.querySelector(".live-line .live-state")?.textContent.includes(${JSON.stringify(words)}) === true)`;

async function ask(text: string): Promise<void> {
    await app.commands.submit(session, owner(app), { text, requestId: crypto.randomUUID() });
    await see(
        `return JSON.stringify(document.querySelector(".live-line") !== null)`,
        "the live line",
    );
}

const done = () =>
    see(
        `return JSON.stringify(document.querySelector(".live-line") === null)`,
        "the run to end",
        40_000,
    );
const altT = () =>
    page.evaluate(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", altKey: true, bubbles: true }))`,
    );
const saved = () =>
    inPage<boolean | null>(
        `return JSON.stringify(JSON.parse(localStorage.getItem("pocket.appearance") ?? "{}").showThinking ?? null)`,
    );
const clickFold = () => page.evaluate(`document.querySelector(".live-fold").click()`);

before(async () => {
    if (real.skip) {
        return;
    }

    const model = fauxProvider({
        tokensPerSecond: 60,
        models: [{ id: "faux-1", reasoning: true }],
    });

    model.setResponses(Array.from({ length: 50 }, () => route));
    app = await openApp(model);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "live-thinking-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
    await page.navigate(`${base}/s/${session}`);
    await see(`return JSON.stringify(document.querySelector("textarea") !== null)`, "the session");
});

// A failed streaming assertion must not leave the model running into the next test's projected edge cases.
afterEach(async () => {
    multiple = false;

    if (app === undefined || page === undefined) {
        return;
    }

    if (app.isBusy(session)) {
        await app.commands.abort(session, owner(app));
    }

    await until(() => !app.isBusy(session), "the run to stop between tests");
    await done();
});

after(async () => {
    if (session !== undefined && app?.isBusy(session)) {
        await app.commands.abort(session, owner(app)).catch(() => {});
        await until(() => !app.isBusy(session), "the work to stop").catch(() => {});
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "off: no thought selection or rendering as the real stream arrives; only the timer moves",
    real,
    async () => {
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
        await page.navigate(`${base}/s/${session}`);
        await see(
            `return JSON.stringify(document.querySelector("textarea") !== null)`,
            "the session",
        );
        await ask("think, with it off");
        await see(says("Thinking"), "Pi thinking");

        const watched = await watchLine(2500);

        assert.equal((await live()).fold, null);
        assert.equal((await live()).thought, null);
        assert.equal(watched.drawn, false);
        assert.equal(watched.renders, 0, "the component that selects thoughts never runs");
        assert.deepEqual(watched.changed, ["SPAN"]);
        assert.equal(await saved(), null);
        await done();
    },
);

test(
    "on: real streaming across tool calls, new thought replaces old and resets follow, no stale text",
    real,
    async () => {
        multiple = true;
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
        await see(
            `return JSON.stringify(document.querySelector('[role="switch"][aria-label="Show thinking"]') !== null)`,
            "the switch",
        );
        await page.evaluate(
            `document.querySelector('[role="switch"][aria-label="Show thinking"]').click()`,
        );
        assert.equal(await saved(), true);
        await page.evaluate(`(await import("/store.js")).closeSheet()`);
        await ask("think, with it on");
        await see(
            `return JSON.stringify(document.querySelector(".live-fold") !== null)`,
            "the disclosure",
        );

        let now = await live();

        assert.match(now.fold!.before, /spinner/, "left of the spinner");
        assert.equal(now.fold!.expanded, "false");
        assert.equal(now.fold!.open, false);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(!!document.querySelector(".live-fold svg"))`,
            ),
            true,
            "the timeline's chevron",
        );

        const folded = await watchLine(1500);

        assert.equal(folded.drawn, false);
        assert.equal(folded.renders, 0);
        assert.deepEqual(folded.changed, ["SPAN"]);
        await clickFold();
        await until(
            async () => ((await live()).thought?.text.length ?? 0) > 80,
            "the first partial",
        );
        now = await live();
        assert.equal(now.fold!.expanded, "true");
        assert.equal(now.fold!.controls, now.thought!.id);
        assert.equal(now.thought!.above, true);
        assert.equal(now.thought!.streaming, true);
        assert.equal(now.thought!.label, "Current thought");
        assert.ok(THOUGHT.startsWith(now.thought!.text));
        assert.ok(
            now.thought!.text.length < THOUGHT.length,
            "visible before the response is complete",
        );

        const streaming = await watchLine(300);

        assert.ok(streaming.renders > 0, "the render probe detects real stream updates while open");
        await until(async () => (await live()).thought?.overflows === true, "more than fits");
        assert.ok((await live()).thought!.gap < 8, "following the newest words");
        await page.evaluate(`document.querySelector(".live-thought-text").scrollTop = 0`);
        const length = (await live()).thought!.text.length;

        await until(
            async () => ((await live()).thought?.text.length ?? 0) > length + 80,
            "more words",
        );
        assert.ok((await live()).thought!.top < 8, "reading position retained");
        // "Working" can already mean the tool-call arguments are streaming; wait for the saved-response handoff.
        await until(
            async () => (await live()).thought?.label === "Latest thought",
            "the first thought handed off to tools",
            20_000,
        );
        assert.equal(await inPage<boolean>(says("Working")), true);
        now = await live();
        assert.equal(now.thought!.text, THOUGHT);
        assert.equal(now.thought!.label, "Latest thought");
        assert.equal(now.thought!.streaming, false);
        assert.ok(now.thought!.top < 8, "handoff does not yank the reader to the bottom");

        await until(
            async () => {
                const thought = (await live()).thought;

                return (
                    thought?.streaming === true &&
                    thought.text.length > 0 &&
                    thought.text.length < THOUGHT.length
                );
            },
            "the second thought replacing the first",
            10_000,
        );
        await until(
            async () => (await live()).thought?.overflows === true,
            "second thought overflows",
        );
        assert.ok(
            (await live()).thought!.gap < 8,
            "a new response follows again despite the same prefix",
        );
        await until(
            async () => (await live()).thought?.label === "Latest thought",
            "the second thought handed off to tools",
            20_000,
        );
        assert.equal((await live()).thought!.text, SECOND);

        await until(
            async () => (await live()).thought?.text === "Waiting for thinking text…",
            "no old thought even before the new partial",
        );
        await until(
            async () =>
                (await live()).thought?.text === "No thinking text shared for this response.",
            "no old thought during the text-only response",
        );
        assert.equal((await live()).thought!.streaming, false);
        await done();
        multiple = false;
    },
);

test(
    "empty/redacted blocks and timer isolation, without changing timeline Thought steps",
    real,
    async () => {
        // Edge projections in the actual app, with the real run idle. This changes only the browser's view, not stored data.
        await page.evaluate(`
        const { store } = await import("/store.js");
        window.beforeThinkingTest = store.state.view;
        const view = store.state.view;
        const entries = new Map(view.entries);

        entries.set(90001, { id: 90001, kind: "user", text: "Inspect thinking", images: 0 });
        entries.set(90002, { id: 90002, kind: "assistant", blocks: [{ type: "thinking", text: "Previous completed thought" }] });
        window.thinkingTestView = { ...view, entries, order: [...view.order, 90001, 90002] };
        (await import("/theme.js")).setPrefs({ showThinking: true });
        store.set({ view: { ...window.thinkingTestView, live: { busy: true, generation: { attempt: 0 } } } });
    `);

        try {
            await until(
                async () => (await live()).fold !== null,
                "the open state retained for a later run",
            );

            if (!(await live()).fold!.open) {
                await clickFold();
            }

            await until(
                async () => (await live()).thought?.text === "Waiting for thinking text…",
                "no previous response",
            );
            await page.evaluate(`
            const { store } = await import("/store.js");
            store.set({ view: { ...window.thinkingTestView, live: { busy: true, generation: { attempt: 0, message: { blocks: [{ type: "thinking", text: "", redacted: true }] } } } } });
        `);
            await until(
                async () => (await live()).thought?.text === "The model has hidden its thinking.",
                "redacted thinking",
            );
            await page.evaluate(`
            const { store } = await import("/store.js");
            store.set({ view: { ...window.thinkingTestView, live: { busy: true, tools: [] } } });
        `);
            await until(
                async () => (await live()).thought?.text === "Previous completed thought",
                "retained during tools only",
            );
            const idle = await watchLine(1600);

            assert.equal(
                idle.renders,
                0,
                "even open, timer ticks never select or render the thought",
            );
            assert.deepEqual(idle.changed, ["SPAN"]);
            await page.evaluate(`
                const button = [...document.querySelectorAll(".step-head")].findLast((each) => each.querySelector(".thought"));
                if (button.getAttribute("aria-expanded") !== "true") button.click();
            `);
            await see(
                `return JSON.stringify(!!document.querySelector(".timeline .thought-body"))`,
                "the existing Thought step expanded",
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(!document.querySelector(".live-thought").classList.contains("thought-body") && !!document.querySelector(".timeline .thought-body"))`,
                ),
                true,
                "separate styles; timeline preserved",
            );
            await clickFold();
            assert.equal((await live()).thought, null, "unmounted on closing");
        } finally {
            await page.evaluate(
                `(await import("/store.js")).store.set({ view: window.beforeThinkingTest }); delete window.beforeThinkingTest; delete window.thinkingTestView`,
            );
        }

        await done();
    },
);

test("Alt+T turns Show thinking off and on", real, async () => {
    assert.equal(await saved(), true);
    await ask("think, by keys");
    await see(
        `return JSON.stringify(document.querySelector(".live-fold") !== null)`,
        "the disclosure",
    );
    await altT();
    await see(
        `return JSON.stringify(document.querySelector(".live-fold") === null)`,
        "off with Alt+T",
    );
    assert.equal(await saved(), false);
    await altT();
    await see(
        `return JSON.stringify(document.querySelector(".live-fold") !== null)`,
        "on with Alt+T",
    );
    assert.equal(await saved(), true);
    await done();
});
