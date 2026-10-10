/**
 * `/hook/<id>/<secret>`, and `/hook/<id>` with GitHub's signature: posts from other services, which `hooks.ts` turns
 * into messages to Pi. No sign-in and no `X-Pocket` header: the secret is what lets a post in.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import { HttpError } from "../errors.ts";
import { MAX_POST } from "../hooks.ts";
import { json, readBody } from "./io.ts";

export async function hookRoute(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    id: string,
    secret: string | undefined,
): Promise<void> {
    if (request.method !== "POST") {
        response.setHeader("allow", "POST");

        throw new HttpError(405, "Webhooks take POST.");
    }

    await app.hooks.precheck(id, secret);
    const body = await readBody(request, MAX_POST);
    const answer = await app.hooks.deliver(id, {
        ...(secret === undefined ? {} : { secret }),
        headers: request.headers,
        body,
    });

    json(response, answer.status, { ok: true, message: answer.message });
}
