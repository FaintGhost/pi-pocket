// Linked sessions (`linked-sessions.ts`): a repeat acts once, a link shares nothing, and the checks of whom Pi works for
// apply before anything is made or sent.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    modelTexts,
    newSession,
    openApp,
    owner,
    recordCost,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { LinkedSessionCallDoc, TurnsDoc } from "../src/server/docs.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});
after(async () => {
    await app?.close();
    cleanUp();
});

/** A session with someone Pi works for: linked sessions act as them. */
async function source() {
    const id = await newSession(app);

    await say(app, id, "hello");

    return id;
}

const start = (id: ConversationId, key: string = crypto.randomUUID(), model?: string) =>
    app.linkedSessions.start(id, { title: "Linked", message: "a task", model }, key);
const send = (id: ConversationId, target: ConversationId, key: string = crypto.randomUUID()) =>
    app.linkedSessions.send(id, Number(target), "a message", false, key);
const sent = async (id: ConversationId) =>
    (await modelTexts(app, id)).filter((text) => text.includes("<linked-session-message>")).length;

test("a repeated start or send makes one session or one message", async () => {
    const id = await source();
    const target = await start(id, "start-key");
    const count = app.sessions().length;

    assert.equal(await start(id, "start-key"), target);
    assert.equal(app.sessions().length, count);
    await send(id, target, "send-key");
    await send(id, target, "send-key");
    await until(async () => (await sent(target)) > 0, "the message");
    assert.equal(await sent(target), 1);
});

test("someone who cannot see the origin learns nothing of it and cannot reach it", async () => {
    const id = await source();

    await app.commands.updateSession(id, owner(app), { title: "Secret origin" });
    const target = await start(id);
    const { user } = app.config.addUser("Target only", "guest", [String(target)]);
    const tab = fakeTab(undefined, user);

    await app.attach(tab.client);
    // A later change goes out in a broadcast, which must be this person's own list too.
    await app.commands.updateSession(target, owner(app), { title: "Renamed" });
    const lists = () => tab.events.filter((each) => each.event === "sessions");

    await until(() => lists().length > 1, "a list");
    app.detach(tab.client);

    for (const list of [app.sessions(user), ...lists().map((each) => each.data)]) {
        assert.ok(!JSON.stringify(list).includes("Secret origin"));
        assert.ok(!JSON.stringify(list).includes(`"id":${Number(id)}`));
    }

    // With Pi working for them in the linked session, its peers are out of reach.
    await app.commands.submit(target, user, { text: "hello", requestId: "guest" });
    assert.deepEqual(await app.linkedSessions.list(target), []);
    await assert.rejects(send(target, id), /not linked/);
});

test("a start or send is refused in plan mode, past a spend limit, or without the turn", async () => {
    const id = await source();
    const target = await start(id);
    const count = app.sessions().length;

    const refused = async (why: RegExp) => {
        await assert.rejects(start(id), why);
        await assert.rejects(send(id, target), why);
        assert.equal(app.sessions().length, count);
        assert.equal(await sent(target), 0);
    };

    await app.commands.setPlan(id, owner(app), true);
    await refused(/Approve/);
    await app.commands.setPlan(id, owner(app), false);

    await recordCost(app, id, 0.02);
    await until(() => app.spend.sessionSpent(id) === 0.02, "the spend");
    await app.spend.setSessionBudget(owner(app), id, 0.01);
    await refused(/spend limit/);
    await app.spend.setSessionBudget(owner(app), id, null);

    const driver = app.config.addUser("Driver", "guest").user;

    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(TurnsDoc, id), { on: true, driver: driver.id, asks: [] });
    }, context);
    await refused(/driving/);
});

test("an unavailable model creates no session", async (t) => {
    const id = await source();
    const count = app.sessions().length;
    const key = "unavailable";

    t.mock.method(app.providers, "problem", async () => "its sign-in expired");
    await assert.rejects(start(id, key, "faux/faux-2"), /sign-in expired/);
    assert.equal(app.sessions().length, count);

    const token = createHash("sha256").update(`${id}:${key}`).digest("hex");

    assert.equal(await app.harness.snapshot(LinkedSessionCallDoc, id, token, context), undefined);
});
