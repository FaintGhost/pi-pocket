import { cleanUp, fakeTab, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";

const app = await PocketApp.open({
    dataDir: join(root, "scope-data"),
    defaultCwd: work,
    supervised: false,
    log: () => {},
    configureModels: (models) => models.registerNativeProvider(scriptedModel().provider),
});

type Choices = Awaited<ReturnType<typeof app.modelList>>;
const scopedIds = (models: Choices) =>
    models.filter((model) => model.scoped).map((model) => model.id);

after(async () => {
    await app.close();
    cleanUp();
});

test("scope is optional picker metadata and uses Pi patterns without applying thinking", async () => {
    app.settings.setEnabledModels(["faux/*2:high", "faux/faux-2"]);
    const choices = (await app.hello(owner(app))).models;

    assert.deepEqual(scopedIds(choices), ["faux-2"]);
    assert.equal(choices.length, 3);
    assert.ok(choices.every((model) => !Object.hasOwn(model, "thinkingLevel")));
    assert.equal(app.config.defaultModel, undefined);
    app.settings.setEnabledModels(undefined);
    assert.deepEqual(scopedIds(await app.modelList()), []);
    app.settings.setEnabledModels(["missing/*"]);
    assert.deepEqual(scopedIds(await app.modelList()), []);
});

test("manual refresh rereads scope and malformed settings do not break model payloads", async () => {
    await app.settings.flush();
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);

    try {
        writeFileSync(
            join(root, "agent", "settings.json"),
            JSON.stringify({ enabledModels: ["faux/faux-2:high"] }),
        );
        await app.providers.modelRefresh.refresh();
        await until(() => tab.last("models") !== undefined, "refreshed models event");
        assert.deepEqual(scopedIds(tab.last("models") as unknown as Choices), ["faux-2"]);
        writeFileSync(
            join(root, "agent", "settings.json"),
            JSON.stringify({ enabledModels: [null, 7] }),
        );
        await app.settings.reload();
        assert.deepEqual(scopedIds((await app.hello(owner(app))).models), []);
        writeFileSync(
            join(root, "agent", "settings.json"),
            JSON.stringify({ enabledModels: "not-an-array" }),
        );
        await app.settings.reload();
        assert.deepEqual(scopedIds(await app.modelList()), []);
    } finally {
        app.detach(tab.client);
    }
});
