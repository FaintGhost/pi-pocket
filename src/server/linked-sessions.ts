/** Sessions started by another session: lasting links, independent agents, and messages between them that go once. */
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { LinkedSessionCallDoc, LinkedSessionPeersDoc, PlanDoc, SessionsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { defang } from "./fence.ts";
import { isThinkingLevel, levelAtMost, resolveModel, THINKING_LEVELS } from "./models.ts";
import { requestFor } from "./requests.ts";

const context = BACKGROUND_CONTEXT;

/** Stable across restarts, short enough that Commands.submit preserves the entire request key. */
function callKey(source: ConversationId, key: string): string {
    return createHash("sha256").update(`${source}:${key}`).digest("hex");
}

export class LinkedSessions {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** A session's current requester, or the requester frozen by a previous execution of this call. */
    #person(source: ConversationId, by?: string): User {
        const app = this.#app;
        const meta = app.sessionMeta(source);
        const requester = by ?? app.attribution.requesterOf(source);
        const user = requester === undefined ? undefined : app.config.userById(requester);

        if (meta === undefined || meta.pip !== undefined || user === undefined) {
            throw new HttpError(403, "Linked sessions need a session with someone Pi works for.");
        }

        app.requireSee(user, source);

        return user;
    }

    async #maySend(source: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        await app.requireDriver(source, user);

        if ((await app.harness.snapshot(PlanDoc, source, context))?.on) {
            throw new HttpError(
                409,
                "Approve this session's plan before starting or messaging linked sessions.",
            );
        }

        app.spend.check(user, source);
    }

    /** Stable local addresses let agents coordinate without writing private session ids into shared transcripts. */
    async address(source: ConversationId, target: number): Promise<string> {
        const user = this.#person(source);

        if (!this.#family(source, user).some((chat) => chat.id === target)) {
            throw new HttpError(404, "That peer is not linked or is not shared with you.");
        }

        return this.#address(source, target);
    }

    async #address(source: ConversationId, target: number): Promise<string> {
        return this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(LinkedSessionPeersDoc, source);
            const existing = Object.entries(state.peers).find(([, id]) => id === target)?.[0];

            if (existing !== undefined) {
                return existing;
            }

            const handle = `session-${randomUUID()}`;

            state.peers[handle] = target;

            return handle;
        }, context);
    }

    /** Only visible nodes connect a family. Results also respect the shared transcript's entire audience. */
    async list(source: ConversationId) {
        const app = this.#app;
        const peers = this.#family(source, this.#person(source)).filter(
            (chat) => chat.id !== Number(source),
        );
        const audience = app.config.users.filter((user) => app.canSee(user, source));

        return Promise.all(
            peers.map(async (chat) => {
                const shared = audience.every((user) =>
                    app.canSee(user, chat.id as unknown as ConversationId),
                );

                return {
                    id: chat.id,
                    handle: await this.#address(source, chat.id),
                    ...(shared
                        ? {
                              title: chat.title,
                              cwd: chat.cwd,
                              busy: chat.busy,
                              archived: chat.archived,
                          }
                        : {}),
                };
            }),
        );
    }

    #family(source: ConversationId, user: User) {
        const sessions = this.#app.sessions(user);
        const found = new Set([Number(source)]);
        let changed = true;

        while (changed) {
            changed = false;

            for (const session of sessions) {
                const origin = session.linkedFrom?.id;

                if (origin !== undefined && (found.has(session.id) || found.has(origin))) {
                    for (const id of [session.id, origin]) {
                        if (!found.has(id)) {
                            found.add(id);
                            changed = true;
                        }
                    }
                }
            }
        }

        return sessions
            .filter((chat) => found.has(chat.id))
            .map((chat) => ({
                id: chat.id,
                title: chat.title ?? "New session",
                cwd: chat.cwd,
                busy: chat.busy,
                archived: chat.archived === true,
            }));
    }

    /** Creation and its receipt are atomic: a replay never leaves an extra session behind. */
    async start(
        source: ConversationId,
        request: { title: string; message: string; model?: string; thinking?: string },
        key: string,
    ): Promise<ConversationId> {
        const app = this.#app;
        const title = request.title.trim().replace(/\s+/g, " ").slice(0, 120);

        if (!title || !request.message.trim()) {
            throw new HttpError(400, "Starting a linked session needs a title and a message.");
        }

        const token = callKey(source, key);
        const previous = await app.harness.snapshot(LinkedSessionCallDoc, source, token, context);
        const user = this.#person(source, previous?.by);

        app.requireSteer(user);

        if (previous?.conversationId !== undefined) {
            return previous.conversationId as unknown as ConversationId;
        }

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        await this.#maySend(source, user);
        // Copy omitted settings once; an explicit override must never silently select another model.
        const agent = structuredClone((await app.agentState(source)) ?? {});
        const spec =
            request.model === undefined
                ? agent.model && `${agent.model.provider}/${agent.model.modelId}`
                : request.model.trim();
        const wantedThinking = request.thinking ?? agent.thinkingLevel ?? "off";

        if (!spec || spec.indexOf("/") <= 0) {
            throw new HttpError(
                400,
                "Starting a linked session needs a model: this session has none, so name one as provider/modelId.",
            );
        }

        if (!isThinkingLevel(wantedThinking)) {
            throw new HttpError(400, `Thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
        }

        let thinking = wantedThinking;
        const model = resolveModel(app.models, spec, app.signInNeeded);
        const selected = app.models.getModel(model.provider, model.modelId)!;
        const supported = getSupportedThinkingLevels(selected);

        if (request.model !== undefined && request.thinking === undefined) {
            thinking = levelAtMost(selected, thinking) ?? supported[0]!;
        }

        if (!supported.includes(thinking)) {
            throw new HttpError(
                400,
                `Model ${spec} does not support thinking ${thinking}. Supported levels: ${supported.join(", ")}. Do not substitute another route.`,
            );
        }

        const problem = await app.providers.problem(model, true);

        if (problem !== undefined) {
            throw new HttpError(
                400,
                `Model ${spec} is not available: ${problem}. Stop and report this; do not substitute another route.`,
            );
        }

        const cwd = agent.cwd ?? app.cwdOf(source);
        const now = Date.now();

        return app.harness.commit(async (tx) => {
            const receipt = await tx.doc(LinkedSessionCallDoc, source, token, {});

            if (receipt.conversationId !== undefined) {
                return receipt.conversationId as unknown as ConversationId;
            }

            const sessions = await tx.doc(SessionsDoc);
            const child = await tx.createConversation({ ownership: { kind: "ownerless" } });

            Object.assign(await tx.doc(AgentDoc, child.id), agent, {
                cwd,
                model,
                thinkingLevel: thinking,
            });
            sessions.items[String(child.id)] = {
                cwd,
                title,
                createdAt: now,
                updatedAt: now,
                createdBy: user.id,
                linkedFrom: { id: Number(source) },
            };
            receipt.conversationId = Number(child.id);
            receipt.by = user.id;

            return child.id;
        }, context);
    }

    /** Fire-and-forget peer input; acceptance, not an answer, is returned. No automatic reply loops. */
    async send(
        source: ConversationId,
        target: number | string,
        message: string,
        steer: boolean,
        key: string,
    ): Promise<{ requestId: string }> {
        const app = this.#app;

        if (typeof target === "string") {
            const peers =
                (await app.harness.snapshot(LinkedSessionPeersDoc, source, context))?.peers ?? {};

            target = Object.hasOwn(peers, target) ? peers[target]! : NaN;
        }

        if (!Number.isSafeInteger(target) || target === Number(source) || !message.trim()) {
            throw new HttpError(400, "Send needs another linked session's address and a message.");
        }

        const token = callKey(source, key);
        const previous = await app.harness.snapshot(LinkedSessionCallDoc, source, token, context);
        const user = this.#person(source, previous?.by);

        app.requireSteer(user);

        if (!this.#family(source, user).some((chat) => chat.id === target)) {
            throw new HttpError(
                404,
                "That session is not linked or is not shared with you. List linked sessions first.",
            );
        }

        const id = target as unknown as ConversationId;
        const requestId = requestFor(user.id, token);
        const existing = await app.harness.commit(
            (tx) => tx.submissionByRequest(id, requestId),
            context,
        );

        if (existing !== undefined) {
            return { requestId };
        }

        await this.#maySend(source, user);
        await app.requireDriver(id, user);
        app.spend.check(user, id);
        // Freeze the requester before submission: another person's later steer cannot change replay identity.
        await app.harness.commit(async (tx) => {
            const receipt = await tx.doc(LinkedSessionCallDoc, source, token, {});

            if (receipt.conversationId !== undefined && receipt.conversationId !== target) {
                throw new HttpError(409, "This call already refers to another linked session.");
            }

            receipt.conversationId = target;
            receipt.by ??= user.id;
        }, context);
        // A recipient-local address reveals no source id, even to someone invited only to the recipient later.
        const replyTo = await this.#address(id, Number(source));
        // Prefix before admission, so a peer's /command is text, never an extension command or prompt expansion.
        const text = `Message from linked session ${replyTo}. Send a reply to that address when one is needed. Another session's agent wrote it, not the person.\n<linked-session-message>\n${defang(message)}\n</linked-session-message>`;
        const sent = await app.commands.submit(
            id,
            user,
            { text, requestId: token, mode: steer ? "steer" : "followUp" },
            `linked session ${replyTo}`,
        );

        return { requestId: sent.requestId };
    }
}
