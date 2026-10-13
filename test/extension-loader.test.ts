// The extension loader on its own, with a real registry: loads that a newer one overtakes, modules turned off while they
// load, async default exports, a version that fails part way through installing, removals that are only a save, and
// who hears about it all.
import { cleanUp, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";

after(cleanUp);

/** What the test modules reach on `globalThis`: gates to hold their import, and counts of their cleanups. */
const shared = globalThis as unknown as {
    gates?: Record<string, Promise<void>>;
    cleaned?: Record<string, number>;
};

shared.gates = {};
shared.cleaned = {};

let folders = 0;

/** A loader on fresh folders, with every drop-in on unless `off` says otherwise. */
function setUp(off = new Set<string>(), loadLimitMs?: number) {
    const directory = join(root, `loader-${++folders}`);
    const builtIn = join(directory, "built-in");
    const dropIn = join(directory, "drop-ins");

    mkdirSync(builtIn, { recursive: true });
    mkdirSync(dropIn, { recursive: true });

    const registry = createRegistry();
    const notices: { to: string; level: string; message: string }[] = [];
    const host = {
        notice: (level: string, message: string) =>
            notices.push({ to: "everyone", level, message }),
    } as unknown as PocketHost;
    const webs = new ExtensionWebs();
    const loader = new ExtensionLoader(
        registry,
        host,
        { builtIn, dropIn },
        (file) => !off.has(file),
        {
            webs,
            notify: (level, message) => notices.push({ to: "owner", level, message }),
            ...(loadLimitMs === undefined ? {} : { loadLimitMs }),
        },
    );
    const installed = () =>
        registry
            .snapshot()
            .installed()
            .filter((extension) => extension.name.startsWith("t-"))
            .map((extension) => `${extension.name}@${(extension as { v?: number }).v}`);

    return { dropIn, registry, notices, webs, loader, installed, off };
}

/** A module that waits at its top level for `gate`, then adds a route answering its version and one extension. */
const gated = (name: string, version: number, gate?: string) => `/** ${name}, version ${version}. */
${gate === undefined ? "" : `await globalThis.gates[${JSON.stringify(gate)}];`}
export default (_host, web) => {
	web.route("GET", "v", () => ({ v: ${version} }));
	web.onDispose(() => { globalThis.cleaned[${JSON.stringify(name)}] = (globalThis.cleaned[${JSON.stringify(name)}] ?? 0) + 1; });
	return { name: "t-${name}", v: ${version} };
};
`;

/** A gate the test opens by hand. */
function gate(name: string): () => void {
    let open!: () => void;

    shared.gates![name] = new Promise<void>((resolve) => (open = resolve));

    return open;
}

const owner = { role: "owner" as const };

const answer = (webs: ExtensionWebs, module: string) => {
    const found = webs.match(module, "GET", ["v"], owner);

    return found !== undefined && "route" in found
        ? (found.route.handle({} as never) as { v?: unknown })
        : undefined;
};

test("a load that a newer one overtakes installs nothing: the newest version wins", async () => {
    const { dropIn, loader, webs, installed } = setUp();

    writeFileSync(join(dropIn, "race.ts"), gated("race", 1, "race-1"));
    const open = gate("race-1");
    const first = loader.reload("race.ts");

    // While version 1 still waits at its top level, version 2 is saved and loads.
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(dropIn, "race.ts"), gated("race", 2));
    await loader.reload("race.ts");
    assert.deepEqual(answer(webs, "race"), { v: 2 });

    // Version 1 finishes last: it installs nothing, and is no failure.
    open();
    await first;
    assert.deepEqual(answer(webs, "race"), { v: 2 });
    assert.deepEqual(installed(), ["t-race@2"]);
    assert.equal(loader.list().find((each) => each.file === "race.ts")?.error, undefined);
});

test("a module turned off while it loads stays off: no routes, no browser module, no extensions", async () => {
    const { dropIn, loader, webs, installed, off } = setUp();

    writeFileSync(join(dropIn, "slow.ts"), gated("slow", 1, "slow"));
    const open = gate("slow");
    const loading = loader.apply("slow.ts");

    await new Promise((resolve) => setTimeout(resolve, 20));
    off.add("slow.ts");
    await loader.apply("slow.ts");
    open();
    await loading;
    assert.equal(answer(webs, "slow"), undefined);
    assert.deepEqual(installed(), []);
    assert.equal(loader.list().find((each) => each.file === "slow.ts")?.enabled, false);
    // What it registered while it loaded was cleaned up.
    assert.equal(shared.cleaned!.slow, undefined, "its default export never ran");
});

test("a load still running when the server stops installs nothing", async () => {
    const { dropIn, loader, installed } = setUp();

    writeFileSync(join(dropIn, "late.ts"), gated("late", 1, "late"));
    const open = gate("late");
    const loading = loader.reload("late.ts");

    await new Promise((resolve) => setTimeout(resolve, 20));
    await loader.close();
    open();
    await loading;
    assert.deepEqual(installed(), []);
});

test("an async default export may register until it settles; one that rejects is a failed load", async () => {
    const { dropIn, loader, webs } = setUp();

    writeFileSync(
        join(dropIn, "later.ts"),
        `/** Later: sets up after a wait. */
export default async (_host, web) => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	web.route("GET", "v", () => ({ v: "later" }));
};
`,
    );
    await loader.reload("later.ts");
    assert.deepEqual(answer(webs, "later"), { v: "later" });

    writeFileSync(
        join(dropIn, "sour.ts"),
        `/** Sour: fails after a wait. */
export default async () => {
	await new Promise((resolve) => setTimeout(resolve, 10));
	throw new Error("went sour");
};
`,
    );
    await assert.rejects(loader.reload("sour.ts"), /went sour/);
    assert.match(loader.list().find((each) => each.file === "sour.ts")?.error ?? "", /went sour/);
});

test("a version that fails part way through installing leaves the version before whole", async () => {
    const { dropIn, loader, webs, installed } = setUp();
    const module = (version: number, extra: string) => `/** Halves, version ${version}. */
export default (_host, web) => {
	web.route("GET", "v", () => ({ v: ${version} }));
	web.onDispose(() => { globalThis.cleaned.halves = (globalThis.cleaned.halves ?? 0) + 1; });
	return [{ name: "t-halves-a", v: ${version} }, ${extra}];
};
`;

    writeFileSync(join(dropIn, "halves.ts"), module(1, `{ name: "t-halves-b", v: 1 }`));
    await loader.reload("halves.ts");
    assert.deepEqual(installed(), ["t-halves-a@1", "t-halves-b@1"]);

    // The second extension of version 2 is refused by the registry (a bad section key), after the first installed.
    writeFileSync(
        join(dropIn, "halves.ts"),
        module(2, `{ name: "t-halves-c", v: 2, sections: [{ key: "BAD" }] }`),
    );
    await assert.rejects(loader.reload("halves.ts"), /Section key "BAD"/);
    assert.deepEqual(installed(), ["t-halves-a@1", "t-halves-b@1"]);
    assert.deepEqual(answer(webs, "halves"), { v: 1 });
    assert.deepEqual(
        loader.extensionNames().filter((name) => name.startsWith("t-")),
        ["t-halves-a", "t-halves-b"],
    );
    // Version 2's own cleanup ran; version 1's did not.
    assert.equal(shared.cleaned!.halves, 1);
});

test("what the loader says about modules goes to the owner alone", async () => {
    const { dropIn, loader, notices } = setUp();

    writeFileSync(join(dropIn, "tell.ts"), gated("tell", 1));
    await loader.reload("tell.ts");
    loader.watch();

    try {
        // An edit that fails to load names what failed: words for the owner, as they can quote a secret.
        writeFileSync(
            join(dropIn, "tell.ts"),
            `/** Tell. */\nexport default () => { throw new Error("provider said sk-not-for-guests"); };\n`,
        );
        await until(
            () => notices.some((each) => /sk-not-for-guests/.test(each.message)),
            "the failure is told",
        );
        assert.ok(notices.every((each) => each.to === "owner"));
    } finally {
        await loader.close();
    }
});

test("a module file removed for a moment, as some editors save, is not taken away", async () => {
    const { dropIn, loader, webs, notices } = setUp();
    const file = join(dropIn, "saved.ts");

    writeFileSync(file, gated("saved", 1));
    await loader.reload("saved.ts");
    loader.watch();

    try {
        // Saved by writing a new file and putting it in place of the old one: gone for an instant.
        renameSync(file, `${file}.old`);
        writeFileSync(`${file}.new`, gated("saved", 2));
        renameSync(`${file}.new`, file);
        rmSync(`${file}.old`);
        await until(() => answer(webs, "saved")?.v === 2, "the new version loads");
        assert.ok(!notices.some((each) => /Removed/.test(each.message)));

        // Really removed: its routes go.
        rmSync(file);
        await until(() => answer(webs, "saved") === undefined, "it is taken away");
        assert.ok(
            notices.some((each) => /Removed the drop-in extension saved\.ts/.test(each.message)),
        );
    } finally {
        await loader.close();
    }
});

test("two loads in the same millisecond each import the file as it is then", async () => {
    const { dropIn, loader, webs } = setUp();
    const realNow = Date.now;

    // Every load at the very same time: the address of each import must still be its own.
    Date.now = () => 1_800_000_000_000;

    try {
        writeFileSync(join(dropIn, "quick.ts"), gated("quick", 1));
        await loader.reload("quick.ts");
        writeFileSync(join(dropIn, "quick.ts"), gated("quick", 2));
        await loader.reload("quick.ts");
    } finally {
        Date.now = realNow;
    }

    assert.deepEqual(answer(webs, "quick"), { v: 2 });
});

test("a load that fails after a newer one installed, or after the module was turned off, records no error", async () => {
    const { dropIn, loader, webs, off } = setUp();
    const sour = (version: number, gateName: string) => `/** Sour, version ${version}. */
export default async (_host, web) => {
	web.route("GET", "v", () => ({ v: ${version} }));
	await globalThis.gates[${JSON.stringify(gateName)}];
	throw new Error("version ${version} went sour");
};
`;

    writeFileSync(join(dropIn, "late.ts"), sour(1, "late-1"));
    const open = gate("late-1");
    const first = loader.reload("late.ts");

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(dropIn, "late.ts"), gated("late", 2));
    await loader.reload("late.ts");
    open();
    // It fails, but it no longer counts: no error for the version that works, and the caller hears none either.
    await first;
    assert.deepEqual(answer(webs, "late"), { v: 2 });
    assert.equal(loader.list().find((each) => each.file === "late.ts")?.error, undefined);

    // Turned off while a load that will fail runs: off, with no error.
    writeFileSync(join(dropIn, "late.ts"), sour(3, "late-3"));
    const close = gate("late-3");
    const third = loader.reload("late.ts");

    await new Promise((resolve) => setTimeout(resolve, 20));
    off.add("late.ts");
    await loader.apply("late.ts");
    close();
    await third;
    assert.equal(loader.list().find((each) => each.file === "late.ts")?.error, undefined);
    assert.equal(answer(webs, "late"), undefined);
});

test("a module whose file is removed during its first load installs nothing", async () => {
    const { dropIn, loader, webs, installed } = setUp();

    loader.watch();

    try {
        writeFileSync(join(dropIn, "brief.ts"), gated("brief", 1, "brief"));
        const open = gate("brief");
        const loading = loader.apply("brief.ts");

        await new Promise((resolve) => setTimeout(resolve, 50));
        rmSync(join(dropIn, "brief.ts"));
        // Gone for longer than an editor's save.
        await new Promise((resolve) => setTimeout(resolve, 600));
        open();
        await loading;
        assert.equal(answer(webs, "brief"), undefined);
        assert.deepEqual(installed(), []);
    } finally {
        await loader.close();
    }
});

test("a load that never finishes fails after the limit, and installs nothing if it finishes later", async () => {
    const { dropIn, loader, webs } = setUp(new Set(), 200);

    writeFileSync(
        join(dropIn, "stuck.ts"),
        `/** Stuck: waits for ever while it sets up. */
export default async (_host, web) => {
	web.route("GET", "v", () => ({ v: "stuck" }));
	await globalThis.gates.stuck;
};
`,
    );
    const open = gate("stuck");

    await assert.rejects(
        loader.reload("stuck.ts"),
        /did not finish loading in time \(0\.2 s at most/,
    );
    open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(answer(webs, "stuck"), undefined);
    assert.match(
        loader.list().find((each) => each.file === "stuck.ts")?.error ?? "",
        /did not finish/,
    );
});

test("a version whose old extensions cannot all be removed leaves the version before whole", async () => {
    const { dropIn, loader, registry, webs, installed } = setUp();
    const module = (version: number, names: string[]) => `/** Drops, version ${version}. */
export default (_host, web) => {
	web.route("GET", "v", () => ({ v: ${version} }));
	return ${JSON.stringify(names.map((name) => ({ name, v: version })))};
};
`;

    writeFileSync(join(dropIn, "drops.ts"), module(1, ["t-drops-a", "t-drops-b"]));
    await loader.reload("drops.ts");

    // A listener of the registry that throws once the second extension is gone: after the registry changed.
    let armed = true;
    const stop = registry.subscribe(() => {
        if (armed && registry.snapshot().extension("t-drops-b") === undefined) {
            armed = false;

            throw new Error("a listener failed");
        }
    });

    try {
        writeFileSync(join(dropIn, "drops.ts"), module(2, ["t-drops-a"]));
        await assert.rejects(loader.reload("drops.ts"), /a listener failed/);
    } finally {
        stop();
    }

    assert.deepEqual(installed(), ["t-drops-a@1", "t-drops-b@1"]);
    assert.deepEqual(answer(webs, "drops"), { v: 1 });

    // And a version that returns two extensions of one name is refused before anything installs.
    writeFileSync(join(dropIn, "drops.ts"), module(3, ["t-drops-a", "t-drops-a"]));
    await assert.rejects(loader.reload("drops.ts"), /two extensions named t-drops-a/);
    assert.deepEqual(installed(), ["t-drops-a@1", "t-drops-b@1"]);
});

test("a failed version that moved a task between its extensions is put back whole, in order", async () => {
    const { dropIn, loader, registry, webs } = setUp();
    const task = `{ definition: { name: "t-moved-task" } }`;
    const module = (version: number, body: string) => `/** Moves, version ${version}. */
export default (_host, web) => {
	web.route("GET", "v", () => ({ v: ${version} }));
	return ${body};
};
`;
    const order = () =>
        registry
            .snapshot()
            .installed()
            .filter((extension) => extension.name.startsWith("t-moves-"))
            .map(
                (extension) =>
                    `${extension.name}@${(extension as { v?: number }).v}${extension.tasks?.length ? "+task" : ""}`,
            );

    writeFileSync(
        join(dropIn, "moves.ts"),
        module(1, `[{ name: "t-moves-a", v: 1, tasks: [${task}] }, { name: "t-moves-b", v: 1 }]`),
    );
    await loader.reload("moves.ts");
    assert.deepEqual(order(), ["t-moves-a@1+task", "t-moves-b@1"]);

    // Version 2 moves the task from a to b, and its third extension is refused.
    writeFileSync(
        join(dropIn, "moves.ts"),
        module(
            2,
            `[{ name: "t-moves-a", v: 2 }, { name: "t-moves-b", v: 2, tasks: [${task}] }, { name: "t-moves-c", v: 2, sections: [{ key: "BAD" }] }]`,
        ),
    );
    await assert.rejects(loader.reload("moves.ts"), /Section key "BAD"/);
    assert.deepEqual(order(), ["t-moves-a@1+task", "t-moves-b@1"]);
    assert.deepEqual(answer(webs, "moves"), { v: 1 });
});

test("at the start, modules that hang share one limit, and a stop ends the loads that wait", async () => {
    const { dropIn, loader, webs } = setUp(new Set(), 900);
    const stuck = (name: string) => `/** ${name}: waits for ever at its top level. */
await new Promise(() => {});
export default () => [];
`;

    for (const name of ["hang-a", "hang-b", "hang-c"]) {
        writeFileSync(join(dropIn, `${name}.ts`), stuck(name));
    }

    writeFileSync(join(dropIn, "zz-fine.ts"), gated("fine", 1));

    const started = Date.now();

    await loader.loadAll();

    const took = Date.now() - started;

    // One by one they would take 2.7 s; sharing, 0.9 s and then a fifteenth of it for each after.
    assert.ok(took < 1600, `the start took ${took} ms`);
    assert.deepEqual(answer(webs, "zz-fine"), { v: 1 });
    assert.match(
        loader.list().find((each) => each.file === "hang-c.ts")?.error ?? "",
        /did not finish loading in time/,
    );

    // A load that waits when the server stops ends at once, with no error.
    writeFileSync(join(dropIn, "waits.ts"), gated("waits", 1, "waits"));
    gate("waits");
    const waiting = loader.reload("waits.ts");
    const stopping = Date.now();

    await loader.close();
    await waiting;
    assert.ok(Date.now() - stopping < 200, "the waiting load ended with the stop");
    assert.equal(loader.list().find((each) => each.file === "waits.ts")?.error, undefined);
});

test("a built-in removed while it loads installs nothing, though a drop-in has its name", async () => {
    const { dropIn, loader, installed } = setUp();
    const builtIn = join(dropIn, "..", "built-in");

    writeFileSync(join(builtIn, "twin.ts"), gated("twin", 1, "twin"));
    writeFileSync(join(dropIn, "twin.ts"), gated("twin-drop-in", 1));
    loader.watch();

    try {
        const open = gate("twin");
        const loading = loader.reload("twin.ts");

        await new Promise((resolve) => setTimeout(resolve, 50));
        rmSync(join(builtIn, "twin.ts"));
        await new Promise((resolve) => setTimeout(resolve, 600));
        open();
        await loading;
        assert.deepEqual(installed(), []);
    } finally {
        await loader.close();
    }
});
