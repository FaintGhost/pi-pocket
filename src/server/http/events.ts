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
 * How much may wait for one tab, unread: a tab that does not read its stream, or does not acknowledge its polls, is
 * cut off past it rather than hold the server's memory. It connects again, and gets a full view.
 */
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024;
const MAX_BACKLOG_EVENTS = 5000;

/** One browser tab that receives events by long polling instead of an event stream. */
interface Poller {
    id: string;
    userId: string;
    client: Client;
    queue: { seq: number; event: string; data: unknown; size: number }[];
    /** The queue's events, as JSON, in bytes. */
    bytes: number;
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
        const client = newClient(url, user, (event, data) => {
            if (response.writableEnded || response.destroyed) {
                return;
            }

            // A tab that does not read: cut off, so what waits for it does not grow without end.
            if (response.writableLength > MAX_BACKLOG_BYTES) {
                response.destroy();

                return;
            }

            response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        });

        client.close = () => response.end();
        response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        });
        response.write("retry: 1500\n\n");
        const ping = setInterval(() => response.write(": ping\n\n"), 15_000);

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
                seq: 0,
                waiting: undefined,
                timer: undefined,
                expiry: undefined,
            };

            created.client = newClient(url, user, (event, data) => {
                const size = JSON.stringify(data ?? null)?.length ?? 0;

                created.queue.push({ seq: ++created.seq, event, data, size });
                created.bytes += size;

                // A tab that does not acknowledge what it got: its session ends, and its next poll starts afresh.
                if (
                    created.bytes > MAX_BACKLOG_BYTES ||
                    created.queue.length > MAX_BACKLOG_EVENTS
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

            poller.queue = poller.queue.filter((item) => item.seq > ack);
            poller.bytes = poller.queue.reduce((sum, item) => sum + item.size, 0);
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
