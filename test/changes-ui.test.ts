// Changes totals and per-file diffs agree before and after staging, in real desktop and phone browsers.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
};
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session = 0;
const repo = join(root, "counts-repo");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(`return JSON.stringify(${script})`)) === true, what);

const settle = async () => {
    await page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter(a => a.effect?.getComputedTiming().endTime !== Infinity)
            .map(a => a.finished.catch(() => {})));
        return "true";
    `);
    await new Promise((resolve) => setTimeout(resolve, 450));
};

before(async () => {
    if (real.skip) {
        return;
    }

    mkdirSync(repo);
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "tracked.txt"), "old\n");
    git("add", ".");
    git("commit", "-qm", "baseline");
    writeFileSync(join(repo, "tracked.txt"), "new\n");
    writeFileSync(join(repo, "fresh.txt"), "one\ntwo\nthree\n");
    app = await openApp(scriptedModel());
    session = Number(await newSession(app, repo));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "counts-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
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
        `Changes summary and new-file diff stay consistent after staging (${size})`,
        real,
        async () => {
            git("reset", "-q", "HEAD", "--", "fresh.txt");
            await page.setViewport(VIEWPORTS[size]);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);

            if (
                await inPage<boolean>(
                    `return JSON.stringify(!!document.querySelector('form[action="/login"]'))`,
                )
            ) {
                await page.click({ selector: 'form[action="/login"] button' });
            }

            await see(`!!document.querySelector(".home-list")`, "the session list");
            await page.navigate(`${base}/s/${session}`);
            await see(`!!document.querySelector(".changes-button")`, "the Changes button");
            await settle();
            await see(
                `document.querySelector(".changes-button").getAttribute("aria-label").includes("4 lines added and 1 removed")`,
                "top-bar total +4 -1",
            );
            await page.click({ selector: ".changes-button" });
            await see(`!!document.querySelector(".dr-summary")`, "Changes review");
            await see(
                `document.querySelector(".dr-stats").textContent.includes("+4") && document.querySelector(".dr-stats").textContent.includes("−1")`,
                "review total +4 -1",
            );
            await see(
                `document.querySelector('.dr-file[data-path="fresh.txt"]')?.textContent.includes("three")`,
                "three-line new-file diff",
            );
            await see(
                `document.querySelector('.dr-file[data-path="fresh.txt"]').textContent.includes("+3")`,
                "new-file count +3",
            );
            await settle();
            git("add", "fresh.txt");
            await page.click({ selector: '.dr [aria-label="Refresh"]' });
            await see(
                `!!document.querySelector('.dr-file[data-path="fresh.txt"] .change-kind.added')`,
                "refresh has read the staged state",
            );
            await see(
                `document.querySelector('.dr-file[data-path="fresh.txt"]')?.textContent.includes("three") && document.querySelector(".dr-stats").textContent.includes("+4")`,
                "staged review remains +4",
            );
            await see(
                `document.querySelector(".changes-button").getAttribute("aria-label").includes("4 lines added and 1 removed")`,
                "staged top-bar total +4 -1",
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
                ),
                true,
                "no horizontal overflow",
            );
            await settle();
            await page.press("Alt+e");
            await see(
                `!document.querySelector(".files-tile:not(.leaving)")`,
                "Alt+E closes Changes",
            );
        },
    );
}
