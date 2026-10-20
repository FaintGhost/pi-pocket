// Every module that translates a string must import the translator: a bare t() throws when the component first
// renders, and nothing else notices — TypeScript does not check these files' globals, and the pack test only reads
// the keys that got wrapped. A wrapped string without its import is a panel that refuses to open.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const web = new URL("../web/", import.meta.url).pathname;

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : path.endsWith(".js") ? [path] : [];
    });
}

/** The translator, imported under the name the call sites use. */
const IMPORTS_T = /import\s*(?:[\w$]+\s*,\s*)?\{[^}]*\bt\b[^}]*\}\s*from\s*"\.{1,2}\/(?:[\w/]*\/)?i18n\.js"/;

test("a module that calls t() imports it", () => {
    const missing = files(web)
        .filter((path) => !path.endsWith("/i18n.js"))
        .filter((path) => {
            const source = readFileSync(path, "utf8");
            const calls = /(?<![\w$.])t\(/.test(source);
            return calls && !IMPORTS_T.test(source);
        })
        .map((path) => relative(web, path));

    assert.deepEqual(missing, [], `these files call t() without importing it: ${missing.join(", ")}`);
});

test("a module that imports t() also calls it, or the import is dead", () => {
    const unused = files(web)
        .filter((path) => !path.endsWith("/i18n.js"))
        .filter((path) => {
            const source = readFileSync(path, "utf8");
            return IMPORTS_T.test(source) && !/(?<![\w$.])t\(/.test(source);
        })
        .map((path) => relative(web, path));

    assert.deepEqual(unused, [], `these files import t() without calling it: ${unused.join(", ")}`);
});
