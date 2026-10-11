// Models are a person's to choose. A subagent runs on its session's model: with no models allowed (the default), Pi is
// offered no model and one it names is refused; the owner may allow others, and Pi may use only those. A subagent on a
// model no longer allowed gets no more work. A subagent its model failed is reported as such, with the model, and Pi is
// told to stop and tell the user rather than try another model; the people in the session are told too.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    openApp,
    owner,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import { MODEL_FAILED } from "../src/server/extensions/subagents.ts";

/** The subagent tool's parameters as the parent's last request offered them. */
let offered: Record<string, unknown> | undefined;
/** Subagents whose model fails, as a provider whose sign-in expired would. */
const failing = new Set<string>();
/** Subagents whose request fails for a reason of its own, not their model's or provider's. */
const refused = new Set<string>();

/**
 * The parent does as its message says: `spawn <name> [model]` or `send <name>`. Subagents answer, or fail when their
 * name is in `failing`; the parent is done.
 */
const route: FauxResponseStep = (request) => {
    const messages = (request as { messages: { role: string; toolsAdded?: unknown[] }[] }).messages;
    const all = JSON.stringify(messages);
    const { role, text: said } = lastText(request as never);
    // With more than one person on the server, a message starts with who sent it.
    const text = said.replace(/^\[from: [^\]]+\] /, "");
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined && refused.has(subagent)) {
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Bad request" });
    }

    if (subagent !== undefined) {
        return failing.has(subagent)
            ? fauxAssistantMessage([], {
                  stopReason: "error",
                  errorMessage: "OAuth refresh failed for faux",
              })
            : fauxAssistantMessage([fauxText(`result of ${subagent}`)]);
    }

    for (const message of messages) {
        for (const tool of (message.toolsAdded ?? []) as {
            name: string;
            parameters: { properties: Record<string, unknown> };
        }[]) {
            if (tool.name === "subagent") {
                offered = tool.parameters.properties;
            }
        }
    }

    const spawn = /^spawn (\S+)(?: (\S+))?$/.exec(text);
    const send = /^send (\S+)$/.exec(text);

    if (role === "user" && (spawn !== null || send !== null)) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: spawn === null ? "send" : "spawn",
                    name: (spawn ?? send)![1]!,
                    message: "Review it, please.",
                    ...(spawn?.[2] === undefined ? {} : { model: spawn[2] }),
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("done")]);
};

const faux = fauxProvider({ models: [{ id: "mine" }, { id: "pricey" }, { id: "other" }] });

faux.setResponses(Array.from({ length: 200 }, () => route));

let app: App;

before(async () => {
    app = await openApp(faux);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** A session on faux/mine. */
async function session(): Promise<ConversationId> {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "mine" },
        thinkingLevel: "off",
    });

    return id;
}

/** Send the parent `text` and wait for it to be done; what its tool calls answered, and its subagents. */
async function ask(id: ConversationId, text: string) {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await until(() => !app.isBusy(id), "the parent at rest");
    const results = (await (await app.harness.conversation(id, context))!.context(context)).messages
        .filter((message) => message.role === "toolResult")
        .map((message) => JSON.stringify(message));

    return {
        answer: results.at(-1) ?? "",
        agents: (await app.harness.snapshot(SubagentsDoc, id, context))?.agents ?? {},
    };
}

test("with no models allowed, a subagent runs on its session's model, and Pi is offered no other", async () => {
    const id = await session();
    const started = await ask(id, "spawn plain");

    assert.match(started.answer, /Started plain on faux\/mine\./);
    assert.equal(
        (await app.agentState(started.agents.plain!.conversationId))?.model?.modelId,
        "mine",
    );
    assert.ok(offered !== undefined, "the parent was offered the tool");
    assert.equal("model" in offered, false, "no model parameter");

    // One it names anyway is refused, nothing made, and Pi is told to ask the user.
    const refused = await ask(id, "spawn sneaky faux/pricey");

    assert.match(refused.answer, /cannot choose another/);
    assert.match(refused.answer, /ask the user/);
    assert.equal(refused.agents.sneaky, undefined);

    // Its own model, named, is no choice.
    assert.match((await ask(id, "spawn same faux/mine")).answer, /Started same on faux\/mine\./);
});

test("the owner allows models: Pi may use those, and is refused any other with word to ask the user", async () => {
    const me = owner(app);
    const guest = app.config.addUser("Guest", "guest").user;

    await assert.rejects(app.setSubagentModels(guest, ["faux/pricey"]), { status: 403 });
    await assert.rejects(app.setSubagentModels(me, ["faux/nothing"]), { status: 400 });
    await assert.rejects(app.setSubagentModels(me, "faux/pricey"), { status: 400 });
    await app.setSubagentModels(me, ["faux/pricey", "faux/pricey"]);
    assert.deepEqual(app.config.subagentModels, ["faux/pricey"]);
    assert.deepEqual((await app.hello(me)).server.subagentModels, ["faux/pricey"]);
    assert.equal("subagentModels" in (await app.hello(guest)).server, false, "the owner's to see");

    const id = await session();
    const allowed = await ask(id, "spawn reviewer faux/pricey");

    assert.match(allowed.answer, /Started reviewer on faux\/pricey\./);
    assert.ok(offered !== undefined && "model" in offered, "the tool offers a model now");
    assert.equal(
        (await app.agentState(allowed.agents.reviewer!.conversationId))?.model?.modelId,
        "pricey",
    );

    const refused = await ask(id, "spawn wanderer faux/other");

    assert.match(refused.answer, /faux\/other is not one of the models the user allows/);
    assert.match(refused.answer, /Do not pick another model/);
    assert.equal(refused.agents.wanderer, undefined);

    // Allowed no longer: the subagent on it gets no more work.
    await app.setSubagentModels(me, []);
    const after = await ask(id, "send reviewer");

    assert.match(
        after.answer,
        /reviewer runs on faux\/pricey, which is neither this session's model nor one/,
    );
    assert.equal("model" in (offered ?? {}), false, "the tool offers no model again");
});

test("a subagent its model failed is reported with the model, Pi is told to stop and tell the user, and so are people", async () => {
    const id = await session();
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);
    failing.add("expired");

    try {
        await ask(id, "spawn expired");
        await until(
            async () =>
                JSON.stringify(
                    (await (await app.harness.conversation(id, context))!.context(context))
                        .messages,
                ).includes("[subagent expired failed"),
            "the failure's report",
        );
    } finally {
        failing.delete("expired");
        app.detach(tab.client);
    }

    const said = JSON.stringify(
        (await (await app.harness.conversation(id, context))!.context(context)).messages,
    );

    assert.match(said, /\[subagent expired failed: faux\/mine: OAuth refresh failed for faux\]/);
    assert.ok(said.includes(MODEL_FAILED), "Pi is told to stop and tell the user");
    assert.ok(
        tab.events.some(
            (event) =>
                event.event === "notice" &&
                /Subagent expired failed: faux\/mine: OAuth refresh failed for faux\. Pi was told to stop and tell you/.test(
                    String(event.data.message),
                ),
        ),
        "the people in the session are told",
    );
    const agent = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.expired;

    assert.equal(agent?.failed, true);
    assert.match(String(agent?.error), /faux\/mine: OAuth refresh failed/);
});

test("a subagent that failed for a reason not its model's is reported plainly, with no word about models", async () => {
    const id = await session();

    refused.add("plain-fail");

    try {
        await ask(id, "spawn plain-fail");
        await until(
            async () =>
                JSON.stringify(
                    (await (await app.harness.conversation(id, context))!.context(context))
                        .messages,
                ).includes("[subagent plain-fail failed"),
            "the failure's report",
        );
    } finally {
        refused.delete("plain-fail");
    }

    const said = JSON.stringify(
        (await (await app.harness.conversation(id, context))!.context(context)).messages,
    );

    assert.match(said, /\[subagent plain-fail failed: Bad request\]/);
    assert.equal(said.includes(MODEL_FAILED), false);
});

test("the settings route changes the models for subagents, for the owner only, one setting at a time", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const settings = (token: string, body: object) =>
        fetch(`http://127.0.0.1:${port}/api/settings`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "x-pocket": "1",
            },
            body: JSON.stringify(body),
        });

    try {
        const guest = app.config.addUser("Bea", "guest").token;

        assert.equal((await settings(guest, { subagentModels: ["faux/pricey"] })).status, 403);
        assert.deepEqual(app.config.subagentModels, []);
        assert.equal(
            (await settings(app.config.ownerToken, { subagentModels: ["faux/pricey"] })).status,
            200,
        );
        assert.deepEqual(app.config.subagentModels, ["faux/pricey"]);
        assert.equal(
            (
                await settings(app.config.ownerToken, {
                    subagentModels: [],
                    approvalRule: "others",
                })
            ).status,
            400,
        );
        assert.deepEqual(app.config.subagentModels, ["faux/pricey"], "unchanged");
        assert.equal((await settings(app.config.ownerToken, { subagentModels: [] })).status, 200);
        assert.deepEqual(app.config.subagentModels, []);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
