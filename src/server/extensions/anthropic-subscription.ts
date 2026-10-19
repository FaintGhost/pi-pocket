/**
 * Claude subscription billing: makes Anthropic treat Pi Pocket's requests as Claude Code usage, so a Claude
 * subscription pays for them. Use at your own risk: Anthropic decides this from the request, not from the sign-in, and
 * may change how. While this is off, requests go out as Pi builds them.
 */
import { isClaudeCodeRequest, shapeRequest } from "../anthropic-shape.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";

export default function createAnthropicSubscription(host: PocketHost, web: ExtensionWeb): void {
    const stop = host.shapeModelRequests((payload, model) =>
        model.provider === "anthropic" && isClaudeCodeRequest(payload)
            ? shapeRequest(payload)
            : undefined,
    );

    web.onDispose(stop);
}
