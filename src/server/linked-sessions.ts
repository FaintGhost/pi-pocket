/** Sessions started by another session: lasting links, independent agents, and messages between them that go once. */
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import type { LinkedSession, LinkedSessionsApi } from "./host.ts";
import { LinkedSessionCallDoc, LinkedSessionPeersDoc, PlanDoc, SessionsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { defang } from "./fence.ts";
import { isThinkingLevel, levelAtMost, resolveModel, THINKING_LEVELS } from "./models.ts";
import { requestFor } from "./requests.ts";

const context = BACKGROUND_CONTEXT;

/** The most linked sessions one session may start. Linked sessions start none, so a team is one level deep. */
const MAX_STARTED = 10;

/** Stable across restarts, short enough that Commands.submit preserves the entire request key. */
function callKey(source: ConversationId, key: string): string {
    return createHash("sha256").update(`${source}:${key}`).digest("hex");
}

export class LinkedSessions implements LinkedSessionsApi {
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

    /** The source's addresses for `targets`, made for those that have none yet: in one commit, only when one is new. */
    async #addresses(
        source: ConversationId,
        targets: readonly number[],
    ): Promise<Map<number, string>> {
        const app = this.#app;
        const find = (peers: Record<string, number>) =>
            new Map(
                Object.entries(peers)
                    .filter(([, id]) => targets.includes(id))
                    .map(([address, id]) => [id, address]),
            );
        const known = find(
            (await app.harness.snapshot(LinkedSessionPeersDoc, source, context))?.peers ?? {},
        );

        if (targets.every((target) => known.has(target))) {
            return known;
        }

        return app.harness.commit(async (tx) => {
            const state = await tx.doc(LinkedSessionPeersDoc, source);
            const found = find(state.peers);

            for (const target of targets) {
                if (!found.has(target)) {
                    const address = `session-${randomUUID()}`;

                    state.peers[address] = target;
                    found.set(target, address);
                }
            }

            return found;
        }, context);
    }

    async #address(source: ConversationId, target: number): Promise<string> {
        return (await this.#addresses(source, [target])).get(target)!;
    }

    /** Only visible sessions connect a family. Names show only when the source's whole audience sees them. */
    async list(source: ConversationId): Promise<LinkedSession[]> {
        const app = this.#app;
        const peers = this.#family(source, this.#person(source)).filter(
            (each) => each.id !== Number(source),
        );
        const audience = app.config.users.filter((user) => app.canSee(user, source));
        const addresses = await this.#addresses(
            source,
            peers.map((each) => each.id),
        );

        return peers.map((each) => {
            const shared = audience.every((user) =>
                app.canSee(user, each.id as unknown as ConversationId),
            );

            return {
                address: addresses.get(each.id)!,
                ...(shared
                    ? { title: each.title, cwd: each.cwd, busy: each.busy, archived: each.archived }
                    : {}),
            };
        });
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
            .filter((each) => found.has(each.id))
            .map((each) => ({
                id: each.id,
                title: each.title ?? "New session",
                cwd: each.cwd,
                busy: each.busy,
                archived: each.archived === true,
            }));
    }

    /** One call makes the session and sends its first message; its record makes a repeat do neither again. */
    async start(
        source: ConversationId,
        request: { title?: string; message: string; model?: string; thinking?: string },
        key: string,
    ): Promise<{ session: ConversationId; address: string }> {
        const app = this.#app;

        if (!request.message.trim()) {
            throw new HttpError(400, "Starting a linked session needs a title and a message.");
        }

        const title =
            (request.title ?? request.message.split("\n")[0]!)
                .trim()
                .replace(/\s+/g, " ")
                .slice(0, 120) || "Linked session";
        const token = callKey(source, key);
        const previous = await app.harness.snapshot(LinkedSessionCallDoc, source, token, context);
        const user = this.#person(source, previous?.by);

        app.requireSteer(user);

        const session =
            previous?.conversationId === undefined
                ? await this.#create(source, user, { ...request, title }, token)
                : (previous.conversationId as unknown as ConversationId);
        const address = await this.#address(source, Number(session));

        await this.#deliver(source, session, user, request.message, false, token);

        return { session, address };
    }

    /** Make the linked session and the call's record, in one commit. */
    async #create(
        source: ConversationId,
        user: User,
        request: { title: string; model?: string; thinking?: string },
        token: string,
    ): Promise<ConversationId> {
        const app = this.#app;
        const title = request.title;

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        if (app.sessionMeta(source)?.linkedFrom !== undefined) {
            throw new HttpError(403, "A linked session cannot start sessions.");
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
        const chosen = `${model.provider}/${model.modelId}`;

        // Only people choose models: the source's own, or one the owner allows for subagents.
        if (
            chosen !== (agent.model && `${agent.model.provider}/${agent.model.modelId}`) &&
            !app.config.subagentModels.includes(chosen)
        ) {
            throw new HttpError(403, `The model ${chosen} is not allowed here.`);
        }

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
            const started = Object.values(sessions.items).filter(
                (each) => each.linkedFrom?.id === Number(source),
            ).length;

            if (started >= MAX_STARTED) {
                throw new HttpError(
                    409,
                    `A session can start at most ${String(MAX_STARTED)} linked sessions.`,
                );
            }

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

    /** Send a message to a linked session, by the source's address for it. Taken, not answered: no reply waits. */
    async send(
        source: ConversationId,
        request: { to: string; message: string; steer?: boolean },
        key: string,
    ): Promise<void> {
        const app = this.#app;
        const peers =
            (await app.harness.snapshot(LinkedSessionPeersDoc, source, context))?.peers ?? {};
        const target = Object.hasOwn(peers, request.to) ? peers[request.to] : undefined;

        if (target === undefined || target === Number(source) || !request.message.trim()) {
            throw new HttpError(400, "Send needs another linked session's address and a message.");
        }

        const token = callKey(source, key);
        const previous = await app.harness.snapshot(LinkedSessionCallDoc, source, token, context);
        const user = this.#person(source, previous?.by);

        app.requireSteer(user);

        if (!this.#family(source, user).some((each) => each.id === target)) {
            throw new HttpError(
                404,
                "That session is not linked or is not shared with you. List linked sessions first.",
            );
        }

        const id = target as unknown as ConversationId;

        await this.#deliver(source, id, user, request.message, request.steer === true, token, () =>
            // Whom it acts for is kept before it is sent: someone else writing there later changes nothing on a repeat.
            app.harness.commit(async (tx) => {
                const record = await tx.doc(LinkedSessionCallDoc, source, token, {});

                if (record.conversationId !== undefined && record.conversationId !== target) {
                    throw new HttpError(409, "This call already refers to another linked session.");
                }

                record.conversationId = target;
                record.by ??= user.id;
            }, context),
        );
    }

    /**
     * Send `message` from `source` to `target` as `user`, once for `token`: a repeat finds the first. The checks run
     * first, then `record`, then the message goes.
     */
    async #deliver(
        source: ConversationId,
        target: ConversationId,
        user: User,
        message: string,
        steer: boolean,
        token: string,
        record?: () => Promise<void>,
    ): Promise<void> {
        const app = this.#app;
        const requestId = requestFor(user.id, token);
        const existing = await app.harness.commit(
            (tx) => tx.submissionByRequest(target, requestId),
            context,
        );

        if (existing !== undefined) {
            return;
        }

        await this.#maySend(source, user);
        await app.requireDriver(target, user);
        app.spend.check(user, target);
        await record?.();
        // The target's own address for the source: it learns no session id.
        const replyTo = await this.#address(target, Number(source));
        // Words before the fence, so a message that starts with / is text, never a command or a prompt template.
        const text = `Message from linked session ${replyTo}. Send a reply to that address when one is needed. Another session's agent wrote it, not the person.\n<linked-session-message>\n${defang(message)}\n</linked-session-message>`;

        await app.commands.submit(
            target,
            user,
            { text, requestId: token, mode: steer ? "steer" : "followUp" },
            `linked session ${replyTo}`,
        );
    }
}
