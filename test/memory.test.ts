// Memory: lessons Pi saves with its tool reach later sessions of the same project (its worktrees too) in their system
// prompt, and everywhere's reach every session and PiP; a guest's wait for the owner; a call run again saves once;
// caps; and who may change what through the routes.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { ChatDoc, MemoryDoc } from "../src/server/docs.ts";
import { MAX_EVERYWHERE_LESSONS, MAX_PROJECT_LESSONS } from "../src/server/memory.ts";

const tool = (args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall("memory", args)], { stopReason: "toolUse" });

/**
 * "remember …" saves a project lesson, "remember-everywhere …" one for everywhere, "forget ID" removes one, and
 * "check WORD" answers whether WORD is in what Pi was given before that message: its system prompt.
 */
const route: FauxResponseStep = (request) => {
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    const [verb = "", ...rest] = text.split(" ");

    switch (verb) {
        case "remember":
            return tool({ action: "add", text: rest.join(" "), scope: "project" });
        case "remember-everywhere":
            return tool({ action: "add", text: rest.join(" "), scope: "everywhere" });
        case "forget":
            return tool({ action: "remove", id: rest[0] ?? "" });

        case "check": {
            const { messages, systemPrompt } = request as {
                messages: unknown[];
                systemPrompt?: string;
            };
            const given = JSON.stringify({ systemPrompt, messages: messages.slice(0, -1) });

            return fauxAssistantMessage([fauxText(`has ${rest[0]}: ${given.includes(rest[0]!)}`)]);
        }

        default:
            return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }
};

let app: App;
const repo = join(root, "memory-repo");
const worktree = join(root, "memory-worktree");
const elsewhere = join(root, "memory-elsewhere");
const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

before(async () => {
    mkdirSync(repo, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    gitIn(repo, "init", "-q");
    gitIn(repo, "config", "user.email", "t@example.com");
    gitIn(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "README.md"), "hello\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "init");
    gitIn(repo, "worktree", "add", "-q", worktree, "-b", "side");
    app = await openApp(scriptedModel(route), join(root, "memory-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Pi's last answer in a conversation. */
async function answer(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);
    const last = entries.findLast((entry) => entry.kind === "assistant");

    return last?.kind === "assistant"
        ? last.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

/** Whether a new session in `cwd` gets `word` in its system prompt. */
async function given(cwd: string, word: string): Promise<boolean> {
    const id = await newSession(app, cwd);

    await say(app, id, `check ${word}`);

    return (await answer(id)) === `has ${word}: true`;
}

/** Forget every lesson, for the next test. */
async function clear(): Promise<void> {
    await app.harness.commit(async (tx) => {
        (await tx.doc(MemoryDoc)).items = {};
    }, context);
}

async function lessons() {
    return Object.values((await app.harness.snapshot(MemoryDoc, context))?.items ?? {});
}

async function sayAs(user: User, id: ConversationId, text: string): Promise<void> {
    const { submissionId } = await app.commands.submit(id, user, {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

test("a lesson Pi saves reaches later sessions in the repository and its worktrees, not other folders", async () => {
    const id = await newSession(app, repo);

    await say(app, id, "remember Run the tests with make check-zebra.");
    assert.match(await answer(id), /^ok: Saved \[\w+\] for memory-repo\.$/);
    const [lesson] = await lessons();

    assert.equal(lesson?.text, "Run the tests with make check-zebra.");
    assert.equal(lesson?.projectName, "memory-repo");
    assert.equal(lesson?.byPi, true);
    assert.equal(lesson?.by, owner(app).id);
    assert.equal(lesson?.pending, undefined);
    assert.equal(lesson?.from?.conversationId, Number(id));
    assert.ok(await given(repo, "check-zebra"), "the repository");
    assert.ok(await given(worktree, "check-zebra"), "a worktree of it");
    assert.ok(!(await given(elsewhere, "check-zebra")), "not another folder");

    // People see who saved it and where it came from, and a line in the chat said so.
    const view = await app.memory.view(id, owner(app));

    assert.deepEqual(view.project, { name: "memory-repo" });
    assert.equal(view.lessons[0]?.from?.id, Number(id));
    const chat = await app.harness.snapshot(ChatDoc, id, context);

    assert.ok(
        chat?.messages.some((message) => /saved a lesson for memory-repo/.test(message.text)),
    );

    // Forgotten, it is gone from the next session's prompt.
    await say(app, id, `forget ${lesson!.id}`);
    assert.equal((await lessons()).length, 0);
    assert.ok(!(await given(repo, "check-zebra")));
});

test("lessons for everywhere reach every folder, and PiP, which has no project", async () => {
    const id = await newSession(app, elsewhere);

    await say(app, id, "remember-everywhere Answer in British-spelling-yak.");
    assert.ok(await given(repo, "British-spelling-yak"));
    assert.ok(await given(elsewhere, "British-spelling-yak"));

    const pip = await app.pip.ensure(owner(app));

    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await say(app, pip, "check British-spelling-yak");
    assert.equal(await answer(pip), "has British-spelling-yak: true");
    // PiP's own lessons are for everywhere, whatever it asks for.
    await say(app, pip, "remember PiP-prefers-llamas");
    assert.match(await answer(pip), /for everywhere/);
    assert.equal((await app.memory.view(pip, owner(app))).project, null);

    await clear();
});

test("a guest's lesson waits for the owner, and is used once approved", async () => {
    const guest = app.config.addUser("Gina", "guest").user;
    const id = await newSession(app, repo);

    await sayAs(guest, id, "remember Always-deploy-to-moon.");
    assert.match(await answer(id), /waits for the owner's approval/);
    const [lesson] = await lessons();

    assert.equal(lesson?.pending, true);
    assert.equal(lesson?.by, guest.id);
    assert.ok(!(await given(repo, "Always-deploy-to-moon")), "not used while pending");

    // The guest sees their own; the owner sees it to approve; another guest does not see it.
    const other = app.config.addUser("Otto", "guest").user;

    assert.equal((await app.memory.view(id, guest)).lessons.length, 1);
    assert.equal((await app.memory.view(id, other)).lessons.length, 0);
    assert.equal((await app.memory.view(id, owner(app))).lessons[0]?.pending, true);
    await assert.rejects(app.memory.edit(id, guest, lesson!.id, "approve"), /Only the owner/);
    await app.memory.edit(id, owner(app), lesson!.id, "approve");
    assert.ok(await given(repo, "Always-deploy-to-moon"), "used once approved");

    // The guest's change waits again; the other guest may not change it at all.
    await app.memory.edit(id, guest, lesson!.id, { text: "Always-deploy-to-mars." });
    assert.equal((await lessons())[0]?.pending, true);
    await assert.rejects(app.memory.edit(id, other, lesson!.id, "remove"), /Only the owner/);
    await app.memory.edit(id, owner(app), lesson!.id, "remove");
});

test("a call run again saves its lesson once", async () => {
    const id = await newSession(app, repo);
    const writer = { userId: owner(app).id, byPi: true, name: "Pi" };
    const request = { text: "Once only.", scope: "project" as const, key: "task-1:call-1" };
    const first = await app.memory.add(id, repo, writer, request);
    const second = await app.memory.add(id, repo, writer, request);

    assert.equal(first.id, second.id);
    assert.equal((await lessons()).length, 1);
    await app.memory.edit(id, owner(app), first.id, "remove");
});

test("a project and everywhere keep so many lessons, and say to forget one first", async () => {
    const id = await newSession(app, elsewhere);
    const writer = { userId: owner(app).id, byPi: false, name: "Owner" };

    for (let index = 0; index < MAX_PROJECT_LESSONS; index++) {
        await app.memory.add(id, elsewhere, writer, { text: `p${index}`, scope: "project" });
    }

    await assert.rejects(
        app.memory.add(id, elsewhere, writer, { text: "one more", scope: "project" }),
        /forget one first/,
    );

    for (let index = 0; index < MAX_EVERYWHERE_LESSONS; index++) {
        await app.memory.add(id, elsewhere, writer, { text: `e${index}`, scope: "everywhere" });
    }

    await assert.rejects(
        app.memory.add(id, elsewhere, writer, { text: "one more", scope: "everywhere" }),
        /forget one first/,
    );
    await assert.rejects(
        app.memory.add(id, elsewhere, writer, { text: "x".repeat(301), scope: "project" }),
        /300 characters at most/,
    );

    // Another project still has room.
    await app.memory.add(id, repo, writer, { text: "fits", scope: "project" });

    await clear();
});

test("the routes: viewers read, guests add (pending) and cannot remove the owner's", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const viewer = app.config.addUser("Vic", "viewer");
    const guest = app.config.addUser("Gus", "guest");
    const call = (token: string, path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const id = await newSession(app, repo);
    const ownerToken = app.config.ownerToken;

    try {
        const added = await call(ownerToken, `c/${id}/memory`, { text: "Owner's rule." });

        assert.equal(added.status, 200);
        const lesson = (await added.json()) as { id: string; pending?: boolean };

        assert.equal(lesson.pending, undefined);

        const seen = await call(viewer.token, `c/${id}/memory`);

        assert.equal(seen.status, 200);
        const view = (await seen.json()) as {
            project: { name: string };
            canWrite: boolean;
            lessons: { id: string; mine: boolean }[];
        };

        assert.equal(view.project.name, "memory-repo");
        assert.equal(view.canWrite, false);
        assert.deepEqual(
            view.lessons.map((each) => [each.id, each.mine]),
            [[lesson.id, false]],
        );
        assert.equal((await call(viewer.token, `c/${id}/memory`, { text: "nope" })).status, 403);
        assert.equal(
            (await call(viewer.token, `c/${id}/memory/${lesson.id}/remove`, {})).status,
            403,
        );

        const proposed = await call(guest.token, `c/${id}/memory`, {
            text: "Guest's idea.",
            scope: "everywhere",
        });

        assert.equal(((await proposed.json()) as { pending?: boolean }).pending, true);
        assert.equal(
            (await call(guest.token, `c/${id}/memory/${lesson.id}/remove`, {})).status,
            403,
        );
        assert.equal(
            (await call(guest.token, `c/${id}/memory/${lesson.id}`, { text: "changed" })).status,
            403,
        );
        assert.equal(
            (await call(ownerToken, `c/${id}/memory/${lesson.id}/remove`, {})).status,
            200,
        );
        assert.equal((await call(ownerToken, `c/${id}/memory/nope/approve`, {})).status, 404);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
