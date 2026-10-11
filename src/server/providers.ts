/**
 * Model providers: which ones Pi knows, whether each is signed in, and sign-ins run from the app. A sign-in asks its
 * questions (an API key, a code, a choice) through the tabs of the person who started it. Pi Pocket shares Pi's own
 * sign-ins (`~/.pi/agent/auth.json`).
 *
 * A subscription's sign-in (OAuth) counts as signed in for as long as it is stored, even once it can no longer be
 * renewed. So each is asked afresh (the Providers sheet, a model Pi or PiP is about to use, a run that failed on it):
 * one its provider refuses to renew is marked as needing sign-in, its models are offered to no one, and the owner is
 * told, until someone signs in again.
 */
import { randomUUID } from "node:crypto";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { modelList } from "./models.ts";

/** How long asking a provider's sign-in afresh may take: a renewal's own limit is 15 seconds. */
const CHECK_MS = 20_000;

/** What a provider says when it will not renew a sign-in, as opposed to a network that failed on the way. */
const REFUSED =
    /invalid_grant|invalid_token|invalid_client|unauthori[sz]ed|revoked|expired|reauth|sign in again|log ?in again|\b40[013]\b/i;

/** What a failed run says when its provider's sign-in could not be renewed (pi-ai's `ModelsError`), and whose. */
const RENEWAL_FAILED = /OAuth (?:refresh|auth derivation) failed for ([\w.-]+)/;

/** An error and its causes, as one line. */
function chain(error: unknown): string {
    const parts: string[] = [];
    let each: unknown = error;

    for (let depth = 0; each !== undefined && each !== null && depth < 5; depth++) {
        parts.push(each instanceof Error ? each.message : String(each));
        each = each instanceof Error ? each.cause : undefined;
    }

    return parts.join(": ").replace(/\s+/g, " ").slice(0, 300);
}

/** A network or TLS failure on the way, which says nothing about the sign-in (a certificate can be "expired" too). */
const ON_THE_WAY =
    /certificate|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timed? ?out|aborted/i;

/** Whether an error from asking a sign-in means the provider refused to renew it (not a network or timeout). */
export function renewalRefused(error: unknown): boolean {
    if (
        (error as { code?: unknown } | undefined)?.code !== "oauth" ||
        !(error instanceof Error) ||
        error.cause === undefined
    ) {
        return false;
    }

    const said = chain(error.cause);

    return REFUSED.test(said) && !ON_THE_WAY.test(said);
}

interface AuthFlow {
    id: string;
    userId: string;
    prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
    abort: AbortController;
}

export class Providers {
    readonly #app: PocketApp;
    readonly #flows = new Map<string, AuthFlow>();
    /** Providers whose sign-in could not be renewed, and what they said. In memory: asked again after a restart. */
    readonly #expired = new Map<string, string>();
    /** Checks under way, by provider, so asking twice at once asks once. */
    readonly #checking = new Map<string, Promise<string | undefined>>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Why a provider's sign-in needs a person to sign in again, as last asked; undefined when it does not. */
    needsSignIn(providerId: string): string | undefined {
        return this.#expired.get(providerId);
    }

    /**
     * Ask a provider's sign-in afresh. A subscription's (OAuth) near its end is renewed, as a request would renew it;
     * one the provider refuses to renew is marked as needing sign-in, and one that works again is cleared. A network
     * that fails on the way changes nothing. Returns why it needs signing in, if it does.
     */
    check(providerId: string): Promise<string | undefined> {
        let pending = this.#checking.get(providerId);

        if (pending === undefined) {
            pending = this.#check(providerId).finally(() => this.#checking.delete(providerId));
            this.#checking.set(providerId, pending);
        }

        return pending;
    }

    async #check(providerId: string): Promise<string | undefined> {
        const models = this.#app.models;

        if (!models.isUsingOAuth(providerId)) {
            this.#clear(providerId);

            return undefined;
        }

        try {
            await models.getAuth(providerId, { signal: AbortSignal.timeout(CHECK_MS) });
            this.#clear(providerId);
        } catch (error) {
            if (renewalRefused(error)) {
                this.#mark(providerId, chain((error as Error).cause));
            }
        }

        return this.#expired.get(providerId);
    }

    /** Ask every subscription's sign-in afresh, as the Providers sheet opens. */
    async checkAll(): Promise<void> {
        const models = this.#app.models;

        await Promise.all(
            models
                .getProviders()
                .filter((provider) => models.isUsingOAuth(provider.id))
                .map((provider) => this.check(provider.id)),
        );
    }

    /** A run failed with `detail`: when its provider's sign-in could not be renewed, ask it, to mark it. */
    runFailed(detail: unknown): void {
        const provider = typeof detail === "string" ? RENEWAL_FAILED.exec(detail)?.[1] : undefined;

        if (provider !== undefined && this.#app.models.getProvider(provider) !== undefined) {
            void this.check(provider).catch(() => {});
        }
    }

    /**
     * Why Pi may not use a model now, in words for Pi to pass on: it is not known here, its provider is not signed in,
     * or its sign-in expired. `fresh` asks the provider's sign-in again first. Undefined when it may be used.
     */
    async problem(ref: ModelRef, fresh = false): Promise<string | undefined> {
        const models = this.#app.models;
        const name = models.getProvider(ref.provider)?.name ?? ref.provider;

        if (models.getModel(ref.provider, ref.modelId) === undefined) {
            return `${ref.provider}/${ref.modelId} is not a model known here`;
        }

        if (!models.hasConfiguredAuth(ref.provider)) {
            return `${name} is not signed in`;
        }

        const expired = fresh ? await this.check(ref.provider) : this.needsSignIn(ref.provider);

        return expired === undefined
            ? undefined
            : `the sign-in to ${name} expired and could not be renewed: a person must sign in again (Providers)`;
    }

    #mark(providerId: string, why: string): void {
        const known = this.#expired.has(providerId);

        this.#expired.set(providerId, why);

        if (!known) {
            const name = this.#app.models.getProvider(providerId)?.name ?? providerId;

            this.#app.notice(
                "warning",
                `The sign-in to ${name} expired and could not be renewed. Sign in again in Providers; until then its models are not used by Pi, subagents, or PiP.`,
            );
            this.#sendModels();
        }
    }

    #clear(providerId: string): void {
        if (this.#expired.delete(providerId)) {
            this.#sendModels();
        }
    }

    /** Every provider and its sign-in. What a provider said when it refused to renew one is for the `owner` only. */
    list(owner = false) {
        const models = this.#app.models;

        return models.getProviders().map((provider) => {
            const status = models.getProviderAuthStatus(provider.id);
            const expired = this.#expired.get(provider.id);
            const auth = (
                provider as {
                    auth?: { apiKey?: unknown; oauth?: { name?: string; loginLabel?: string } };
                }
            ).auth;

            return {
                id: provider.id,
                name: provider.name,
                configured: status.configured,
                source: status.source ?? null,
                label: status.label ?? null,
                apiKey: auth?.apiKey !== undefined,
                oauth:
                    auth?.oauth === undefined
                        ? null
                        : (auth.oauth.loginLabel ?? auth.oauth.name ?? "Subscription"),
                models: models.getModels(provider.id).length,
                ...(expired === undefined
                    ? {}
                    : { needsSignIn: owner ? expired : "its provider would not renew it" }),
            };
        });
    }

    startLogin(user: User, providerId: string, type: "api_key" | "oauth"): string {
        const app = this.#app;
        const flow: AuthFlow = {
            id: randomUUID(),
            userId: user.id,
            prompts: new Map(),
            abort: new AbortController(),
        };

        this.#flows.set(flow.id, flow);

        const send = (data: Record<string, unknown>) => {
            for (const client of app.clients) {
                if (client.user.id === user.id) {
                    client.send("auth", { flowId: flow.id, providerId, ...data });
                }
            }
        };

        const interaction = {
            signal: flow.abort.signal,
            prompt: (prompt: AuthPrompt) =>
                new Promise<string>((resolvePrompt, rejectPrompt) => {
                    const promptId = randomUUID();

                    flow.prompts.set(promptId, { resolve: resolvePrompt, reject: rejectPrompt });
                    const { signal, ...shown } = prompt;

                    signal?.addEventListener("abort", () => {
                        flow.prompts.delete(promptId);
                        send({ step: "prompt-closed", promptId });
                        rejectPrompt(new Error("cancelled"));
                    });
                    send({ step: "prompt", promptId, prompt: shown });
                }),
            notify: (event: unknown) => send({ step: "event", event }),
        };

        void app.models
            // Sign-ins that identify the installation (ChatGPT) get the ID Pi keeps for it, the same as Pi's own login.
            .login(providerId, type, interaction, {
                getDeviceId: () => app.settings.getOrCreateDeviceId(),
            })
            .then(
                async () => {
                    await app.models.getAvailable().catch(() => []);
                    this.#expired.delete(providerId);
                    send({ step: "done", ok: true });
                    this.#sendModels();
                },
                (error: unknown) => send({ step: "done", ok: false, error: describe(error) }),
            )
            .finally(() => this.#flows.delete(flow.id));

        return flow.id;
    }

    answerLogin(user: User, flowId: string, promptId: string, value: string | undefined): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            throw new HttpError(404, "No such login");
        }

        const prompt = flow.prompts.get(promptId);

        if (prompt === undefined) {
            throw new HttpError(404, "No such prompt");
        }

        flow.prompts.delete(promptId);

        if (value === undefined) {
            prompt.reject(new Error("cancelled"));
            flow.abort.abort();
        } else {
            prompt.resolve(value);
        }
    }

    /** Stop a sign-in its person gave up on, whether or not it is asking something. */
    cancelLogin(user: User, flowId: string): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            return;
        }

        for (const prompt of flow.prompts.values()) {
            prompt.reject(new Error("cancelled"));
        }

        flow.prompts.clear();
        flow.abort.abort();
    }

    async logout(providerId: string): Promise<void> {
        await this.#app.models.logout(providerId);
        await this.#app.models.getAvailable().catch(() => []);
        this.#expired.delete(providerId);
        this.#sendModels();
    }

    /** Every tab gets the models available now, marked when their sign-in needs renewing. */
    #sendModels(): void {
        const models = modelList(this.#app.models, (provider) => this.#expired.has(provider));

        for (const client of this.#app.clients) {
            client.send("models", models);
        }
    }

    close(): void {
        for (const flow of this.#flows.values()) {
            flow.abort.abort();
        }
    }
}
