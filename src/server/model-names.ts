/**
 * Which models a text names, so PiP passes a model, or names one in a task, only when its person named that model.
 * Words are compared, not characters: "GPT 5.1 Codex", "gpt-5.1-codex", and "gpt5.1 codex" name the same model, and
 * "auto" alone names none. Words that name a longer model name only that one: "gpt-5-nano" is not "gpt-5".
 */
import type { Api, Model } from "@earendil-works/pi-ai";

/** Lowercased words, split at anything not a letter or digit, and where letters and digits meet: "GPT-5.1" is gpt 5 1. */
export function words(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
        .filter((word) => word !== "");
}

/** Where `phrase` is a run of `text`'s words: the index of its first word, each time. */
function starts(text: readonly string[], phrase: readonly string[]): number[] {
    const found: number[] = [];

    if (phrase.length === 0) {
        return found;
    }

    for (let start = 0; start + phrase.length <= text.length; start++) {
        if (phrase.every((word, offset) => text[start + offset] === word)) {
            found.push(start);
        }
    }

    return found;
}

/** Whether `phrase` is a run of `text`'s words. */
function contains(text: readonly string[], phrase: readonly string[]): boolean {
    return starts(text, phrase).length > 0;
}

/** Spelled out enough to name a model: two words or more, one of them made of letters. "auto" or "4 5" is not. */
function distinct(phrase: readonly string[]): boolean {
    return phrase.length >= 2 && phrase.some((word) => /\p{L}/u.test(word));
}

/**
 * Whether a phrase starts with a word of its own, three letters or more, as "opus 4 5" does. Without its first word, a
 * name that starts with a number or a lone letter is said in ordinary text too: "4 mini" (o4-mini) in "build 4 mini
 * apps", "k 3" (Kimi K3) in "K-3".
 */
function startsWithWord(phrase: readonly string[]): boolean {
    return /^\p{L}{3,}$/u.test(phrase[0] ?? "");
}

/**
 * The phrases that name a model: its id, its name, and its provider with its id. `loosely` adds its id and its name
 * without their first word, as people say them ("opus 4.5" for claude-opus-4-5), when what is left starts with a word.
 */
function phrases(model: Model<Api>, loosely: boolean): string[][] {
    const id = words(model.id);
    const name = words(model.name);
    const all = [id, name, words(`${model.provider} ${model.id}`)];

    if (loosely) {
        all.push(...[id.slice(1), name.slice(1)].filter(startsWithWord));
    }

    return all.filter(distinct);
}

/**
 * The models among `models` that `text` names, by the phrases above. Where a phrase of one model runs on into a longer
 * phrase of another, from the same word, the text names only the longer one: "gpt-5-nano" names gpt-5-nano, not gpt-5.
 */
export function modelsNamed(
    text: string,
    models: readonly Model<Api>[],
    loosely = false,
): Model<Api>[] {
    const said = words(text);
    const found = models.map((model) =>
        phrases(model, loosely).flatMap((phrase) =>
            starts(said, phrase).map((start) => ({ start, length: phrase.length })),
        ),
    );
    // The most words any model's phrase takes from each word on.
    const longest = new Map<number, number>();

    for (const { start, length } of found.flat()) {
        longest.set(start, Math.max(longest.get(start) ?? 0, length));
    }

    return models.filter((_, index) =>
        found[index]!.some(({ start, length }) => length === longest.get(start)),
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
 * Whether a person's `text` names `model`, as they would say it, among the `models` there are: words that name a longer
 * one of them ("gpt-5-nano") do not name `model` (gpt-5). When the same words name it at another provider too (Claude
 * Opus 4.5 is at Anthropic and GitHub Copilot), the provider must be named as well, by a word of its id or name that
 * the others do not share ("copilot", "codex"): which one pays is theirs to say.
 */
export function personNamed(
    text: string,
    model: Model<Api>,
    models: readonly Model<Api>[],
    providerName: (provider: string) => string = (provider) => provider,
): boolean {
    if (!modelsNamed(text, [model, ...models], true).includes(model)) {
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
