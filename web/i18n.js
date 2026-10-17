// Interface languages.
//
// Pi Pocket has no build step, so this file translates the rendered page: after Preact draws (and after every later
// change), a MutationObserver looks for text nodes and `placeholder` / `title` / `aria-label` values that are keys of a
// locale table, and swaps in that language's text. Message text, files, diffs and code are left alone.
//
// Adding a language: add its table under `tables`, one `text` map of exact strings and one `patterns` list for text with
// numbers or names in it. A key that the table does not have stays English, so a partial translation is usable.
//
// 界面语言：没有构建步骤，所以在渲染之后按文案表替换文本节点与 placeholder/title/aria-label。
// 没翻到的条目保持英文；消息正文、文件、diff、代码一律不动。

import { patterns as zhPatterns, text as zhText } from "./i18n.zh.js";

export const LANGS = [
    { id: "en", label: "English" },
    { id: "zh", label: "中文" },
];

const STORE = "pocket.lang";
const tables = {
    zh: { text: zhText, patterns: zhPatterns, html: "zh-CN" },
};

/** What the page is in: the language chosen in Appearance, else the browser's, else English. */
function pick() {
    try {
        const saved = localStorage.getItem(STORE);

        if (saved && LANGS.some((each) => each.id === saved)) {
            return saved;
        }
    } catch {
        // storage can be off; the browser's language is enough
    }

    return /^zh\b/i.test(navigator.language ?? "") ? "zh" : "en";
}

let lang = pick();
const table = tables[lang];

/** The language the interface is in now. */
export function currentLang() {
    return lang;
}

/** Choose a language and reload: every string on the page is rebuilt by the app, then translated here. */
export function setLang(id) {
    if (!LANGS.some((each) => each.id === id)) {
        return;
    }

    lang = id;

    try {
        localStorage.setItem(STORE, id);
    } catch {
        // a reload still applies it for this visit
    }

    location.reload();
}

/** Text of one string, for code that draws a string of its own. */
export function t(text) {
    if (!table || typeof text !== "string") {
        return text;
    }

    return lookup(text) ?? joined(text) ?? text;
}

/** One exact key, or one pattern: what this string says in the chosen language, or null. */
function lookup(text) {
    const exact = table.text[text];

    if (exact !== undefined) {
        return exact;
    }

    for (const [pattern, value] of table.patterns) {
        const match = pattern.exec(text);

        if (match) {
            return value.replace(/\$(\d)/g, (_, at) => match[Number(at)] ?? "");
        }
    }

    return null;
}

// A label the app builds by joining pieces with commas: "New session, Alt N", "Show peek tiles, other sessions' live
// work beside this one, Alt P". Each piece is a key of its own; shortcuts and names stay as they are. Only chrome gets
// here: if the first piece is not one of ours, the line is someone's own text and is left alone.
function joined(text) {
    if (!text.includes(", ") || !table) {
        return null;
    }

    const parts = text.split(", ");
    const head = lookup(parts[0]);

    if (head === null) {
        return null;
    }

    return parts.map((part, at) => (at === 0 ? head : (lookup(part) ?? part))).join("，");
}

// ── the page ─────────────────────────────────────────────────

/** What a string means on screen: the same text, in the chosen language. */
function translate(value) {
    const trimmed = value.trim();

    if (!trimmed || !/[A-Za-z]/.test(trimmed)) {
        return null;
    }

    const swapped = t(trimmed);

    if (swapped === trimmed) {
        return null;
    }

    return value.replace(trimmed, swapped);
}

// Message bodies, files, diffs and code carry the user's text, not ours.
// Everything that shows text someone else wrote — the prompt, the answer, tool output, a diff, a command — is out of
// reach. Exact keys alone would be enough (a sentence is never a key), but this keeps even a one-word answer intact.
const SKIP_TEXT =
    "pre, code, textarea, input, select, [contenteditable], .prompt-body, .step-body, .thought-body, .divider-body, .user-text, .diff, .fenced-data, .cmd";
// An input's own placeholder, title and label are ours; what someone typed into it is not, and no code here reads it.
const SKIP_ATTRS = "pre, code, [contenteditable], [data-i18n-skip]";

const ATTRS = ["placeholder", "title", "aria-label"];

function translateText(node) {
    const parent = node.parentElement;

    if (!parent || parent.closest(SKIP_TEXT)) {
        return;
    }

    if (parent.closest("[data-i18n-skip]")) {
        return;
    }

    const next = translate(node.nodeValue);

    if (next !== null && next !== node.nodeValue) {
        node.nodeValue = next;

        if (stats) {
            stats.texts++;
        }
    }
}

function translateAttrs(element) {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    if (element.closest(SKIP_ATTRS)) {
        return;
    }

    for (const attr of ATTRS) {
        const value = element.getAttribute(attr);

        if (!value) {
            continue;
        }

        const next = translate(value);

        if (next !== null && next !== value) {
            element.setAttribute(attr, next);

            if (stats) {
                stats.attrs++;
            }
        }
    }
}

/** Translate a subtree that is already on the page. */
function translateTree(root) {
    if (!table) {
        return;
    }

    if (root instanceof Text) {
        translateText(root);

        return;
    }

    if (!(root instanceof Element)) {
        return;
    }

    translateAttrs(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
        translateText(node);
        node = walker.nextNode();
    }

    for (const element of root.querySelectorAll("*")) {
        translateAttrs(element);
    }
}

let stats = null;
let queued = false;
const batches = new Set();

function flush() {
    queued = false;
    const roots = [...batches];

    batches.clear();

    for (const root of roots) {
        if (root.isConnected) {
            translateTree(root);
        }
    }
}

function schedule(root) {
    batches.add(root);

    if (queued) {
        return;
    }

    queued = true;
    // A microtask, not requestAnimationFrame: a background tab throttles frames, and a phone that screen-locks still
    // has to find the page translated when it comes back.
    queueMicrotask(flush);
}

/** Translate everything on the page now, and everything that appears later. */
export function start() {
    document.documentElement.lang = table?.html ?? "en";

    if (!table) {
        return;
    }

    stats = { texts: 0, attrs: 0 };
    translateTree(document.body);
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === "childList") {
                for (const node of record.addedNodes) {
                    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
                        schedule(node);
                    }
                }
            } else if (record.type === "characterData") {
                if (record.target.nodeType === Node.TEXT_NODE) {
                    schedule(record.target);
                }
            } else if (record.type === "attributes") {
                schedule(record.target);
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ATTRS,
    });
    // Tests and extensions can ask what the translator did.
    window.__pocketI18n = Object.freeze({
        lang,
        langs: LANGS,
        translate: t,
        stats,
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
    start();
}
