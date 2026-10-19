import { shapeRequest } from "../src/server/anthropic-shape.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("a request gains one Claude Code billing header ahead of its system blocks", () => {
    const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI." };
    const payload = {
        model: "claude-opus-5-5",
        system: [identity],
        messages: [{ role: "user", content: "Please fix the failing test." }],
    };
    const shaped = shapeRequest(payload);

    assert.ok(shaped !== undefined);
    assert.match(
        shaped.system[0]?.text ?? "",
        /^x-anthropic-billing-header: cc_version=2\.1\.\d+\.\w{3}; cc_entrypoint=sdk-cli; cch=\w{5};$/,
    );
    assert.deepEqual(shaped.system.slice(1), [identity]);
    assert.equal(shapeRequest(shaped), undefined);
    assert.equal(shapeRequest({ ...payload, system: undefined }), undefined);
});
