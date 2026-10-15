// PiP's private browser component uses its compaction budget, capped at the model window.
import { cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

test("PiP's meter uses its capped compaction budget", real, async (t) => {
    const app = await openApp(scriptedModel());
    let server: ReturnType<typeof createServer> | undefined;
    let browsers: Browsers | undefined;

    t.after(async () => {
        try {
            await browsers?.closeAll({ final: true });
        } finally {
            server?.closeAllConnections();
            server?.close();

            try {
                await app.close();
            } finally {
                cleanUp();
            }
        }
    });

    app.watches.gh = async () => {
        throw new Error("No GitHub in PiP context UI tests");
    };

    const pip = await app.pip.ensure(owner(app));

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "pip-context-browser-")),
        load: async () => undefined,
        save: () => {},
    });

    const page = await browsers.open(1);
    const inPage = async <T>(script: string): Promise<T> =>
        JSON.parse(await page.evaluate(script)) as T;

    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify((await import('/store.js')).store.state.me?.role === 'owner')`,
            ),
        "owner signed in",
    );
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify((await import('/store.js')).store.state.pipView.conversation?.id === ${Number(pip)} && document.querySelector('.pip-panel') !== null)`,
            ),
        "PiP's live view",
    );

    await page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished.catch(() => {})));
    `);

    // Exact usage fixtures avoid generating tens of thousands of tokens.
    const fill = async (at: number, window = 128_000, used = 55_000) => {
        await page.evaluate(`
            const { store } = await import('/store.js');
            const view = store.state.pipView;
            store.set({
                server: { ...store.state.server, pipCompactAt: ${at} },
                pipView: {
                    ...view,
                    agent: { ...view.agent, contextWindow: ${window} },
                    stats: { ...view.stats, contextTokens: ${used} },
                },
            });
            await new Promise((resolve) => requestAnimationFrame(resolve));
            await new Promise((resolve) => requestAnimationFrame(resolve));
        `);

        return inPage<string>(
            `return JSON.stringify(document.querySelector('.pip-context .meter > span').style.width)`,
        );
    };

    assert.equal(await fill(60_000), "92%");
    assert.equal(await fill(100_000), "55%");
    assert.equal(await fill(60_000, 32_000, 30_000), "94%");
    assert.equal(await fill(0), "43%");
});
