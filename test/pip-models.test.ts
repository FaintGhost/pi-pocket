// PiP is dependable before fast, and never chooses a model. Its prompt says so; it acts on a session only after it
// looked at it lately, and its tools that act on one say how the session stands after; it starts a session on a model,
// or names one in what it sends, only when its person named that model in their own words to it.
import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Api, FauxResponseStep, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { modelsNamed, personNamed, sharePhrase, words } from "../src/server/model-names.ts";

/** PiP's last prompt, as its requests carry it. */
let prompt = "";

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (!all.includes("You are PiP")) {
        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }

    prompt = all;

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }

    const call = /^call (\S+) (.*)$/s.exec(text);

    return call === null
        ? fauxAssistantMessage([fauxText(`pip: ${text}`)])
        : fauxAssistantMessage(
              [fauxToolCall(call[1]!, JSON.parse(call[2]!) as Parameters<typeof fauxToolCall>[1])],
              { stopReason: "toolUse" },
          );
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "pip-models-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** A fresh PiP context for the owner, on the scripted model. */
async function pip(): Promise<ConversationId> {
    const id = await app.pip.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    // What the person said in an earlier test is out of its context.
    await app.commands.reset(id, owner(app), undefined);

    return id;
}

/** What PiP said last. */
async function last(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);
    const answer = entries.findLast((entry) => entry.kind === "assistant");

    return answer?.kind === "assistant"
        ? answer.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

const model = (provider: string, id: string, name = id) =>
    ({ provider, id, name, input: ["text"] }) as unknown as Model<Api>;

test("model names are matched by words, as people write them", () => {
    const codex = model("openai-codex", "gpt-5.1-codex", "GPT-5.1 Codex");
    const opus = model("anthropic", "claude-opus-4-5", "Claude Opus 4.5");
    const routed = model("openrouter", "anthropic/claude-opus-4.5", "Anthropic: Claude Opus 4.5");
    const auto = model("openrouter", "auto", "Auto");
    const kimi = model("opencode-go", "kimi-k3", "Kimi K3");
    const all = [codex, opus, routed, auto, kimi];

    assert.deepEqual(words("GPT5.1-Codex"), ["gpt", "5", "1", "codex"]);
    // PiP's text names a model by its id, its name, or its provider and id; never by one plain word.
    assert.deepEqual(modelsNamed("Review it with gpt-5.1-codex, please", all), [codex]);
    assert.deepEqual(modelsNamed("turn on auto mode", all), []);
    assert.deepEqual(modelsNamed("spawn a reviewer on Kimi K3", all), [kimi]);
    assert.deepEqual(modelsNamed("use opus 4.5", all), [], "strictly, it must be spelled out");
    assert.deepEqual(modelsNamed("use opus 4.5", all, true), [opus], "as people say it");
    // A person may say it as people do.
    assert.equal(personNamed("use opus 4.5 for the review", opus, all), true);
    assert.equal(personNamed("use kimi for the review", kimi, all), false);
    assert.equal(personNamed("try GPT 5.1 codex", codex, all), true);
    // The same words at two providers: which one pays is theirs to say.
    assert.equal(personNamed("use claude opus 4.5", opus, all), false);
    assert.equal(personNamed("use claude opus 4.5", routed, all), false);
    assert.equal(personNamed("use claude opus 4.5 on anthropic", opus, all), true);
    const names = (provider: string) => (provider === "openrouter" ? "OpenRouter" : provider);

    assert.equal(personNamed("use claude opus 4.5 through OpenRouter", routed, all, names), true);
    assert.equal(personNamed("use claude opus 4.5 through OpenRouter", opus, all, names), false);
    // A word of the provider's that the others lack is enough, and one they share is not.
    const copilot = model("github-copilot", "claude-opus-4.5", "Claude Opus 4.5");
    const both = [opus, copilot];

    assert.equal(personNamed("opus 4.5 on copilot", copilot, both), true);
    assert.equal(personNamed("opus 4.5 on copilot", opus, both), false);
    assert.equal(personNamed("opus 4.5", opus, both), false);
    // The same words at two providers name both: PiP passing them on picks no provider.
    assert.equal(sharePhrase("Review it on claude-opus-4-5.", copilot, opus), true);
    assert.equal(sharePhrase("Review it on claude-opus-4-5.", kimi, opus), false);
});

test("PiP's prompt puts checking before acting, and never picking a model", async () => {
    const id = await pip();

    await say(app, id, "hello");
    assert.match(prompt, /be dependable before fast/);
    assert.match(prompt, /Check before you act/);
    assert.match(prompt, /Never send one message to several sessions without checking each/);
    assert.match(prompt, /Say only what your tools showed you just now/);
    assert.match(prompt, /run the checks and tests/);
    assert.match(prompt, /Never choose a model/);
    assert.doesNotMatch(prompt, /just do it/);
});

test("PiP acts on a session only after it looked at it, and sees how it stands after", async () => {
    const id = await pip();
    const session = Number(await newSession(app));

    await assert.rejects(
        app.pip.send(id, session, "run the tests", false, "unread-1"),
        /Check \/s\/\d+ first with session_read/,
    );
    await assert.rejects(app.pip.stop(id, session), /Check \/s\/\d+ first/);
    await assert.rejects(app.pip.archive(id, session, true), /Check \/s\/\d+ first/);
    await assert.rejects(
        app.pip.schedule(id, session, "tomorrow 9:00", "check CI", "unread-2"),
        /Check \/s\/\d+ first/,
    );

    // Once it read it, it may; its tool says how the session stands now.
    await say(app, id, `call session_read ${JSON.stringify({ session, entries: 4 })}`);
    await say(
        app,
        id,
        `call session_send ${JSON.stringify({ session, message: "run the tests", report: false })}`,
    );
    assert.match(
        await last(id),
        /done: Sent to \/s\/\d+\.\n\/s\/\d+ now: (working|about to start|idle)(, 1 message waiting)?, last active/,
    );
    await until(() => !app.isBusy(session as unknown as ConversationId), "the session at rest");

    // A session it started is one it knows.
    const started = await app.pip.start(id, {});

    await app.pip.send(id, Number(started), "first task", false, "started-1");

    // Following a session's own run is acting too: a report starts a run of PiP's.
    const busy = Number(await newSession(app));

    await app.commands.submit(busy as unknown as ConversationId, owner(app), {
        text: "work a while",
        requestId: "busy-1",
    });
    await until(() => app.isBusy(busy as unknown as ConversationId), "the session at work");
    await assert.rejects(app.pip.follow(id, busy, undefined, "follow-1"), /Check \/s\/\d+ first/);
    await until(() => !app.isBusy(busy as unknown as ConversationId), "the session at rest");
});

test("PiP starts a session on a model only when its person named it, in their own words", async () => {
    const id = await pip();
    const before = app.sessions().length;

    await assert.rejects(
        app.pip.start(id, { model: "faux/faux-2" }),
        /Your person did not name faux\/faux-2\. Models are theirs to choose/,
    );
    assert.equal(app.sessions().length, before, "no session made");

    // A webhook's post naming it is not its person's word.
    await app.commands.submit(
        id,
        owner(app),
        { text: "start a session on faux-2", requestId: "hook-1" },
        "webhook test",
    );
    await until(() => !app.isBusy(id), "PiP at rest");
    await assert.rejects(app.pip.start(id, { model: "faux/faux-2" }), /did not name/);

    await say(app, id, "start a session on faux 2 for the review");
    const made = await app.pip.start(id, { model: "faux/faux-2" });

    assert.equal((await app.agentState(made))?.model?.modelId, "faux-2");
    await assert.rejects(
        app.pip.start(id, { model: "faux/nothing" }),
        /not a model signed in here/,
    );
});

test("PiP's messages name no model its person did not name", async () => {
    const id = await pip();
    const session = Number(await newSession(app));

    await app.pip.read(id, session);
    // What its person said before this context (the test before) is out of it.
    await assert.rejects(app.pip.start(id, { model: "faux/faux-2" }), /did not name/);
    await say(app, id, "have it reviewed on faux 2");
    await assert.rejects(
        app.pip.send(id, session, "Spawn a reviewer subagent on faux-vision.", false, "named-1"),
        /names faux\/faux-vision, which your person did not name/,
    );
    await assert.rejects(
        app.pip.start(id, { message: "Review it with faux-vision." }),
        /names faux\/faux-vision/,
    );
    // Nor in a schedule, or a watch's instructions.
    await assert.rejects(
        app.pip.schedule(
            id,
            session,
            "tomorrow 9:00",
            "Rerun the review on faux-vision.",
            "named-3",
        ),
        /names faux\/faux-vision/,
    );
    await assert.rejects(
        app.pip.addRepoWatch(
            id,
            {
                repo: "acme/api",
                events: ["ci"],
                instructions: "Fix it in a session, with a faux-vision reviewer.",
            },
            "named-4",
        ),
        /names faux\/faux-vision/,
    );
    // The one they named may be passed on.
    await app.pip.send(id, session, "Spawn a reviewer subagent on faux-2.", false, "named-2");
    await until(() => !app.isBusy(session as unknown as ConversationId), "the session at rest");
});

test("a webhook's standing instructions to PiP are its person's words; what was posted is not", async () => {
    const id = await pip();

    await app.hooks.add(owner(app), id, {
        name: "deploys",
        instructions: "When a deploy fails, start a session on faux-vision to find out why.",
    });
    const made = await app.pip.start(id, { model: "faux/faux-vision" });

    assert.equal((await app.agentState(made))?.model?.modelId, "faux-vision");
    // A post's words name nothing for them.
    await app.commands.submit(
        id,
        owner(app),
        { text: "deploy failed; use faux-2 to look", requestId: "post-1" },
        "webhook deploys",
    );
    await until(() => !app.isBusy(id), "PiP at rest");
    await assert.rejects(app.pip.start(id, { model: "faux/faux-2" }), /did not name/);
});
