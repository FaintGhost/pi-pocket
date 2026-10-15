// Ordinary sessions use trusted settings from their final folder, without changing legacy creation paths.
import {
    type App,
    cleanUp,
    context,
    home,
    lastText,
    openApp,
    owner,
    root,
    say,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PocketApp } from "../src/server/app.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR!;
const apps: App[] = [];
const pair = { defaultProvider: "faux", defaultModel: "project" };
const last = { provider: "faux", modelId: "last", thinkingLevel: "low" as const };

function settings(cwd: string, value: unknown): void {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(value));
}

function project(value: unknown = pair, trusted = true): string {
    const cwd = mkdtempSync(join(root, "model-project-"));

    settings(cwd, value);

    if (trusted) {
        new ProjectTrustStore(agentDir).set(cwd, true);
    }

    return cwd;
}

function globalSettings(value: unknown): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(value));
}

async function start(defaultCwd = work): Promise<App> {
    const faux = fauxProvider({
        tokensPerSecond: 2000,
        models: [
            { id: "project", reasoning: true },
            { id: "last", reasoning: true },
            { id: "global", reasoning: true },
            { id: "launch", reasoning: true },
            { id: "plain" },
        ],
    });

    faux.setResponses(
        Array.from({ length: 1000 }, () => (request) => {
            const { role, text } = lastText(request as never);

            if (role === "user" && text.endsWith("start a helper")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("subagent", {
                            action: "spawn",
                            name: "helper",
                            message: "report",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage([fauxText("done")]);
        }),
    );
    const dataDir = mkdtempSync(join(root, "model-data-"));
    const app =
        defaultCwd === work
            ? await openApp(faux, dataDir)
            : await PocketApp.open({
                  dataDir,
                  defaultCwd,
                  supervised: false,
                  log: () => {},
                  configureModels: (models) => models.registerNativeProvider(faux.provider),
                  home,
              });

    apps.push(app);
    app.config.lastModel = { ...last };

    return app;
}

async function choice(app: App, id: ConversationId) {
    const agent = await app.agentState(id);

    return { model: agent?.model, thinking: agent?.thinkingLevel };
}

async function create(app: App, cwd: string) {
    const { id } = await app.commands.createSession(owner(app), { cwd });

    return choice(app, id);
}

const chosen = (modelId: string, thinking = "off", provider = "faux") => ({
    model: { provider, modelId },
    thinking,
});

beforeEach(() => {
    rmSync(join(agentDir, "settings.json"), { force: true });
    rmSync(join(agentDir, "trust.json"), { force: true });
});

afterEach(async () => {
    for (const app of apps.splice(0)) {
        await app.close();
    }
});

after(cleanUp);

test("a trusted project pair beats the last choice and supplies only its own thinking", async () => {
    globalSettings({ defaultThinkingLevel: "high" });
    const app = await start();
    const cwd = project();

    assert.deepEqual(await create(app, cwd), chosen("project"));
    settings(cwd, { ...pair, defaultThinkingLevel: "medium" });
    assert.deepEqual(await create(app, cwd), chosen("project", "medium"));
});

test("settings-only projects ask for trust; an owner's answer affects only later creations", async () => {
    const app = await start();
    const cwd = project(pair, false);
    const { id } = await app.commands.createSession(owner(app), { cwd });
    const info = app.projectTrust(id, owner(app));

    assert.equal(info.ask, true);
    assert.equal((info as typeof info & { settings?: boolean }).settings, true);
    assert.deepEqual(await choice(app, id), chosen("last", "low"));
    const guest = app.config.addUser("Guest", "guest").user;

    assert.throws(() => app.setProjectTrust(id, guest, "trust"), { status: 403 });
    app.setProjectTrust(id, owner(app), "trust");
    assert.deepEqual(await create(app, cwd), chosen("project"));
    assert.deepEqual(await choice(app, id), chosen("last", "low"));
});

test("an explicit owner default bypasses even malformed trusted project settings", async () => {
    const app = await start();
    const cwd = project();

    writeFileSync(join(cwd, ".pi", "settings.json"), "{ secret-invalid-json");
    await app.setDefaultModel(owner(app), {
        provider: "faux",
        modelId: "global",
        thinkingLevel: "high",
    });
    assert.deepEqual(await create(app, cwd), chosen("global", "high"));
});

for (const [name, value] of [
    ["malformed JSON", undefined],
    ["a non-object root", []],
    ["a null root", null],
    ["a non-string provider", { defaultProvider: 42, defaultModel: "project" }],
    ["a non-string model", { defaultProvider: "faux", defaultModel: false }],
    ["provider without model", { defaultProvider: "faux" }],
    ["model without provider", { defaultModel: "project" }],
    ["empty provider", { defaultProvider: "", defaultModel: "project" }],
    ["empty model", { defaultProvider: "faux", defaultModel: "" }],
    ["unknown provider", { defaultProvider: "secret-provider", defaultModel: "project" }],
    ["unknown model", { defaultProvider: "faux", defaultModel: "secret-model" }],
    ["invalid thinking", { ...pair, defaultThinkingLevel: "secret-thinking" }],
    ["invalid thinking without a pair", { defaultThinkingLevel: 17 }],
] as const) {
    test(`trusted ${name} fails safely, with no session or fallback`, async () => {
        const app = await start();
        const cwd = project(value);

        if (value === undefined) {
            writeFileSync(join(cwd, ".pi", "settings.json"), "{ secret-invalid-json");
        }

        const before = app.sessions().length;

        await assert.rejects(app.commands.createSession(owner(app), { cwd }), (error: unknown) => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.doesNotMatch(error.message, /secret-|SyntaxError|Unexpected|JSON at position/);
            assert.ok(!error.message.includes(cwd), "no local path in validation errors");

            return true;
        });
        assert.equal(app.sessions().length, before);
    });
}

test("untrusted settings are ignored, including malformed JSON and project self-trust", async () => {
    const app = await start();
    const cwd = project({ ...pair, defaultProjectTrust: "always" }, false);

    assert.deepEqual(await create(app, cwd), chosen("last", "low"));
    writeFileSync(join(cwd, ".pi", "settings.json"), "{ invalid");
    assert.deepEqual(await create(app, cwd), chosen("last", "low"));
    new ProjectTrustStore(agentDir).set(cwd, false);
    assert.deepEqual(await create(app, cwd), chosen("last", "low"));
});

test("global defaultProjectTrust can trust settings, but an explicit distrust wins", async () => {
    globalSettings({ defaultProjectTrust: "always" });
    const app = await start();
    const cwd = project(pair, false);

    assert.deepEqual(await create(app, cwd), chosen("project"));
    new ProjectTrustStore(agentDir).set(cwd, false);
    assert.deepEqual(await create(app, cwd), chosen("last", "low"));
});

test("ordinary creations read global trust changes immediately without replacing shared settings", async () => {
    globalSettings({ defaultProjectTrust: "always" });
    const app = await start();
    const cwd = project(pair, false);

    assert.deepEqual(await create(app, cwd), chosen("project"));
    globalSettings({ defaultProjectTrust: "ask" });
    assert.deepEqual(await create(app, cwd), chosen("last", "low"));
    globalSettings({ defaultProjectTrust: "never" });
    assert.deepEqual(await create(app, cwd), chosen("last", "low"));
    globalSettings({ defaultProjectTrust: "always" });
    assert.deepEqual(await create(app, cwd), chosen("project"));
    assert.equal(
        app.settings.getDefaultProjectTrust(),
        "always",
        "the shared startup reader stays unchanged",
    );
});

test("ordinary creations read global fallback model and thinking changes immediately", async () => {
    globalSettings({
        defaultProvider: "faux",
        defaultModel: "global",
        defaultThinkingLevel: "medium",
    });
    const app = await start();
    const cwd = project({}, false);

    app.config.lastModel = undefined;
    assert.deepEqual(await create(app, cwd), chosen("global", "medium"));
    globalSettings({ defaultProvider: "faux", defaultModel: "last", defaultThinkingLevel: "high" });
    assert.deepEqual(await create(app, cwd), chosen("last", "high"));
    globalSettings({});
    assert.deepEqual(await create(app, cwd), { model: undefined, thinking: undefined });
    assert.equal(app.settings.getDefaultModel(), "global", "no reload of shared settings");
});

test("invalid global defaultProjectTrust values act as ask, never as project trust", async () => {
    for (const value of ["secret-invalid-trust", true, 42, null]) {
        globalSettings({ defaultProjectTrust: value });
        const app = await start();
        const cwd = project(pair, false);
        const { id } = await app.commands.createSession(owner(app), { cwd });
        const info = app.projectTrust(id, owner(app));

        assert.deepEqual(await choice(app, id), chosen("last", "low"));
        assert.equal(info.defaultProjectTrust, "ask");
        assert.equal(info.trusted, false);
        assert.equal(info.ask, true);
    }
});

test("trust-parent applies to later creations in sibling folders, not to existing sessions", async () => {
    const app = await start();
    const parent = mkdtempSync(join(root, "model-parent-"));
    const a = join(parent, "a");
    const b = join(parent, "b");

    settings(a, pair);
    settings(b, pair);
    const { id } = await app.commands.createSession(owner(app), { cwd: a });

    new ProjectTrustStore(agentDir).set(a, false);
    app.setProjectTrust(id, owner(app), "trust-parent");
    assert.equal(new ProjectTrustStore(agentDir).get(parent), true);
    assert.deepEqual(await create(app, a), chosen("project"));
    assert.deepEqual(await create(app, b), chosen("project"));
    assert.deepEqual(await choice(app, id), chosen("last", "low"));
});

for (const kind of ["corrupt", "directory-valued"] as const) {
    test(`a ${kind} trust store fails closed even with global always trust`, async () => {
        globalSettings({ defaultProjectTrust: "always" });
        const app = await start();
        const cwd = project();
        const store = join(agentDir, "trust.json");

        if (kind === "corrupt") {
            writeFileSync(store, "{ secret-broken-trust");
        } else {
            rmSync(store);
            mkdirSync(store);
        }

        try {
            // Even invalid project settings cannot be consulted when the trust store is unreadable.
            writeFileSync(join(cwd, ".pi", "settings.json"), "{ secret-broken-project");
            const { id } = await app.commands.createSession(owner(app), { cwd });
            const info = app.projectTrust(id, owner(app));

            assert.deepEqual(await choice(app, id), chosen("last", "low"));
            assert.equal(info.trusted, false);
            assert.equal(info.unreadable, true);
            assert.equal(info.ask, false);
            assert.throws(() => app.setProjectTrust(id, owner(app), "trust"), { status: 409 });
        } finally {
            rmSync(store, { recursive: true, force: true });
        }
    });
}

test("a directory-valued trusted settings file gives a controlled error without creating a session", async () => {
    const app = await start();
    const cwd = project();
    const path = join(cwd, ".pi", "settings.json");
    const before = app.sessions().length;

    rmSync(path);
    mkdirSync(path);
    await assert.rejects(app.commands.createSession(owner(app), { cwd }), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 400);
        assert.doesNotMatch(error.message, /EISDIR|syscall|errno/);
        assert.ok(!error.message.includes(cwd));

        return true;
    });
    assert.equal(app.sessions().length, before);
});

test("new global settings errors are safe and do not fall back to the last model", async () => {
    const app = await start();
    const cwd = project(pair, false);
    const before = app.sessions().length;

    writeFileSync(join(agentDir, "settings.json"), "{ secret-invalid-global");
    await assert.rejects(app.commands.createSession(owner(app), { cwd }), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 400);
        assert.doesNotMatch(error.message, /secret-|SyntaxError|Unexpected/);
        assert.ok(!error.message.includes(agentDir));

        return true;
    });
    assert.equal(app.sessions().length, before);
});

test("valid thinking-only settings do not override the fallback's thinking", async () => {
    const app = await start();

    assert.deepEqual(
        await create(app, project({ defaultThinkingLevel: "high" })),
        chosen("last", "low"),
    );
});

test("project thinking is clamped to the chosen model's supported levels", async () => {
    const app = await start();

    assert.deepEqual(
        await create(
            app,
            project({ ...pair, defaultModel: "plain", defaultThinkingLevel: "high" }),
        ),
        chosen("plain"),
    );
    assert.deepEqual(
        await create(app, project({ ...pair, defaultThinkingLevel: "max" })),
        chosen("project", "high"),
    );
});

test("a known project model stays selected even when it is not signed in", async () => {
    const app = await start();
    const away = app.models.getModels("anthropic")[0]!;

    assert.ok(away);
    assert.ok(
        !app.models
            .getAvailableSnapshot()
            .some((model) => model.provider === away.provider && model.id === away.id),
    );
    assert.deepEqual(
        await create(app, project({ defaultProvider: away.provider, defaultModel: away.id })),
        chosen(away.id, clampThinkingLevel(away, "off"), away.provider),
    );
});

test("fallback order is last choice, Pi global default, then none, never launch-folder settings", async () => {
    globalSettings({
        defaultProvider: "faux",
        defaultModel: "global",
        defaultThinkingLevel: "medium",
    });
    const launch = project({
        defaultProvider: "faux",
        defaultModel: "launch",
        defaultThinkingLevel: "high",
    });
    const app = await start(launch);
    const cwd = project({}, false);
    const sharedBefore = app.settings.getDefaultModel();

    assert.deepEqual(await create(app, cwd), chosen("last", "low"));
    app.config.lastModel = undefined;
    assert.deepEqual(await create(app, cwd), chosen("global", "medium"));
    assert.equal(
        app.settings.getDefaultModel(),
        sharedBefore,
        "shared settings are not replaced by session settings",
    );
    globalSettings({});
    const other = await start(launch);

    other.config.lastModel = undefined;
    assert.deepEqual(await create(other, cwd), { model: undefined, thinking: undefined });
});

test("project reads have no cross-folder cache, and cwd/config changes do not reconfigure existing sessions", async () => {
    const app = await start();
    const a = project({ ...pair, defaultThinkingLevel: "medium" });
    const b = project({ ...pair, defaultModel: "plain" });
    const sharedBefore = app.settings.getDefaultModel();
    const { id } = await app.commands.createSession(owner(app), { cwd: a });

    assert.deepEqual(await choice(app, id), chosen("project", "medium"));
    assert.deepEqual(await create(app, b), chosen("plain"));
    settings(a, { ...pair, defaultModel: "global", defaultThinkingLevel: "high" });
    assert.deepEqual(await create(app, a), chosen("global", "high"));
    await app.commands.configure(id, owner(app), { cwd: b });
    await app.setDefaultModel(owner(app), { provider: "faux", modelId: "last" });
    assert.deepEqual(await choice(app, id), chosen("project", "medium"));
    assert.equal(app.settings.getDefaultModel(), sharedBefore);
});

test("worktree creation consults the final checkout, not source settings", async () => {
    globalSettings({ defaultProjectTrust: "always" });
    const app = await start();
    const cwd = project(pair, false);
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

    git("init", "-q");
    git("add", ".pi/settings.json");
    git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "Fixture settings",
    );
    // This local-only edit is intentionally absent from stash/create and thus from the checkout.
    git("update-index", "--assume-unchanged", ".pi/settings.json");
    settings(cwd, { ...pair, defaultModel: "plain" });
    const { id } = await app.commands.createSession(owner(app), { cwd, worktree: true });
    const finalCwd = app.cwdOf(id);

    assert.notEqual(finalCwd, cwd);
    assert.equal(
        JSON.parse(readFileSync(join(finalCwd, ".pi", "settings.json"), "utf8")).defaultModel,
        "project",
    );
    assert.equal(
        JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).defaultModel,
        "plain",
    );
    assert.deepEqual(await choice(app, id), chosen("project"));
});

test("worktree trust is checked at the final folder, not inherited from a trusted source", async () => {
    const app = await start();
    const cwd = project();
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

    git("init", "-q");
    git("add", ".pi/settings.json");
    git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "Fixture settings",
    );
    const { id } = await app.commands.createSession(owner(app), { cwd, worktree: true });

    assert.deepEqual(await choice(app, id), chosen("last", "low"));
    assert.equal(app.projectTrust(id, owner(app)).ask, true);
});

test("malformed final worktree settings leave no session, checkout, or branch", async () => {
    globalSettings({ defaultProjectTrust: "always" });
    const app = await start();
    const cwd = project(pair, false);
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

    git("init", "-q");
    git("add", ".pi/settings.json");
    git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "Fixture settings",
    );
    writeFileSync(join(cwd, ".pi", "settings.json"), "{ secret-invalid-checkout");
    const before = app.sessions().length;
    const checkouts = git("worktree", "list", "--porcelain");
    const branches = git("branch", "--format=%(refname)");

    await assert.rejects(
        app.commands.createSession(owner(app), { cwd, worktree: true }),
        (error: unknown) => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.doesNotMatch(error.message, /secret-|SyntaxError|Unexpected/);
            assert.ok(!error.message.includes(cwd));

            return true;
        },
    );
    assert.equal(app.sessions().length, before);
    assert.equal(git("worktree", "list", "--porcelain"), checkouts);
    assert.equal(git("branch", "--format=%(refname)"), branches);
    const folder = join(app.dataDir, "worktrees");

    assert.deepEqual(existsSync(folder) ? readdirSync(folder) : [], []);
    assert.equal(
        readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
        "{ secret-invalid-checkout",
    );
});

test("imports keep their recorded model, or legacy fallback when none was recorded", async () => {
    const app = await start();
    const cwd = project();

    writeFileSync(join(cwd, ".pi", "settings.json"), "{ malformed but not consulted by imports");

    for (const withModel of [true, false]) {
        const manager = SessionManager.inMemory(cwd);

        if (withModel) {
            manager.appendModelChange("faux", "global");
            manager.appendThinkingLevelChange("medium");
        }

        manager.appendMessage({ role: "user", content: "An imported conversation", timestamp: 1 });
        const folder = join(
            agentDir,
            "sessions",
            `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`,
        );
        const path = join(folder, `${withModel}.jsonl`);

        mkdirSync(folder, { recursive: true });
        writeFileSync(
            path,
            [manager.getHeader(), ...manager.getEntries()]
                .map((entry) => JSON.stringify(entry))
                .join("\n") + "\n",
        );
        const { id } = await app.commands.continuePiSession(owner(app), path);

        assert.deepEqual(
            await choice(app, id),
            withModel ? chosen("global", "medium") : chosen("last", "low"),
        );
    }
});

test("PiP's human-named model bypasses project pins and validation, but unnamed starts use them", async () => {
    globalSettings({ defaultProjectTrust: "always" });
    const app = await start();
    const cwd = project({ ...pair, defaultThinkingLevel: "high" }, false);
    const pip = await app.pip.ensure(owner(app));

    assert.deepEqual(await choice(app, pip), chosen("last", "low"));
    // PiP requires a multi-word model name; the bare one-word faux id is intentionally not a name.
    await say(app, pip, "Use faux/global");
    const explicit = await app.pip.start(pip, { folder: cwd, model: "faux/global" });

    assert.deepEqual(await choice(app, explicit), chosen("global", "low"));
    // Starting another session must not change the saved legacy fallback for this check.
    app.config.lastModel = { ...last };
    writeFileSync(join(cwd, ".pi", "settings.json"), "{ secret-invalid-project-pin");
    const bypass = await app.pip.start(pip, { folder: cwd, model: "faux/global" });

    assert.deepEqual(await choice(app, bypass), chosen("global", "low"));
    settings(cwd, { ...pair, defaultThinkingLevel: "high" });
    app.config.lastModel = { ...last };
    const unnamed = await app.pip.start(pip, { folder: cwd });

    assert.deepEqual(await choice(app, unnamed), chosen("project", "high"));
    assert.deepEqual(await choice(app, pip), chosen("last", "low"));
});

test("manual choices, forks, subagents, and PiP retain their legacy defaults or inheritance", async () => {
    const launch = project(pair);
    const app = await start(launch);
    const { id } = await app.commands.createSession(owner(app), { cwd: launch });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "global" },
        thinkingLevel: "medium",
    });
    settings(launch, { ...pair, defaultModel: "plain" });
    await say(app, id, "a finished reply");
    const entries = await (await app.conversation(id)).entries({}, 50, undefined, context);
    const reply = entries.items.findLast((entry) => entry.kind === "pi.assistant")!;
    const fork = await app.commands.fork(id, owner(app), { entryId: Number(reply.id) });

    assert.deepEqual(await choice(app, fork.id), chosen("global", "medium"));
    await say(app, id, "start a helper");
    await until(
        async () =>
            !!(await app.harness.snapshot(SubagentsDoc, id, context))?.agents.helper
                ?.conversationId,
        "the helper to start",
    );
    const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
        .conversationId;

    await until(() => !app.isBusy(id) && !app.isBusy(helper), "the helper to finish");
    assert.deepEqual(await choice(app, helper), chosen("global", "medium"));
    assert.deepEqual(await choice(app, id), chosen("global", "medium"));
    app.config.lastModel = { ...last };
    const pip = await app.pip.ensure(owner(app));

    assert.deepEqual(await choice(app, pip), chosen("last", "low"));
});
