import { type App, cleanUp, openApp, owner, root, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false };
const faux = fauxProvider({
    models: Array.from({ length: 10 }, (_, index) => ({
        id: `model-${String(index + 1)}`,
        name: `Choice ${String(index + 1)}`,
        reasoning: true,
    })),
});
const scope = ["faux/model-1:high", "faux/model-2", "faux/model-3"];
const scopedIds = ["model-1", "model-2", "model-3"];
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let id: ConversationId;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what);
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));
const rows = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.pop-menu-list [role="option"]')].map(row => row.title.split(' · ')[0].split('/')[1]))`,
    );

async function picker(forDefault = false): Promise<void> {
    await page.evaluate(
        `(await import('/store.js')).openSheet({ type: 'model', forDefault: ${forDefault} }); return 'true'`,
    );
    await see(`return JSON.stringify(!!document.querySelector('.pop-menu'))`, "model picker");
    await settled();
}

async function closePicker(): Promise<void> {
    await page.press("Escape");
    await see(`return JSON.stringify(!document.querySelector('.pop-menu'))`, "picker closed");
    await settled();
}

async function signIn(size: keyof typeof VIEWPORTS): Promise<void> {
    await page.setViewport(VIEWPORTS[size]);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import('/store.js')).store.state.me?.role === 'owner')`,
        "signed in as owner",
    );
    await page.navigate(`${base}/s/${Number(id)}`);
    await see(
        `return JSON.stringify((await import('/store.js')).store.state.view.agent?.model?.modelId === 'model-10')`,
        "current session model outside scope",
    );
}

async function toggle(all: boolean): Promise<void> {
    await page.click({ selector: `.model-scope button:nth-child(${all ? 2 : 1})` });
    await see(
        `return JSON.stringify(document.querySelector('.model-scope button:nth-child(${all ? 2 : 1})')?.getAttribute('aria-pressed') === 'true')`,
        all ? "All selected" : "Scoped selected",
    );
}

async function noOverflow(): Promise<void> {
    assert.equal(
        await inPage<boolean>(`
            const menu = document.querySelector('.pop-menu');
            const rect = menu.getBoundingClientRect();
            return JSON.stringify(menu.scrollWidth <= menu.clientWidth + 1 && rect.left >= -1 && rect.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1);
        `),
        true,
        "picker and page stay inside viewport",
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(faux);
    app.settings.setEnabledModels(scope);
    await app.settings.flush();
    await app.setDefaultModel(owner(app), {
        provider: "faux",
        modelId: "model-9",
        thinkingLevel: "low",
    });
    const session = await app.commands.createSession(owner(app), { cwd: work });

    id = session.id;
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "model-10" },
        thinkingLevel: "low",
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "scope-ui-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.settings.flush();
    await app?.close();
    cleanUp();
});

test(
    "phone and desktop pickers filter Scoped/All, preserve search and reset keyboard highlight",
    real,
    async () => {
        for (const size of ["mobile", "desktop"] as const) {
            await signIn(size);
            await picker();
            assert.deepEqual(await rows(), scopedIds, size);
            assert.deepEqual(
                await inPage<string[]>(
                    `return JSON.stringify([...document.querySelectorAll('.model-scope button')].map(button => button.textContent.trim()))`,
                ),
                ["Scoped · 3", "All · 10"],
            );
            assert.equal(
                await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll('.pop-menu-list [aria-selected="true"]').length)`,
                ),
                0,
                "scope does not inject the current outside model",
            );
            await noOverflow();
            await page.click({ selector: ".pop-menu-search input" });
            await page.type({ selector: ".pop-menu-search input" }, "FAUX/model-1");
            await see(
                `return JSON.stringify(document.querySelectorAll('.pop-menu-list [role="option"]').length === 1)`,
                "provider/id search inside scope",
            );
            assert.deepEqual(await rows(), ["model-1"]);
            await toggle(true);
            assert.equal(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector('.pop-menu-search input').value)`,
                ),
                "FAUX/model-1",
            );
            assert.deepEqual(await rows(), ["model-10", "model-1"]);
            await toggle(false);
            assert.deepEqual(await rows(), ["model-1"]);
            await page.type({ selector: ".pop-menu-search input" }, "Choice 9");
            await see(
                `return JSON.stringify(document.querySelector('.pop-menu-list').textContent.includes('No model matches'))`,
                "outside model excluded from search",
            );
            await toggle(true);
            assert.deepEqual(await rows(), ["model-9"], "name search in All");
            await page.type({ selector: ".pop-menu-search input" }, "");
            await toggle(false);
            await page.click({ selector: ".pop-menu-search input" });
            await page.press("ArrowDown");
            await see(
                `return JSON.stringify(document.querySelector('.pop-menu-row.on')?.title.startsWith('faux/model-2 ·'))`,
                "keyboard moved to second scoped model",
            );
            await toggle(true);
            await see(
                `return JSON.stringify(document.querySelector('.pop-menu-row.on') === document.querySelector('.pop-menu-row'))`,
                "toggle resets highlighted row",
            );
            assert.equal((await rows()).length, 10);
            await noOverflow();
            await toggle(false);
            await closePicker();
            assert.equal((await app.agentState(id))?.model?.modelId, "model-10");
            assert.equal((await app.agentState(id))?.thinkingLevel, "low");
            assert.equal(app.config.defaultModel?.modelId, "model-9");
        }

        await picker();
        await page.click({ selector: ".pop-menu-search input" });
        await page.press("ArrowDown");
        await page.press("Enter");
        await until(
            async () => (await app.agentState(id))?.model?.modelId === "model-2",
            "keyboard model chosen",
        );
        await see(
            `return JSON.stringify(!document.querySelector('.pop-menu'))`,
            "session picker closes after Enter",
        );
        assert.equal((await app.agentState(id))?.thinkingLevel, "low");
        assert.equal(app.config.defaultModel?.modelId, "model-9");
        assert.deepEqual(
            page.logs().filter((entry) => entry.level === "error"),
            [],
        );
    },
);

test(
    "default picker shares scope and keeps the session unchanged; suffix does not set thinking",
    real,
    async () => {
        for (const size of ["mobile", "desktop"] as const) {
            await page.setViewport(VIEWPORTS[size]);
            await picker(true);
            assert.deepEqual(await rows(), scopedIds);
            assert.equal(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector('.pop-menu').getAttribute('aria-label'))`,
                ),
                "Default model",
            );
            await toggle(true);
            assert.equal((await rows())[0], app.config.defaultModel?.modelId);
            await toggle(false);
            await noOverflow();
            await closePicker();
        }

        await picker(true);
        await page.click({ selector: ".pop-menu-search input" });
        await page.press("Enter");
        await until(() => app.config.defaultModel?.modelId === "model-1", "default model chosen");
        assert.equal(
            app.config.defaultModel?.thinkingLevel,
            "low",
            "scope's :high suffix is not applied",
        );
        assert.equal((await app.agentState(id))?.model?.modelId, "model-2");
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(!!document.querySelector('.pop-menu'))`),
            true,
        );
        await closePicker();
        assert.deepEqual(
            page.logs().filter((entry) => entry.level === "error"),
            [],
        );
    },
);

test(
    "empty or unmatched scope shows all models without a toggle in either picker",
    real,
    async () => {
        for (const patterns of [[], ["not-a-provider/*"]]) {
            app.settings.setEnabledModels(patterns);
            await app.settings.flush();
            await page.navigate(`${base}/s/${Number(id)}`);
            await see(
                `return JSON.stringify((await import('/store.js')).store.state.models.length === 10 && (await import('/store.js')).store.state.models.every(model => !model.scoped))`,
                "hello has no scoped models",
            );

            for (const forDefault of [false, true]) {
                await picker(forDefault);
                assert.equal((await rows()).length, 10);
                assert.equal(
                    await inPage<number>(
                        `return JSON.stringify(document.querySelectorAll('.model-scope').length)`,
                    ),
                    0,
                );
                await noOverflow();
                await closePicker();
            }

            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        }
    },
);
