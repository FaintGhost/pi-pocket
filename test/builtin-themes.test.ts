// The themes in web/themes/ ship with the app: one that fails the server's checks would quietly not be offered.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";
import { Themes } from "../src/server/themes.ts";

test("every built-in theme passes the server's checks", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pi-pocket-test-themes-"));
    const told: string[] = [];
    const themes = new Themes({
        builtIn: join(APP_ROOT, "web", "themes"),
        dataDir,
        notify: (message) => told.push(message),
        changed: () => {},
        log: (line) => told.push(line),
    });

    try {
        await themes.load();
        assert.deepEqual(
            themes.list().filter((theme) => !theme.usable || theme.problem !== undefined),
            [],
        );
        assert.deepEqual(told, []);
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
});
