/**
 * Sharing a drop-in: whether it stands on its own (its files are all its own, and it imports only what every Pi Pocket
 * has), and a draft of its index entry, from its doc comment and its files' hashes. Pi Pocket makes no GitHub calls for
 * it: the owner opens the pull request.
 */
import { builtinModules } from "node:module";
import { posix } from "node:path";

/** The packages a browser module can import by name: the app's import map (`web/index.html`). */
const BROWSER_PACKAGES = new Set(["preact", "preact/hooks", "htm", "marked", "dompurify"]);

/**
 * What a file imports when it runs: `import … from`, `export … from`, `import "…"`, and `import("…")`, but not
 * `import type`, which is erased. Read from the text, so it can only be a first check: the index loads the module.
 */
function specifiers(source: string): Set<string> {
    // Comments first, so a `from "…"` in one is not read as an import.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const found = (pattern: RegExp) => [...code.matchAll(pattern)].map((match) => match[2]!);

    return new Set([
        ...found(/\b(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s*(["'])([^"'\n]+)\1/g),
        ...found(/\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g),
        ...found(/(?:^|[;\s])import\s*(["'])([^"'\n]+)\1/g),
    ]);
}

/** A package's name from a specifier: `@scope/name` or `name`, without the path in it. */
function packageOf(spec: string): string {
    const parts = spec.split("/");

    return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * What keeps a drop-in from standing on its own, in words: imports of files that are not among its own, of files by
 * where they are on this machine, of code from other sites, or of packages Pi Pocket does not have.
 */
export function importProblems(
    name: string,
    files: { name: string; text: string | undefined }[],
    packages: ReadonlySet<string>,
): string[] {
    const problems: string[] = [];
    const names = new Set(files.map((file) => file.name));

    for (const file of files) {
        if (file.text === undefined || !/\.(ts|js|mjs)$/.test(file.name)) {
            continue;
        }

        const browser = !file.name.endsWith(".ts");

        for (const spec of specifiers(file.text)) {
            if (spec.startsWith("./") || spec.startsWith("../")) {
                const target = posix.normalize(posix.join(posix.dirname(file.name), spec));

                if (!names.has(target)) {
                    problems.push(
                        `${file.name} imports ${spec}, which is not one of its own files. Move it into ${name}/.`,
                    );
                }

                continue;
            }

            if (spec.startsWith("/") || spec.startsWith("file:") || /^[A-Za-z]:[\\/]/.test(spec)) {
                problems.push(
                    `${file.name} imports ${spec} by where it is on this machine. Others do not have it: use a file of its own.`,
                );
                continue;
            }

            if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith("node:")) {
                problems.push(
                    `${file.name} loads ${spec} from elsewhere. Keep its code in its own files.`,
                );
                continue;
            }

            const known = browser
                ? BROWSER_PACKAGES.has(spec)
                : spec.startsWith("node:") ||
                  builtinModules.includes(spec) ||
                  packages.has(packageOf(spec));

            if (!known) {
                problems.push(
                    `${file.name} imports the package ${spec}, which Pi Pocket does not have: others cannot load it.`,
                );
            }
        }
    }

    return problems;
}

/** The first paragraph of a module's `/** … *\/` comment, as one line: its description in the index. */
export function docDescription(source: string): string {
    const comment = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? "";
    const paragraph =
        comment
            .replace(/^\s*\* ?/gm, "")
            .trim()
            .split(/\n\s*\n/)[0] ?? "";

    return paragraph.replace(/\s+/g, " ").trim();
}

/** A title from a module's name: `acme-clock` is "Acme clock". */
export function titleOf(name: string): string {
    const words = name.replace(/[-_]+/g, " ").trim();

    return words.charAt(0).toUpperCase() + words.slice(1);
}
