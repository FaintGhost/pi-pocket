// Extensions' web parts: the routes a module adds under /api/x/, the browser module it serves from /x/, and the events
// it sends there. Who may use each, what a folder serves, and how they come and go with the module.
import {
    type App,
    cleanUp,
    fakeTab,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ExtensionWebs, POCKET_API } from "../src/server/extension-web.ts";
import type { ExtensionWeb } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
/** What the test modules leave on `globalThis`: their `web`, and how many of their versions were cleaned up. */
const seen = globalThis as unknown as { panelWeb?: ExtensionWeb; panelGone?: number };

/** A module with routes for every kind of person, and a folder of browser files for everyone with every session. */
const panel = (
    version: number,
    extra = "",
) => `/** Panel: a test module with routes and a browser module. */
export default function (_host, web) {
	web.route("GET", "status", () => ({ version: ${version} }));
	web.route("GET", "items/:id", ({ params, query }) => ({ id: params.id, q: query.get("q") }));
	web.route("POST", "items", ({ body, user }) => ({ got: body, by: user.name }));
	web.route("GET", "who", ({ user }) => user, { access: "view" });
	web.route("POST", "steer", () => ({ ok: true }), { access: "steer" });
	web.route("GET", "teapot", () => { throw web.error(418, "I am a teapot"); });
	web.route("GET", "leaky", () => { throw Object.assign(new Error("Incorrect API key sk-123"), { status: 401 }); }, { access: "view" });
	web.route("GET", "broken", () => { throw new Error("a secret detail"); }, { access: "view" });
	web.route("GET", "nothing", () => undefined);
	web.client("panel-web", { access: "view" });
	web.onDispose(() => { globalThis.panelGone = (globalThis.panelGone ?? 0) + 1; });
	globalThis.panelWeb = web;
	${extra}
}
`;

let app: App;
let server: Server;
let base = "";
const people: Record<string, { token: string; id: string }> = {};

before(async () => {
    mkdirSync(join(dropIns, "panel-web", "node_modules"), { recursive: true });
    writeFileSync(join(dropIns, "panel.ts"), panel(1));
    writeFileSync(join(dropIns, "panel-web", "index.js"), "export const marker = 'panel index';\n");
    writeFileSync(join(dropIns, "panel-web", "part.js"), "export const part = 1;\n");
    writeFileSync(join(dropIns, "panel-web", "look.css"), ".panel { color: red; }\n");
    writeFileSync(join(dropIns, "panel-web", "notes.ts"), "export const secret = 'server code';\n");
    writeFileSync(join(dropIns, "panel-web", ".hidden.js"), "export {};\n");
    writeFileSync(join(dropIns, "panel-web", "node_modules", "dep.js"), "export {};\n");
    writeFileSync(join(root, "outside.js"), "export const outside = true;\n");
    symlinkSync(join(root, "outside.js"), join(dropIns, "panel-web", "link.js"));
    // Links that stay in the folder but lead to what is not served, or to what is: none is followed.
    mkdirSync(join(dropIns, "panel-web", ".secret"));
    writeFileSync(join(dropIns, "panel-web", ".secret", "key.json"), '{"key":"sk-secret"}\n');
    symlinkSync("notes.ts", join(dropIns, "panel-web", "alias.js"));
    symlinkSync(".secret", join(dropIns, "panel-web", "visible"));
    symlinkSync("node_modules", join(dropIns, "panel-web", "deps"));
    symlinkSync("part.js", join(dropIns, "panel-web", "same.js"));
    // Routes whose paths overlap, registered least specific first.
    writeFileSync(
        join(dropIns, "order.ts"),
        `/** Order: routes that overlap. */
export default (_host, web) => {
	web.route("GET", "items/:id", ({ params }) => ({ route: "items/:id", id: params.id }));
	web.route("GET", ":kind/new", () => ({ route: ":kind/new" }));
	web.route("GET", "items/new", () => ({ route: "items/new" }));
};
`,
    );
    // One file as the browser module: only it is served, not the files beside it.
    writeFileSync(
        join(dropIns, "solo.ts"),
        `/** Solo: a browser module of one file, for the owner. */\nexport default (_host, web) => { web.client("solo.js"); };\n`,
    );
    writeFileSync(join(dropIns, "solo.js"), "export default () => {};\n");
    writeFileSync(join(dropIns, "other.js"), "export const other = true;\n");
    writeFileSync(
        join(dropIns, "future.ts"),
        `/** Future: needs a newer extension API. */\nexport const pocketApi = 99;\nexport default () => [];\n`,
    );
    writeFileSync(
        join(dropIns, "odd.name.ts"),
        `/** Odd: a name that is no part of an address. */\nexport default (_host, web) => { web.route("GET", "x", () => 1); };\n`,
    );
    writeFileSync(
        join(dropIns, "empty.ts"),
        `/** Empty: forgot to return its extensions. */\nexport default () => {};\n`,
    );
    writeFileSync(
        join(dropIns, "bad.ts"),
        `/** Bad: a path with a space. */\nexport default (_host, web) => { web.route("GET", "a b", () => 1); };\n`,
    );
    app = await openApp(scriptedModel(), dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    for (const [name, role, sessions] of [
        ["Gale", "guest", undefined],
        ["Vic", "viewer", undefined],
        ["Sid", "guest", ["1"]],
    ] as const) {
        const added = app.config.addUser(name, role, sessions ? [...sessions] : undefined);

        people[name] = { token: added.token, id: added.user.id };
    }

    people.owner = { token: app.config.ownerToken, id: owner(app).id };
    await app.setExtensionEnabled(owner(app), "panel.ts", true);
    await app.setExtensionEnabled(owner(app), "solo.ts", true);
    await app.setExtensionEnabled(owner(app), "order.ts", true);
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** A request as someone (by name, or nobody), with the `X-Pocket` header unless told not to. */
async function call(
    who: string | null,
    path: string,
    {
        method = "GET",
        body,
        header = true,
    }: { method?: string; body?: unknown; header?: boolean } = {},
) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(who === null ? {} : { authorization: `Bearer ${people[who]!.token}` }),
            ...(header ? { "x-pocket": "1" } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data: unknown = text;

    try {
        data = JSON.parse(text);
    } catch {
        // Not JSON: a file.
    }

    return { status: response.status, data, headers: response.headers };
}

/** The browser modules someone's tabs load, as `hello` says. */
const uiFor = async (who: string) =>
    ((await call(who, "/api/me")).data as { server: { ui: { module: string; url: string }[] } })
        .server.ui;

test("a module's routes answer signed-in people, by method, path, and who may use each", async () => {
    assert.deepEqual((await call("owner", "/api/x/panel/status")).data, { version: 1 });
    assert.deepEqual((await call("owner", "/api/x/panel/items/7?q=hi")).data, { id: "7", q: "hi" });
    assert.deepEqual(
        (await call("owner", "/api/x/panel/items", { body: { a: 1 }, method: "POST" })).data,
        {
            got: { a: 1 },
            by: "Owner",
        },
    );
    assert.deepEqual((await call("owner", "/api/x/panel/nothing")).data, {});

    // The API's own checks come first: a sign-in, and the header a link or form on another site cannot send, which a
    // module's routes need on a GET too.
    assert.equal((await call(null, "/api/x/panel/status")).status, 401);
    assert.equal((await call("owner", "/api/x/panel/status", { header: false })).status, 403);
    assert.equal(
        (await call("owner", "/api/x/panel/items", { method: "POST", body: {}, header: false }))
            .status,
        403,
    );

    // A path the module has under another method, a path it lacks, and a module that is not there.
    const wrong = await call("owner", "/api/x/panel/items");

    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
    assert.equal((await call("owner", "/api/x/panel/nope")).status, 404);
    assert.equal((await call("owner", "/api/x/nobody/status")).status, 404);

    // Owner by default; "steer" lets guests in, "view" viewers too; someone invited to one session never. A route
    // someone may not use is not there for them: the same 404 as a path the module lacks, and no methods told.
    assert.equal((await call("Gale", "/api/x/panel/status")).status, 404);
    assert.equal(
        (await call("Gale", "/api/x/panel/steer", { method: "POST", body: {} })).status,
        200,
    );
    assert.equal(
        (await call("Vic", "/api/x/panel/steer", { method: "POST", body: {} })).status,
        404,
    );
    assert.deepEqual((await call("Vic", "/api/x/panel/who")).data, {
        id: people.Vic!.id,
        name: "Vic",
        role: "viewer",
    });
    assert.equal((await call("Sid", "/api/x/panel/who")).status, 404);

    const asGuest = await call("Gale", "/api/x/panel/items");

    assert.equal(asGuest.status, 404, "the owner's POST items is not told to a guest");
    assert.equal(asGuest.headers.get("allow"), null);
    // Without the header, nothing is looked up: a path that is there and one that is not answer alike.
    assert.deepEqual(
        [
            (await call("Gale", "/api/x/panel/status", { header: false })).status,
            (await call("Gale", "/api/x/panel/nope", { header: false })).status,
            (await call("Gale", "/api/x/nobody/x", { header: false })).status,
        ],
        [403, 403, 403],
    );

    // A part decoded to a step out (`..%2F` is `../` once decoded), or with a backslash or NUL, is refused.
    for (const path of ["items/..%2F", "items/a%5Cb", "items/a%00b"]) {
        assert.equal((await call("owner", `/api/x/panel/${path}`)).status, 400, path);
    }

    // Of the routes a path matches, the most specific: a fixed part before a `:name` part.
    assert.deepEqual((await call("owner", "/api/x/order/items/new")).data, { route: "items/new" });
    assert.deepEqual((await call("owner", "/api/x/order/items/7")).data, {
        route: "items/:id",
        id: "7",
    });
    assert.deepEqual((await call("owner", "/api/x/order/a/new")).data, { route: ":kind/new" });
});

test("what a route throws becomes its answer: web.error's as it is, else a 500 whose words only the owner sees", async () => {
    const teapot = await call("Gale", "/api/x/panel/teapot");

    // The teapot is the owner's: for Gale it is not there. The owner gets the module's own status and words.
    assert.equal(teapot.status, 404);
    assert.deepEqual((await call("owner", "/api/x/panel/teapot")).data, { error: "I am a teapot" });
    assert.equal((await call("owner", "/api/x/panel/teapot")).status, 418);

    // A library's error has a status too, and words that may not be for everyone: a 500, as any other throw.
    const leakyToGuest = await call("Gale", "/api/x/panel/leaky");

    assert.equal(leakyToGuest.status, 500);
    assert.deepEqual(leakyToGuest.data, { error: "The extension failed to answer." });
    assert.match(JSON.stringify((await call("owner", "/api/x/panel/leaky")).data), /sk-123/);

    const toOwner = await call("owner", "/api/x/panel/broken");
    const toGuest = await call("Gale", "/api/x/panel/broken");

    assert.equal(toOwner.status, 500);
    assert.match(JSON.stringify(toOwner.data), /panel\.ts failed: a secret detail/);
    assert.equal(toGuest.status, 500);
    assert.deepEqual(toGuest.data, { error: "The extension failed to answer." });
});

test("a browser module loads for the people it is for, and its folder serves only its web files", async () => {
    const ownerUi = await uiFor("owner");
    const panelUrl = ownerUi.find((each) => each.module === "panel")!.url;
    const soloUrl = ownerUi.find((each) => each.module === "solo")!.url;

    assert.match(panelUrl, /^\/x\/panel\/[0-9a-f]{12}\/index\.js$/);
    assert.match(soloUrl, /^\/x\/solo\/[0-9a-f]{12}\/solo\.js$/);
    // Panel's is for everyone with every session; Solo's for the owner alone.
    assert.deepEqual(
        (await uiFor("Vic")).map((each) => each.module),
        ["panel"],
    );
    assert.deepEqual(await uiFor("Sid"), []);

    const folder = panelUrl.replace(/index\.js$/, "");
    const index = await call("owner", panelUrl);

    assert.equal(index.status, 200);
    assert.equal(index.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(String(index.data), /panel index/);
    assert.equal((await call("Vic", `${folder}part.js`)).status, 200);
    assert.equal(
        (await call("owner", `${folder}look.css`)).headers.get("content-type"),
        "text/css; charset=utf-8",
    );

    // Never server code, hidden files, dependencies, a link (out of the folder or in it), or a step out of it.
    for (const path of [
        "notes.ts",
        ".hidden.js",
        "node_modules/dep.js",
        "link.js",
        "alias.js",
        "visible/key.json",
        "deps/dep.js",
        "same.js",
        "%2E%2E/panel.ts",
        "a%5C..%5Cpanel.ts",
    ]) {
        assert.equal((await call("owner", `${folder}${path}`)).status, 404, path);
    }

    // Nobody signed in, and someone it is not for, learn nothing.
    assert.equal((await call(null, panelUrl)).status, 401);
    assert.equal((await call("Sid", panelUrl)).status, 404);
    assert.equal((await call("Gale", soloUrl)).status, 404);
    // One file is all a file serves, only to be read, and only by the app's own pages.
    const solo = await call("owner", soloUrl);

    assert.equal(solo.status, 200);
    assert.equal(solo.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal((await call("owner", soloUrl, { method: "POST", body: {} })).status, 405);
    assert.equal((await call("owner", soloUrl.replace(/solo\.js$/, "other.js"))).status, 404);

    // The Extensions sheet tells others who loads a browser module only when it loads for them; hello has no API
    // version (the app's own files are always the server's).
    const sheet = async (who: string) =>
        (await app.extensions(app.config.userById(people[who]!.id)!)).modules;

    assert.deepEqual((await sheet("Vic")).find((each) => each.file === "panel.ts")?.web, {
        routes: [],
        client: "view",
    });
    assert.equal((await sheet("Gale")).find((each) => each.file === "solo.ts")?.web, undefined);
    assert.equal(
        "extensionApi" in ((await call("owner", "/api/me")).data as { server: object }).server,
        false,
    );
});

test("events reach the tabs that load the browser module, or one person's, and what is not JSON goes nowhere", async () => {
    const tabs = Object.fromEntries(
        ["owner", "Gale", "Sid"].map((name) => [
            name,
            fakeTab(undefined, app.config.userById(people[name]!.id)!),
        ]),
    );

    for (const tab of Object.values(tabs)) {
        await app.attach(tab.client);
    }

    const ext = (name: string) =>
        tabs[name]!.events.filter((each) => each.event === "ext").map((each) => each.data);

    seen.panelWeb!.send("tick", { n: 1 });
    seen.panelWeb!.send("tick", 2, { to: people.Gale!.id });
    assert.deepEqual(ext("owner"), [{ module: "panel", event: "tick", data: { n: 1 } }]);
    assert.deepEqual(ext("Gale"), [
        { module: "panel", event: "tick", data: { n: 1 } },
        { module: "panel", event: "tick", data: 2 },
    ]);
    assert.deepEqual(ext("Sid"), []);
    // Never a throw (a timer's throw would stop the server): it is logged, and nobody gets it.
    const cycle: Record<string, unknown> = {};

    cycle.self = cycle;
    seen.panelWeb!.send("no spaces");
    seen.panelWeb!.send("fn", () => 1);
    seen.panelWeb!.send("cycle", cycle);
    seen.panelWeb!.send("big", "é".repeat(140_000));
    assert.equal(ext("owner").length, 1);

    for (const tab of Object.values(tabs)) {
        app.detach(tab.client);
    }
});

test("an edit swaps the routes and cleans up the version before; a failed one keeps it; off removes them", async () => {
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);
    const urlBefore = (await uiFor("owner")).find((each) => each.module === "panel")!.url;
    const gone = seen.panelGone ?? 0;

    writeFileSync(join(dropIns, "panel.ts"), panel(2));
    await app.loader.reload("panel.ts");
    assert.deepEqual((await call("owner", "/api/x/panel/status")).data, { version: 2 });
    assert.equal(seen.panelGone, gone + 1, "the version before was cleaned up");
    // Its browser files did not change: tabs keep what they loaded.
    assert.equal((await uiFor("owner")).find((each) => each.module === "panel")!.url, urlBefore);

    // An edit to a browser file gives a new version, and tabs hear of it.
    writeFileSync(
        join(dropIns, "panel-web", "index.js"),
        "export const marker = 'panel index, edited';\n",
    );
    app.webs.touched(dropIns, "panel-web");
    await until(async () => {
        const hello = tab.last("hello") as
            { server: { ui: { module: string; url: string }[] } } | undefined;

        return (
            hello?.server.ui.some((each) => each.module === "panel" && each.url !== urlBefore) ===
            true
        );
    }, "tabs hear of the new version");

    // A version that throws while it loads: the one before keeps answering, and what the failed one set up goes.
    writeFileSync(join(dropIns, "panel.ts"), panel(3, `throw new Error("not today");`));
    await assert.rejects(app.loader.reload("panel.ts"), /not today/);
    assert.deepEqual((await call("owner", "/api/x/panel/status")).data, { version: 2 });
    assert.equal(seen.panelGone, gone + 2, "the failed version's cleanup ran");
    assert.match(
        JSON.stringify(
            (await app.extensions(owner(app))).modules.find((each) => each.file === "panel.ts"),
        ),
        /"web":\{"routes":\["GET status","GET items\/:id","POST items","GET who","POST steer","GET teapot","GET leaky","GET broken","GET nothing"\],"client":"view"\}/,
    );

    // Off: its routes, files, and browser module go, and its cleanup runs.
    await app.setExtensionEnabled(owner(app), "panel.ts", false);
    assert.equal((await call("owner", "/api/x/panel/status")).status, 404);
    assert.equal((await call("owner", urlBefore)).status, 404);
    assert.ok(!(await uiFor("owner")).some((each) => each.module === "panel"));
    assert.equal(seen.panelGone, gone + 3);
    // A send from a version that is gone reaches nobody.
    seen.panelWeb!.send("late", 1);
    assert.ok(!tab.events.some((each) => each.event === "ext" && each.data.event === "late"));
    app.detach(tab.client);
});

test("a module needs a name fit for an address, good routes, and a version of the API this app has", async () => {
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "future.ts", true),
        /needs version 99 .* has 1/,
    );
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "odd.name.ts", true),
        /rename odd\.name\.ts/,
    );
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "bad.ts", true),
        /each part of a path/,
    );
    // One that forgot to return its extensions says so, rather than load as nothing.
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "empty.ts", true),
        /returned no extensions and added nothing/,
    );

    // A module that only adds to the app installs no extensions, and says what it adds.
    const solo = (await app.extensions(owner(app))).modules.find(
        (each) => each.file === "solo.ts",
    )!;

    assert.deepEqual(solo.extensions, []);
    assert.deepEqual(solo.web, { routes: [], client: "owner" });
    // Its routes are the owner's to know.
    const panelSeen = async (name: string) =>
        (await app.extensions(app.config.userById(people[name]!.id)!)).modules.find(
            (each) => each.file === "panel.ts",
        )?.web;

    writeFileSync(join(dropIns, "panel.ts"), panel(4));
    await app.setExtensionEnabled(owner(app), "panel.ts", true);
    assert.equal((await panelSeen("owner"))?.routes.length, 9);
    assert.deepEqual(await panelSeen("Gale"), { routes: [], client: "view" });
});

const OWNER = { role: "owner" as const };

test("a web part registers only while its module loads, and its cleanups run once it goes", async () => {
    const webs = new ExtensionWebs();
    const { part, web } = webs.stage("late.ts", dropIns, "late");
    let cleaned = 0;

    web.route("GET", "now", () => 1);
    web.onDispose(() => cleaned++);
    assert.throws(() => web.route("GET", "now", () => 2), /registered twice/);
    assert.throws(() => web.route("TRACE" as never, "x", () => 1), /the method is/);
    assert.throws(() => web.route("GET", "a/:id/:id", () => 1), /names a part twice/);
    assert.throws(() => web.route("GET", "", () => 1), /give the route a path/);
    assert.throws(() => web.route("GET", "a/../b", () => 1), /not \. or \.\. alone/);
    assert.throws(() => web.route("GET", "p/:__proto__", () => 1), /each part of a path/);
    assert.throws(() => web.client("../outside.js"), /right beside the module/);
    assert.throws(() => web.client("a#b.js"), /right beside the module/);
    assert.throws(() => web.client("missing.js"), /there is no missing\.js/);
    assert.throws(() => web.error(200, "fine"), /from 400 to 599/);
    assert.equal(web.error(404, "No such item").message, "No such item");
    assert.equal(web.error(500, { toString: 0 } as never).message, "The extension failed.");
    webs.commit(part);
    assert.throws(() => web.route("GET", "later", () => 1), /while the module loads/);
    assert.ok(webs.match("late", "GET", ["now"], OWNER));
    await webs.close();
    assert.equal(cleaned, 1);
    assert.equal(webs.match("late", "GET", ["now"], OWNER), undefined);
    // Registered after it went: it runs at once.
    web.onDispose(() => cleaned++);
    assert.equal(cleaned, 2);
});

test("a cleanup added after the module loaded runs when it goes, and the server waits for cleanups that wait", async () => {
    const webs = new ExtensionWebs();
    // A module that added nothing to the app while it loaded, and a cleanup later (from a timer, say).
    const quiet = webs.stage("quiet.ts", dropIns, "quiet");
    let ran = false;

    webs.commit(quiet.part);
    quiet.web.onDispose(() => {
        ran = true;
    });
    webs.remove("quiet.ts");
    assert.equal(ran, true);

    const slow = webs.stage("slow.ts", dropIns, "slow");
    let finished = false;

    slow.web.onDispose(
        () =>
            new Promise<void>((resolve) =>
                setTimeout(() => {
                    finished = true;
                    resolve();
                }, 30),
            ),
    );
    webs.commit(slow.part);
    await webs.close();
    assert.equal(finished, true, "close settled after the cleanup that waits");
});

test("web.send never throws, logs each kind of mistake once, and drops what comes too fast", async () => {
    const log: string[] = [];
    const sent: unknown[] = [];
    const folder = join(root, "send-test");

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "send.js"), "export default () => {};\n");

    const webs = new ExtensionWebs({
        log: (line) => log.push(line),
        deliver: (_part, _access, _event, data) => sent.push(data),
    });
    const { part, web } = webs.stage("send.ts", folder, "send");

    // While it loads, nothing goes out yet.
    web.send("early", 1);
    web.client("send.js");
    webs.commit(part);

    // An event named with an object whose own `toString` throws: converting it to text for the log would throw.
    for (let each = 0; each < 3; each++) {
        assert.doesNotThrow(() => web.send(JSON.parse('{"toString":0}') as never, {}));
    }

    assert.doesNotThrow(() => web.send("to", 1, { to: { toString: 0 } as never }));

    for (let each = 0; each < 150; each++) {
        web.send("tick", each);
    }

    assert.equal(sent.length, 100, "100 events a second at most");
    assert.equal(log.filter((line) => /once the module has loaded/.test(line)).length, 1);
    assert.equal(log.filter((line) => /name the event/.test(line)).length, 1, "logged once");
    assert.ok(log.some((line) => /`to` is a person's id/.test(line)));
    assert.equal(log.filter((line) => /more than 100 events/.test(line)).length, 1);

    // A module without a browser module: its events go nowhere, and the log says why.
    const bare = webs.stage("bare.ts", folder, "bare");

    webs.commit(bare.part);
    bare.web.send("tick", 1);
    assert.ok(log.some((line) => /bare\.ts: .*no browser module/.test(line)));
    await webs.close();
});

test("a browser module that is a link, or not a regular file, is refused, and one swapped for a pipe is not served", async () => {
    const folder = join(root, "kinds");

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "real.js"), "export default () => {};\n");
    symlinkSync("real.js", join(folder, "linked.js"));
    mkdirSync(join(folder, "linked-folder-target"));
    writeFileSync(join(folder, "linked-folder-target", "index.js"), "export default () => {};\n");
    symlinkSync("linked-folder-target", join(folder, "linked-folder"));
    execFileSync("mkfifo", [join(folder, "pipe.js")]);

    const webs = new ExtensionWebs();
    const { part, web } = webs.stage("kinds.ts", folder, "kinds");

    assert.throws(() => web.client("linked.js"), /is a link/);
    assert.throws(() => web.client("linked-folder"), /is a link/);
    assert.throws(() => web.client("pipe.js"), /is not a \.js file/);

    web.client("real.js");
    webs.commit(part);
    const rev = webs.clients(OWNER)[0]!.url.split("/")[3]!;

    assert.ok(webs.file("kinds", ["real.js"], OWNER));
    // Swapped for a pipe after it loaded: reading it would wait forever, holding up the whole server.
    rmSync(join(folder, "real.js"));
    execFileSync("mkfifo", [join(folder, "real.js")]);
    assert.equal(webs.file("kinds", ["real.js"], OWNER), undefined);
    // And swapped for a link: not served either.
    rmSync(join(folder, "real.js"));
    symlinkSync(join(root, "outside.js"), join(folder, "real.js"));
    assert.equal(webs.file("kinds", ["real.js"], OWNER), undefined);
    assert.ok(rev.length > 0);
    await webs.close();
});

test("edits anywhere in a browser module's folder reach the tabs, new folders included, but not other files", async (t) => {
    const folder = join(root, "watched");

    mkdirSync(join(folder, "watched-web"), { recursive: true });
    writeFileSync(join(folder, "watched-web", "index.js"), "export default () => {};\n");

    let changes = 0;
    const webs = new ExtensionWebs({ changed: () => changes++ });
    const { part, web } = webs.stage("watched.ts", folder, "watched");

    web.client("watched-web");
    webs.commit(part);
    webs.watch();
    // Watches keep the process alive: they stop whatever happens.
    t.after(() => webs.close());

    const url = () => webs.clients(OWNER)[0]!.url;
    const first = url();

    // A folder made after the module loaded, and then a file in it edited.
    mkdirSync(join(folder, "watched-web", "parts"));
    writeFileSync(join(folder, "watched-web", "parts", "one.js"), "export const one = 1;\n");
    await until(() => url() !== first, "the new file gives a new version");

    const second = url();

    await new Promise((resolve) => setTimeout(resolve, 250));
    writeFileSync(join(folder, "watched-web", "parts", "one.js"), "export const one = 2;\n");
    await until(() => url() !== second, "an edit in the new folder gives a new version");

    // A log the module writes beside its files is no new version: tabs do not load it again.
    const third = url();
    const before = changes;

    writeFileSync(join(folder, "watched-web", "debug.log"), "a line\n");
    writeFileSync(join(folder, "watched-web", "cache.tmp"), "x");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(url(), third);
    assert.equal(changes, before);
    await webs.close();
});

test("the server's web and the app's pocket are the same version of the extension API", () => {
    const app = readFileSync(new URL("../web/extension-ui.js", import.meta.url), "utf8");

    assert.equal(Number(/export const POCKET_API = (\d+);/.exec(app)?.[1]), POCKET_API);
});
