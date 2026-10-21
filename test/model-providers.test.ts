// Extension modules' model providers: registered with Pi's runtime, and taken out only by the version that put them in.
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
const file = "dropin-models.ts";

/** A drop-in that registers one provider with one model, and takes it out again with its module. */
const module = (model: string) => `/** Drop-in models: one provider for the model providers test. */
export default (host, web) => {
    const stop = host.registerModelProvider("dropin", {
        name: "Drop-in",
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "test-only",
        models: [
            {
                id: "${model}",
                name: "${model}",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8000,
                maxTokens: 1000,
            },
        ],
    });

    web.onDispose(stop);
};
`;

let app: App;

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, file), module("one"));
    app = await openApp(scriptedModel(), dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a module's provider serves Pi's model runtime, a reload keeps it, and turning the module off takes it out", async () => {
    assert.equal(app.models.getProvider("dropin"), undefined, "off until the owner turns it on");

    await app.setExtensionEnabled(owner(app), file, true);
    assert.ok(app.models.getModel("dropin", "one"), "the provider's model is in Pi's runtime");

    // A new version starts before the old one's cleanups run: the old cleanup must leave the new provider in place.
    writeFileSync(join(dropIns, file), module("two"));
    await app.loader.apply(file);
    assert.ok(
        app.models.getModel("dropin", "two"),
        "the reloaded module's model replaced the old one",
    );
    assert.equal(app.models.getModel("dropin", "one"), undefined);

    await app.setExtensionEnabled(owner(app), file, false);
    assert.equal(app.models.getProvider("dropin"), undefined, "the module's provider went with it");
    await newSession(app);
});
