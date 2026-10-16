// The reference pages and the public types file say the same. types/pocket.d.ts is the one source of the signatures,
// and each member's TSDoc gives its release (@since) and stability (@experimental, @deprecated). The pages are
// written by hand, in this format:
//
// - a heading at level 2 to 4 that is only the name in code (### `resolveModel`), then the signature, then the line
//   "Since 0.14.0 · Stable" (or Experimental, or Deprecated);
// - the members of Host, Web, Pocket, Command, CommandContext, Module, and BrowserModule have headings with their
//   names alone; the nested ones are written `text.quoted` and `linkedSessions.start`;
// - every other exported type has a heading of its own name, with its fields as bullets.
//
// Each heading the types file expects must be on its page with the same Since line, and each heading with a Since
// line must be one the types file has (the gallery entry's fields are not in it, so gallery-entry.md is not checked).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export const TYPES = "types/pocket.d.ts";
const REFERENCE = "docs/extensions/reference";

/** The interfaces whose members are headings, and the prefix of nested ones. */
const HEADED = new Map([
    ["Host", ""],
    ["Web", ""],
    ["Pocket", ""],
    ["Command", ""],
    ["CommandContext", ""],
    ["Module", ""],
    ["BrowserModule", ""],
    ["SafeText", "text."],
    ["LinkedSessions", "linkedSessions."],
]);

/** Which types each page describes. */
export const PAGES = {
    "host.md": ["Host", "SafeText", "LinkedSessions", "LinkedSession"],
    "web.md": ["Web", "WebHandler", "WebRequest", "WebMethod", "WebAccess"],
    "pocket.md": [
        "Pocket",
        "BrowserModule",
        "Action",
        "RailSpec",
        "MenuSpec",
        "LauncherSpec",
        "PageSpec",
        "SheetSpec",
        "PageProps",
        "SheetProps",
        "ToolCallSpec",
        "CallSummary",
        "Added",
        "IconProps",
        "LoaderProps",
        "MarkdownProps",
        "SwitchProps",
    ],
    "command-context.md": ["Command", "CommandContext", "CommandResult"],
    "types.md": ["Module", "Person", "Role", "NoticeLevel"],
};

function meta(node) {
    const tags = ts.getJSDocTags(node);
    const has = (kind) => tags.some((tag) => tag.tagName.text === kind);
    const since = tags.find((tag) => tag.tagName.text === "since")?.comment;
    const stability = has("deprecated")
        ? "Deprecated"
        : has("experimental")
          ? "Experimental"
          : "Stable";

    return `${typeof since === "string" ? since.trim() : "no @since"} · ${stability}`;
}

/** What the types file expects on each page: heading → "Since … · …". */
function expected(source) {
    const file = ts.createSourceFile(TYPES, source, ts.ScriptTarget.Latest, true);
    const owners = new Map();

    for (const statement of file.statements) {
        if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
            continue;
        }

        const name = statement.name.text;
        const headings = new Map();

        // A type is a heading of its own, but for the headed interfaces, whose members are (Module is both).
        if (!HEADED.has(name) || name === "Module") {
            headings.set(name, meta(statement));
        }

        if (ts.isInterfaceDeclaration(statement) && HEADED.has(name)) {
            for (const member of statement.members) {
                const key = `${HEADED.get(name)}${member.name?.getText(file)}`;

                if (!headings.has(key)) {
                    headings.set(key, meta(member));
                }
            }
        }

        owners.set(name, headings);
    }

    return owners;
}

/** The headings of a page that have a Since line: heading → { line, says }. */
function found(source) {
    const headings = new Map();
    let heading;
    let fence = false;

    for (const [at, line] of source.split("\n").entries()) {
        if (line.startsWith("```")) {
            fence = !fence;
            continue;
        }

        if (fence) {
            continue;
        }

        const title = /^#{2,4} `([^`]+)`$/.exec(line);

        if (title !== null) {
            heading = { name: title[1], line: at + 1 };
            continue;
        }

        if (line.startsWith("#")) {
            heading = undefined;
            continue;
        }

        const since = /^Since (\S+) · (Stable|Experimental|Deprecated)\b/.exec(line);

        if (since !== null && heading !== undefined) {
            const key = headings.has(heading.name) ? `${heading.name} (again)` : heading.name;

            headings.set(key, { line: heading.line, says: `${since[1]} · ${since[2]}` });
            heading = undefined;
        }
    }

    return headings;
}

/** Every difference between the types file and the reference pages; none while the types file is not there. */
export function checkReference(root) {
    const errors = [];

    if (!existsSync(join(root, TYPES))) {
        return errors;
    }

    const owners = expected(readFileSync(join(root, TYPES), "utf8"));

    for (const [page, types] of Object.entries(PAGES)) {
        const path = `${REFERENCE}/${page}`;

        if (!existsSync(join(root, path))) {
            continue;
        }

        const there = found(readFileSync(join(root, path), "utf8"));
        const wanted = new Map();

        for (const type of types) {
            const headings = owners.get(type);

            if (headings === undefined) {
                errors.push(`${TYPES}: there is no type ${type}, which ${path} describes`);
                continue;
            }

            for (const [heading, says] of headings) {
                wanted.set(heading, says);
            }
        }

        for (const [heading, says] of wanted) {
            const seen = there.get(heading);

            if (seen === undefined) {
                errors.push(
                    `${path}: no heading \`${heading}\` with "Since ${says}" (${TYPES} has it)`,
                );
            } else if (seen.says !== says) {
                errors.push(
                    `${path}:${seen.line}: \`${heading}\` says "Since ${seen.says}", ${TYPES} "Since ${says}"`,
                );
            }
        }

        for (const [heading, { line }] of there) {
            if (!wanted.has(heading)) {
                errors.push(
                    `${path}:${line}: \`${heading}\` has a Since line, but ${TYPES} has no such member here`,
                );
            }
        }
    }

    return errors;
}

/**
 * Each number in the limits page is also in a page that its section or its line links to, so that a limit is never
 * stated in one place only, and a change to it shows in both.
 */
export function checkLimits(root) {
    const page = `${REFERENCE}/limits.md`;
    const errors = [];

    if (!existsSync(join(root, page))) {
        return errors;
    }

    const pagesIn = (text) =>
        [...text.matchAll(/\]\(([^)#]+\.md)(#[^)]*)?\)/g)].map((link) =>
            readFileSync(join(root, REFERENCE, link[1]), "utf8"),
        );
    const numbers = (text) =>
        text.replace(/`[^`]*`/g, "").match(/(?<![\w.,])\d+(?:,\d{3})*(?![\w,]\d|\.\d)/g) ?? [];
    const has = (text, number) => new RegExp(`(?<![\\d,.])${number}(?![\\d]|,\\d)`).test(text);

    for (const section of readFileSync(join(root, page), "utf8").split(/^## /m).slice(1)) {
        const [head, ...lines] = section.split("\n");
        const intro = lines.filter((line) => !line.startsWith("- ")).join("\n");
        const shared = pagesIn(intro);

        for (const line of lines.filter((each) => each.startsWith("- "))) {
            const texts = [...shared, ...pagesIn(line)].join("\n");

            for (const number of numbers(line.replace(/\]\([^)]*\)/g, "]"))) {
                if (!has(texts, number)) {
                    errors.push(
                        `${page} (${head}): ${number} is in no page that it links to: "${line.slice(2, 80)}…"`,
                    );
                }
            }
        }
    }

    return errors;
}
