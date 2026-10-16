/**
 * Themes: folders of CSS, colors, fonts, and images that change how the app looks and is laid out
 * (docs/extensions/themes.md). The built-in ones are in `web/themes/`, the owner's in the data folder's `themes/`. Each
 * is read and checked here (`themes/format.ts`, `themes/css.ts`), its CSS kept in memory as it was checked, and served
 * at `/themes/<id>/<rev>/…` to everyone signed in (`http/theme-routes.ts`). A theme that breaks keeps its last good
 * version while the server runs, and the owner is told why.
 */
import { createHash } from "node:crypto";
import {
    closeSync,
    constants,
    cpSync,
    type Dirent,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { opened } from "./http/extension-routes.ts";
import { desktopTheme } from "./omarchy.ts";
import { watchTree } from "./reload.ts";
import { cssReferences, themeFile } from "./themes/css.ts";
import {
    assetType,
    colorsToml,
    type Manifest,
    newThemeId,
    parseManifest,
    parseThemeColors,
    plainLine,
    THEME_ID,
    THEME_LIMITS,
    ThemeProblem,
} from "./themes/format.ts";

/** The app's own look, which every theme builds on: choosing it loads no stylesheet. */
export const BASE_THEME = "pocket";

/** A theme as the web app lists it. */
export interface ThemeInfo {
    id: string;
    name: string;
    description?: string;
    author?: string;
    version?: string;
    /** In `web/themes/`, with the app: it cannot be changed or removed here. */
    builtIn: boolean;
    /** The stylesheets to load, in order (a theme it extends first); none for the base theme and for colors alone. */
    css: string[];
    /** Its palette, by `colors.toml`'s keys, when it has one. */
    colors?: Record<string, string>;
    /** Changes when any of its files do. */
    rev?: string;
    extends?: string;
    /** Why it is not as its files are: it keeps its last good version, or, with none, it is not offered. */
    problem?: string;
    /** Whether it can be chosen: it has a good version. */
    usable: boolean;
}

/** A file of a theme's folder, as it was when it was read. */
interface FileStat {
    file: string;
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
}

/** A theme as it was checked: what is served. */
interface Version {
    id: string;
    dir: string;
    builtIn: boolean;
    manifest?: Manifest;
    colors?: Record<string, string>;
    /** Its stylesheets' text, by their path in the folder, `theme.css` first. */
    css: Map<string, string>;
    /** Its fonts and images, by their path in the folder. */
    assets: Map<string, FileStat & { type: string }>;
    rev: string;
}

/** Pi Pocket's version, from its package. */
function pocketVersion(): string {
    try {
        return (
            (
                JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
                    version?: string;
                }
            ).version ?? "0.0.0"
        );
    } catch {
        return "0.0.0";
    }
}

/** A theme folder found, in the order listed. */
interface Listed {
    id: string;
    builtIn: boolean;
    name?: string | undefined;
}

/** What a theme's address serves: a stylesheet as it was checked, or a font or image on disk. */
export type ThemeFile = { css: string } | (FileStat & { type: string });

export interface ThemesOptions {
    builtIn: string;
    dataDir: string;
    /** Pi Pocket's version, for a theme's `minPocket`: its package's, unless a test says otherwise. */
    version?: string;
    /** Something about a theme only the owner can mend. */
    notify: (message: string) => void;
    /** The list changed: tabs should hear it. */
    changed: () => void;
    log: (line: string) => void;
}

export class Themes {
    readonly builtInDir: string;
    /** The owner's themes. */
    readonly dir: string;
    readonly #options: ThemesOptions & { version: string };
    /** The last good version of each theme, by id. */
    readonly #good = new Map<string, Version>();
    /** Why a theme's files are not what is served, by id. */
    readonly #problems = new Map<string, string>();
    /** Every theme folder found, by id, in the order listed: built-in ones first. */
    #found: Listed[] = [];
    /** The palettes that come with the app (`web/themes.js`), by id: their ids are taken. */
    #palettes: Record<string, { name: string; colors: Record<string, string> }> = {};
    /** Folders not read for their names, with why: told once. */
    #misnamed = new Map<string, string>();
    #stops: (() => void)[] = [];
    #timer: NodeJS.Timeout | undefined;
    #listKey = "";

    constructor(options: ThemesOptions) {
        this.#options = { ...options, version: options.version ?? pocketVersion() };
        this.builtInDir = options.builtIn;
        this.dir = join(options.dataDir, "themes");
    }

    /** Read every theme, once, as the server starts. */
    async load(): Promise<void> {
        try {
            const module = (await import(
                pathToFileURL(join(APP_ROOT, "web", "themes.js")).href
            )) as {
                THEMES: Record<string, { name: string; colors: Record<string, string> }>;
            };

            this.#palettes = module.THEMES;
        } catch (error) {
            this.#options.log(`The app's palettes could not be read: ${describe(error)}`);
        }

        try {
            mkdirSync(this.dir, { recursive: true });
        } catch (error) {
            this.#options.log(`No themes folder at ${this.dir}: ${describe(error)}`);
        }

        this.#scan(false);
    }

    /** Read the themes again shortly after their files change. */
    watch(): void {
        const later = () => {
            clearTimeout(this.#timer);
            this.#timer = setTimeout(() => this.rescan(), 300);
        };

        for (const dir of [this.builtInDir, this.dir]) {
            try {
                this.#stops.push(watchTree(dir, later));
            } catch (error) {
                this.#options.log(
                    `Themes in ${dir} are not reloaded when edited: ${describe(error)}`,
                );
            }
        }
    }

    close(): void {
        clearTimeout(this.#timer);

        for (const stop of this.#stops.splice(0)) {
            stop();
        }
    }

    /** Read every theme again, and tell the tabs and the owner what changed. */
    rescan(): void {
        this.#scan(true);
    }

    /** Every theme, as the web app lists it: built-in ones first, then the owner's by name. */
    list(): ThemeInfo[] {
        return this.#found.map(({ id, builtIn, name }) => {
            const good = this.#good.get(id);
            const problem = this.#problems.get(id);
            const manifest = good?.manifest;

            return {
                id,
                name: manifest?.name ?? name ?? id,
                ...(manifest?.description === undefined
                    ? {}
                    : { description: manifest.description }),
                ...(manifest?.author === undefined ? {} : { author: manifest.author }),
                ...(manifest?.version === undefined ? {} : { version: manifest.version }),
                builtIn,
                css: good === undefined || id === BASE_THEME ? [] : this.#chain(good),
                ...(good?.colors === undefined ? {} : { colors: good.colors }),
                ...(good === undefined ? {} : { rev: good.rev }),
                ...(manifest?.extends === undefined ? {} : { extends: manifest.extends }),
                ...(problem === undefined ? {} : { problem }),
                usable: good !== undefined,
            };
        });
    }

    /** A file a theme serves now, by its path in the folder; none for anything else. */
    file(id: string, path: readonly string[]): ThemeFile | undefined {
        const good = this.#good.get(id);
        const key = path.join("/");

        if (good === undefined) {
            return undefined;
        }

        const css = good.css.get(key);

        return css === undefined ? good.assets.get(key) : { css };
    }

    /** Whether a theme is the owner's, and so may be changed or removed here. */
    #owned(id: string): boolean {
        return this.#found.some((each) => each.id === id && !each.builtIn);
    }

    /**
     * A new theme of the owner's called `name`, from `from`: a copy of a theme's files, or a palette (a built-in one, or
     * `desktop`, the desktop's as it is now) as a theme of colors alone. Answers its id.
     */
    async duplicate(from: string, name: unknown): Promise<string> {
        const title = (() => {
            try {
                return plainLine(name, "The name", 60);
            } catch (error) {
                throw new HttpError(400, describe(error));
            }
        })();
        const id = newThemeId(title, (each) => this.#taken(each));
        const target = join(this.dir, id);
        const source = this.#good.get(from);
        let manifest: Record<string, unknown> | undefined;
        let colors: Record<string, string> | undefined;

        if (source !== undefined) {
            // Its own now: what the copy says of itself is the owner's to write.
            manifest = { ...(source.manifest ?? { themeApi: 1 }), name: title };
            delete manifest.description;
            delete manifest.author;
            delete manifest.version;
            colors = source.colors;
        } else if (from === "desktop") {
            colors = (await desktopTheme())?.colors;
        } else {
            colors = this.#palettes[from]?.colors;
        }

        if (source === undefined && colors === undefined) {
            throw new HttpError(404, "No such theme or colors to copy");
        }

        mkdirSync(this.dir, { recursive: true });
        mkdirSync(target);

        try {
            // Its files as they are written, not as they are served.
            for (const path of [...(source?.css.keys() ?? []), ...(source?.assets.keys() ?? [])]) {
                mkdirSync(dirname(join(target, path)), { recursive: true });
                cpSync(join(source!.dir, path), join(target, path), { dereference: false });
            }

            if (colors !== undefined) {
                writeFileSync(join(target, "colors.toml"), colorsToml(colors));
            }

            writeFileSync(
                join(target, "theme.json"),
                `${JSON.stringify(manifest ?? { themeApi: 1, name: title }, null, 4)}\n`,
            );
        } catch (error) {
            this.#options.log(`Theme ${id} was not copied whole: ${describe(error)}`);

            throw new HttpError(500, `The copy failed: ${describe(error)}`);
        }

        this.#scan(true);

        return id;
    }

    /** Take one of the owner's themes away: into `themes/.removed/`, which is not listed, so nothing is lost. */
    remove(id: string): void {
        if (!this.#owned(id)) {
            throw new HttpError(404, "No such theme of yours");
        }

        const removed = join(this.dir, ".removed");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");

        mkdirSync(removed, { recursive: true });
        renameSync(join(this.dir, id), join(removed, `${id}-${stamp}`));
        this.#scan(true);
    }

    /** Where a session that edits one of the owner's themes works, and what its message box starts with. */
    edit(id: string): { cwd: string; draft: string } {
        if (!this.#owned(id)) {
            throw new HttpError(
                404,
                "Only your own themes can be edited here: duplicate this one first",
            );
        }

        const name = this.list().find((each) => each.id === id)?.name ?? id;
        const docs = join(APP_ROOT, "docs", "extensions");

        return {
            cwd: join(this.dir, id),
            draft: `Help me change the theme “${name}” in this folder. Read the theme guide (${join(docs, "themes.md")}) and the list of tokens and parts (${join(docs, "reference", "theme-surface.md")}) first. What I want: `,
        };
    }

    /** Whether an id is a theme's, a built-in palette's, or a word the app keeps. */
    #taken(id: string): boolean {
        if (id === "desktop" || id === BASE_THEME || this.#palettes[id] !== undefined) {
            return true;
        }

        if (this.#found.some((each) => each.id === id)) {
            return true;
        }

        try {
            lstatSync(join(this.dir, id));

            return true;
        } catch {
            return false;
        }
    }

    /** The stylesheets of a theme, the ones of the themes it extends first. */
    #chain(version: Version): string[] {
        const own = version.css.has("theme.css")
            ? [`/themes/${version.id}/${version.rev}/theme.css`]
            : [];
        const base = version.manifest?.extends;
        const parent = base === undefined || base === BASE_THEME ? undefined : this.#good.get(base);

        return parent === undefined ? own : [...this.#chain(parent), ...own];
    }

    /** Read every theme folder; with `tell`, tell the owner about new problems and the tabs about a changed list. */
    #scan(tell: boolean): void {
        const found: { id: string; builtIn: boolean; dir: string }[] = [];

        for (const [root, builtIn] of [
            [this.builtInDir, true],
            [this.dir, false],
        ] as const) {
            let entries: Dirent[];

            try {
                entries = readdirSync(root, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries
                .filter((each) => each.isDirectory() && !each.name.startsWith("."))
                .sort((a, b) => (a.name < b.name ? -1 : 1))) {
                found.push({ id: entry.name, builtIn, dir: join(root, entry.name) });
            }
        }

        const before = new Map(this.#problems);
        const seen = new Set<string>();
        const listed: Listed[] = [];
        const misnamed = new Map<string, string>();

        for (const { id, builtIn, dir } of found) {
            if (!THEME_ID.test(id)) {
                misnamed.set(
                    dir,
                    "its folder's name is not an id: 2 to 48 lowercase letters, digits, and -",
                );
                continue;
            }

            if (
                seen.has(id) ||
                (!builtIn && (this.#palettes[id] !== undefined || id === "desktop"))
            ) {
                misnamed.set(
                    dir,
                    "its folder has the name of a theme or colors that come with Pi Pocket",
                );
                continue;
            }

            seen.add(id);

            try {
                const version = readTheme(dir, id, builtIn, this.#options.version);

                this.#good.set(id, version);
                this.#problems.delete(id);
                listed.push({ id, builtIn, name: version.manifest?.name });
            } catch (error) {
                this.#problems.set(
                    id,
                    error instanceof ThemeProblem
                        ? error.message
                        : `it cannot be read: ${describe(error)}`,
                );
                listed.push({ id, builtIn, name: this.#good.get(id)?.manifest?.name });
            }
        }

        // Themes whose folder went: nothing of them is served or listed.
        for (const id of [...this.#good.keys()]) {
            if (!seen.has(id)) {
                this.#good.delete(id);
            }
        }

        for (const id of [...this.#problems.keys()]) {
            if (!seen.has(id)) {
                this.#problems.delete(id);
            }
        }

        // The owner's by name, after the built-in ones.
        const owners = listed
            .filter((each) => !each.builtIn)
            .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));

        this.#found = [...listed.filter((each) => each.builtIn), ...owners];

        const told: string[] = [];

        for (const [id, problem] of this.#problems) {
            if (before.get(id) !== problem) {
                const name = this.#found.find((each) => each.id === id)?.name;
                const kept = this.#good.has(id)
                    ? "It keeps its last good version."
                    : "It is not offered until that is mended.";

                told.push(`Theme ${name ? `“${name}” (${id})` : id}: ${problem}. ${kept}`);
            }
        }

        for (const [dir, problem] of misnamed) {
            if (this.#misnamed.get(dir) !== problem) {
                told.push(`The theme folder ${dir} is not read: ${problem}.`);
            }
        }

        this.#misnamed = misnamed;

        for (const message of told) {
            this.#options.log(message);

            if (tell) {
                this.#options.notify(message);
            }
        }

        const key = JSON.stringify(this.list());

        if (key !== this.#listKey) {
            this.#listKey = key;

            if (tell) {
                this.#options.changed();
            }
        }
    }
}

/** A theme's folder: its files, by their path in it; no hidden ones, `node_modules`, or links, four folders deep. */
function walk(dir: string): Map<string, FileStat> {
    const files = new Map<string, FileStat>();
    let looked = 0;

    const visit = (folder: string, prefix: string, depth: number) => {
        let entries: Dirent[];

        try {
            entries = readdirSync(folder, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (++looked > THEME_LIMITS.walk) {
                throw new ThemeProblem(
                    `its folder holds more than ${THEME_LIMITS.walk} files and folders`,
                );
            }

            if (entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }

            const path = join(folder, entry.name);
            const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

            if (entry.isDirectory()) {
                if (depth < THEME_LIMITS.depth) {
                    visit(path, relative, depth + 1);
                }
            } else if (entry.isFile()) {
                try {
                    const stats = lstatSync(path);

                    files.set(relative, {
                        file: path,
                        size: stats.size,
                        mtimeMs: stats.mtimeMs,
                        dev: stats.dev,
                        ino: stats.ino,
                    });
                } catch {
                    // Gone since the listing.
                }
            }
        }
    };

    const stats = lstatSync(dir);

    if (!stats.isDirectory()) {
        throw new ThemeProblem("it is not a folder (a link to one is not read)");
    }

    visit(dir, "", 0);

    return files;
}

/** A file of the folder as text, read as it was listed: not a link, the same file, and no bigger than `max`. */
export function readListed(stat: FileStat, max: number, what: string): string {
    if (stat.size > max) {
        throw new ThemeProblem(`${what} is larger than ${Math.round(max / 1024)} KB`);
    }

    let fd: number;

    try {
        fd = openSync(stat.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        throw new ThemeProblem(`${what} cannot be read: ${describe(error)}`);
    }

    try {
        const now = fstatSync(fd);

        if (!now.isFile() || !opened(fd, stat, now) || now.size > max) {
            throw new ThemeProblem(`${what} changed while it was read: it is read again soon`);
        }

        return readFileSync(fd, "utf8");
    } finally {
        closeSync(fd);
    }
}

/** Read and check one theme folder: what it serves, or why it cannot. */
export function readTheme(
    dir: string,
    id: string,
    builtIn: boolean,
    pocketVersion: string,
): Version {
    const files = walk(dir);
    const hash = createHash("sha256");
    const manifestFile = files.get("theme.json");
    const colorsFile = files.get("colors.toml");
    const entry = files.get("theme.css");
    let manifest: Manifest | undefined;
    let colors: Record<string, string> | undefined;

    if (manifestFile !== undefined) {
        const text = readListed(manifestFile, THEME_LIMITS.small, "theme.json");

        manifest = parseManifest(text, pocketVersion);
        hash.update(`theme.json\0${text}\0`);
    }

    if (colorsFile !== undefined) {
        const text = readListed(colorsFile, THEME_LIMITS.small, "colors.toml");

        colors = parseThemeColors(text);
        hash.update(`colors.toml\0${text}\0`);
    }

    if (entry === undefined && colors === undefined) {
        throw new ThemeProblem("it has neither a theme.css nor a colors.toml");
    }

    if (entry !== undefined && manifest === undefined) {
        throw new ThemeProblem("it has a theme.css but no theme.json");
    }

    if (manifest?.extends === id) {
        throw new ThemeProblem("it extends itself");
    }

    const css = new Map<string, string>();
    /** Where each stylesheet loads a font or an image, to write the theme's own address in (`served` below). */
    const loads = new Map<string, { start: number; end: number; quoted: boolean; to: string }[]>();
    const assets = new Map<string, FileStat & { type: string }>();
    let cssBytes = 0;
    let assetBytes = 0;
    const queue = entry === undefined ? [] : ["theme.css"];

    while (queue.length > 0) {
        const path = queue.shift()!;

        if (css.has(path)) {
            continue;
        }

        const stat = files.get(path)!;

        cssBytes += stat.size;

        if (cssBytes > THEME_LIMITS.css) {
            throw new ThemeProblem(`its CSS is larger than ${THEME_LIMITS.css / 1024} KB together`);
        }

        const text = readListed(stat, THEME_LIMITS.css, path);
        const found = cssReferences(text);
        const where = (line: number) => `${path} line ${line}`;

        css.set(path, found.text);
        loads.set(path, []);
        hash.update(`${path}\0${text}\0`);

        if (found.problems.length > 0) {
            const first = found.problems[0]!;

            throw new ThemeProblem(`${where(first.line)}: ${first.message}`);
        }

        for (const ref of found.imports) {
            const target = themeFile(ref.url, path);

            if (typeof target !== "object" || !target.file.toLowerCase().endsWith(".css")) {
                throw new ThemeProblem(
                    `${where(ref.line)}: @import ${JSON.stringify(ref.url)} is not a .css file of the theme's own: a theme loads only its own files`,
                );
            }

            if (!files.has(target.file)) {
                throw new ThemeProblem(
                    `${where(ref.line)}: there is no ${target.file} in its folder`,
                );
            }

            queue.push(target.file);
        }

        for (const ref of found.assets) {
            const target = themeFile(ref.url, path);

            if (target === "fragment" || target === "data") {
                continue;
            }

            if (target === undefined) {
                throw new ThemeProblem(
                    `${where(ref.line)}: url(${JSON.stringify(ref.url)}) is not a file in the theme's folder: a theme loads only its own files`,
                );
            }

            const type = assetType(target.file);
            const stat = files.get(target.file);

            if (type === undefined) {
                throw new ThemeProblem(
                    `${where(ref.line)}: ${target.file} is not a .woff2 font or an image (.png, .jpg, .webp, .avif, .gif, .svg)`,
                );
            }

            if (stat === undefined) {
                throw new ThemeProblem(
                    `${where(ref.line)}: there is no ${target.file} in its folder`,
                );
            }

            const fragment = ref.url.indexOf("#");

            loads.get(path)!.push({
                start: ref.start,
                end: ref.end,
                quoted: ref.quoted,
                to: `${target.file}${fragment === -1 ? "" : `#${encodeURIComponent(ref.url.slice(fragment + 1))}`}`,
            });

            if (assets.has(target.file)) {
                continue;
            }

            if (stat.size > THEME_LIMITS.asset) {
                throw new ThemeProblem(
                    `${target.file} is larger than ${THEME_LIMITS.asset / 1024 / 1024} MB`,
                );
            }

            assetBytes += stat.size;

            if (assetBytes > THEME_LIMITS.total) {
                throw new ThemeProblem(
                    `its fonts and images are larger than ${THEME_LIMITS.total / 1024 / 1024} MB together`,
                );
            }

            assets.set(target.file, { ...stat, type });
            hash.update(`${target.file}\0${stat.size}\0${stat.mtimeMs}\0`);
        }

        if (css.size + assets.size > THEME_LIMITS.files) {
            throw new ThemeProblem(`it serves more than ${THEME_LIMITS.files} files`);
        }
    }

    const rev = hash.digest("base64url").slice(0, 12);

    return {
        id,
        dir,
        builtIn,
        ...(manifest === undefined ? {} : { manifest }),
        ...(colors === undefined ? {} : { colors }),
        css: new Map(
            [...css].map(([path, text]) => [path, served(text, loads.get(path)!, id, rev)]),
        ),
        assets,
        rev,
    };
}

/**
 * A stylesheet as it is served: each font and image it loads named by its full address, not by a path from the
 * stylesheet. A path in a variable (`--wallpaper: url("images/a.png")`) would otherwise be read where the variable is
 * used, from the app's own stylesheet, and miss.
 */
function served(
    text: string,
    loads: { start: number; end: number; quoted: boolean; to: string }[],
    id: string,
    rev: string,
): string {
    let out = text;

    for (const load of [...loads].sort((a, b) => b.start - a.start)) {
        const [file, fragment] = load.to.split("#");
        const address = `/themes/${id}/${rev}/${file!.split("/").map(encodeURIComponent).join("/")}${fragment === undefined ? "" : `#${fragment}`}`;

        out = `${out.slice(0, load.start)}${load.quoted ? `"${address}"` : `url("${address}")`}${out.slice(load.end)}`;
    }

    return out;
}
