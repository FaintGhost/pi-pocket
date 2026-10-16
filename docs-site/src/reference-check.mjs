// The reference pages and the public types file say the same: each member of an interface has a heading on its page
// (### `name`), and the line under it (Since 0.14.0 · Stable) gives the same release and stability as the member's
// TSDoc (@since, @experimental, @deprecated). types/pocket.d.ts is the one source of the signatures; the pages are
// written by hand, so this check keeps them in step.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Which interfaces each reference page describes. */
export const PAGES = {
    "docs/extensions/reference/host.md": ["Host"],
    "docs/extensions/reference/web.md": ["Web"],
    "docs/extensions/reference/command-context.md": ["Command", "CommandContext"],
    "docs/extensions/reference/pocket.md": ["BrowserModule", "Pocket"],
};

export const TYPES = "types/pocket.d.ts";

/** Each member of each interface in the types file: its release, and its stability. */
function members(source) {
    const file = ts.createSourceFile(TYPES, source, ts.ScriptTarget.Latest, true);
    const found = new Map();

    for (const statement of file.statements) {
        if (!ts.isInterfaceDeclaration(statement)) {
            continue;
        }

        const own = new Map();

        for (const member of statement.members) {
            const name = member.name?.getText(file);

            if (name === undefined || own.has(name)) {
                continue;
            }

            const tags = ts.getJSDocTags(member);
            const tag = (kind) => tags.find((each) => each.tagName.text === kind);
            const since = tag("since")?.comment;

            own.set(name, {
                since: typeof since === "string" ? since.trim() : undefined,
                stability: tag("deprecated")
                    ? "Deprecated"
                    : tag("experimental")
                      ? "Experimental"
                      : "Stable",
            });
        }

        found.set(statement.name.text, own);
    }

    return found;
}

/** The members a page describes: ### `name`, and its "Since … · …" line. */
function headings(source) {
    const found = new Map();
    const lines = source.replace(/^```[\s\S]*?^```/gm, "").split("\n");

    for (const [at, line] of lines.entries()) {
        const heading = /^###\s+`([^`(]+)/.exec(line);

        if (heading === null) {
            continue;
        }

        const meta = lines
            .slice(at + 1, at + 12)
            .map((each) => /^Since (\d+\.\d+\.\d+) · (Stable|Experimental|Deprecated)\b/.exec(each))
            .find((each) => each !== null);

        found.set(heading[1].trim().replace(/^[a-z]+\./, ""), {
            line: at + 1,
            since: meta?.[1],
            stability: meta?.[2],
        });
    }

    return found;
}

/** Every difference between the types file and the reference pages, or none when the types file is not there yet. */
export function checkReference(root) {
    const errors = [];

    if (!existsSync(join(root, TYPES))) {
        return errors;
    }

    const types = members(readFileSync(join(root, TYPES), "utf8"));

    for (const [page, interfaces] of Object.entries(PAGES)) {
        if (!existsSync(join(root, page))) {
            continue;
        }

        const described = headings(readFileSync(join(root, page), "utf8"));

        for (const name of interfaces) {
            const own = types.get(name);

            if (own === undefined) {
                errors.push(`${TYPES}: there is no interface ${name}, which ${page} describes`);
                continue;
            }

            for (const [member, { since, stability }] of own) {
                const heading = described.get(member);

                if (heading === undefined) {
                    errors.push(`${page}: no heading for ${name}.${member} (### \`${member}\`)`);
                } else if (heading.since !== since || heading.stability !== stability) {
                    errors.push(
                        `${page}:${heading.line}: ${name}.${member} says "Since ${heading.since} · ${heading.stability}", ` +
                            `but ${TYPES} says "Since ${since} · ${stability}"`,
                    );
                }
            }
        }
    }

    return errors;
}
