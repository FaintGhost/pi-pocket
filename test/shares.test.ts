// Sharing an artifact to anyone with its address: no sign-in, one version or the newest, for a time or until ended.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";

let app: App;
let server: Server;
let port = 0;
let now = 1_700_000_000_000;
let calls = 0;

before(async () => {
    app = await openApp(scriptedModel(), undefined, () => now);

    const { createHandler } = await import("../src/server/http.ts");

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

/** A session with one artifact published to it. */
async function publish(content: string, title = "Demo"): Promise<ConversationId> {
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const { id } = await app.commands.createSession(owner(app), { cwd: work });
    const tool = createArtifacts({} as PocketHost).tools![0]!;
    const api = {
        conversationId: id,
        taskId: 1000 + (calls += 1),
        callId: "publish",
        agent: async () => ({ cwd: work }),
        snapshot: app.harness.snapshot.bind(app.harness),
        commit: app.harness.commit.bind(app.harness),
    };

    await tool.execute({ id: "demo", title, content } as never, api as never, context);

    return id;
}

async function get(path: string): Promise<{ status: number; body: string; type: string }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);

    return {
        status: response.status,
        body: await response.text(),
        type: response.headers.get("content-type") ?? "",
    };
}

test("a published artifact opens with no sign-in, and follows its newest version until one is pinned", async () => {
    const id = await publish("<h1>one</h1>");
    const follow = await app.shares.create(id, owner(app), { id: "demo" });

    assert.equal(follow.version, null);
    assert.equal(follow.path, `/pub/${follow.token}`);

    const first = await get(follow.path);

    assert.equal(first.status, 200);
    assert.equal(first.body, "<h1>one</h1>");
    assert.match(first.type, /^text\/html/);

    // A newer version: the page that follows shows it.
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const tool = createArtifacts({} as PocketHost).tools![0]!;

    await tool.execute(
        { id: "demo", title: "Demo", content: "<h1>two</h1>" } as never,
        {
            conversationId: id,
            taskId: 5000,
            callId: "publish",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );
    assert.equal((await get(follow.path)).body, "<h1>two</h1>");

    // Pinned to version 1: it stays there, whoever looks, however many versions come.
    const pinned = await app.shares.create(id, owner(app), { id: "demo", version: 1 });

    assert.equal(pinned.version, 1);
    assert.equal((await get(pinned.path)).body, "<h1>one</h1>");

    const listed = await app.shares.list(id);

    assert.deepEqual(listed.map((each) => each.token).sort(), [follow.token, pinned.token].sort());
});

test("a share shows the artifact's own page, in the artifact's sandbox", async () => {
    const id = await publish("# Notes\n\nSome **text**.", "Notes");

    // A Markdown artifact renders as `/a/…` does, with no viewer colors named.
    const meta = await app.artifactBody(id, "demo", undefined);

    assert.equal(meta.meta.type, "html");
    const share = await app.shares.create(id, owner(app), { id: "demo" });
    const page = await get(share.path);

    assert.equal(page.status, 200);
    assert.equal(page.body, "# Notes\n\nSome **text**.");

    // The token names one thing only: anything else is nothing.
    assert.equal((await get(`/pub/${share.token}x`)).status, 404);
    assert.equal((await get("/pub/")).status, 404);
    assert.equal((await get("/pub")).status, 404);
});

test("a share closes at its time, and when it is ended", async () => {
    const id = await publish("<p>timed</p>");
    const timed = await app.shares.create(id, owner(app), { id: "demo", hours: 24 });

    assert.equal((await get(timed.path)).status, 200);

    now += 24 * 60 * 60 * 1000 + 1;
    assert.equal((await get(timed.path)).status, 404, "a day later it is gone");
    assert.deepEqual(await app.shares.list(id), [], "a share that closed is not listed");

    const ended = await app.shares.create(id, owner(app), { id: "demo" });

    assert.equal((await get(ended.path)).status, 200);
    await app.shares.revoke(owner(app), ended.token);
    assert.equal((await get(ended.path)).status, 404);
    await assert.rejects(app.shares.revoke(owner(app), ended.token), { status: 404 });
    assert.deepEqual(await app.shares.list(id), []);
});

test("only people who see every session publish or end one, and only for their own sessions", async () => {
    const id = await publish("<p>mine</p>");
    const guest = app.config.addUser("Guest", "guest").user;
    const viewer = app.config.addUser("Viewer", "viewer").user;
    const scoped = app.config.addUser("Scoped", "guest", [String(id)]).user;

    await assert.rejects(app.shares.create(id, scoped, { id: "demo" }), { status: 403 });
    await assert.rejects(app.shares.create(id, viewer, { id: "demo" }), { status: 403 });

    const theirs = await app.shares.create(id, guest, { id: "demo" });

    await assert.rejects(app.shares.revoke(scoped, theirs.token), { status: 403 });
    await assert.rejects(app.shares.create(id, guest, { id: "missing" }), { status: 404 });
    await assert.rejects(app.shares.create(id, guest, { id: "demo", hours: 5 }), { status: 400 });
    assert.equal((await get(theirs.path)).status, 200);
    await app.shares.revoke(owner(app), theirs.token);
});

test("a share is asked for without a cookie, and its page is the API's own answer to a signed-in reader", async () => {
    const id = await publish("<p>public</p>");
    const share = await app.shares.create(id, owner(app), { id: "demo" });

    // No cookie, no X-Pocket header, and a browser that is not signed in: still the artifact's page.
    const response = await fetch(`http://127.0.0.1:${port}${share.path}`, {
        headers: { "sec-fetch-mode": "navigate" },
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /allow-same-origin/);

    // The signed-in address of the same artifact still needs a sign-in.
    assert.equal((await get(`/a/${id}/demo/latest`)).status, 401);

    const api = await fetch(`http://127.0.0.1:${port}/api/c/${id}/shares`, {
        headers: { authorization: `Bearer ${app.config.ownerToken}` },
    });
    const listed = (await api.json()) as { shares: { token: string }[]; base: string | null };

    assert.equal(api.status, 200);
    assert.ok(listed.shares.some((each) => each.token === share.token));
    assert.ok("base" in listed);
});

test("a share whose artifact is gone, or which names a version that never was, shows nothing", async () => {
    const id = await publish("<p>x</p>");

    await assert.rejects(app.shares.create(id, owner(app), { id: "demo", version: 9 }), {
        status: 404,
    });
    await assert.rejects(app.shares.create(id, owner(app), { id: "nope" }), { status: 404 });
    assert.ok(root.length > 0);
});
