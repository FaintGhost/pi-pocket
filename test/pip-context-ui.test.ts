// PiP's context meter uses its compaction budget, not an ordinary session's model window.
// Real browsers and an isolated scripted provider; store fixtures cover exact token boundaries.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { SUMMARY_SYSTEM } from "../src/server/pip-compact.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const METER = ".pip-context";
const SETTING = 'select[aria-label="Compact PiP\'s context"]';
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let pip: ConversationId;
let background: ConversationId;
let summaries = 0;

const inPage = async <T>(script: string, tab = page): Promise<T> =>
    JSON.parse(await tab.evaluate(script)) as T;
const see = (condition: string, what: string, tab = page) =>
    until(() => inPage<boolean>(`return JSON.stringify(Boolean(${condition}))`, tab), what);
const settle = () =>
    page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished.catch(() => {})));
        for (let frame = 0; frame < 3; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);

async function open(): Promise<void> {
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await see(
        `(await import('/store.js')).store.state.pipView.conversation?.id === ${Number(pip)} &&
            document.querySelector('.pip-panel:not(.leaving)') !== null`,
        "PiP's live view",
    );
    await settle();
}

async function fresh(viewport = VIEWPORTS.desktop): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${background}`);
    await see(
        `document.querySelector('.status-line .context') !== null`,
        "the normal session meter",
    );
    await open();
}

/** Exact usages without generating 55k tokens. No server documents or ordinary session logic change. */
async function fixture(
    used: number | undefined,
    window = 128_000,
    estimated = false,
): Promise<void> {
    await page.evaluate(`
        const { store } = await import('/store.js');
        const pipView = store.state.pipView;
        const view = store.state.view;
        store.set({
            pipView: {
                ...pipView,
                agent: { ...pipView.agent, contextWindow: ${window} },
                stats: { ...pipView.stats, contextTokens: ${used}, contextEstimated: ${estimated} },
            },
            view: {
                ...view,
                agent: { ...view.agent, contextWindow: 128_000 },
                stats: { ...view.stats, contextTokens: 55_000, contextEstimated: false },
            },
        });
    `);
    await settle();
}

type Meter = { text: string; label: string | null; title: string; level: string; fill: string };
const meter = (selector = METER) =>
    inPage<Meter | null>(`
        const element = document.querySelector(${JSON.stringify(selector)});
        return JSON.stringify(element ? {
            text: element.textContent.replace(/\\s+/g, ' ').trim(),
            label: element.getAttribute('aria-label'),
            title: element.title,
            level: element.querySelector('.meter').className.trim(),
            fill: element.querySelector('.meter > span').style.width,
        } : null);
    `);

async function expectMeter(percent: number, level = "", estimated = false): Promise<Meter> {
    const actual = await meter();
    const about = estimated ? "~" : "";

    assert.ok(actual, "PiP's meter is present");
    assert.equal(actual.text, `${about}${percent}%`);
    assert.equal(actual.label, `Context ${about}${percent}% full`);
    assert.equal(actual.fill, `${percent}%`);
    assert.equal(actual.level, `meter ${level}`.trim());

    return actual;
}

async function normalUnchanged(): Promise<void> {
    const normal = await meter(".status-line .context");

    assert.ok(normal);
    assert.match(normal.text, /43%$/);
    assert.equal(normal.fill, "43%");
    assert.equal(normal.level, "meter");
    assert.equal(normal.title, "55k of 128k tokens in context");
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(
        scriptedModel((request) => {
            const system = JSON.stringify(
                (request as { messages: { role: string; content: unknown }[] }).messages.filter(
                    (message) => message.role === "system",
                ),
            );

            if (system.includes(JSON.stringify(SUMMARY_SYSTEM).slice(1, -1))) {
                summaries++;

                return fauxAssistantMessage([fauxText("Keep replies short. The plan is ready.")]);
            }

            return fauxAssistantMessage([fauxText("Noted.")]);
        }),
    );

    app.watches.gh = async () => {
        throw new Error("No GitHub in PiP context UI tests");
    };

    app.settings.getCompactionSettings = () => ({
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 50,
    });
    background = await newSession(app);
    pip = await app.pip.ensure(owner(app));
    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "pip-context-browser-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `(await import('/store.js')).store.state.me?.role === 'owner'`,
        "isolated owner signed in",
    );
});

after(async () => {
    try {
        await browsers?.closeAll({ final: true });
    } finally {
        server?.closeAllConnections();
        server?.close();

        try {
            await app?.close();
        } finally {
            cleanUp();
        }
    }
});

for (const [device, viewport] of [
    ["desktop", VIEWPORTS.desktop],
    ["390px mobile", { ...VIEWPORTS.mobile, width: 390 }],
] as const) {
    test(
        `${device}: 55k uses PiP's default 60k budget; the normal session still uses 128k`,
        real,
        async () => {
            await fresh(viewport);
            assert.equal(
                await inPage<number>(
                    `return JSON.stringify((await import('/store.js')).store.state.server.pipCompactAt)`,
                ),
                60_000,
                "the default comes from the real server",
            );
            await fixture(55_000);
            const actual = await expectMeter(92, "err");

            assert.match(actual.title, /55k of 60k tokens/);
            assert.match(actual.title, /compacts itself above 60k once idle/);
            await normalUnchanged();
            const bounds = await inPage<{ left: number; right: number; width: number }>(`
            const box = document.querySelector('.pip-context').getBoundingClientRect();
            return JSON.stringify({ left: box.left, right: box.right, width: innerWidth });
        `);

            assert.ok(
                bounds.left >= 0 && bounds.right <= bounds.width,
                "the meter fits the viewport",
            );
        },
    );
}

test("unknown usage is hidden, but zero usage is a visible 0%", real, async () => {
    await fresh();
    await fixture(undefined);
    assert.equal(await meter(), null);
    await fixture(0);
    const zero = await expectMeter(0);

    assert.match(zero.title, /0 of 60k tokens/);
});

test(
    "PiP warns above 70%, errors above 90%, and clamps only the display at 100%",
    real,
    async () => {
        await fresh();

        for (const [percent, level] of [
            [70, ""],
            [71, "warn"],
            [90, "warn"],
            [91, "err"],
        ] as const) {
            await fixture(percent * 600);
            await expectMeter(percent, level);
        }

        await fixture(75_000);
        const over = await expectMeter(100, "err");

        assert.match(
            over.title,
            /75k of 60k tokens/,
            "the tooltip keeps the true over-budget usage",
        );
        await normalUnchanged();
    },
);

test(
    "Extensions changes 40k / 100k / As sessions do broadcast into an already-open PiP",
    real,
    async () => {
        await fresh();
        await fixture(55_000);
        await page.evaluate(`window.contextPanel = document.querySelector('.pip-panel')`);
        const settings = await browsers.open(2);

        try {
            await settings.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
            );
            await see(
                `(await import('/store.js')).store.state.me?.role === 'owner'`,
                "settings tab signed in",
                settings,
            );
            await settings.evaluate(
                `(await import('/store.js')).openSheet({ type: 'extensions' })`,
            );
            await see(
                `document.querySelector(${JSON.stringify(SETTING)}) !== null`,
                "Extensions compaction select",
                settings,
            );

            for (const [at, percent, level, denominator] of [
                [40_000, 100, "err", "40k"],
                [100_000, 55, "", "100k"],
                [0, 43, "", "128k"],
            ] as const) {
                await settings.evaluate(`
                const select = document.querySelector(${JSON.stringify(SETTING)});
                select.value = ${JSON.stringify(String(at))};
                select.dispatchEvent(new Event('change', { bubbles: true }));
            `);
                await until(
                    () => app.pipCompaction.compactAt === at,
                    "setting accepted by the server",
                );
                await see(
                    `(await import('/store.js')).store.state.server.pipCompactAt === ${at}`,
                    "setting broadcast to the PiP tab",
                );
                await settle();
                const actual = await expectMeter(percent, level);

                assert.match(actual.title, new RegExp(`55k of ${denominator} tokens`));
                assert.equal(
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector('.pip-panel') === window.contextPanel)`,
                    ),
                    true,
                    "the panel was never reopened",
                );
                await normalUnchanged();
            }
        } finally {
            await app.setPipCompactAt(owner(app), 60_000);
            await see(
                `(await import('/store.js')).store.state.server.pipCompactAt === 60000`,
                "default restored",
            );
        }
    },
);

test(
    "a missing server setting falls back to the model window; a smaller model caps PiP's budget",
    real,
    async () => {
        await fresh();
        await fixture(55_000);
        await page.evaluate(`
        const { store } = await import('/store.js');
        const { pipCompactAt, ...server } = store.state.server;
        store.set({ server });
    `);
        await settle();
        const fallback = await expectMeter(43);

        assert.match(fallback.title, /55k of 128k tokens/);
        await page.evaluate(`
        const { store } = await import('/store.js');
        store.set({ server: { ...store.state.server, pipCompactAt: 60_000 } });
    `);
        await fixture(30_000, 32_000);
        const capped = await expectMeter(94, "err");

        assert.match(capped.title, /30k of 32k tokens/);
        assert.match(capped.title, /PiP's idle compaction limit is 60k tokens\./);
        assert.match(
            capped.title,
            /The meter is capped at the model's context window\./,
            "the tooltip explains the smaller model cap",
        );
        await fixture(55_000, 60_000);
        const equal = await expectMeter(92, "err");

        assert.match(equal.title, /55k of 60k tokens/);
        assert.match(equal.title, /compacts itself above 60k once idle/);
        assert.doesNotMatch(equal.title, /capped/);
        await normalUnchanged();
    },
);

test("post-compaction estimates show ~ until the next measured answer", real, async () => {
    await fresh();
    await fixture(42_000, 128_000, true);
    const estimate = await expectMeter(70, "", true);

    assert.match(estimate.title, /~42k of 60k tokens/);
    await fixture(42_600);
    const measured = await expectMeter(71, "warn");

    assert.match(measured.title, /43k of 60k tokens/);
    assert.doesNotMatch(measured.title, /~/);
});

test(
    "manual Compact writes a short scripted summary and a fresh view estimates the smaller context",
    real,
    async () => {
        await fresh();
        await say(app, pip, `Keep this plan: ${"release steps and checks. ".repeat(400)}`);
        await say(app, pip, "Keep replies short.");
        await say(app, pip, "Ready.");
        await see(
            `(await import('/store.js')).store.state.pipView.stats?.contextTokens > 0 &&
        !(await import('/store.js')).store.state.pipView.live.busy`,
            "measured PiP answer",
        );
        const beforeTokens = await inPage<number>(
            `return JSON.stringify((await import('/store.js')).store.state.pipView.stats.contextTokens)`,
        );

        await settle();
        await page.click({ selector: '.pip-panel button[aria-label="Compact"]' });
        await see(
            `(await import('/store.js')).store.state.pipView.stats?.contextEstimated === true &&
        !(await import('/store.js')).store.state.pipView.live.compactions?.length`,
            "compaction estimate",
        );
        assert.equal(summaries, 1, "PiP used its short scripted summarizer");
        // Reload as well as reopening: the estimate must survive a fresh server view, not just local state.
        await fresh();
        await see(
            `(await import('/store.js')).store.state.pipView.stats?.contextEstimated === true`,
            "a fresh server view retains the compaction estimate",
        );
        const afterTokens = await inPage<number>(
            `return JSON.stringify((await import('/store.js')).store.state.pipView.stats.contextTokens)`,
        );

        assert.ok(
            afterTokens < beforeTokens,
            `${afterTokens} estimated tokens remain of ${beforeTokens}`,
        );
        assert.match((await meter())!.text, /^~/);
        assert.match((await meter())!.title, /^~/);
        await say(app, pip, "Thanks.");
        await see(
            `(await import('/store.js')).store.state.pipView.stats?.contextEstimated !== true &&
        !(await import('/store.js')).store.state.pipView.live.busy`,
            "next answer measures the context",
        );
        await settle();
        assert.doesNotMatch((await meter())!.text, /~/);
        assert.doesNotMatch((await meter())!.title, /~/);
    },
);
