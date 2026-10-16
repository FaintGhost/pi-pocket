/**
 * `/themes/:id/:rev/…`: a theme's files, for everyone signed in (`themes.ts`). Its CSS as it was checked, from memory;
 * its fonts and images from disk, opened as they were checked. Any version in the address serves the files as they are
 * now: the version is there so a changed theme gets a new address.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { THEME_LIMITS } from "../themes/format.ts";
import { sniffImage } from "./assets.ts";
import { opened } from "./extension-routes.ts";
import { send } from "./io.ts";

/** Opened on its own, an SVG could run script with the app's origin: give it an opaque one. */
const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

export function themeFile(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    parts: string[],
    user: User | undefined,
): void {
    if (user === undefined) {
        throw new HttpError(401, "Sign in first");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");

        throw new HttpError(405, "Files are only read");
    }

    const [id, rev, ...path] = parts;
    const served = id === undefined ? undefined : app.themes.file(id, rev, path);

    if (served === undefined) {
        throw new HttpError(404, "Not found");
    }

    const found = served.file;
    const headers = {
        // The version in the address is the files' hash: under the current one, nothing else will ever be served, so the
        // browser keeps it. An older address serves what is there now, and asks each time.
        "cache-control": served.current
            ? "private, max-age=31536000, immutable"
            : "private, no-cache",
        // Another site's page may not use it: the sign-in cookie would go along with the request.
        "cross-origin-resource-policy": "same-origin",
    };

    if ("css" in found) {
        send(response, 200, found.css, "text/css; charset=utf-8", headers);

        return;
    }

    let body: Buffer;
    let fd: number;

    try {
        fd = openSync(found.file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch {
        throw new HttpError(404, "Not found");
    }

    try {
        const stats = fstatSync(fd);

        if (!stats.isFile() || !opened(fd, found, stats) || stats.size > THEME_LIMITS.asset) {
            throw new HttpError(404, "Not found");
        }

        body = readFileSync(fd);
    } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(404, "Not found");
    } finally {
        closeSync(fd);
    }

    // What it holds must be what its name says: a font, or an image of that kind.
    const sniffed =
        found.type === "font/woff2"
            ? body.subarray(0, 4).toString("latin1") === "wOF2"
                ? "font/woff2"
                : undefined
            : sniffImage(body.subarray(0, 1024));

    if (sniffed !== found.type) {
        throw new HttpError(415, "That file is not what its name says");
    }

    send(response, 200, body, found.type, {
        ...headers,
        ...(found.type === "image/svg+xml" ? { "content-security-policy": SVG_CSP } : {}),
    });
}
