/**
 * Which models a text names, so PiP passes a model, or names one in a task, only when its person named that model.
 * Words are compared, not characters: "GPT 5.1 Codex", "gpt-5.1-codex", and "gpt5.1 codex" name the same model, and
 * "auto" alone names none.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

/** Lowercased words, split at anything not a letter or digit, and where letters and digits meet: "GPT-5.1" is gpt 5 1. */
export function words(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
        .filter((word) => word !== "");
}

/** Whether `phrase` is a run of `text`'s words. */
function contains(text: readonly string[], phrase: readonly string[]): boolean {
    if (phrase.length === 0) {
        return false;
    }

    for (let start = 0; start + phrase.length <= text.length; start++) {
        if (phrase.every((word, offset) => text[start + offset] === word)) {
            return true;
        }
    }

    return false;
}

/** Spelled out enough to name a model: two words or more, one of them made of letters. "auto" or "4 5" is not. */
function distinct(phrase: readonly string[]): boolean {
    return phrase.length >= 2 && phrase.some((word) => /\p{L}/u.test(word));
}

/**
 * The phrases that name a model: its id, its name, and its provider with its id. `loosely` adds its id and its name
 * without their first word, as people say them ("opus 4.5" for claude-opus-4-5).
 */
function phrases(model: Model<Api>, loosely: boolean): string[][] {
    const id = words(model.id);
    const name = words(model.name);
    const all = [id, name, words(`${model.provider} ${model.id}`)];

    if (loosely) {
        all.push(id.slice(1), name.slice(1));
    }

    return all.filter(distinct);
}

/** The models among `models` that `text` names, by the phrases above. */
export function modelsNamed(
    text: string,
    models: readonly Model<Api>[],
    loosely = false,
): Model<Api>[] {
    const said = words(text);

    return models.filter((model) =>
        phrases(model, loosely).some((phrase) => contains(said, phrase)),
    );
}

const key = (phrase: readonly string[]) => phrase.join(" ");

/** Whether a phrase in `text` names both `a` and `b`: the same model at two providers, as far as those words go. */
export function sharePhrase(text: string, a: Model<Api>, b: Model<Api>): boolean {
    const said = words(text);
    const theirs = new Set(phrases(b, true).map(key));

    return phrases(a, true).some((phrase) => theirs.has(key(phrase)) && contains(said, phrase));
}

/**
 * Whether a person's `text` names `model`, as they would say it. When the same words name it at another provider too
 * (Claude Opus 4.5 is at Anthropic and GitHub Copilot), the provider must be named as well, by a word of its id or name
 * that the others do not share ("copilot", "codex"): which one pays is theirs to say.
 */
export function personNamed(
    text: string,
    model: Model<Api>,
    models: readonly Model<Api>[],
    providerName: (provider: string) => string = (provider) => provider,
): boolean {
    if (modelsNamed(text, [model], true).length === 0) {
        return false;
    }

    const twins = models.filter(
        (other) => other.provider !== model.provider && sharePhrase(text, model, other),
    );

    if (twins.length === 0) {
        return true;
    }

    const providerWords = (provider: string) =>
        new Set([...words(provider), ...words(providerName(provider))]);
    const shared = new Set([
        ...twins.flatMap((other) => [...providerWords(other.provider)]),
        ...words(model.id),
        ...words(model.name),
    ]);
    const said = new Set(words(text));

    return [...providerWords(model.provider)].some((word) => !shared.has(word) && said.has(word));
}
