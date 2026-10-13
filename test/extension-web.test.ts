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
import {
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ExtensionWebs, POCKET_API } from "../src/server/extension-web.ts";
import type { ExtensionWeb } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import { eventTiming } from "../src/server/http/events.ts";
import { opened } from "../src/server/http/extension-routes.ts";

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
    // Too large to serve: each request would read it whole.
    writeFileSync(join(dropIns, "panel-web", "huge.json"), Buffer.alloc(9 * 1024 * 1024, 32));
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

    assert.equal((await call("owner", `${folder}huge.json`)).status, 413);

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

/** Run `act` with the clock `ms` ahead: how a test waits out the 30 s a tab far behind has to take something. */
async function later<T>(ms: number, act: () => Promise<T> | T): Promise<T> {
    const realNow = Date.now;

    Date.now = () => realNow() + ms;

    try {
        return await act();
    } finally {
        Date.now = realNow;
    }
}

test("a polling tab far behind is cut off only once it acknowledged nothing for long", async () => {
    type Poll = { session: string; events: { seq: number; event: string }[] };
    const poll = async (query: string): Promise<Poll> =>
        (await call("owner", `/api/poll?${query}`)).data as Poll;

    const megabytes = (count: number) => {
        for (let each = 0; each < count; each++) {
            app.notice("info", "é".repeat(512 * 1024));
        }
    };

    const first = await poll("tab=unread");

    assert.equal(first.events[0]?.event, "hello");

    // Far behind at once (a large first view comes this way): not cut off, as it has had no time to take it.
    megabytes(9);

    const second = await poll(`tab=unread&session=${first.session}&ack=0`);

    assert.equal(second.session, first.session);

    // It keeps acknowledging: it keeps up, however far behind, even long after.
    const acked = await later(31_000, async () => {
        const next = await poll(
            `tab=unread&session=${first.session}&ack=${second.events.at(-1)!.seq}`,
        );

        megabytes(9);

        return next;
    });

    assert.equal(acked.session, first.session);

    // Its answer is on its way (a slow link takes long): events long after do not cut it off.
    const taking = await later(31_000, () => poll(`tab=unread&session=${first.session}&ack=0`));

    assert.equal(taking.session, first.session);
    await later(62_000, () => megabytes(1));

    // Then it polls, but acknowledges nothing for longer than that: its session ends, and it starts with a full view.
    const next = await later(93_000, () => poll(`tab=unread&session=${first.session}&ack=0`));

    assert.notEqual(next.session, first.session);
    assert.equal(next.events[0]?.event, "hello");
    await call("owner", `/api/poll?session=${next.session}&close=1`);
});

test("a polling tab whose answer is on its way, or whose first view is slow to build, is not cut off", async () => {
    type Poll = { session: string; events: { seq: number; event: string }[] };
    const poll = async (query: string): Promise<Poll> =>
        (await call("owner", `/api/poll?${query}`)).data as Poll;

    const megabytes = (count: number) => {
        for (let each = 0; each < count; each++) {
            app.notice("info", "é".repeat(512 * 1024));
        }
    };

    // A first view that takes longer than the stall limit to build, and is large.
    const attach = app.attach.bind(app);

    app.attach = async (client) => {
        await attach(client);
        await later(31_000, () => {
            for (let each = 0; each < 9; each++) {
                client.send("notice", { level: "info", message: "é".repeat(512 * 1024) });
            }
        });
    };

    let first: Poll;

    try {
        first = await poll("tab=slow-build");
    } finally {
        app.attach = attach;
    }

    assert.equal(first.events[0]?.event, "hello");
    assert.ok(first.events.filter((each) => each.event === "notice").length >= 9, "all of it came");

    // It took its answer and asks again; a large answer goes to it, and it is slow to take it.
    const second = await poll(
        `tab=slow-build&session=${first.session}&ack=${first.events.at(-1)!.seq}`,
    );

    assert.equal(second.session, first.session);
    megabytes(9);

    const third = await poll(
        `tab=slow-build&session=${first.session}&ack=${second.events.at(-1)?.seq ?? first.events.at(-1)!.seq}`,
    );

    assert.equal(third.session, first.session);
    // Long after, with that answer still on its way, more events come: it is not cut off, and its next poll takes them.
    await later(31_000, () => megabytes(1));

    const fourth = await poll(
        `tab=slow-build&session=${first.session}&ack=${third.events.at(-1)!.seq}`,
    );

    assert.equal(fourth.session, first.session, "not cut off while its answer was on its way");
    await call("owner", `/api/poll?session=${first.session}&close=1`);
});

test("web.send's own failure cannot throw, and the server waits for cleanups still running or of loads not done", async () => {
    const webs = new ExtensionWebs();
    const sending = webs.stage("throws.ts", dropIns, "throws");

    webs.commit(sending.part);
    assert.doesNotThrow(() =>
        sending.web.send("tick", null, {
            get to(): string {
                throw { toString: 0 };
            },
        }),
    );

    const slow =
        (done: { at: number }, ms = 60) =>
        () =>
            new Promise<void>((resolve) =>
                setTimeout(() => {
                    done.at = Date.now();
                    resolve();
                }, ms),
            );
    // One turned off whose cleanup still runs, and one still loading when the server stops.
    const removed = { at: 0 };
    const loading = { at: 0 };
    const gone = webs.stage("gone.ts", dropIns, "gone");

    gone.web.onDispose(slow(removed));
    webs.commit(gone.part);
    webs.remove("gone.ts");

    const staged = webs.stage("staged.ts", dropIns, "staged");

    staged.web.onDispose(slow(loading));

    // A cleanup added after its version went runs at once: the stop waits for it too.
    const late = { at: 0 };

    gone.web.onDispose(slow(late, 250));
    await webs.close();
    assert.ok(removed.at > 0, "close waited for the cleanup of the module turned off");
    assert.ok(loading.at > 0, "close ran and waited for the cleanup of the version still loading");
    assert.ok(late.at > 0, "close waited for the cleanup added after its version went");
});

test("the server waits for a cleanup that another cleanup adds as it runs", async () => {
    const webs = new ExtensionWebs();
    const { part, web } = webs.stage("nested.ts", dropIns, "nested");
    const late = { at: 0 };

    web.onDispose(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        web.onDispose(
            () =>
                new Promise<void>((resolve) =>
                    setTimeout(() => {
                        late.at = Date.now();
                        resolve();
                    }, 200),
                ),
        );
    });
    webs.commit(part);
    await webs.close();
    assert.ok(late.at > 0, "close waited for the cleanup added while another ran");
});

test("a thousand files a browser module does not serve leave its own edits seen; a client that becomes a link is told", async () => {
    const folder = join(root, "crowded");
    const log: string[] = [];

    mkdirSync(join(folder, "crowded-web"), { recursive: true });
    writeFileSync(join(folder, "crowded-web", "index.js"), "export default () => {};\n");

    // Logs that sort before index.js: they must not use up the files looked at.
    for (let each = 0; each < 2100; each++) {
        writeFileSync(join(folder, "crowded-web", `a${String(each).padStart(4, "0")}.log`), "x");
    }

    const warned: string[] = [];
    const webs = new ExtensionWebs({
        log: (line) => log.push(line),
        warn: (message) => warned.push(message),
    });
    const { part, web } = webs.stage("crowded.ts", folder, "crowded");

    web.client("crowded-web");
    webs.commit(part);

    const url = () => webs.clients(OWNER)[0]!.url;
    const first = url();

    writeFileSync(
        join(folder, "crowded-web", "index.js"),
        "export default () => { /* edited */ };\n",
    );
    webs.touched(folder, "crowded-web");
    await until(() => url() !== first, "the edit gives a new version");

    // The folder swapped for a link to a copy: it is served no more, and the log says why.
    mkdirSync(join(root, "crowded-copy"));
    writeFileSync(join(root, "crowded-copy", "index.js"), "export default () => {};\n");
    rmSync(join(folder, "crowded-web"), { recursive: true });
    symlinkSync(join(root, "crowded-copy"), join(folder, "crowded-web"));
    webs.touched(folder, "crowded-web");
    // The owner is told why, in the app, once (the notice goes to the log too, so the log has it no more).
    await until(() => warned.length > 0, "the owner is told why");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(warned.length, 1);
    assert.equal(log.filter((line) => /gone or became a link/.test(line)).length, 0);
    assert.match(
        warned[0]!,
        /crowded\.ts: its browser module crowded-web is gone or became a link/,
    );
    assert.equal(webs.file("crowded", ["index.js"], OWNER), undefined);
    await webs.close();
});

test("the server stops in time when a module's cleanup never ends, and still closes the rest", async () => {
    const dataDir = join(root, "stopping");
    const folder = join(dataDir, "extensions");

    mkdirSync(folder, { recursive: true });
    writeFileSync(
        join(folder, "forever.ts"),
        `/** Forever: a cleanup that never ends. */
export default (_host, web) => {
	web.onDispose(() => new Promise(() => {}));
};
`,
    );

    const other = await openApp(scriptedModel(), dataDir);

    await other.setExtensionEnabled(owner(other), "forever.ts", true);
    const started = Date.now();

    await other.close();

    const took = Date.now() - started;

    assert.ok(took >= 2900 && took < 8000, `stopped after ${took} ms`);
    assert.equal(existsSync(join(dataDir, "harness.lock")), false, "the rest closed too");
});

test("a stream far behind is cut off only once it took nothing for long, and one that reads never is", async () => {
    const { port } = server.address() as { port: number };

    const open = (tab: string) => {
        const socket = connect(port, "127.0.0.1");
        let got = 0;

        socket.on("error", () => {});
        socket.on("data", (chunk: Buffer) => (got += chunk.length));
        socket.write(
            `GET /api/events?tab=${tab} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${app.config.ownerToken}\r\n\r\n`,
        );

        return {
            socket,
            got: () => got,
            closed: new Promise<void>((resolve) => socket.on("close", () => resolve())),
        };
    };

    const reading = open("reading");
    const stalled = open("stalled");

    await until(() => reading.got() > 0 && stalled.got() > 0, "both streams start");
    // One reads nothing from here on.
    stalled.socket.pause();

    let cut = false;

    void stalled.closed.then(() => (cut = true));

    const flood = async (count: number) => {
        for (let each = 0; each < count; each++) {
            app.notice("info", "x".repeat(1024 * 1024));
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };

    // Far behind, but only for a moment: nothing is cut off yet.
    await flood(20);
    stalled.socket.resume();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(cut, false, "not cut off for being behind a moment");
    stalled.socket.pause();
    await flood(20);

    // Long after, the one that reads still gets everything; the one that took nothing is cut off.
    let readingCut = false;

    void reading.closed.then(() => (readingCut = true));
    await later(31_000, () => flood(3));
    stalled.socket.resume();
    await Promise.race([stalled.closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
    assert.equal(cut, true, "the stalled stream was cut off");
    assert.equal(readingCut, false, "the stream that reads was not");
    reading.socket.destroy();
    stalled.socket.destroy();
});

test("a polling session lives on from its last answer, so one that went late in a long wait still comes in", async () => {
    type Poll = { session: string; events: { seq: number; event: string }[] };
    const poll = async (query: string): Promise<Poll> =>
        (await call("owner", `/api/poll?${query}`)).data as Poll;
    const pollExpireMs = eventTiming.pollExpireMs;

    eventTiming.pollExpireMs = 2000;

    try {
        const first = await poll("tab=late-answer");
        let ack = first.events.at(-1)!.seq;
        let asked = 0;

        // A poll that waits, as nothing is there for it, and whose answer goes when an event comes, late in the
        // session's time (polls answered at once carry what was still on its way from the start).
        for (let round = 0; round < 10; round++) {
            asked = Date.now();
            const late = setTimeout(() => app.notice("info", "late"), 1400);
            const answer = await poll(`tab=late-answer&session=${first.session}&ack=${ack}`);

            clearTimeout(late);
            assert.equal(answer.session, first.session);
            ack = answer.events.at(-1)?.seq ?? ack;

            if (Date.now() - asked >= 1350) {
                break;
            }
        }

        assert.ok(Date.now() - asked >= 1350, "a poll waited");
        // Past its time from that poll, well within it from its answer: the session is still there.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, asked + 2300 - Date.now())));

        const next = await poll(`tab=late-answer&session=${first.session}&ack=${ack}`);

        assert.equal(next.session, first.session, "the session lived on from its answer");
        await call("owner", `/api/poll?session=${first.session}&close=1`);
    } finally {
        eventTiming.pollExpireMs = pollExpireMs;
    }
});

test("a polling session's time starts once its first view is built, however long that takes", async () => {
    type Poll = { session: string; events: { seq: number; event: string }[] };
    const poll = async (query: string): Promise<Poll> =>
        (await call("owner", `/api/poll?${query}`)).data as Poll;
    const pollExpireMs = eventTiming.pollExpireMs;
    const attach = app.attach.bind(app);

    eventTiming.pollExpireMs = 500;

    // A first view that takes longer to build than a session lives.
    app.attach = async (client) => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await attach(client);
    };

    try {
        const first = await poll("tab=slow-start");

        app.attach = attach;
        assert.equal(first.events[0]?.event, "hello");

        const next = await poll(
            `tab=slow-start&session=${first.session}&ack=${first.events.at(-1)!.seq}`,
        );

        assert.equal(next.session, first.session, "the session outlived its slow start");
        await call("owner", `/api/poll?session=${first.session}&close=1`);
    } finally {
        app.attach = attach;
        eventTiming.pollExpireMs = pollExpireMs;
    }
});

test("a polling tab whose first view fails to build leaves nothing behind", async () => {
    const attach = app.attach.bind(app);
    const detach = app.detach.bind(app);
    const detached: string[] = [];

    app.attach = async (client) => {
        await attach(client);

        throw new Error("the view failed");
    };

    app.detach = (client) => {
        detached.push(client.id);
        detach(client);
    };

    try {
        const answer = await call("owner", "/api/poll?tab=broken-start");

        assert.equal(answer.status, 500);
        assert.deepEqual(detached, ["broken-start"], "its tab was let go at once");
    } finally {
        app.attach = attach;
        app.detach = detach;
    }
});

test("a polling tab that goes while its first view is built is let go, though the build ends long after", async () => {
    const { port } = server.address() as { port: number };
    const attach = app.attach.bind(app);
    const detach = app.detach.bind(app);
    const detached: string[] = [];
    const pollExpireMs = eventTiming.pollExpireMs;
    let release!: () => void;
    const never = new Promise<void>((resolve) => (release = resolve));

    eventTiming.pollExpireMs = 300;

    // The build ends only when the test says, and then the tab comes in, after its poller was let go.
    let built = false;

    app.attach = async (client) => {
        await never;
        await attach(client);
        built = true;
    };

    app.detach = (client) => {
        detached.push(client.id);
        detach(client);
    };

    try {
        const socket = connect(port, "127.0.0.1");

        socket.on("error", () => {});
        socket.write(
            `GET /api/poll?tab=gone-early HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${app.config.ownerToken}\r\n\r\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The tab goes; its first view is not built yet.
        socket.destroy();
        await until(() => detached.includes("gone-early"), "the tab let go", 3000);
        // The build ends: the tab that comes in now is let go too.
        release();
        await until(() => built, "the build to end");
        await until(
            () => [...app.clients].every((client) => client.id !== "gone-early"),
            "the late tab let go",
            3000,
        );
    } finally {
        release();
        app.attach = attach;
        app.detach = detach;
        eventTiming.pollExpireMs = pollExpireMs;
    }
});

test("a stream far behind that takes nothing is cut off at its ping, with no new events for it", async () => {
    const { port } = server.address() as { port: number };
    const pingMs = eventTiming.pingMs;

    eventTiming.pingMs = 100;

    try {
        const socket = connect(port, "127.0.0.1");
        let got = 0;

        socket.on("error", () => {});
        socket.on("data", (chunk: Buffer) => (got += chunk.length));
        socket.write(
            `GET /api/events?tab=quiet HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${app.config.ownerToken}\r\n\r\n`,
        );

        const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
        let cut = false;

        void closed.then(() => (cut = true));
        await until(() => got > 0, "the stream starts");
        socket.pause();

        // Far behind, then nothing more for it: only the ping can see it took nothing.
        for (let each = 0; each < 24; each++) {
            app.notice("info", "x".repeat(1024 * 1024));
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(cut, false, "not cut off for being behind a moment");
        await later(31_000, () => new Promise((resolve) => setTimeout(resolve, 500)));
        socket.resume();
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
        assert.equal(cut, true, "the ping cut it off");
        socket.destroy();
    } finally {
        eventTiming.pingMs = pingMs;
    }
});

test("a file is served only when what was opened is the file that was checked", async () => {
    const ownerUi = await uiFor("owner");
    const folder = ownerUi.find((each) => each.module === "solo")!.url.replace(/solo\.js$/, "");
    // A folder on the way swapped for a link after the check: the path checked leads elsewhere when opened.
    const outside = join(root, "swapped-outside");

    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.json"), '{"secret":"sk-outside"}\n');
    symlinkSync(outside, join(root, "swapped-link"));

    const checked = app.webs.file.bind(app.webs);
    // What the check saw: the module's own file, before its folder was swapped.
    const real = app.webs.file("solo", ["solo.js"], OWNER)!;

    app.webs.file = () => ({
        file: join(root, "swapped-link", "secret.json"),
        type: "application/json",
        dev: real.dev,
        ino: real.ino,
    });

    try {
        const answer = await call("owner", `${folder}solo.js`);

        assert.equal(answer.status, 404);
        assert.doesNotMatch(String(JSON.stringify(answer.data)), /sk-outside/);
    } finally {
        app.webs.file = checked;
    }

    assert.equal((await call("owner", `${folder}solo.js`)).status, 200);

    // Where the system cannot say where an open file is (macOS has no /proc), the file opened must still be the one
    // checked: the swapped folder's file is another.
    const fd = openSync(join(root, "swapped-link", "secret.json"), "r");

    try {
        const stats = fstatSync(fd);
        const swapped = { file: join(root, "swapped-link", "secret.json") };

        assert.equal(opened(fd, { ...swapped, dev: real.dev, ino: real.ino }, stats, false), false);
        assert.equal(
            opened(fd, { ...swapped, dev: stats.dev, ino: stats.ino }, stats, false),
            true,
        );
    } finally {
        closeSync(fd);
    }
});
