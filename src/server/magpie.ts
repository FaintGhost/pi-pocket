/**
 * Magpie (github.com/yetone/magpie): a model gateway that sits in front of the vendors this machine already pays
 * for — API keys, subscriptions, and local models — and answers on one endpoint, `http://127.0.0.1:3425/v1`.
 *
 * To Pi it is one provider, `magpie`. What it serves is not compiled in: the gateway's catalog is fetched
 * (`GET /v1/models`), so every model and every routing group it has today is selectable, and a model it gains
 * tomorrow shows up on the next refresh. A routing group moves to the next account or model when a quota runs out,
 * which is the point of using it: the session never sees the error.
 *
 * The gateway also keeps what its own sign-ins know and Pi Pocket can't: how much of each plan is left
 * (`GET /v1/magpie/quotas/cards`) and what has been sent lately (`GET /v1/magpie/usage`). The Magpie sheet shows
 * both, and asks for a fresh reading of one card with `POST /v1/magpie/quotas/refresh`.
 *
 * Where it is and how it is opened comes from the environment (`POCKET_MAGPIE_URL`, `POCKET_MAGPIE_KEY`), and
 * failing that from magpie's own key file, which is enough when both run on this machine.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The provider id Pi knows it by: a model ref reads `magpie/group/intent-coder`. */
export const MAGPIE_PROVIDER = "magpie";

/** How long one catalog, quota reading, or usage answer is reused before it is asked for again. */
const CATALOG_MS = 5 * 60_000;
const QUOTA_MS = 45_000;
const USAGE_MS = 5 * 60_000;

/** How long one request to the gateway may take. A gateway that is not there fails at once; one that hangs does not. */
const TIMEOUT_MS = 6_000;

/** One model as `/v1/models` lists it, with only the fields read here. */
interface RemoteModel {
    id?: unknown;
    display_name?: unknown;
    magpie_label?: unknown;
    context_length?: unknown;
    max_output_tokens?: unknown;
    modalities?: { input?: unknown };
    reasoning?: unknown;
}

/** How much of one plan's window is used, as the gateway last read it. */
export interface MagpieQuotaWindow {
    name: string;
    /** Percent used, 0 to 100. */
    used?: number;
    resetsAt?: string;
}

/** One account the gateway holds a sign-in for, and what is left on it. */
export interface MagpieQuota {
    provider: string;
    name: string;
    plan?: string;
    user?: string;
    kind?: string;
    readAt?: string;
    windows: MagpieQuotaWindow[];
}

/** What the gateway has sent lately, over its own 30-day window. */
export interface MagpieUsage {
    period?: string;
    since?: string;
    calls?: number;
    errors?: number;
    retried?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
}

/** A model or a routing group the gateway serves. */
export interface MagpieModel {
    id: string;
    name: string;
    /** Where it comes from, such as `DeepSeek`, or `routing group`. */
    from: string;
    group: boolean;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    images: boolean;
}

/** Everything the Magpie sheet shows. */
export interface MagpieState {
    url: string;
    /** False when no gateway answered: Pi has no `magpie` provider then, and the sheet says why. */
    reachable: boolean;
    error?: string;
    models: MagpieModel[];
    groups: MagpieModel[];
    quotas: MagpieQuota[];
    usage?: MagpieUsage;
    /** When the catalog was last read, as ISO text. */
    readAt?: string;
}

/** One answer from the gateway, or the reason there was none. */
type Answer<T> = { value: T } | { problem: string };

/** An empty number is 0 here, and anything else is left out rather than guessed. */
function count(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A field as text, or undefined. */
function text(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The gateway's address and key: the environment first, so a tunnel or another machine can be pointed at, then
 * magpie's own key file on this machine. `undefined` means there is no gateway to read, and nothing is registered.
 */
export function magpieSettings(): { url: string; key: string } | undefined {
    const url = (process.env.POCKET_MAGPIE_URL ?? "").trim().replace(/\/+$/, "");
    const key = (process.env.POCKET_MAGPIE_KEY ?? "").trim();

    if (url !== "" && key !== "") {
        return { url, key };
    }

    const found = url !== "" ? url : "http://127.0.0.1:3425";

    try {
        const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
        const file = join(configHome, "magpie", "caller-keys.json");
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        const keys = entries
            .filter(
                (each): each is { name?: unknown; secret?: unknown } => typeof each === "object",
            )
            .map((each) => ({ name: text(each.name) ?? "", secret: text(each.secret) }))
            .filter((each) => each.secret !== undefined);

        // The key magpie names for a tailnet or this machine is the one its own agents use; any other will do.
        const chosen = keys.find((each) => /tailnet|local|magpie/i.test(each.name)) ?? keys[0];

        return chosen === undefined ? undefined : { url: found, key: chosen.secret! };
    } catch {
        return undefined;
    }
}

/** The Magpie gateway this app reads, and the provider it registers with Pi. */
export class Magpie {
    readonly #url: string;
    readonly #key: string;
    #models: MagpieModel[] = [];
    #quotas: MagpieQuota[] = [];
    #usage: MagpieUsage | undefined;
    #readAt: number | undefined;
    #quotasAt: number | undefined;
    #usageAt: number | undefined;
    #problem: string | undefined;
    #registering: Promise<void> | undefined;

    private constructor(settings: { url: string; key: string }) {
        this.#url = settings.url;
        this.#key = settings.key;
    }

    /** The gateway to read, or undefined when this machine has none: then Pi Pocket behaves as it always did. */
    static fromEnvironment(): Magpie | undefined {
        const settings = magpieSettings();

        return settings === undefined ? undefined : new Magpie(settings);
    }

    get url(): string {
        return this.#url;
    }

    /** What the sheet shows: the last catalog, quotas, and usage read, and whether the gateway answered. */
    state(): MagpieState {
        return {
            url: this.#url,
            reachable: this.#problem === undefined && this.#models.length > 0,
            error: this.#problem,
            models: this.#models,
            groups: this.#models.filter((each) => each.group),
            quotas: this.#quotas,
            usage: this.#usage,
            readAt: this.#readAt === undefined ? undefined : new Date(this.#readAt).toISOString(),
        };
    }

    /**
     * Register the gateway with Pi as one provider, and read its catalog. Called once at startup and again on every
     * refresh; a gateway that is not there leaves Pi's own providers alone, and the sheet says what happened.
     */
    async attach(models: ModelRuntime): Promise<void> {
        await this.refresh(models);
    }

    /** Read the catalog again and register it, replacing what Pi knew of `magpie` before. */
    async refresh(models: ModelRuntime): Promise<MagpieState> {
        this.#registering ??= this.#read(models).finally(() => {
            this.#registering = undefined;
        });
        await this.#registering;

        return this.state();
    }

    async #read(models: ModelRuntime): Promise<void> {
        const catalog = await this.#catalog();

        if (catalog.length === 0) {
            return;
        }

        try {
            models.registerProvider(MAGPIE_PROVIDER, {
                name: "Magpie",
                baseUrl: `${this.#url}/v1`,
                api: "openai-completions",
                apiKey: this.#key,
                models: catalog.map((model) => ({
                    id: model.id,
                    name: model.name,
                    type: "chat" as const,
                    api: "openai-completions" as const,
                    baseUrl: `${this.#url}/v1`,
                    // What the gateway charges is its own business: it bills the plan behind it, not this session.
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    input: model.images
                        ? (["text", "image"] as ("text" | "image")[])
                        : (["text"] as ("text" | "image")[]),
                    reasoning: model.reasoning,
                    contextWindow: model.contextWindow,
                    maxTokens: model.maxTokens,
                })),
            });
        } catch (error) {
            this.#problem = error instanceof Error ? error.message : String(error);
        }
    }

    /** Every model and routing group the gateway lists, cached for a few minutes. */
    async #catalog(): Promise<MagpieModel[]> {
        if (
            this.#models.length > 0 &&
            this.#readAt !== undefined &&
            Date.now() - this.#readAt < CATALOG_MS
        ) {
            return this.#models;
        }

        const answer = await this.#get<{ data?: RemoteModel[] }>("/v1/models");

        if ("problem" in answer) {
            this.#problem = answer.problem;

            return this.#models;
        }

        const listed = Array.isArray(answer.value.data) ? answer.value.data : [];

        this.#models = listed
            .map((each) => this.#model(each))
            .filter((each): each is MagpieModel => each !== undefined);
        this.#readAt = Date.now();

        if (this.#models.length === 0) {
            this.#problem = "the gateway listed no models";
        } else {
            this.#problem = undefined;
        }

        return this.#models;
    }

    /** One listed model, or undefined when it says too little to offer. */
    #model(each: RemoteModel): MagpieModel | undefined {
        const id = text(each.id);

        if (id === undefined) {
            return undefined;
        }

        const label = text(each.magpie_label);
        const name = text(each.display_name) ?? id;
        const modalities = Array.isArray(each.modalities?.input)
            ? (each.modalities!.input as unknown[])
            : [];

        return {
            id,
            name,
            from:
                label?.split("·").at(-1)?.trim() ??
                (id.startsWith("group/") ? "routing group" : (id.split("/")[0] ?? "")),
            group: id.startsWith("group/"),
            contextWindow: count(each.context_length, 128_000),
            maxTokens: count(each.max_output_tokens, 8_192),
            reasoning: each.reasoning === true,
            images: modalities.includes("image"),
        };
    }

    /** What the gateway's own sign-ins have left, cached for a minute. */
    async quotas(force = false): Promise<MagpieQuota[]> {
        if (!force && this.#quotasAt !== undefined && Date.now() - this.#quotasAt < QUOTA_MS) {
            return this.#quotas;
        }

        const answer = await this.#get<{ data?: unknown[] }>("/v1/magpie/quotas/cards");

        if ("value" in answer && Array.isArray(answer.value.data)) {
            this.#quotas = answer.value.data
                .map((each) => quotaOf(each))
                .filter((each): each is MagpieQuota => each !== undefined);
            this.#quotasAt = Date.now();
        }

        return this.#quotas;
    }

    /** What the gateway has sent lately, cached for five minutes. */
    async usage(force = false): Promise<MagpieUsage | undefined> {
        if (!force && this.#usageAt !== undefined && Date.now() - this.#usageAt < USAGE_MS) {
            return this.#usage;
        }

        const answer = await this.#get<MagpieUsage>("/v1/magpie/usage");

        if ("value" in answer) {
            this.#usage = answer.value;
            this.#usageAt = Date.now();
        }

        return this.#usage;
    }

    /** Ask the gateway to read its plans again, at most once in 30 seconds a card, as it allows. */
    async refreshQuotas(): Promise<MagpieQuota[]> {
        await this.#post("/v1/magpie/quotas/refresh");

        return this.quotas(true);
    }

    async #get<T>(path: string): Promise<Answer<T>> {
        try {
            const response = await fetch(`${this.#url}${path}`, {
                headers: { authorization: `Bearer ${this.#key}` },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });

            if (!response.ok) {
                return { problem: await this.#why(response) };
            }

            return { value: (await response.json()) as T };
        } catch (error) {
            return { problem: error instanceof Error ? error.message : String(error) };
        }
    }

    async #post(path: string): Promise<void> {
        try {
            await fetch(`${this.#url}${path}`, {
                method: "POST",
                headers: { authorization: `Bearer ${this.#key}` },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch {
            // A reading that could not be asked for leaves the last one in place; the sheet says when that was.
        }
    }

    /** What the gateway said, as one line: its own message when it sends one. */
    async #why(response: Response): Promise<string> {
        try {
            const body = (await response.json()) as { error?: { message?: unknown } };
            const message = text(body.error?.message);

            if (message !== undefined) {
                return message;
            }
        } catch {
            // not JSON; the status says enough
        }

        return `${response.status} ${response.statusText}`.trim();
    }
}

/** One quota card, or undefined when it names no provider. */
function quotaOf(each: unknown): MagpieQuota | undefined {
    if (typeof each !== "object" || each === null) {
        return undefined;
    }

    const card = each as Record<string, unknown>;
    const provider = text(card.provider);

    if (provider === undefined) {
        return undefined;
    }

    const windows: unknown[] = Array.isArray(card.windows) ? card.windows : [];

    return {
        provider,
        name: text(card.name) ?? provider,
        plan: text(card.plan),
        user: text(card.user),
        kind: text(card.kind),
        readAt: text(card.readAt),
        windows: windows
            .filter(
                (each): each is Record<string, unknown> =>
                    typeof each === "object" && each !== null,
            )
            .map((each) => ({
                name: text(each.name) ?? "",
                used: typeof each.used === "number" ? each.used : undefined,
                resetsAt: text(each.resetsAt),
            }))
            .filter((each) => each.name !== ""),
    };
}
