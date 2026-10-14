// Manual refresh uses Pi's runtime without stopping sessions, and publishes each provider separately.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { ModelRefresh } from "../src/server/model-refresh.ts";
import { createHandler } from "../src/server/http.ts";
import type { Provider } from "@earendil-works/pi-ai";

let app: App;
const configPath = join(root, "agent", "models.json");

before(async () => {
    app = await openApp(scriptedModel());
});
after(async () => {
    await app?.close();
    cleanUp();
});

function config(ids: string[]) {
    writeFileSync(
        configPath,
        JSON.stringify({
            providers: {
                local: {
                    baseUrl: "http://127.0.0.1:1/v1",
                    api: "openai-completions",
                    apiKey: "none",
                    models: ids.map((id) => ({ id, name: id })),
                },
            },
        }),
    );
}

test("models.json edits stay stale until refresh; additions, removals and invalid files are reported", async () => {
    config(["first"]);
    assert.equal(app.models.getModel("local", "first"), undefined);
    const first = await app.providers.modelRefresh.refresh();

    assert.equal(first.added, 1);
    assert.ok(app.models.getAvailableSnapshot().some((model) => model.id === "first"));
    config(["second", "third"]);
    assert.ok(app.models.getModel("local", "first"));
    const second = await app.providers.modelRefresh.refresh();

    assert.equal(second.added, 2);
    assert.equal(second.removed, 1);
    writeFileSync(configPath, "{ not valid");
    const invalid = await app.providers.modelRefresh.refresh();

    assert.equal(invalid.errors[0]?.provider, "models.json");
    assert.equal(invalid.added, 0);
    assert.ok(app.models.getModel("local", "second"));
    rmSync(configPath);
    const removed = await app.providers.modelRefresh.refresh();

    assert.equal(removed.removed, 2);
});

test("a sign-in changed by Pi is reloaded without a server restart", async () => {
    writeFileSync(
        configPath,
        JSON.stringify({
            providers: {
                external: {
                    baseUrl: "http://127.0.0.1:1/v1",
                    api: "openai-completions",
                    models: [{ id: "external-model" }],
                },
            },
        }),
    );
    await app.providers.modelRefresh.refresh();
    assert.equal(app.models.hasConfiguredAuth("external"), false);
    const authPath = join(root, "agent", "auth.json");

    writeFileSync(authPath, JSON.stringify({ external: { type: "api_key", key: "test-only" } }));
    assert.equal(app.models.hasConfiguredAuth("external"), false);
    const signedIn = await app.providers.modelRefresh.refresh();

    assert.equal(signedIn.added, 1);
    assert.ok(app.models.getAvailableSnapshot().some((model) => model.provider === "external"));
    writeFileSync(authPath, "{}");
    const signedOut = await app.providers.modelRefresh.refresh();

    assert.equal(signedOut.removed, 1);
    rmSync(configPath);
    await app.providers.modelRefresh.refresh();
});

test("slow and failing providers keep their models while a healthy provider and sessions work", async () => {
    const base = app.models.getProvider("faux")!;
    const template = base.getModels()[0]!;
    let fail = true;
    let slowPublished = false;
    let healthyRequests = 0;
    const catalog = (id: string, refreshModels: Provider["refreshModels"]): Provider => ({
        ...base,
        id,
        name: id,
        auth: base.auth,
        getModels: () => [{ ...template, provider: id, id: "old" }],
        refreshModels,
    });
    const healthy = catalog("healthy", async (context) => {
        if (context.allowNetwork) {
            assert.equal(context.force, true);
            healthyRequests++;
            await context.publish({
                update: () => {
                    healthy.getModels = () =>
                        ["old", "new"].map((id) => ({ ...template, provider: "healthy", id }));
                },
            });
        }
    });
    const slow = catalog("slow", async (context) => {
        if (context.allowNetwork) {
            // A provider that ignores cancellation still cannot publish after the refresh ends.
            await new Promise((resolve) => setTimeout(resolve, 700));
            slowPublished = await context.publish({
                update: () => {
                    slow.getModels = () => [];
                },
            });
        }
    });
    const broken = catalog("broken", async (context) => {
        if (context.allowNetwork && fail) {
            throw new Error("secret API key must not reach the browser");
        }
    });

    for (const provider of [healthy, slow, broken]) {
        app.models.registerNativeProvider(provider);
    }

    await until(async () => {
        await app.models.getAvailable();

        return ["healthy", "slow", "broken"].every((id) =>
            app.models.getAvailableSnapshot().some((model) => model.provider === id),
        );
    }, "registered providers available");
    const refresh = new ModelRefresh(app, 400);
    const pending = refresh.refresh();

    assert.equal(refresh.refresh(), pending, "concurrent tabs share one refresh");
    await until(
        () =>
            app.models
                .getAvailableSnapshot()
                .some((model) => model.provider === "healthy" && model.id === "new"),
        "healthy models published before slow provider ends",
    );
    const session = await newSession(app);

    await say(app, session, "A session works during refresh");
    const result = await pending;

    assert.equal(result.added, 1);
    assert.deepEqual(result.errors.map((error) => error.provider).sort(), ["broken", "slow"]);
    assert.doesNotMatch(JSON.stringify(result), /secret API/);
    assert.equal(healthyRequests, 1);
    assert.ok(app.models.getModel("slow", "old"));
    assert.ok(app.models.getModel("broken", "old"));
    assert.deepEqual((await app.agentState(session))?.model, {
        provider: "faux",
        modelId: "faux-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(slowPublished, false);
    assert.ok(app.models.getModel("slow", "old"));
    fail = false;
    app.models.unregisterProvider("slow");
    const retried = await refresh.refresh();

    assert.deepEqual(retried.errors, []);

    for (const id of ["healthy", "broken"]) {
        app.models.unregisterProvider(id);
    }
});

test("corrupt sign-ins produce one safe error, and a later retry works", async () => {
    const authPath = join(root, "agent", "auth.json");

    writeFileSync(authPath, "{ broken");
    const failed = await app.providers.modelRefresh.refresh();

    assert.deepEqual(failed.errors, [
        {
            provider: "Sign-ins",
            message: "Could not read sign-ins. Check auth.json and try again.",
        },
    ]);
    writeFileSync(authPath, "{}");
    assert.deepEqual((await app.providers.modelRefresh.refresh()).errors, []);
});

test("a concurrent registration retries once, then reports repeated interruption", async () => {
    const base = app.models.getProvider("faux")!;
    let requests = 0;
    let changes = 1;
    const provider: Provider = {
        ...base,
        id: "changing",
        name: "Changing",
        getModels: () => [{ ...base.getModels()[0]!, provider: "changing" }],
        refreshModels: async (context) => {
            if (context.allowNetwork) {
                requests++;

                if (changes-- > 0) {
                    app.models.registerNativeProvider(provider);
                }
            }
        },
    };

    app.models.registerNativeProvider(provider);
    await until(async () => {
        await app.models.getAvailable();

        return app.models.hasConfiguredAuth("changing");
    }, "changing configured");
    const retried = await app.providers.modelRefresh.refresh();

    assert.equal(requests, 2);
    assert.deepEqual(retried.errors, []);
    requests = 0;
    changes = 2;
    const interrupted = await app.providers.modelRefresh.refresh();

    assert.equal(requests, 2);
    assert.deepEqual(interrupted.errors, [
        { provider: "changing", message: "Refresh was interrupted. Try again." },
    ]);
    app.models.unregisterProvider("changing");
    await app.models.getAvailable();
});

test("shutdown starts no more work or broadcasts, and offline refresh is explicit", async () => {
    const refresh = new ModelRefresh(app, 1_000);
    let updates = 0;
    const changed = app.providers.modelsChanged;

    app.providers.modelsChanged = () => {
        updates++;
    };

    const pending = refresh.refresh();

    refresh.close();
    await pending;
    await refresh.refresh();
    assert.equal(updates, 0);
    app.providers.modelsChanged = changed;
    process.env.PI_OFFLINE = "1";

    try {
        const result = await app.providers.modelRefresh.refresh();

        assert.equal(result.offline, true);
        assert.deepEqual(result.errors, []);
    } finally {
        delete process.env.PI_OFFLINE;
    }
});

test("an externally fixed sign-in clears an old needs-sign-in mark", async () => {
    const base = app.models.getProvider("faux")!;
    const authPath = join(root, "agent", "auth.json");
    const provider: Provider = {
        ...base,
        id: "expired",
        name: "Expired",
        getModels: () => [{ ...base.getModels()[0]!, provider: "expired" }],
        auth: {
            apiKey: base.auth.apiKey,
            oauth: {
                name: "Expired",
                login: async () => {
                    throw new Error("Not used");
                },
                refresh: async () => {
                    throw new Error("invalid_grant");
                },
                toAuth: async (credential) => ({ apiKey: credential.access }),
            },
        },
    };

    writeFileSync(
        authPath,
        JSON.stringify({ expired: { type: "oauth", access: "old", refresh: "old", expires: 0 } }),
    );
    app.models.registerNativeProvider(provider);
    await until(async () => {
        await app.models.getAvailable();

        return app.models.isUsingOAuth("expired");
    }, "expired configured");
    await app.providers.check("expired");
    assert.ok(app.providers.needsSignIn("expired"));
    writeFileSync(
        authPath,
        JSON.stringify({ expired: { type: "api_key", key: "fixed-test-key" } }),
    );
    await app.providers.modelRefresh.refresh();
    assert.equal(app.providers.needsSignIn("expired"), undefined);
    app.models.unregisterProvider("expired");
    writeFileSync(authPath, "{}");
    await app.providers.modelRefresh.refresh();
});

test("the refresh endpoint requires an owner and the CSRF header", async () => {
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/models/refresh`;
    const guest = app.config.addUser("Guest", "guest");
    const post = (token: string, csrf = true) =>
        fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, ...(csrf ? { "X-Pocket": "1" } : {}) },
        });

    try {
        assert.equal((await post(guest.token)).status, 403);
        assert.equal((await post(app.config.ownerToken, false)).status, 403);
        const response = await post(app.config.ownerToken);

        assert.equal(response.status, 200);
        assert.equal((await response.json()).added, 0);
        assert.equal((await app.hello(owner(app))).server.refreshModels, true);
        assert.equal((await app.hello(guest.user)).server.refreshModels, false);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
