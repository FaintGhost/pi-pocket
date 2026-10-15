// A first-use PiP keeps its suggestions while the owner chooses a model.
import { cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

test(
    "model-less PiP leads to its picker and keeps the suggestions usable",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser" : false,
    },
    async (t) => {
        const app = await openApp(scriptedModel());
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({ dataDir: root });

        t.after(async () => {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            server.close();
            await app.close();
            cleanUp();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const read = async <T>(script: string): Promise<T> =>
            JSON.parse(await page.evaluate(script));
        const see = (condition: string) =>
            until(() => read<boolean>(`return JSON.stringify(Boolean(${condition}))`), condition);

        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await see(`(await import('/store.js')).store.state.me?.role === 'owner'`);
        await page.evaluate(`(await import('/pip.js')).openPip()`);
        await see(`document.querySelector('.pip-welcome')`);
        assert.equal(
            await read(`return JSON.stringify(!!document.querySelector('.pip-welcome .button'))`),
            true,
        );
        assert.deepEqual(
            await read(
                `return JSON.stringify([...document.querySelectorAll('.pip-chip')].map(b => b.disabled))`,
            ),
            [true, true, false, true, false],
        );
        await page.evaluate(`document.querySelector('.pip-welcome .button').click()`);
        await see(`document.querySelector('[role=option]')`);
        await page.evaluate(`document.querySelector('[role=option]').click()`);
        await see(`document.querySelector('.pip-model').textContent.includes('faux-1')`);
        assert.equal(
            await read(
                `return JSON.stringify(document.querySelectorAll('.pip-chip:not(:disabled)').length)`,
            ),
            5,
        );
        await page.evaluate(`document.querySelector('.pip-chip').click()`);
        await see(
            `document.querySelector('.pip-reply')?.textContent.includes('echo: What needs me?')`,
        );
    },
);
