import { type App, cleanUp, fakeTab, home, owner, root, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const { PocketApp } = await import("../src/server/app.ts");
const faux = fauxProvider({
    models: [
        { id: "plain" },
        { id: "thinker", reasoning: true },
        { id: "thinker-two", reasoning: true },
        { id: "colon:exacto" },
    ],
});
const core = fauxProvider({ provider: "scope-other", models: [{ id: "plain" }] });
let refuse = false;
const other: Provider = {
    ...core.provider,
    auth: {
        oauth: {
            name: "Scope other",
            login: async () => {
                throw new Error("No interactive sign-in in this test");
            },
            refresh: async (credential: OAuthCredential) => {
                if (refuse) {
                    throw new Error("token refresh failed (400): invalid_grant");
                }

                return { ...credential, access: "fresh", expires: Date.now() + 3_600_000 };
            },
            toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
        },
    },
};
const startupPatterns = ["faux/think*:high", "faux/thinker", "faux/colon:exacto"];
let app: App;

type Choices = Awaited<ReturnType<App["modelList"]>>;

before(async () => {
    const settings = SettingsManager.create(work);

    settings.setEnabledModels(startupPatterns);
    await settings.flush();
    writeFileSync(
        join(root, "agent", "auth.json"),
        JSON.stringify({
            "scope-other": { type: "oauth", access: "old", refresh: "stale", expires: 0 },
        }),
    );
    app = await PocketApp.open({
        dataDir: join(root, "scope-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => {
            models.registerNativeProvider(faux.provider);
            models.registerNativeProvider(other);
        },
    });
});

after(async () => {
    await app?.settings.flush();
    await app?.close();
    cleanUp();
});

const keys = (models: Choices) => models.map((model) => `${model.provider}/${model.id}`).sort();
const scopedKeys = (models: Choices) => keys(models.filter((model) => model.scoped));
const allKeys = [
    "faux/colon:exacto",
    "faux/plain",
    "faux/thinker",
    "faux/thinker-two",
    "scope-other/plain",
];

test("startup reads enabledModels from Pi settings; hello keeps all models and only marks scope", async () => {
    const persisted = JSON.parse(readFileSync(join(root, "agent", "settings.json"), "utf8")) as {
        enabledModels: string[];
    };
    const choices = await app.modelList();

    assert.deepEqual(persisted.enabledModels, startupPatterns);
    assert.deepEqual(app.settings.getEnabledModels(), startupPatterns);
    assert.deepEqual(keys(choices), allKeys);
    assert.deepEqual(scopedKeys(choices), [
        "faux/colon:exacto",
        "faux/thinker",
        "faux/thinker-two",
    ]);
    assert.equal(new Set(keys(choices)).size, choices.length);
    assert.deepEqual((await app.hello(owner(app))).models, choices);
    assert.ok(choices.every((model) => model.scoped === true || !Object.hasOwn(model, "scoped")));
    assert.ok(choices.every((model) => !Object.hasOwn(model, "thinkingLevel")));
});

test("SDK patterns handle provider-qualified globs, bare globs, thinking suffixes and duplicates", async () => {
    const cases: { patterns: string[]; expected: string[] }[] = [
        { patterns: ["faux/*"], expected: allKeys.filter((key) => key.startsWith("faux/")) },
        { patterns: ["*think*"], expected: ["faux/thinker", "faux/thinker-two"] },
        { patterns: ["scope-other/plain"], expected: ["scope-other/plain"] },
        {
            patterns: ["faux/thinker:high", "faux/thinker", "faux/thinker:low"],
            expected: ["faux/thinker"],
        },
        { patterns: ["faux/colon:exacto"], expected: ["faux/colon:exacto"] },
        { patterns: ["missing-provider/*", "faux/not-a-real-model"], expected: [] },
        { patterns: [], expected: [] },
    ];

    for (const { patterns, expected } of cases) {
        app.settings.setEnabledModels(patterns);
        const choices = await app.modelList();

        assert.deepEqual(keys(choices), allKeys, JSON.stringify(patterns));
        assert.deepEqual(scopedKeys(choices), expected, JSON.stringify(patterns));
        assert.equal(new Set(keys(choices)).size, choices.length);
    }

    app.settings.setEnabledModels(undefined);
    assert.deepEqual(scopedKeys(await app.modelList()), []);
    assert.deepEqual(keys((await app.hello(owner(app))).models), allKeys);
});

test("scope is picker metadata, not a session/default model or thinking-level override", async () => {
    const chosen = { provider: "faux", modelId: "plain", thinkingLevel: "off" };

    await app.setDefaultModel(owner(app), chosen);
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "thinker" },
        thinkingLevel: "low",
    });
    app.settings.setEnabledModels(["faux/thinker:high"]);
    await app.modelList();
    await app.hello(owner(app));
    assert.deepEqual(app.config.defaultModel, chosen);
    assert.deepEqual((await app.agentState(id))?.model, { provider: "faux", modelId: "thinker" });
    assert.equal((await app.agentState(id))?.thinkingLevel, "low");
    const next = await app.commands.createSession(owner(app), { cwd: work });

    assert.deepEqual((await app.agentState(next.id))?.model, {
        provider: "faux",
        modelId: "plain",
    });
    assert.equal((await app.agentState(next.id))?.thinkingLevel, "off");
});

test("provider updates keep scope and signIn together, then clear only signIn after renewal", async () => {
    app.settings.setEnabledModels(["scope-other/*", "faux/thinker:high"]);
    writeFileSync(
        join(root, "agent", "auth.json"),
        JSON.stringify({
            "scope-other": { type: "oauth", access: "old", refresh: "stale", expires: 0 },
        }),
    );
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);

    try {
        refuse = true;
        await app.providers.check("scope-other");
        await until(() => tab.last("models") !== undefined, "models event on refused renewal");
        const marked = tab.last("models") as unknown as Choices;

        assert.deepEqual(keys(marked), allKeys);
        assert.deepEqual(scopedKeys(marked), ["faux/thinker", "scope-other/plain"]);
        assert.equal(marked.find((model) => model.provider === "scope-other")?.signIn, true);
        assert.equal(marked.find((model) => model.provider === "faux")?.signIn, undefined);
        assert.deepEqual((await app.hello(owner(app))).models, marked);
        tab.events.length = 0;
        refuse = false;
        await app.providers.check("scope-other");
        await until(() => tab.last("models") !== undefined, "models event on renewed sign-in");
        const renewed = tab.last("models") as unknown as Choices;

        assert.deepEqual(scopedKeys(renewed), scopedKeys(marked));
        assert.ok(renewed.every((model) => model.signIn === undefined));
        assert.deepEqual(keys(renewed), allKeys);
    } finally {
        app.detach(tab.client);
    }
});
