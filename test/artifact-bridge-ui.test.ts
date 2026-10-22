// An artifact's page asks the app for its saved state and offers a follow-up (#88, #89), in a real Chromium: the state
// comes back on the next open, and the follow-up joins the draft in the message box, marked as the artifact's, unsent.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** A page that counts its opens in its saved state, then offers a follow-up about that count. */
const PAGE = `<!doctype html><html><body><p id="out">waiting</p><script>
const ask = (message) => new Promise((resolve) => {
    const requestId = String(Math.random()).slice(2);
    addEventListener("message", function hear(event) {
        if (event.data && event.data.requestId === requestId) {
            removeEventListener("message", hear);
            resolve(event.data);
        }
    });
    parent.postMessage({ ...message, requestId }, "*");
});
(async () => {
    const got = await ask({ type: "pocket-state-get", schema: "v1" });
    const count = ((got.state && got.state.count) || 0) + 1;
    await ask({ type: "pocket-state-set", schema: "v1", state: { count } });
    parent.postMessage({ type: "pocket-follow-up", text: "Tell me about option " + count, selection: { option: count } }, "*");
})();
</script></body></html>`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const boxText = () =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(".composer textarea")?.value ?? "")`,
    );

/** Open the artifact's viewer as the app does, through the store. */
const openViewer = () =>
    inPage(`
        const { openSheet } = await import("/store.js");
        openSheet({ type: "viewer", id: "calc" });
        return "null";
    `);

const closeSheet = () =>
    inPage(`
        const { closeSheet } = await import("/store.js");
        closeSheet();
        return "null";
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    ({ id: session } = await app.commands.createSession(owner(app), { cwd: work }));
    await createArtifacts({} as PocketHost).tools![0]!.execute(
        { id: "calc", title: "Calculator", content: PAGE } as never,
        {
            conversationId: session,
            taskId: 9001,
            callId: "publish",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "artifact-bridge-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".composer textarea")))`,
            ),
        "the message box",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a follow-up joins the draft, marked as the artifact's, and nothing is sent",
    real,
    async () => {
        await inPage(`
        const box = document.querySelector(".composer textarea");
        box.value = "my draft";
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
        await openViewer();
        await until(async () => (await boxText()).includes("option 1"), "the follow-up in the box");

        const text = await boxText();

        assert.match(text, /^my draft/, "the draft stays, first");
        assert.match(text, /Tell me about option 1/);
        assert.match(text, /From the artifact “Calculator”:/);
        assert.match(text, /"option": 1/);
        assert.equal(
            (await app.transcripts.allEntries(session, false)).length,
            0,
            "the page made Pi do nothing",
        );
    },
);

test("its saved state comes back when it opens again", real, async () => {
    const saved = await app.harness.snapshot(
        (await import("../src/server/docs.ts")).ArtifactStateDoc,
        session,
        context,
    );

    assert.deepEqual(saved?.items.calc?.[owner(app).id]?.value, { count: 1 });
    await closeSheet();
    // A sheet that closes stays for its fade: only once it is gone does the viewer open afresh.
    await until(
        async () =>
            !(await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".viewer")))`,
            )),
        "the viewer gone",
    );
    await openViewer();
    await until(async () => (await boxText()).includes("option 2"), "the second open's follow-up");
});
