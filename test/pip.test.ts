// PiP, the owner's assistant: made once and kept out of the session list; its own tools, and none that change files;
// sessions started and messaged as its person, with reports when their runs end, across a restart too; denials but no
// approvals; and a tab's panel, which watches PiP beside the session the tab shows.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { AuthorsDoc, FollowsDoc } from "../src/server/docs.ts";
import { PIP_EXTENSION } from "../src/server/pip.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const route: FauxResponseStep = (request) => {
    // PiP's requests carry its prompt; the prompt and the tools come as the transcript's system messages.
    const isPip = JSON.stringify((request as { messages: unknown[] }).messages).includes(
        "You are PiP",
    );
    const { role, text: written } = lastText(request as never);
    // With more than one person on the server, a message starts with who sent it.
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    // A session's Pi: a "sleepy" task sleeps first, so a restart can come while it works.
    if (!isPip) {
        if (role === "user" && text.includes("sleepy")) {
            return tool("bash", { command: "sleep 1.5" });
        }

        return fauxAssistantMessage([
            fauxText(role === "toolResult" ? "woke up" : `echo: ${text}`),
        ]);
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }

    if (text.startsWith("[report]")) {
        return fauxAssistantMessage([fauxText(`noted ${text}`)]);
    }

    const [verb = "", first = "", ...rest] = text.split(" ");

    switch (verb) {
        case "start":
            return tool("session_start", { message: [first, ...rest].join(" "), folder: work });
        case "send":
            return tool("session_send", { session: Number(first), message: rest.join(" ") });
        case "list":
            return tool("sessions", {});
        case "read":
            return tool("session_read", { session: Number(first) });
        case "approvals":
            return tool("approvals", { action: "list" });
        case "deny":
            return tool("approvals", { action: "deny", id: first });
        default:
            return fauxAssistantMessage([fauxText(`pip: ${text}`)]);
    }
};

const model = scriptedModel(route);
const dataDir = join(root, "pip-data");
let app: App;

before(async () => {
    app = await openApp(model, dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** The owner's PiP, with the scripted model. */
async function pip(): Promise<ConversationId> {
    const id = await app.pip.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

/** The texts of a conversation's user messages and Pi's answers, oldest first. */
async function said(id: ConversationId): Promise<string[]> {
    const entries = await app.transcripts.allEntries(id, true);

    return entries.flatMap((entry) =>
        entry.kind === "user"
            ? [`> ${entry.text}`]
            : entry.kind === "assistant"
              ? entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
              : [],
    );
}

test("PiP is made once, for the owner, and stays out of the session list", async () => {
    const [first, second] = await Promise.all([
        app.pip.ensure(owner(app)),
        app.pip.ensure(owner(app)),
    ]);

    assert.equal(first, second);
    assert.equal(await app.pip.ensure(owner(app)), first);
    assert.equal(app.pip.idOf(owner(app).id), first);
    assert.equal(app.sessionMeta(first)?.pip, owner(app).id);
    assert.ok(!app.sessions().some((session) => session.id === Number(first)));
    assert.deepEqual(app.pip.state(owner(app)), { id: Number(first), busy: false });
    await assert.rejects(
        app.commands.fork(first, owner(app), { entryId: 1 }),
        /PiP's conversation cannot be forked/,
    );

    const guest = app.config.addUser("Guest", "guest").user;

    await assert.rejects(app.pip.ensure(guest), /owner/);
    assert.equal(app.pip.state(guest), null);
    assert.equal((await app.hello(owner(app))).server.pip, true);
    assert.equal((await app.hello(guest)).server.pip, false);
});

test("only PiP has PiP's tools, and PiP has none that change files or run commands", async () => {
    const id = await pip();
    const session = await newSession(app);
    const names = async (conversation: ConversationId) =>
        (await (await app.conversation(conversation)).agent(context)).tools.map(
            (each) => each.name,
        );
    const pipTools = await names(id);
    const sessionTools = await names(session);

    for (const name of ["sessions", "session_start", "session_send", "approvals", "read"]) {
        assert.ok(pipTools.includes(name), `PiP has ${name}`);
    }

    for (const name of ["bash", "write", "edit", "browser", "subagent"]) {
        assert.ok(!pipTools.includes(name), `PiP has no ${name}`);
    }

    assert.ok(sessionTools.includes("bash"));
    assert.ok(!sessionTools.includes("sessions"), "a session has no PiP tools");
    assert.ok(
        !(await (await app.conversation(session)).agent(context)).extensions.some(
            (extension) => extension.name === PIP_EXTENSION,
        ),
    );
});

test("PiP starts a session for its person, and hears back when Pi there answers", async () => {
    const id = await pip();
    const before = new Set(app.sessions().map((session) => session.id));

    await say(app, id, "start fix the flaky test");
    const started = app.sessions().find((session) => !before.has(session.id));

    assert.ok(started, "a new session");
    assert.equal(started.title, "fix the flaky test");
    assert.equal(started.cwd, work);
    await until(
        async () => (await said(id)).some((line) => line.startsWith("noted [report]")),
        "PiP's report",
    );
    const lines = await said(id);

    assert.match(lines.join("\n"), /done: Started session \/s\/\d+ and sent the message/);
    assert.match(
        lines.join("\n"),
        /noted \[report\] “fix the flaky test” \(\/s\/\d+\) answered your message:\n<session-output>\necho: \[via PiP\] fix the flaky test\n<\/session-output>/,
    );

    // The session's message is marked as sent through PiP, and is the owner's work but not their own words.
    const sessionLines = await said(started.id as unknown as ConversationId);

    assert.equal(sessionLines[0], "> [via PiP] fix the flaky test");
    assert.equal(
        app.attribution.requesterOf(started.id as unknown as ConversationId),
        owner(app).id,
    );
    const authors = await app.harness.snapshot(
        AuthorsDoc,
        started.id as unknown as ConversationId,
        context,
    );

    assert.deepEqual(Object.values(authors?.entries ?? {}), [], "nobody wrote it themselves");
});

test("PiP lists and reads sessions as its person sees them", async () => {
    const id = await pip();
    const session = await newSession(app);

    await say(app, session, "hello there");
    await app.commands.updateSession(session, owner(app), { title: "Greeting" });
    await say(app, id, "list");
    let lines = (await said(id)).join("\n");

    assert.match(lines, new RegExp(`#${String(session)} Greeting · idle · `));
    assert.doesNotMatch(lines, new RegExp(`#${String(id)} PiP`), "PiP does not list itself");

    await say(app, id, `read ${String(session)}`);
    lines = (await said(id)).join("\n");
    assert.match(lines, /“Greeting” · idle/);
    assert.match(lines, /Pi: echo: hello there/);

    await say(app, id, `read ${String(id)}`);
    assert.match((await said(id)).join("\n"), /That is your own conversation/);
});

test("PiP denies a waiting call, as its person through PiP, and cannot allow one", async () => {
    const id = await pip();
    const session = await newSession(app);
    const answer = app.approvals.request(
        {
            id: "call-1",
            conversationId: session,
            taskId: 1 as unknown as TaskId,
            tool: "bash",
            subject: "rm -rf build",
            reason: "deletes files",
            createdAt: Date.now(),
        },
        context,
    );

    await say(app, id, "approvals");
    assert.match(
        (await said(id)).join("\n"),
        /call-1 · \[New session\]\(\/s\/\d+\) · bash: rm -rf build/,
    );
    await say(app, id, "deny call-1");
    assert.deepEqual(await answer, { allow: false, by: `${owner(app).name} via PiP` });

    const approvals = (await (await app.conversation(id)).agent(context)).tools.find(
        (each) => each.name === "approvals",
    );

    assert.doesNotMatch(JSON.stringify(approvals?.parameters), /allow/);
});

test("a tab's PiP panel gets PiP's view beside its session, and counts as looking at PiP", async () => {
    const id = await pip();
    const session = await newSession(app);
    const tab = fakeTab(session, owner(app));

    await app.attach(tab.client);
    await until(() => tab.last("pip") !== undefined, "the PiP state");
    assert.equal((tab.last("pip") as { id: number }).id, Number(id));
    assert.ok(
        !(tab.last("sessions") as unknown as { id: number }[]).some(
            (each) => each.id === Number(id),
        ),
    );

    await app.setPip(owner(app), tab.client.connection, true);
    await until(
        () =>
            tab.events.some(
                (each) =>
                    each.event === "pipview" &&
                    (each.data.conversation as { id: number }).id === Number(id),
            ),
        "PiP's view",
    );
    assert.ok(app.watching(owner(app).id, id));
    assert.ok(app.watching(owner(app).id, session), "the tab still shows its session");

    await app.commands.submit(id, owner(app), { text: "hi", requestId: "panel-1" });
    await until(
        () =>
            tab.events.some(
                (each) =>
                    each.event === "pipview" &&
                    (each.data.entries as { kind: string; blocks?: { text?: string }[] }[]).some(
                        (entry) =>
                            entry.kind === "assistant" && entry.blocks?.[0]?.text === "pip: hi",
                    ),
            ),
        "PiP's answer in the panel",
    );

    await app.setPip(owner(app), tab.client.connection, false);
    assert.ok(!app.watching(owner(app).id, id));
    app.detach(tab.client);
});

test("a follow outlives a restart: the report comes once the session's run ends", async () => {
    const id = await pip();
    const session = await newSession(app);

    await say(app, id, `send ${String(session)} a sleepy job`);
    assert.match((await said(id)).join("\n"), /done: Sent to \/s\/\d+; a report comes back/);
    await until(() => app.isBusy(session), "the session at work");
    await app.close();
    app = await openApp(model, dataDir);
    await until(
        async () =>
            (await said(id)).some(
                (line) => line.startsWith("> [report]") && line.includes(`/s/${String(session)})`),
            ),
        "the report after the restart",
        20_000,
    );
    const reports = (await said(id)).filter((line) => line.startsWith("> [report]"));

    assert.equal(
        reports.filter((line) => line.includes(`/s/${String(session)}`)).length,
        1,
        "one report",
    );
    assert.match(
        reports.at(-1)!,
        /answered your message:\n<session-output>\nwoke up\n<\/session-output>/,
    );
    assert.equal(app.pip.idOf((owner(app) as User).id), id);
});

test("nobody but its person sees PiP or writes to it: PiP acts as its person", async () => {
    const id = await pip();
    const guest = app.config.addUser("Gus", "guest").user;
    const viewer = app.config.addUser("Vic", "viewer").user;

    assert.ok(app.canSee(owner(app), id));
    assert.ok(!app.canSee(guest, id));
    assert.ok(!app.canSee(viewer, id));
    await assert.rejects(
        app.commands.submit(id, guest, { text: "start rm everything", requestId: "g-1" }),
        /not shared with you/,
    );
    await assert.rejects(app.setPip(guest, "nowhere", true), /owner/);

    const tab = fakeTab(id, guest);

    await app.attach(tab.client);
    assert.equal(tab.last("view"), undefined, "a guest's tab gets no view of PiP");
    assert.ok(tab.last("missing"));
    app.detach(tab.client);
});

test("PiP's messages go once per call, whatever its call ids look like", async () => {
    const id = await pip();
    const session = await newSession(app);
    // OpenAI-style call ids are long; codemode adds "/n" for each call a script makes.
    const call = `pip-7-call_${"x".repeat(70)}|fc_${"y".repeat(20)}`;

    await app.pip.send(id, Number(session), "first", false, `${call}/1`);
    await app.pip.send(id, Number(session), "second", false, `${call}/2`);
    // A replayed call finds what it sent.
    await app.pip.send(id, Number(session), "second", false, `${call}/2`);
    await until(async () => !app.isBusy(session), "the session at rest");
    const sent = (await said(session)).filter((line) => line.startsWith("> "));

    assert.deepEqual(sent, ["> [via PiP] first", "> [via PiP] second"]);
});

test("following an idle session answers at once; an aborted follow leaves PiP's list", async () => {
    const id = await pip();
    const session = await newSession(app);

    await say(app, session, "hello");
    const idle = await app.pip.follow(id, Number(session), undefined, "follow-idle");

    assert.match(idle.now ?? "", /is idle\. Pi's last answer:\n<session-output>\necho: hello/);
    assert.equal(
        (await app.harness.snapshot(FollowsDoc, id, context))?.items["follow-idle"],
        undefined,
        "no follow, so no report",
    );

    await app.commands.submit(session, owner(app), { text: "a sleepy job", requestId: "s-1" });
    await until(() => app.isBusy(session), "the session at work");
    await app.pip.follow(id, Number(session), undefined, "follow-busy");
    const follow = (await app.harness.snapshot(FollowsDoc, id, context))?.items["follow-busy"];

    assert.ok(follow !== undefined && follow.doneAt === undefined);
    await app.harness.abortTask(follow.taskId as unknown as TaskId, context);
    await until(
        async () =>
            (await app.harness.snapshot(FollowsDoc, id, context))?.items["follow-busy"]?.doneAt !==
            undefined,
        "the follow marked done",
    );
    // Made again by a replayed call, it is not followed twice.
    await app.pip.follow(id, Number(session), undefined, "follow-busy");
    assert.equal(
        (await app.harness.snapshot(FollowsDoc, id, context))?.items["follow-busy"]?.taskId,
        follow.taskId,
    );
    await until(() => !app.isBusy(session), "the session at rest", 15_000);
});

test("PiP's cost shows in its person's spend", async () => {
    const id = await pip();

    await recordCost(app, id, 0.25);
    const row = app.spend.summary(owner(app)).sessions.find((each) => each.id === Number(id));

    assert.equal(row?.title, "PiP");
    assert.ok((row?.spent ?? 0) >= 0.25);
});
