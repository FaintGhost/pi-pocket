/**
 * Live events for each browser tab: an event stream (`/api/events`), or long polling (`/api/poll`) for connections
 * that hold event streams back. Either way the tab is a `Client` that the app attaches.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import type { Client } from "../room.ts";
import { conversationId, json } from "./io.ts";

/** How long a poll waits for events before answering empty, and how long an unpolled session lives. */
const POLL_HOLD_MS = 25_000;
const POLL_EXPIRE_MS = 60_000;
/**
 * How far behind a tab may fall. Past `BEHIND_BYTES` (or `BEHIND_EVENTS` waiting), a tab must keep up: one that took
 * nothing (its stream did not drain, or it acknowledged no poll) for `STALLED_MS` is cut off, rather than hold the
 * server's memory without end; it connects again, and gets a full view. A tab that keeps taking is not cut off for being
 * behind, so a session's first view, however large, and a slow phone that still reads both come through. Past
 * `MAX_BEHIND_BYTES` any tab is cut off.
 */
const BEHIND_BYTES = 8 * 1024 * 1024;
const BEHIND_EVENTS = 5000;
const STALLED_MS = 30_000;
const MAX_BEHIND_BYTES = 128 * 1024 * 1024;

/** One browser tab that receives events by long polling instead of an event stream. */
interface Poller {
    id: string;
    userId: string;
    client: Client;
    queue: { seq: number; event: string; data: unknown; size: number }[];
    /** The queue's events, as JSON, in bytes. */
    bytes: number;
    /** When the tab last took something: its poll acknowledged events, or nothing waited for it. */
    tookAt: number;
    seq: number;
    waiting: ServerResponse | undefined;
    timer: NodeJS.Timeout | undefined;
    expiry: NodeJS.Timeout | undefined;
}

function newClient(url: URL, user: User, send: Client["send"]): Client {
    const raw = url.searchParams.get("c");

    return {
        id: (url.searchParams.get("tab") ?? randomUUID()).slice(0, 64),
        connection: randomUUID(),
        user,
        conversationId: raw === null || raw === "" ? undefined : conversationId(raw),
        sentEntries: new Set(),
        orderKey: "",
        send,
    };
}

/** The event routes of one HTTP handler, with their own pollers. */
export function createEventStreams(app: PocketApp) {
    const events = async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        user: User,
    ): Promise<void> => {
        // What went to the stream, and of it what the tab took (left the stream's buffer), and when it last took some.
        let written = 0;
        let taken = 0;
        let tookAt = Date.now();

        const write = (text: string) => {
            written += Buffer.byteLength(text);
            response.write(text);
        };

        const client = newClient(url, user, (event, data) => {
            if (response.writableEnded || response.destroyed) {
                return;
            }

            const behind = response.writableLength;
            const now = Date.now();

            if (written - behind > taken || behind <= BEHIND_BYTES) {
                taken = written - behind;
                tookAt = now;
            }

            // A tab that takes nothing for long while far behind, or one too far behind: cut off.
            if (behind > MAX_BEHIND_BYTES || now - tookAt > STALLED_MS) {
                response.destroy();

                return;
            }

            write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        });

        client.close = () => response.end();
        response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        });
        write("retry: 1500\n\n");
        const ping = setInterval(() => write(": ping\n\n"), 15_000);

        request.on("close", () => {
            clearInterval(ping);
            app.detach(client);
        });
        await app.attach(client);
    };

    // ─── Long polling: the same events as /api/events, for connections that hold back event streams (Cloudflare
    // quick tunnels do). Each answer carries every event after the client's `ack`, so a lost answer is sent again.
    const pollers = new Map<string, Poller>();

    const answerPoll = (poller: Poller): void => {
        clearTimeout(poller.timer);
        poller.timer = undefined;
        const response = poller.waiting;

        poller.waiting = undefined;

        if (response !== undefined && !response.writableEnded) {
            json(response, 200, {
                session: poller.id,
                events: poller.queue.map(({ seq, event, data }) => ({ seq, event, data })),
            });
        }
    };

    const closePoller = (poller: Poller): void => {
        clearTimeout(poller.expiry);

        if (!pollers.delete(poller.id)) {
            return;
        }

        answerPoll(poller);
        app.detach(poller.client);
    };

    const keepPoller = (poller: Poller): void => {
        clearTimeout(poller.expiry);
        poller.expiry = setTimeout(
            () => (poller.waiting === undefined ? closePoller(poller) : keepPoller(poller)),
            POLL_EXPIRE_MS,
        );
        poller.expiry.unref();
    };

    const poll = async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        user: User,
    ): Promise<void> => {
        let poller = pollers.get(url.searchParams.get("session") ?? "");

        if (poller !== undefined && poller.userId !== user.id) {
            poller = undefined;
        }

        if (url.searchParams.get("close") === "1") {
            if (poller !== undefined) {
                closePoller(poller);
            }

            return json(response, 200, { ok: true });
        }

        if (poller === undefined) {
            // A new tab, or one whose session ended (the server restarted): attach afresh, which sends hello and a full view.
            const created: Poller = {
                id: randomUUID(),
                userId: user.id,
                client: undefined as unknown as Client,
                queue: [],
                bytes: 0,
                tookAt: Date.now(),
                seq: 0,
                waiting: undefined,
                timer: undefined,
                expiry: undefined,
            };

            created.client = newClient(url, user, (event, data) => {
                let size = 0;

                try {
                    size = Buffer.byteLength(JSON.stringify(data ?? null) ?? "null");
                } catch {
                    // Not JSON: its answer would fail as it is, and it weighs nothing here.
                }

                created.queue.push({ seq: ++created.seq, event, data, size });
                created.bytes += size;

                const behind = created.bytes > BEHIND_BYTES || created.queue.length > BEHIND_EVENTS;

                // A tab far behind that acknowledged nothing for long, or one too far behind: its session ends, and its
                // next poll starts afresh, with a full view.
                if (
                    created.bytes > MAX_BEHIND_BYTES ||
                    (behind && Date.now() - created.tookAt > STALLED_MS)
                ) {
                    created.queue = [];
                    created.bytes = 0;
                    closePoller(created);

                    return;
                }

                // A short pause lets a burst of events go out in one answer.
                if (created.waiting !== undefined) {
                    clearTimeout(created.timer);
                    created.timer = setTimeout(() => answerPoll(created), 30);
                }
            });
            created.client.close = () => closePoller(created);
            pollers.set(created.id, created);
            keepPoller(created);
            await app.attach(created.client);
            poller = created;
        } else {
            const ack = Number(url.searchParams.get("ack") ?? 0);

            const before = poller.queue.length;

            poller.queue = poller.queue.filter((item) => item.seq > ack);
            poller.bytes = poller.queue.reduce((sum, item) => sum + item.size, 0);

            // It took something, or nothing waits for it: it keeps up.
            if (poller.queue.length < before || poller.queue.length === 0) {
                poller.tookAt = Date.now();
            }

            keepPoller(poller);
        }

        const current = poller;

        // One waiting request per tab: an older one answers now.
        if (current.waiting !== undefined) {
            answerPoll(current);
        }

        current.waiting = response;
        current.timer = setTimeout(
            () => answerPoll(current),
            current.queue.length > 0 ? 30 : POLL_HOLD_MS,
        );
        // Closes when answered, or when the browser gives up on this request.
        response.on("close", () => {
            if (current.waiting !== response) {
                return;
            }

            clearTimeout(current.timer);
            current.waiting = undefined;
        });
    };

    return { events, poll };
}
