// Summary counts agree with the file diff, whether a new file is staged or not.
// Adapted from Lucas Neuhaus's issue #57 regression cases.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changesIn, diffOf } from "../src/server/changes.ts";

function fixture(firstCommit = true) {
    const root = mkdtempSync(join(tmpdir(), "pocket-counts-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");

    if (firstCommit) {
        writeFileSync(join(root, "tracked.txt"), "old\n");
        git("add", "tracked.txt");
        git("commit", "-qm", "baseline");
    }

    return { root, git };
}

const counts = (files: Awaited<ReturnType<typeof changesIn>>["files"]) =>
    files.map(({ path, added, removed }) => ({ path, added, removed }));

test("issue #57: summary stays +4 -1 when a new three-line file is staged", async (t) => {
    const { root, git } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "tracked.txt"), "new\n");
    writeFileSync(join(root, "fresh.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    git("add", ".gitignore");
    git("commit", "-qm", "ignore fixture");
    writeFileSync(join(root, "ignored.txt"), "not counted\n");

    const before = await changesIn(root, []);

    assert.deepEqual(counts(before.files), [
        { path: "tracked.txt", added: 1, removed: 1 },
        { path: "fresh.txt", added: 3, removed: 0 },
    ]);
    assert.match(await diffOf(root, "fresh.txt"), /^\+one\n\+two\n\+three$/m);
    git("add", "fresh.txt");
    assert.deepEqual(
        counts((await changesIn(root, [])).files).sort((a, b) => a.path.localeCompare(b.path)),
        counts(before.files).sort((a, b) => a.path.localeCompare(b.path)),
    );
});

test("new text, binary, empty, symlink and unusual paths keep Git's counts after staging", async (t) => {
    const { root, git } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cases = new Map([
        ["normal.txt", "one\ntwo\nthree\n"],
        ["no-final-newline.txt", "one\ntwo"],
        ["empty.txt", ""],
        ["crlf.txt", "one\r\ntwo\r\n"],
        ["unicode.txt", "Olá\n世界\n"],
        ["space tab\tnewline\n.txt", "one\n"],
    ]);

    for (const [path, content] of cases) {
        writeFileSync(join(root, path), content);
    }

    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 10]));
    symlinkSync("normal.txt", join(root, "link"));
    const before = await changesIn(root, []);

    for (const file of before.files) {
        const expected =
            file.path === "binary.bin"
                ? undefined
                : file.path === "empty.txt"
                  ? 0
                  : file.path === "normal.txt"
                    ? 3
                    : ["link", "space tab\tnewline\n.txt"].includes(file.path)
                      ? 1
                      : 2;

        assert.equal(file.added, expected, file.path);
        assert.equal(file.removed, expected === undefined ? undefined : 0, file.path);
    }

    git("add", "-A");
    assert.deepEqual(counts((await changesIn(root, [])).files), counts(before.files));
});

test("large new and staged files use counts-only output", async (t) => {
    const { root, git } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "large.txt"), `${"x".repeat(79)}\n`.repeat(131072));
    assert.equal((await changesIn(root, [])).files[0]!.added, 131072);
    git("add", "large.txt");
    assert.equal((await changesIn(root, [])).files[0]!.added, 131072);
});

test("attributes and same-size rewrites are read again without a cache", async (t) => {
    const { root } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "fresh.txt"), "a\nb\n");
    assert.equal((await changesIn(root, [])).files[0]!.added, 2);
    writeFileSync(join(root, "fresh.txt"), "abcd");
    assert.equal((await changesIn(root, [])).files[0]!.added, 1);
    writeFileSync(join(root, ".gitattributes"), "fresh.txt -diff\n");
    assert.equal(
        (await changesIn(root, [])).files.find((f) => f.path === "fresh.txt")?.added,
        undefined,
    );
    writeFileSync(join(root, ".gitattributes"), "fresh.txt diff\n");
    assert.equal((await changesIn(root, [])).files.find((f) => f.path === "fresh.txt")?.added, 1);
});

test("before the first commit, staged and untracked files both have counts", async (t) => {
    const { root, git } = fixture(false);

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "staged.txt"), "one\ntwo\n");
    git("add", "staged.txt");
    writeFileSync(join(root, "fresh.txt"), "three");
    const changes = await changesIn(root, []);

    assert.equal(changes.repo?.head, undefined);
    assert.deepEqual(counts(changes.files), [
        { path: "staged.txt", added: 2, removed: 0 },
        { path: "fresh.txt", added: 1, removed: 0 },
    ]);
});

test("new-file counts keep the 500-file cap and the invited folder's scope", async (t) => {
    const { root } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "public"));
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, "private", "secret.txt"), "not in the public total\n");

    for (let index = 0; index < 501; index++) {
        writeFileSync(join(root, "public", `new-${index}.txt`), "one\ntwo\nthree\n");
    }

    const changes = await changesIn(join(root, "public"), [], true);

    assert.equal(changes.files.length, 500);
    assert.equal(changes.more, 1);
    assert.ok(
        changes.files.every(
            (f) => f.path.startsWith("public/") && f.added === 3 && f.removed === 0,
        ),
    );
});
