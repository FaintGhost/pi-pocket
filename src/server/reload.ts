/**
 * Live editing. Extension modules are imported again when they change and installed under the same names, which
 * replaces them in one step: a tool call already running finishes on the old code, the next one uses the new code.
 * Web files only need the browsers to reload.
 *
 * Modules come from two folders: Pi Pocket's own (`src/server/extensions/`), and the owner's drop-ins
 * (`extensions/` in the data folder), which load after them and stay off until the owner turns them on. The owner
 * can turn modules off and on from the app. A module that is off is not loaded, and turning one off uninstalls what
 * it installed; a tool call already running still finishes. What a module adds to the app (routes, a browser module)
 * is kept by `ExtensionWebs` and goes in and out with its extensions.
 */
import {
    type FSWatcher,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    watch,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import { describe } from "./errors.ts";
import { ExtensionWebs, POCKET_API } from "./extension-web.ts";
import type { ExtensionModule, PocketHost, WebAccess } from "./host.ts";

/** Built-in extension modules, in install order. Other `.ts` files in the directory load after them, by name. */
const ORDER = [
    "prompt.ts",
    "artifacts.ts",
    "browser.ts",
    "subagents.ts",
    "schedules.ts",
    "goals.ts",
    "plan.ts",
    "guard.ts",
    "codemode.ts",
    "memory.ts",
    "pip.ts",
    "triggers.ts",
];
/** Modules the app cannot work without: always on. */
const REQUIRED = new Set(["prompt.ts"]);
/** Built-in modules that stay off until the owner turns them on. Drop-ins all do. */
const OFF_BY_DEFAULT = new Set(["guard.ts"]);
const TITLES: Record<string, string> = {
    "prompt.ts": "System prompt",
    "artifacts.ts": "Artifacts",
    "browser.ts": "Browser",
    "subagents.ts": "Subagents",
    "schedules.ts": "Scheduled messages",
    "goals.ts": "Done when",
    "plan.ts": "Plan mode",
    "guard.ts": "Lancet Guard",
    "codemode.ts": "Codemode",
    "memory.ts": "Memory",
    "pip.ts": "PiP",
    "triggers.ts": "Triggers",
};

/**
 * Names Pi Pocket keeps for itself, whether the module that uses them is on or off. Installing an extension, or a tool,
 * with a name already taken replaces it in place, so a drop-in that used one would quietly replace a built-in (or be
 * replaced by it when the built-in is turned on), and turning the drop-in off would remove the built-in too.
 */
const RESERVED_EXTENSIONS = /^(pocket-.*|coding-tools)$/;

/** The tools of Pi Durable's coding tools and of the built-in modules. A test checks it against what they install. */
export const BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
    "read",
    "write",
    "edit",
    "bash",
    "artifact",
    "browser",
    "subagent",
    "schedule",
    "codemode",
    "memory",
    "sessions",
    "session_read",
    "session_start",
    "session_send",
    "session_follow",
    "session_stop",
    "session_archive",
    "session_schedule",
    "approvals",
    "watch_pr",
    "repo_watch",
    "session_watch_pr",
]);

/** Pi Pocket's own modules, or the owner's from the drop-in folder. */
export type ModuleSource = "built-in" | "drop-in";

export interface ExtensionInfo {
    file: string;
    title: string;
    source: ModuleSource;
    /** Where a drop-in's file is. */
    path?: string;
    /** The first sentence of the module's doc comment. */
    summary: string;
    enabled: boolean;
    required: boolean;
    /** What the module installed, with the tools each extension provides. */
    extensions: { name: string; tools: string[] }[];
    /** What it adds to the app: its routes (`GET status`), and who loads its browser module, when it has one. */
    web?: { routes: string[]; client?: WebAccess };
    /** Why the module is not loaded, when it failed. */
    error?: string;
}

type Module = { file: string; directory: string; source: ModuleSource };

/** Extension modules in a folder: `.ts` files, except tests and files starting with `_`. A missing folder has none. */
function moduleFiles(directory: string): string[] {
    try {
        return readdirSync(directory).filter(
            (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.startsWith("_"),
        );
    } catch {
        return [];
    }
}

/**
 * Make the drop-in folder, with a `node_modules` link to Pi Pocket's own packages. Drop-ins then import
 * `@earendil-works/pi-durable` and the rest as built-in modules do, and get the very modules the server runs. A
 * `node_modules` folder the owner made there stays as it is; a link to another place is replaced.
 */
export function prepareDropInFolder(directory: string, appModules: string): void {
    mkdirSync(directory, { recursive: true });
    const link = join(directory, "node_modules");
    let current: string | undefined;

    try {
        if (!lstatSync(link).isSymbolicLink()) {
            return;
        }

        current = realpathSync(link);
    } catch {
        // Missing, or a link to nowhere: made below.
    }

    if (current === realpathSync(appModules)) {
        return;
    }

    rmSync(link, { force: true });
    // A junction on Windows: no administrator rights needed.
    symlinkSync(appModules, link, process.platform === "win32" ? "junction" : "dir");
}

export class ExtensionLoader {
    readonly #registry: Registry;
    readonly #host: PocketHost;
    readonly #builtIn: string;
    readonly #dropIn: string | undefined;
    readonly #choice: (file: string) => boolean | undefined;
    readonly #webs: ExtensionWebs;
    /** Extension names each file installed, to uninstall the ones a new version no longer provides. */
    readonly #installed = new Map<string, Extension[]>();
    readonly #errors = new Map<string, string>();
    readonly #timers = new Map<string, NodeJS.Timeout>();
    /** Drop-ins already reported for having a built-in module's name, so each is reported once. */
    readonly #clashes = new Set<string>();
    readonly #watchers: FSWatcher[] = [];
    readonly #notify: (level: "info" | "warning" | "error", message: string) => void;
    /**
     * Each file's latest load, counted. A load counts only while it is the latest: one that finishes after a newer load
     * started, or after the module was turned off or removed, or after the server began to stop, installs nothing.
     */
    readonly #generations = new Map<string, number>();
    #closed = false;

    /**
     * `folders` are where the built-in modules and the owner's drop-ins are. `choice` says whether the owner turned a
     * module on (true) or off (false), or never chose (undefined, so the module's default applies). It is read again
     * on every load. `webs` keeps what modules add to the app. `notify` tells about modules (loaded, failed, removed):
     * the owner's, as a module's errors can name the server's folders or quote what a provider said.
     */
    constructor(
        registry: Registry,
        host: PocketHost,
        folders: { builtIn: string; dropIn?: string },
        choice: (file: string) => boolean | undefined = () => undefined,
        options: {
            webs?: ExtensionWebs;
            notify?: (level: "info" | "warning" | "error", message: string) => void;
        } = {},
    ) {
        this.#registry = registry;
        this.#host = host;
        this.#builtIn = folders.builtIn;
        this.#dropIn = folders.dropIn;
        this.#choice = choice;
        this.#webs = options.webs ?? new ExtensionWebs();
        this.#notify = options.notify ?? ((level, message) => host.notice(level, message));
    }

    /** Every module, built-in ones first in install order. A drop-in with a built-in's name is left out. */
    #modules(): Module[] {
        const present = moduleFiles(this.#builtIn);
        const builtIn = [
            ...ORDER.filter((file) => present.includes(file)),
            ...present.filter((file) => !ORDER.includes(file)).sort(),
        ];
        const dropIns = this.#dropIn === undefined ? [] : moduleFiles(this.#dropIn).sort();

        return [
            ...builtIn.map((file) => ({
                file,
                directory: this.#builtIn,
                source: "built-in" as const,
            })),
            ...dropIns
                .filter((file) => !builtIn.includes(file))
                .map((file) => ({ file, directory: this.#dropIn!, source: "drop-in" as const })),
        ];
    }

    #module(file: string): Module | undefined {
        return this.#modules().find((module) => module.file === file);
    }

    /** Tell the owner about drop-ins that have a built-in module's name, each once: they are never loaded. */
    #reportClashes(): void {
        if (this.#dropIn === undefined) {
            return;
        }

        const builtIn = moduleFiles(this.#builtIn);

        for (const file of moduleFiles(this.#dropIn)) {
            if (!builtIn.includes(file) || this.#clashes.has(file)) {
                continue;
            }

            this.#clashes.add(file);
            this.#notify(
                "warning",
                `The drop-in extension ${file} has the name of a built-in one and is not loaded. Rename it.`,
            );
        }
    }

    #isOn(module: Module): boolean {
        return (
            REQUIRED.has(module.file) ||
            (this.#choice(module.file) ??
                (module.source === "built-in" && !OFF_BY_DEFAULT.has(module.file)))
        );
    }

    enabled(file: string): boolean {
        const module = this.#module(file);

        return module !== undefined && this.#isOn(module);
    }

    files(): string[] {
        return this.#modules().map((module) => module.file);
    }

    /** Load every module that is on. A module that fails to load at startup is reported and skipped. */
    async loadAll(): Promise<void> {
        this.#reportClashes();

        for (const module of this.#modules()) {
            if (!this.#isOn(module)) {
                continue;
            }

            try {
                await this.#load(module.file, false);
            } catch (error) {
                if (error instanceof Overtaken) {
                    continue;
                }

                this.#errors.set(module.file, describe(error));
                this.#notify(
                    "error",
                    `Extension ${module.file} failed to load: ${describe(error)}`,
                );
            }
        }
    }

    /**
     * Install a module that was turned on, or uninstall one that was turned off (after `choice` already says so).
     * Throws when a module that was turned on fails to load; it stays on, and the error shows in `list()`.
     */
    async apply(file: string): Promise<void> {
        if (!this.files().includes(file)) {
            throw new Error(`There is no extension module ${file}`);
        }

        if (this.enabled(file)) {
            await this.reload(file);

            return;
        }

        this.#uninstall(file);
    }

    #uninstall(file: string): void {
        // A load still running for it installs nothing.
        this.#generation(file);

        for (const extension of this.#installed.get(file) ?? []) {
            this.#registry.uninstall(extension);
        }

        this.#webs.remove(file);
        this.#installed.delete(file);
        this.#errors.delete(file);
    }

    /**
     * Import a module again and install what it builds. When a newer load (or turning the module off) overtakes this
     * one, it installs nothing and answers what is installed: the newer one reports for itself.
     */
    async reload(file: string): Promise<Extension[]> {
        return (await this.#reload(file)) ?? this.#installed.get(file) ?? [];
    }

    /** `reload`, answering nothing when a newer load overtook this one. */
    async #reload(file: string): Promise<Extension[] | undefined> {
        try {
            return await this.#load(file, true);
        } catch (error) {
            if (error instanceof Overtaken) {
                return undefined;
            }

            this.#errors.set(file, describe(error));

            throw error;
        }
    }

    /** Start a file's next load, or end the one running: the number of the load that counts from now. */
    #generation(file: string): number {
        const next = (this.#generations.get(file) ?? 0) + 1;

        this.#generations.set(file, next);

        return next;
    }

    /** Throw when a load no longer counts. */
    #stillLatest(file: string, generation: number): void {
        if (this.#closed || this.#generations.get(file) !== generation) {
            throw new Overtaken(file);
        }
    }

    list(): ExtensionInfo[] {
        return this.#modules().map((module) => {
            const { file } = module;
            const error = this.#errors.get(file);
            const web = this.#webs.describe(file);

            return {
                file,
                title: titleOf(file),
                source: module.source,
                ...(module.source === "drop-in" ? { path: join(module.directory, file) } : {}),
                summary: summary(join(module.directory, file)),
                enabled: this.#isOn(module),
                required: REQUIRED.has(file),
                extensions: (this.#installed.get(file) ?? []).map((extension) => ({
                    name: extension.name,
                    tools: (extension.tools ?? []).map((tool) => tool.name),
                })),
                ...(web === undefined ? {} : { web }),
                ...(error === undefined ? {} : { error }),
            };
        });
    }

    extensionNames(): string[] {
        return [...this.#installed.values()].flat().map((extension) => extension.name);
    }

    async #load(file: string, cacheBust: boolean): Promise<Extension[]> {
        const module = this.#module(file);

        if (module === undefined) {
            throw new Error(`There is no extension module ${file}`);
        }

        const generation = this.#generation(file);
        const url =
            pathToFileURL(join(module.directory, file)).href +
            (cacheBust ? `?v=${Date.now()}` : "");
        const loaded = (await import(url)) as ExtensionModule;

        // The import can take a while (a module may wait at its top level): the module may be off by now, or edited.
        this.#stillLatest(file, generation);

        if (typeof loaded.default !== "function") {
            throw new Error("the module has no default export function");
        }

        const needs = loaded.pocketApi;

        if (needs !== undefined && (typeof needs !== "number" || !(needs <= POCKET_API))) {
            throw new Error(
                `the module needs version ${String(needs)} of Pi Pocket's extension API, and this Pi Pocket has ${POCKET_API}: update Pi Pocket`,
            );
        }

        // What it adds to the app counts only once it installed; a version that fails leaves the one before in place,
        // and what it set up (its cleanups) goes. The new version starts before the old one's cleanups run.
        const { part, web } = this.#webs.stage(file, module.directory, titleOf(file));
        let committed = false;

        try {
            const returned = loaded.default(this.#host, web) as unknown;
            // An async default export: it may register until it settles.
            const built = isThenable(returned) ? await returned : returned;

            this.#stillLatest(file, generation);

            const extensions = (
                built === undefined || built === null ? [] : Array.isArray(built) ? built : [built]
            ) as Extension[];

            // A default export that forgot to return its extensions would load as nothing at all.
            if (
                (built === undefined || built === null) &&
                part.empty &&
                part.disposers.length === 0
            ) {
                throw new Error(
                    "the module returned no extensions and added nothing to the app: return its extensions",
                );
            }

            if (module.source === "drop-in") {
                this.#checkNames(file, extensions);
            }

            const previous = this.#installed.get(file) ?? [];

            this.#installAll(extensions, previous);

            for (const old of previous) {
                if (!extensions.some((extension) => extension.name === old.name)) {
                    this.#registry.uninstall(old);
                }
            }

            this.#installed.set(file, extensions);
            this.#errors.delete(file);
            this.#webs.commit(part);
            committed = true;

            return extensions;
        } finally {
            if (!committed) {
                this.#webs.discard(part);
            }
        }
    }

    /**
     * Install a version's extensions, all or none: when one is refused, the ones before it are put back as they were,
     * so the previous version stays whole.
     */
    #installAll(extensions: readonly Extension[], previous: readonly Extension[]): void {
        const done: Extension[] = [];

        try {
            for (const extension of extensions) {
                this.#registry.install(extension);
                done.push(extension);
            }
        } catch (error) {
            for (const extension of done.reverse()) {
                const before = previous.find((old) => old.name === extension.name);

                try {
                    if (before === undefined) {
                        this.#registry.uninstall(extension);
                    } else {
                        this.#registry.install(before);
                    }
                } catch (undo) {
                    this.#notify(
                        "error",
                        `Could not put back the extension ${extension.name}: ${describe(undo)}`,
                    );
                }
            }

            throw error;
        }
    }

    /**
     * Refuse a drop-in that would take a name Pi Pocket keeps, or one another module installed: installing it would
     * replace that one. Throws before anything is installed, so a version that loaded before keeps running.
     */
    #checkNames(file: string, extensions: readonly Extension[]): void {
        const owners = new Map<string, string>();
        const tools = new Map<string, string>();

        for (const [other, installed] of this.#installed) {
            if (other === file) {
                continue;
            }

            for (const extension of installed) {
                owners.set(extension.name, other);

                for (const tool of extension.tools ?? []) {
                    tools.set(tool.name, other);
                }
            }
        }

        for (const extension of extensions) {
            if (RESERVED_EXTENSIONS.test(extension.name)) {
                throw new Error(
                    `the extension name ${extension.name} is Pi Pocket's own: give it a name of your own`,
                );
            }

            if (owners.has(extension.name)) {
                throw new Error(
                    `${owners.get(extension.name)} already installs an extension named ${extension.name}: give it a name of your own`,
                );
            }

            for (const tool of extension.tools ?? []) {
                if (BUILT_IN_TOOLS.has(tool.name)) {
                    throw new Error(
                        `the tool name ${tool.name} is a built-in tool's: give it a name of your own`,
                    );
                }

                if (tools.has(tool.name)) {
                    throw new Error(
                        `${tools.get(tool.name)} already has a tool named ${tool.name}: give it a name of your own`,
                    );
                }
            }
        }
    }

    /** Watch both folders and reload a module shortly after it changes. Keeps the old code when the new one fails. */
    watch(): void {
        this.#webs.watch();

        for (const directory of [this.#builtIn, this.#dropIn]) {
            if (directory === undefined) {
                continue;
            }

            try {
                this.#watchers.push(
                    watch(
                        directory,
                        (_event, name) =>
                            name !== null && this.#changed(basename(name.toString()), directory),
                    ),
                );
            } catch (error) {
                this.#notify(
                    "warning",
                    `Extensions in ${directory} are not reloaded when edited: ${describe(error)}`,
                );
            }
        }
    }

    #changed(file: string, directory: string): void {
        // A browser module's file, or its folder: tabs load the new version.
        this.#webs.touched(directory, file);

        if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("_")) {
            return;
        }

        if (directory === this.#dropIn) {
            this.#reportClashes();
        }

        // A moment later, for an edit and a removal alike: an editor that saves by writing a new file and renaming it
        // over the old one removes the file for an instant, and that is no removal.
        clearTimeout(this.#timers.get(file));
        this.#timers.set(
            file,
            setTimeout(() => {
                this.#timers.delete(file);
                this.#settle(file, directory);
            }, 300),
        );
    }

    /** After a module's file changed: take away a drop-in that is gone, or load the new version of one that is on. */
    #settle(file: string, directory: string): void {
        const module = this.#module(file);

        if (module === undefined && directory === this.#dropIn && this.#installed.has(file)) {
            this.#uninstall(file);
            this.#notify("info", `Removed the drop-in extension ${file}.`);

            return;
        }

        // A module that is off stays off when its file is edited; turning it on loads the new code.
        if (module?.directory !== directory || !this.enabled(file)) {
            return;
        }

        const loaded = this.#installed.has(file);

        this.#reload(file).then(
            (extensions) => {
                if (extensions !== undefined) {
                    this.#notify(
                        "info",
                        `Reloaded ${file}: ${extensions.map((extension) => extension.name).join(", ") || "it adds to the app"}`,
                    );
                }
            },
            (error: unknown) =>
                this.#notify(
                    "error",
                    loaded
                        ? `Kept the previous ${file}; the edited one failed to load: ${describe(error)}`
                        : `${file} failed to load: ${describe(error)}`,
                ),
        );
    }

    /** Stop watching, and run every module's cleanups: settles once they finished, the ones that wait included. */
    close(): Promise<void> {
        // Loads still running install nothing.
        this.#closed = true;

        for (const watcher of this.#watchers) {
            watcher.close();
        }

        for (const timer of this.#timers.values()) {
            clearTimeout(timer);
        }

        return this.#webs.close();
    }
}

/** A load that a newer one, or turning the module off, overtook: it installs nothing, and is no failure. */
class Overtaken extends Error {
    constructor(file: string) {
        super(`a newer load of ${file} replaced this one`);
    }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

/** A module's title in the Extensions sheet: a built-in's own, or a drop-in's file name. */
function titleOf(file: string): string {
    return TITLES[file] ?? file.replace(/\.ts$/, "");
}

/** The first sentence of a module's doc comment: its description in the Extensions sheet. */
function summary(path: string): string {
    try {
        const comment = /^\s*\/\*\*([\s\S]*?)\*\//.exec(readFileSync(path, "utf8"))?.[1] ?? "";
        const text = comment
            .replace(/^\s*\* ?/gm, "")
            .replace(/\s+/g, " ")
            .trim();

        return /^(.*?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
    } catch {
        return "";
    }
}

/** Calls `onChange` shortly after anything under `directory` changes. */
export function watchTree(directory: string, onChange: (file: string) => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    let last = "";
    const watcher = watch(directory, { recursive: true }, (_event, name) => {
        last = name?.toString() ?? "";
        clearTimeout(timer);
        timer = setTimeout(() => onChange(last), 200);
    });

    return () => {
        clearTimeout(timer);
        watcher.close();
    };
}
