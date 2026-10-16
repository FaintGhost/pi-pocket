// The extension gallery: what comes from its index is untrusted, and what it installs never runs on its own.
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dataDir = join(root, "gallery-data");
const dropIns = join(dataDir, "extensions");
const INDEX = "https://raw.githubusercontent.com/TannerMidd/pi-pocket-extensions/HEAD/index.json";

const clock = `/** A clock tool, for the gallery's tests. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default () => defineExtension({
    name: "test-clock",
    tools: [defineTool({ name: "test_clock", description: "Now", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "now" }] }) })],
});
`;

/** What the stand-in for the network serves, by address. */
const served = new Map<string, string>();
let app: Awaited<ReturnType<typeof openApp>>;

/** An entry for `name` whose files are `files` (name to text) at `commit`, served where the gallery downloads them. */
function entry(name: string, files: Record<string, string>, commit: string, extra = {}) {
    for (const [file, text] of Object.entries(files)) {
        served.set(
            `https://raw.githubusercontent.com/someone/pocket-${name}/${commit}/${file}`,
            text,
        );
    }

    return {
        name,
        title: `Test ${name}`,
        description: "For the gallery's tests.",
        tags: ["test"],
        author: { name: "Someone" },
        version: "1.0.0",
        source: { repo: `someone/pocket-${name}`, commit },
        files: Object.entries(files).map(([file, text]) => ({
            name: file,
            sha256: createHash("sha256").update(text).digest("hex"),
            size: Buffer.byteLength(text),
        })),
        pocketApi: 1,
        minPocket: "0.14.0",
        declares: {
            extensions: ["test-clock"],
            tools: ["test_clock"],
            readOnlyTools: [],
            hooks: [],
            sections: [],
            wraps: [],
            routes: [],
            client: null,
            access: "owner",
        },
        ...extra,
    };
}

/** Serve an index of these entries, and have the gallery read it. */
async function index(...entries: unknown[]) {
    served.set(INDEX, JSON.stringify({ format: 1, extensions: entries }));

    return app.gallery.listing(true);
}

before(async () => {
    app = await openApp(scriptedModel(), dataDir);
    app.gallery.fetch = async (url) =>
        served.has(url) ? new Response(served.get(url)) : new Response("", { status: 404 });
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("an entry whose file would leave the extensions folder is not listed, and writes nothing", async () => {
    const listing = await index(
        entry("escape", { "escape.ts": clock, "../escape.ts": clock }, "1".repeat(40)),
    );

    assert.deepEqual(listing.entries, []);
    assert.match(listing.hidden.invalid[0]?.problem ?? "", /files\[1\]\.name/);
    await assert.rejects(app.gallery.install("escape", "1".repeat(40)), { status: 404 });
    assert.ok(!existsSync(join(dataDir, "escape.ts")));
    assert.ok(!existsSync(join(dropIns, "escape.ts")));
});

test("a file that does not match its pinned SHA-256 installs nothing", async () => {
    const commit = "2".repeat(40);

    await index(entry("tampered", { "tampered.ts": clock }, commit));
    // The file at the pinned commit is not the one the index pinned, though it is as long.
    served.set(
        `https://raw.githubusercontent.com/someone/pocket-tampered/${commit}/tampered.ts`,
        clock.replace("now", "new"),
    );

    await assert.rejects(app.gallery.install("tampered", commit), (error: Error) => {
        assert.match(error.message, /SHA-256/);

        return true;
    });
    assert.deepEqual(
        readdirSync(dropIns).filter(
            (file) => file.startsWith("tampered") || file.includes(".part"),
        ),
        [],
    );
});

test("an installed extension arrives off, even under a name that was turned on before", async () => {
    const commit = "3".repeat(40);

    // A drop-in of this name was on once, and its file was removed by hand: the choice stayed.
    app.config.setExtensionEnabled("stale.ts", true);
    await index(entry("stale", { "stale.ts": clock }, commit));

    const installed = await app.gallery.install("stale", commit);

    assert.ok(existsSync(join(dropIns, "stale.ts")));
    assert.equal(installed.enabled, false);
    assert.equal(app.loader.enabled("stale.ts"), false);
    assert.ok(!app.loader.extensionNames().includes("test-clock"));
});

test("a revoked version is flagged where it is installed, and is never installed again", async () => {
    const first = "4".repeat(40);
    const fixed = "5".repeat(40);

    await index(entry("revoked", { "revoked.ts": clock }, first));
    await app.gallery.install("revoked", first);
    await app.setExtensionEnabled(owner(app), "revoked.ts", true);

    // The index revokes it: the version installed here, and, in another entry, the only one there is.
    await index(
        entry("revoked", { "revoked.ts": clock.replace("now", "later") }, fixed, {
            revoked: [{ commit: first, reason: "It sends your config away." }],
        }),
        entry("withdrawn", { "withdrawn.ts": clock }, first, {
            revoked: [{ commit: first, reason: "Withdrawn." }],
        }),
    );

    const [state] = (await app.gallery.installed()).items.filter((each) => each.name === "revoked");

    assert.equal(state?.revoked, "It sends your config away.");
    assert.equal(state?.enabled, true);
    assert.equal(state?.update?.commit, fixed);
    await assert.rejects(app.gallery.install("withdrawn", first), { status: 409 });
});
