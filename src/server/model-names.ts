/**
 * Which models a text names, so PiP passes a model, or names one in a task, only when its person named that model.
 * Words are compared, not characters: "GPT 5.1 Codex", "gpt-5.1-codex", and "gpt5.1 codex" name the same model, and
 * "auto" alone names none. Words that name a longer model name only that one: "gpt-5-nano" is not "gpt-5".
 */
import type { Api, Model } from "@earendil-works/pi-ai";

/** One written word: letters and digits, and dots between digits ("gpt5.1"). */
const WRITTEN = /(?:[\p{L}\p{N}]|(?<=\p{N})\.(?=\p{N}))+/gu;

/**
 * A text's lowercased words, split at anything not a letter or digit and where letters and digits meet ("GPT-5.1" is
 * gpt 5 1), and how each joins the word before it: "" inside one written word ("4o", "k3"), "." between the digits of
 * a version ("2.5"), and " " for anything else (a space, a dash).
 */
function split(text: string): { words: string[]; joins: string[] } {
    const words: string[] = [];
    const joins: string[] = [];

    for (const written of text.toLowerCase().match(WRITTEN) ?? []) {
        let join = " ";

        for (const part of written.match(/\p{L}+|\p{N}+|\./gu) ?? []) {
            if (part === ".") {
                join = ".";
            } else {
                words.push(part);
                joins.push(join);
                join = "";
            }
        }
    }

    return { words, joins };
}

/** A text's lowercased words, as `split` gives them. */
export function words(text: string): string[] {
    return split(text).words;
}

/** Words that name a model; for a short name, also how they must be joined (`split`'s, the first one aside). */
type Phrase = { words: readonly string[]; joins?: readonly string[] };

/** Where `phrase` is a run of `text`'s words, joined as it says when it says: the index of its first word, each time. */
function starts(text: ReturnType<typeof split>, phrase: Phrase): number[] {
    const found: number[] = [];
    const length = phrase.words.length;

    if (length === 0) {
        return found;
    }

    for (let start = 0; start + length <= text.words.length; start++) {
        if (
            phrase.words.every(
                (word, offset) =>
                    text.words[start + offset] === word &&
                    (offset === 0 ||
                        phrase.joins === undefined ||
                        text.joins[start + offset] === phrase.joins[offset]),
            )
        ) {
            found.push(start);
        }
    }

    return found;
}

/** Whether `phrase` is a run of `text`'s words. */
function contains(text: ReturnType<typeof split>, phrase: Phrase): boolean {
    return starts(text, phrase).length > 0;
}

/** Spelled out enough to name a model: two words or more, one of them made of letters. "auto" or "4 5" is not. */
function distinct(phrase: Phrase): boolean {
    return phrase.words.length >= 2 && phrase.words.some((word) => /\p{L}/u.test(word));
}

/**
 * A model's id or name as people shorten it, without its first written word ("claude", "gpt", "kimi"), when what is
 * left is still a name of its own: a word of three letters or more first ("opus 4.5"), however it is written; or a word
 * that mixes letters and digits ("K3", "4o"), or a version and a word after it ("2.5 Flash"), written as the model
 * writes them. A bare number and a word ("5 mini" of gpt-5-mini) is said in ordinary text, "build 5 mini apps", and so
 * are "K-3" and "4 o'clock".
 */
function shortened(full: string): Phrase | undefined {
    const { words, joins } = split(full);
    const from = joins.indexOf(" ", 1);

    if (from === -1) {
        return undefined;
    }

    const rest = { words: words.slice(from), joins: joins.slice(from) };
    const next = rest.joins.indexOf(" ", 1);
    const first = rest.words.slice(0, next === -1 ? undefined : next);
    const letters = (word: string) => /\p{L}/u.test(word);

    if (/^\p{L}{3,}$/u.test(first[0]!)) {
        return { words: rest.words };
    }

    const mixed = first.some(letters) && !first.every(letters);
    const version =
        first.length > 1 &&
        !first.some(letters) &&
        rest.joins.slice(1, first.length).includes(".") &&
        rest.words.slice(first.length).some(letters);

    return mixed || version ? rest : undefined;
}

/**
 * The phrases that name a model: its id, its name, and its provider with its id. `loosely` adds them as people
 * shorten them (`shortened`).
 */
function phrases(model: Model<Api>, loosely: boolean): Phrase[] {
    const all: Phrase[] = [model.id, model.name, `${model.provider} ${model.id}`].map((each) => ({
        words: words(each),
    }));

    if (loosely) {
        for (const full of [model.id, model.name]) {
            const short = shortened(full);

            if (short !== undefined) {
                all.push(short);
            }
        }
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
    const said = split(text);
    const found = models.map((model) =>
        phrases(model, loosely).flatMap((phrase) =>
            starts(said, phrase).map((start) => ({ start, length: phrase.words.length })),
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

const key = (phrase: Phrase) => `${phrase.words.join(" ")}|${phrase.joins?.join(",") ?? ""}`;

/** Whether a phrase in `text` names both `a` and `b`: the same model at two providers, as far as those words go. */
export function sharePhrase(text: string, a: Model<Api>, b: Model<Api>): boolean {
    const said = split(text);
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
