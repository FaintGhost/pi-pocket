// A theme's CSS reaches only its own folder: the page's content security policy keeps every load on this server, and
// these checks keep a theme from any other address on it (`url(/login?token=…)`, an API route), however it is written.
import { root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readTheme } from "../src/server/themes.ts";
import { ThemeProblem } from "../src/server/themes/format.ts";

test("a theme's CSS may load only files in its own folder", () => {
    const dir = join(root, "themes", "mine");

    mkdirSync(join(dir, "fonts"), { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ themeApi: 1, name: "Mine" }));
    writeFileSync(join(dir, "fonts", "a.woff2"), "wOF2");

    const css = (rule: string) => {
        writeFileSync(join(dir, "theme.css"), `@font-face { src: url(fonts/a.woff2); }\n${rule}\n`);

        return () => readTheme(dir, "mine", false, "0.15.0");
    };

    assert.equal(css(":root { --x: 1px; }")().assets.size, 1);

    for (const rule of [
        "a { background: url(https://elsewhere.example/a.png); }",
        "a { background: url(/login?token=a); }",
        "a { background: \\75 rl(../../a.png); }",
        'a { background: image-set("/api/me" 1x); }',
    ]) {
        assert.throws(css(rule), ThemeProblem, rule);
    }
});
