// Refresh feedback in real browsers; held HTTP responses make loading and partial failures deterministic.
// Lists still update through the real models event stream, including a second tab showing another surface.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { modelList } from "../src/server/models.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let other: BrowserPage;
let base = "";
let session = 0;
let mocked = true;
let requests = 0;
let pending: ServerResponse | undefined;

const inPage = async <T>(script: string, on = page): Promise<T> =>
    JSON.parse(await on.evaluate(script)) as T;
const see = (script: string, what: string, on = page) =>
    until(async () => (await inPage<boolean>(script, on)) === true, what);

const settle = async (on = page) => {
    await on.evaluate(`
        await Promise.all(document.getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished.catch(() => {})));
        return "true";
    `);
    // A person's next tap is past back.js's protection against tapping a newly opened layer.
    await new Promise((resolve) => setTimeout(resolve, 450));
};

const status = (on = page) =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(".model-refresh-status")?.textContent ?? "")`,
        on,
    );
const state = `const { store } = await import("/store.js");`;

async function login(on: BrowserPage, size: keyof typeof VIEWPORTS, token = app.config.ownerToken) {
    await on.setViewport(VIEWPORTS[size]);
    await on.navigate(`${base}/login?token=${encodeURIComponent(token)}`);

    if (
        await inPage<boolean>(
            `return JSON.stringify(!!document.querySelector('form[action="/login"]'))`,
            on,
        )
    ) {
        await on.click({ selector: 'form[action="/login"] button' });
    }

    await see(`${state} return JSON.stringify(!!store.state.me)`, "signed in", on);
    await on.navigate(`${base}/s/${session}`);
    await see(
        `${state} return JSON.stringify(store.state.view.conversation?.id === ${session})`,
        "the session",
        on,
    );
    await settle(on);
}

async function sheet(type: "model" | "providers", on = page, forDefault = false) {
    await on.evaluate(`
        (await import("/store.js")).openSheet({ type: ${JSON.stringify(type)}, forDefault: ${forDefault} });
        return "true";
    `);
    await see(
        `return JSON.stringify(!!document.querySelector(${JSON.stringify(type === "model" ? ".pop-menu" : ".subagent-models")}))`,
        "the sheet",
        on,
    );
    await settle(on);
}

function answer(body: object, code = 200) {
    assert.ok(pending, "a refresh request is waiting");
    pending.writeHead(code, { "content-type": "application/json" });
    pending.end(JSON.stringify(body));
    pending = undefined;
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    session = Number(await newSession(app));
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (mocked && request.url === "/api/models/refresh") {
            assert.equal(request.method, "POST");
            assert.equal(request.headers["x-pocket"], "1");
            let body = "";

            request.on("data", (chunk: Buffer) => {
                body += chunk.toString();
            });
            request.on("end", () => {
                assert.deepEqual(JSON.parse(body), {});
                requests++;
                pending = response;
            });

            return;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "refresh-ui-browser-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    other = await browsers.open(2);
});

after(async () => {
    pending?.end(JSON.stringify({ error: "Test ended" }));
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

for (const size of ["desktop", "mobile"] as const) {
    test(
        `refresh loading, counts, plain provider errors, and live lists across surfaces (${size})`,
        real,
        async () => {
            mocked = true;
            await login(page, size);
            await login(other, size);
            await sheet("model");
            await sheet("providers", other);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".model-refresh-button").getBoundingClientRect().height >= 40)`,
                ),
                true,
            );
            const before = requests;

            await page.click({ selector: ".model-refresh-button" });
            await until(() => pending !== undefined, "refresh request");
            await see(
                `return JSON.stringify(document.querySelector(".model-refresh-button").disabled && document.querySelector(".model-refresh-button").textContent.includes("Refreshing"))`,
                "disabled loading control",
            );
            await page.evaluate(
                `(await import("/model-refresh.js")).refreshModels(); return "true";`,
            );
            assert.equal(requests, before + 1, "repeated requests in one tab are blocked");
            await sheet("providers");
            assert.match(await status(), /Checking configured providers/);
            const models = modelList(app.models, app.signInNeeded);
            const changed = [models[0]!, { ...models[1]!, id: "fresh-model", name: "Fresh model" }];

            for (const client of app.clients) {
                client.send("models", changed);
            }

            answer({
                added: 1,
                removed: 2,
                total: 2,
                errors: [{ provider: "offline", message: "<b>Unavailable</b> & try later" }],
            });
            await see(
                `return JSON.stringify(document.querySelector(".model-refresh-status").textContent.includes("1 added, 2 removed"))`,
                "completion counts",
            );
            assert.match(await status(), /2 models available/);
            assert.match(await status(), /offline: <b>Unavailable<\/b> & try later/);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".model-refresh-status b") === null)`,
                ),
                true,
                "provider messages are text, not markup",
            );

            for (const tab of [page, other]) {
                await see(
                    `return JSON.stringify([...document.querySelectorAll(".subagent-model input")].some((box) => box.value === "faux/fresh-model") && document.querySelectorAll(".subagent-model input").length === 2)`,
                    "the checklist updates through the models event",
                    tab,
                );
            }

            await sheet("model");
            await see(
                `return JSON.stringify(document.querySelector(".pop-menu-list").textContent.includes("Fresh model") && document.querySelectorAll(".pop-menu-row").length === 2)`,
                "the switch picker uses the live list",
            );
            assert.match(await status(), /offline/);
            await sheet("model", page, true);
            assert.match(await status(), /1 added, 2 removed/);
            await page.click({ selector: ".model-refresh-button" });
            await until(() => pending !== undefined, "no-change request");
            answer({ added: 0, removed: 0, total: 2, errors: [], offline: true });
            await see(
                `return JSON.stringify(document.querySelector(".model-refresh-status").textContent.includes("No model changes"))`,
                "no changes reported",
            );
            assert.match(await status(), /Offline: reloaded cached models and configuration\./);
            assert.match(await status(), /2 models available/);
            assert.doesNotMatch(await status(), /offline:/);
            assert.equal(
                await inPage<boolean>(
                    `const menu = document.querySelector(".pop-menu"); return JSON.stringify(menu.scrollWidth <= menu.clientWidth + 1 && menu.getBoundingClientRect().right <= innerWidth + 1)`,
                ),
                true,
                "feedback fits the viewport",
            );
            await page.click({ selector: ".model-refresh-button" });
            await until(() => pending !== undefined, "failing request");
            answer({ error: "Could not read configuration" }, 500);
            await see(
                `return JSON.stringify(document.querySelector(".model-refresh-status").textContent.includes("Could not read configuration") && !document.querySelector(".model-refresh-button").disabled)`,
                "a failed request is shown and can be retried",
            );
        },
    );
}

test("launcher keeps its existing actions and gives feedback after it closes", real, async () => {
    mocked = true;
    await login(page, "desktop");
    await page.press("Control+K");
    await see(`return JSON.stringify(!!document.querySelector(".launcher input"))`, "launcher");
    await page.type({ selector: ".launcher input" }, "> ");
    await see(
        `return JSON.stringify(document.querySelector(".launcher").textContent.includes("Refresh models"))`,
        "the new action",
    );
    const labels = await inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".launcher-title")].map((node) => node.textContent))`,
    );

    for (const label of [
        "Switch model",
        "Default model",
        "Providers",
        "Extensions",
        "New session",
        "Spend",
        "Keyboard shortcuts",
    ]) {
        assert.ok(labels.includes(label), `${label} is still offered`);
    }

    await page.type({ selector: ".launcher input" }, "> Refresh models");
    await settle();
    await page.press("Enter");
    await until(() => pending !== undefined, "launcher request");
    await see(`return JSON.stringify(!document.querySelector(".launcher"))`, "launcher closes");
    answer({ added: 3, removed: 1, total: 5, errors: [] });
    await see(
        `${state} return JSON.stringify(store.state.notices.some((notice) => notice.message.includes("3 added, 1 removed")))`,
        "toast feedback after launcher closes",
    );
    await sheet("providers");
    assert.match(await status(), /3 added, 1 removed/);
});

test(
    "owner can refresh through the real endpoint; older servers and guests offer no refresh",
    real,
    async () => {
        mocked = false;
        await login(page, "mobile");
        await sheet("model", page, true);
        await page.click({ selector: ".model-refresh-button" });
        await see(
            `${state} return JSON.stringify(!store.state.modelRefresh.loading && !!store.state.modelRefresh.result)`,
            "the real endpoint completed",
        );
        const result = await inPage<{ added: number; removed: number; total: number }>(
            `${state} return JSON.stringify(store.state.modelRefresh.result)`,
        );

        assert.equal(result.total, modelList(app.models, app.signInNeeded).length);
        assert.equal(result.added, 0);
        assert.equal(result.removed, 0);
        assert.match(await status(), /No model changes/);
        await page.evaluate(
            `${state} store.set({ server: { ...store.state.server, refreshModels: undefined } }); return "true";`,
        );
        await see(
            `return JSON.stringify(!document.querySelector(".model-refresh"))`,
            "older server hides refresh",
        );
        await page.evaluate(`${state} store.set({ sheet: null, launcher: true }); return "true";`);
        await page.type({ selector: ".launcher input" }, "> Refresh models");
        await see(
            `return JSON.stringify(document.querySelectorAll(".launcher-item").length === 0)`,
            "older server has no refresh action",
        );
        const guest = app.config.addUser("Member", "guest");

        await login(page, "mobile", guest.token);
        await sheet("model");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(!!document.querySelector(".model-refresh"))`,
            ),
            false,
        );
        await page.evaluate(`${state} store.set({ sheet: null, launcher: true }); return "true";`);
        await page.type({ selector: ".launcher input" }, "> Refresh models");
        await see(
            `return JSON.stringify(document.querySelectorAll(".launcher-item").length === 0)`,
            "guest has no refresh action",
        );
    },
);
