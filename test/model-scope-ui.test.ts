import { type App, cleanUp, openApp, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const state = 'const { store, openSheet } = await import("/store.js");';
const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (script: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(${script})`), script);
const settle = () => new Promise((resolve) => setTimeout(resolve, 450));
const rows = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.pop-menu-row')].map(row => row.title.split(' · ')[0]))`,
    );

before(async () => {
    if (!chromium) {
        return;
    }

    app = await openApp(
        fauxProvider({
            models: Array.from({ length: 10 }, (_, index) => ({ id: `model-${index + 1}` })),
        }),
    );
    app.settings.setEnabledModels(["faux/model-1", "faux/model-2"]);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "scope-browser-")),
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
    "Scoped/All keeps search, resets keyboard selection and starts scoped on each opening",
    { skip: !chromium },
    async () => {
        for (const size of ["desktop", "mobile"] as const) {
            await page.setViewport(VIEWPORTS[size]);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await until(
                () =>
                    inPage<boolean>(
                        `${state} return JSON.stringify(store.state.me?.role === 'owner')`,
                    ),
                "signed in",
            );
            await page.evaluate(
                `${state} openSheet({ type: 'model', forDefault: true }); return 'true'`,
            );
            await see("!!document.querySelector('.model-scope')");
            await settle();
            assert.deepEqual(await rows(), ["faux/model-1", "faux/model-2"]);
            await page.type({ selector: ".pop-menu-search input" }, "model-1");
            await page.click({ selector: ".model-scope button:nth-child(2)" });
            await see(
                "document.querySelector('.model-scope button:nth-child(2)').getAttribute('aria-pressed') === 'true'",
            );
            assert.equal(
                await inPage<string>(
                    "return JSON.stringify(document.querySelector('.pop-menu-search input').value)",
                ),
                "model-1",
            );
            assert.deepEqual(await rows(), ["faux/model-1", "faux/model-10"]);
            await page.type({ selector: ".pop-menu-search input" }, "");
            await page.click({ selector: ".pop-menu-search input" });
            await page.press("ArrowDown");
            await see(
                "document.querySelector('.pop-menu-row.on') !== document.querySelector('.pop-menu-row')",
            );
            await page.click({ selector: ".model-scope button:first-child" });
            await see(
                "document.querySelector('.pop-menu-row.on') === document.querySelector('.pop-menu-row')",
            );
            assert.equal(
                await inPage<boolean>(
                    `const menu = document.querySelector('.model-menu'); return JSON.stringify(menu.scrollWidth <= menu.clientWidth && menu.getBoundingClientRect().right <= innerWidth)`,
                ),
                true,
            );
            await page.press("Escape");
            await see("!document.querySelector('.model-menu')");
            await settle();
            await page.evaluate(`${state} openSheet({ type: 'model' }); return 'true'`);
            await see("!!document.querySelector('.model-scope')");
            assert.deepEqual(await rows(), ["faux/model-1", "faux/model-2"]);
            assert.equal(app.config.defaultModel, undefined, "filtering never chooses a model");
            await page.press("Escape");
            await see("!document.querySelector('.model-menu')");
            await settle();
        }

        assert.deepEqual(
            page.logs().filter((entry) => entry.level === "error"),
            [],
        );
    },
);
