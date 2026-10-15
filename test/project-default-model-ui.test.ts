// Settings-only trust and owner-default wording in real Chromium, on desktop and phones.
import { type App, cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
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
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function value<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${script})`)) as T;
}

const see = (script: string, what: string) => until(() => value<boolean>(script), what);

async function settled(): Promise<void> {
    await page.evaluate(`await Promise.all(document.getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})))`);
    // Back intentionally ignores a second click within the opening gesture's 280 ms.
    await new Promise((resolve) => setTimeout(resolve, 450));
}

async function open(id: ConversationId): Promise<void> {
    await page.navigate(`${base}/s/${id}`);
    await see(`document.querySelector('.composer textarea') !== null`, "the composer");
    await settled();
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "model-trust-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${app.config.ownerToken}`);
    await see(`(await import('/store.js')).store.state.me?.role === 'owner'`, "signed in");
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

for (const size of ["desktop", "mobile"] as const) {
    test(
        `${size}: settings-only trust affects later sessions and clearing the owner default explains the order`,
        real,
        async () => {
            const cwd = mkdtempSync(join(root, "settings-only-ui-"));

            mkdirSync(join(cwd, ".pi"));
            writeFileSync(
                join(cwd, ".pi", "settings.json"),
                JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-2" }),
            );
            const first = await app.commands.createSession(owner(app), { cwd });

            await page.setViewport(VIEWPORTS[size]);
            await open(first.id);
            await see(
                `document.querySelector('.trust-bar') !== null`,
                "the settings-only question",
            );
            assert.match(
                await value<string>(`document.querySelector('.trust-bar').textContent`),
                /later new sessions/,
            );
            await page.click({ label: "Review" });
            await see(
                `document.querySelector('.sheet')?.textContent.includes('No project setting can grant trust to itself.') === true`,
                "the trust explanation",
            );
            assert.match(
                await value<string>(`document.querySelector('.sheet').textContent`),
                /Extra skill and prompt paths and per-project run policy are not supported yet/,
            );
            await settled();
            await page.click({ label: "Trust this folder" });
            await see(`document.querySelector('.trust-bar') === null`, "trust saved");
            assert.equal((await app.agentState(first.id))?.model?.modelId, "faux-1");
            const second = await app.commands.createSession(owner(app), { cwd });

            await open(second.id);
            await see(
                `document.querySelector('.model-chip')?.textContent.includes('faux-2') === true`,
                "the project model chip",
            );
            await app.setDefaultModel(owner(app), { provider: "faux", modelId: "faux-1" });
            await page.evaluate(
                `(await import('/store.js')).openSheet({type:'model',forDefault:true})`,
            );
            await see(
                `document.querySelector('.pop-menu')?.textContent.includes('Clear owner default: use project defaults, then last picked') === true`,
                "the owner-default menu",
            );
            assert.match(
                await value<string>(`document.querySelector('.pop-menu').textContent`),
                /owner default wins over project settings/,
            );
            await settled();
            await page.click({
                label: "Clear owner default: use project defaults, then last picked",
            });
            await see(
                `(await import('/store.js')).store.state.server.defaultModel === null`,
                "the default cleared",
            );
            await see(
                `document.querySelector('.pop-menu')?.textContent.includes("Pi's global default") === true`,
                "the fallback order",
            );
            assert.equal(app.config.defaultModel, undefined);
            assert.equal(
                await value<number>(`document.documentElement.scrollWidth`),
                VIEWPORTS[size].width,
            );
            await page.evaluate(`(await import('/store.js')).closeSheet()`);
            await settled();
        },
    );
}
