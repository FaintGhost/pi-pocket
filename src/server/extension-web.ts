/**
 * Extensions' web parts. While a module loads, the `web` its default export gets registers its routes (under
 * `/api/x/<module>/`) and its browser module (served from `/x/<module>/<rev>/`). They count only once the module
 * installed, and they replace the previous version's in one step, as its extensions do; turning the module off removes
 * them. The browser module loads in the tabs of the people its access lets in, and gets the events the module sends.
 */
import { createHash } from "node:crypto";
import { type Dirent, type FSWatcher, readdirSync, realpathSync, statSync, watch } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { User } from "./config.ts";
import { describe } from "./errors.ts";
import type { ExtensionWeb, WebAccess, WebHandler, WebMethod } from "./host.ts";

/**
 * The version of the extension API: the server's `web` and the app's `pocket`. It goes up only when something modules
 * use changes in a way that breaks them; additions keep it.
 */
export const POCKET_API = 1;

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ACCESS: ReadonlySet<string> = new Set(["owner", "steer", "view"]);
/** A module with a web part needs a name that is one part of an address as it is. */
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SEGMENT = /^(?::[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._~-]+)$/;
const EVENT = /^[A-Za-z0-9._:-]{1,64}$/;
/** An event's data, as JSON, at most: the app's event streams carry it to every tab it is for. */
const MAX_EVENT = 256 * 1024;
/** How many files a browser module's folder may have for its version to be worked out; more are not looked at. */
const MAX_FILES = 2000;
/** How many of a browser module's folders are watched for edits; deeper or more are seen at the module's next load. */
const MAX_WATCHED = 64;

/** Marks the errors a module made with `web.error`: only their status and words reach the browser as they are. */
const EXPOSED = Symbol("pocket.webError");

/** An error a module made with `web.error`, to answer with: its status and its words, for whoever asked. */
export function exposedError(error: unknown): { status: number; message: string } | undefined {
    if (typeof error !== "object" || error === null || !(EXPOSED in error)) {
        return undefined;
    }

    const { status, message } = error as { status?: unknown; message?: unknown };

    return typeof status === "number" ? { status, message: String(message) } : undefined;
}

/** The files a browser module's folder serves, by type. Never `.ts`: server code can hold secrets. */
export const WEB_FILE_TYPES: Readonly<Record<string, string>> = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
};

/** Whether someone may use a web part open to `access`. The owner always may; people invited to one session never. */
export function mayUse(user: Pick<User, "role" | "sessions">, access: WebAccess): boolean {
    if (user.role === "owner") {
        return true;
    }

    if (user.sessions !== undefined) {
        return false;
    }

    return access === "view" || (access === "steer" && user.role === "guest");
}

/** A module's name, from its file: `server-status.ts` is `server-status`. */
export function moduleName(file: string): string {
    return file.replace(/\.ts$/, "");
}

interface Route {
    method: WebMethod;
    /** The path as registered, for the Extensions sheet. */
    path: string;
    segments: string[];
    access: WebAccess;
    handle: WebHandler;
}

interface Client {
    access: WebAccess;
    /** The entry file, or the folder everything is served from. */
    root: string;
    folder: boolean;
    /** The entry's path in the browser module's address: `index.js` in a folder, else the file's name. */
    entry: string;
    /** Changes with the files, so browsers import the new version. */
    rev: string;
}

/** What one version of a module registered. Nothing counts until the loader commits it. */
export class WebPart {
    readonly file: string;
    readonly module: string;
    readonly title: string;
    readonly directory: string;
    readonly routes: Route[] = [];
    client: Client | undefined;
    readonly disposers: (() => void)[] = [];
    watchers: FSWatcher[] = [];
    /** Registering ends when the module's default export returns. */
    sealed = false;
    disposed = false;

    constructor(file: string, directory: string, title: string) {
        this.file = file;
        this.module = moduleName(file);
        this.directory = directory;
        this.title = title;
    }

    get empty(): boolean {
        return this.routes.length === 0 && this.client === undefined && this.disposers.length === 0;
    }
}

/** The routes a request to a module could mean. */
export type RouteMatch =
    { route: Route; part: WebPart; params: Record<string, string> } | { allow: WebMethod[] };

interface Options {
    /** Browser modules for the people `access` lets in changed: their tabs must hear which to load. */
    changed?: (access: WebAccess[]) => void;
    /** Send a browser module's event to the tabs it loads in (`to`: one person's). */
    deliver?: (part: WebPart, access: WebAccess, event: string, data: unknown, to?: string) => void;
    log?: (message: string) => void;
}

export class ExtensionWebs {
    /** The web part of every module that has one, by module name. */
    readonly #parts = new Map<string, WebPart>();
    readonly #options: Options;
    #watching = false;
    #closed = false;
    readonly #timers = new Map<WebPart, NodeJS.Timeout>();

    constructor(options: Options = {}) {
        this.#options = options;
    }

    /** What a module registers while `file` (in `directory`) loads, and the `web` its default export gets. */
    stage(file: string, directory: string, title: string): { part: WebPart; web: ExtensionWeb } {
        const part = new WebPart(file, directory, title);

        const open = (what: string) => {
            if (part.sealed) {
                throw new Error(
                    `web.${what}: register routes and the browser module while the module loads`,
                );
            }

            if (!MODULE_NAME.test(part.module)) {
                throw new Error(
                    `web.${what}: rename ${file}: a module with a web part needs a name of letters, digits, - and _`,
                );
            }
        };

        const web: ExtensionWeb = {
            api: POCKET_API,
            module: part.module,
            route: (method, path, handle, options) => {
                open("route");
                part.routes.push(checkRoute(part, method, path, handle, options?.access));
            },
            client: (entry, options) => {
                open("client");

                if (part.client !== undefined) {
                    throw new Error("web.client: a module has one browser module");
                }

                part.client = checkClient(part, entry, options?.access);
            },
            // Never throws: it is mostly called from timers, where a throw would take the whole server down. What it
            // cannot send goes to the log.
            send: (event, data, options) => {
                const problem = (why: string) =>
                    this.#options.log?.(`${file}: web.send(${String(event)}) sent nothing: ${why}`);

                if (typeof event !== "string" || !EVENT.test(event)) {
                    return problem("name the event with up to 64 letters, digits, and . _ : -");
                }

                let json: string | undefined;

                try {
                    json = JSON.stringify(data ?? null) as string | undefined;
                } catch (error) {
                    return problem(`its data is not JSON: ${describe(error)}`);
                }

                if (json === undefined) {
                    return problem("its data is not JSON");
                }

                if (Buffer.byteLength(json) > MAX_EVENT) {
                    return problem(`its data is larger than ${MAX_EVENT} bytes`);
                }

                // Only the version in force, and only to a browser module: one replaced or removed sends nothing.
                if (this.#parts.get(part.module) !== part || part.client === undefined) {
                    return;
                }

                this.#options.deliver?.(
                    part,
                    part.client.access,
                    event,
                    JSON.parse(json),
                    options?.to,
                );
            },
            error: (status, message) => {
                if (!Number.isInteger(status) || status < 400 || status > 599) {
                    throw new Error(`web.error: a status is from 400 to 599, not ${status}`);
                }

                return Object.assign(new Error(String(message)), { status, [EXPOSED]: true });
            },
            onDispose: (dispose) => {
                if (typeof dispose !== "function") {
                    throw new Error("web.onDispose: give it a function");
                }

                if (part.disposed) {
                    runDispose(dispose, part, this.#options.log);

                    return;
                }

                part.disposers.push(dispose);
            },
        };

        return { part, web: Object.freeze(web) };
    }

    /** The module installed: what it registered replaces what its previous version had. */
    commit(part: WebPart): void {
        part.sealed = true;

        // Loaded while the server stopped: it goes at once.
        if (this.#closed) {
            this.#dispose(part);

            return;
        }

        const previous = this.#parts.get(part.module);

        if (part.empty) {
            this.#parts.delete(part.module);
        } else {
            this.#parts.set(part.module, part);
            this.#watchFolder(part);
        }

        if (previous !== undefined) {
            this.#dispose(previous);
        }

        if (clientKey(previous) !== clientKey(part.empty ? undefined : part)) {
            this.#changed(previous, part);
        }
    }

    /** The module failed to load: what it registered goes, and the version before stays. */
    discard(part: WebPart): void {
        part.sealed = true;
        this.#dispose(part);
    }

    /** The module was turned off or deleted. */
    remove(file: string): void {
        const part = this.#parts.get(moduleName(file));

        if (part === undefined || part.file !== file) {
            return;
        }

        this.#parts.delete(part.module);
        this.#dispose(part);

        if (part.client !== undefined) {
            this.#changed(part);
        }
    }

    /** The route a request to `module` means, the methods its path takes when none matches, or none. */
    match(module: string, method: string, path: readonly string[]): RouteMatch | undefined {
        const part = this.#parts.get(module);

        if (part === undefined) {
            return undefined;
        }

        const allow: WebMethod[] = [];

        for (const route of part.routes) {
            const params = matchPath(route.segments, path);

            if (params === undefined) {
                continue;
            }

            if (route.method === method) {
                return { route, part, params };
            }

            allow.push(route.method);
        }

        return allow.length > 0 ? { allow } : undefined;
    }

    /** The browser modules someone's tabs load: each module's name, title, and address. */
    clients(
        user: Pick<User, "role" | "sessions">,
    ): { module: string; title: string; url: string }[] {
        return [...this.#parts.values()]
            .filter((part) => part.client !== undefined && mayUse(user, part.client.access))
            .map((part) => ({
                module: part.module,
                title: part.title,
                url: `/x/${part.module}/${part.client!.rev}/${part.client!.entry}`,
            }));
    }

    /**
     * A file of a module's browser module that someone may load, by its path under the module's address, with its type;
     * none for anything else. A folder serves its own files of the web types, never hidden ones or `node_modules`.
     */
    file(
        module: string,
        path: readonly string[],
        user: Pick<User, "role" | "sessions">,
    ): { file: string; type: string } | undefined {
        const client = this.#parts.get(module)?.client;

        if (client === undefined || !mayUse(user, client.access) || path.length === 0) {
            return undefined;
        }

        if (path.some((part) => part === "" || part.startsWith(".") || part === "node_modules")) {
            return undefined;
        }

        const type = WEB_FILE_TYPES[extname(path.at(-1)!).toLowerCase()];

        if (type === undefined) {
            return undefined;
        }

        if (!client.folder) {
            return path.length === 1 && path[0] === client.entry
                ? { file: client.root, type }
                : undefined;
        }

        // Inside the folder for real: a link out of it serves nothing.
        try {
            const root = realpathSync(client.root);
            const file = realpathSync(join(client.root, ...path));

            return file.startsWith(root + sep) && statSync(file).isFile()
                ? { file, type }
                : undefined;
        } catch {
            return undefined;
        }
    }

    /** What a module's web part has, for the Extensions sheet. */
    describe(file: string): { routes: string[]; client?: WebAccess } | undefined {
        const part = this.#parts.get(moduleName(file));

        if (part === undefined || part.file !== file || part.empty) {
            return undefined;
        }

        return {
            routes: part.routes.map((route) => `${route.method} ${route.path}`),
            ...(part.client === undefined ? {} : { client: part.client.access }),
        };
    }

    /** Look again at browser modules' files when they change: a new version reaches the tabs. */
    watch(): void {
        this.#watching = true;

        for (const part of this.#parts.values()) {
            this.#watchFolder(part);
        }
    }

    /** Something changed in a folder of modules: a browser module that is that file or folder has a new version. */
    touched(directory: string, name: string): void {
        for (const part of this.#parts.values()) {
            const client = part.client;

            if (client !== undefined && client.root === join(directory, name)) {
                this.#recheck(part);
            }
        }
    }

    close(): void {
        this.#closed = true;

        for (const part of this.#parts.values()) {
            this.#dispose(part);
        }

        this.#parts.clear();
    }

    /** Tell the tabs of the people who load either part's browser module. */
    #changed(...parts: (WebPart | undefined)[]): void {
        const access = parts.flatMap((part) => (part?.client ? [part.client.access] : []));

        if (access.length > 0) {
            this.#options.changed?.(access);
        }
    }

    #recheck(part: WebPart): void {
        clearTimeout(this.#timers.get(part));
        this.#timers.set(
            part,
            setTimeout(() => {
                this.#timers.delete(part);
                const client = part.client;

                if (client === undefined || this.#parts.get(part.module) !== part) {
                    return;
                }

                const rev = revision(client.root, client.folder);

                if (rev !== client.rev) {
                    client.rev = rev;
                    this.#changed(part);
                }
            }, 150),
        );
    }

    /**
     * Watch a browser module's folder and the folders in it, each on its own: a recursive watch would walk and watch
     * everything, `node_modules` included. Hidden folders and `node_modules` are left out, as `revision` leaves them out,
     * and at most `MAX_WATCHED` folders are watched.
     */
    #watchFolder(part: WebPart): void {
        if (!this.#watching || part.watchers.length > 0 || part.client?.folder !== true) {
            return;
        }

        for (const folder of folders(part.client.root).slice(0, MAX_WATCHED)) {
            try {
                const watcher = watch(folder, () => this.#recheck(part));

                watcher.on("error", () => {});
                part.watchers.push(watcher);
            } catch (error) {
                this.#options.log?.(
                    `${part.file}'s browser module is not reloaded when ${folder} is edited: ${describe(error)}`,
                );
            }
        }
    }

    #dispose(part: WebPart): void {
        if (part.disposed) {
            return;
        }

        part.disposed = true;

        for (const watcher of part.watchers.splice(0)) {
            watcher.close();
        }

        clearTimeout(this.#timers.get(part));
        this.#timers.delete(part);

        // Last registered first, as cleanups nest.
        for (const dispose of part.disposers.splice(0).reverse()) {
            runDispose(dispose, part, this.#options.log);
        }
    }
}

function runDispose(dispose: () => void, part: WebPart, log?: (message: string) => void): void {
    try {
        const result = dispose() as unknown;

        if (result instanceof Promise) {
            result.catch((error: unknown) =>
                log?.(`${part.file}: a cleanup failed: ${describe(error)}`),
            );
        }
    } catch (error) {
        log?.(`${part.file}: a cleanup failed: ${describe(error)}`);
    }
}

function checkRoute(
    part: WebPart,
    method: unknown,
    path: unknown,
    handle: unknown,
    access: unknown = "owner",
): Route {
    const verb = typeof method === "string" ? method.toUpperCase() : "";

    if (!METHODS.has(verb)) {
        throw new Error(`web.route: the method is GET, POST, PUT, PATCH, or DELETE, not ${method}`);
    }

    if (typeof path !== "string") {
        throw new Error('web.route: give the path as a string, such as "status" or "items/:id"');
    }

    const segments = path.split("/").filter((segment) => segment !== "");

    for (const segment of segments) {
        if (!SEGMENT.test(segment)) {
            throw new Error(
                `web.route: ${path}: each part of a path is letters, digits, and . _ ~ -, or :name`,
            );
        }
    }

    const names = segments.filter((segment) => segment.startsWith(":"));

    if (new Set(names).size !== names.length) {
        throw new Error(`web.route: ${path} names a part twice`);
    }

    if (typeof handle !== "function") {
        throw new Error(`web.route: ${verb} ${path} needs a function to answer it`);
    }

    if (typeof access !== "string" || !ACCESS.has(access)) {
        throw new Error(`web.route: access is "owner", "steer", or "view", not ${String(access)}`);
    }

    const shape = (each: string[]) =>
        each.map((segment) => (segment.startsWith(":") ? ":" : segment)).join("/");

    if (
        part.routes.some(
            (route) => route.method === verb && shape(route.segments) === shape(segments),
        )
    ) {
        throw new Error(`web.route: ${verb} ${path} is registered twice`);
    }

    return {
        method: verb as WebMethod,
        path: segments.join("/"),
        segments,
        access: access as WebAccess,
        handle: handle as WebHandler,
    };
}

function checkClient(part: WebPart, entry: unknown, access: unknown = "owner"): Client {
    if (typeof entry !== "string" || entry === "" || isAbsolute(entry)) {
        throw new Error('web.client: name a file or folder beside the module, such as "status.js"');
    }

    if (typeof access !== "string" || !ACCESS.has(access)) {
        throw new Error(`web.client: access is "owner", "steer", or "view", not ${String(access)}`);
    }

    const root = resolve(part.directory, entry);
    const inside = relative(part.directory, root);

    // Right beside it: the folder of modules is watched for edits, not what is deeper in it.
    if (
        inside === "" ||
        inside.startsWith(".") ||
        inside.includes(sep) ||
        inside === "node_modules"
    ) {
        throw new Error(`web.client: ${entry} is not a file or folder right beside the module`);
    }

    let folder: boolean;

    try {
        folder = statSync(root).isDirectory();
    } catch {
        throw new Error(`web.client: there is no ${entry} beside the module`);
    }

    if (folder) {
        try {
            if (!statSync(join(root, "index.js")).isFile()) {
                throw new Error("not a file");
            }
        } catch {
            throw new Error(`web.client: the folder ${entry} has no index.js`);
        }
    } else if (![".js", ".mjs"].includes(extname(root).toLowerCase())) {
        throw new Error(`web.client: ${entry} is not a .js file`);
    }

    return {
        access: access as WebAccess,
        root,
        folder,
        entry: folder ? "index.js" : basename(root),
        rev: revision(root, folder),
    };
}

/** The values of a path's `:name` parts, or none when it does not match. */
function matchPath(
    segments: readonly string[],
    path: readonly string[],
): Record<string, string> | undefined {
    if (segments.length !== path.length) {
        return undefined;
    }

    const params: Record<string, string> = {};

    for (const [index, segment] of segments.entries()) {
        if (segment.startsWith(":")) {
            params[segment.slice(1)] = path[index]!;
        } else if (segment !== path[index]) {
            return undefined;
        }
    }

    return params;
}

/** What tabs must know of a module's browser module: whether it loads, for whom, and which version. */
function clientKey(part: WebPart | undefined): string {
    const client = part?.client;

    return client === undefined ? "" : `${client.access}:${client.rev}:${client.entry}`;
}

/** A folder and the folders in it, as `revision` walks them: not hidden ones, nor `node_modules`. */
function folders(root: string): string[] {
    const found = [root];

    for (let at = 0; at < found.length && found.length < MAX_WATCHED; at++) {
        let entries: Dirent[];

        try {
            entries = readdirSync(found[at]!, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (
                entry.isDirectory() &&
                !entry.name.startsWith(".") &&
                entry.name !== "node_modules"
            ) {
                found.push(join(found[at]!, entry.name));
            }
        }
    }

    return found;
}

/** A browser module's version: from its files' sizes and times, so an edit to any of them gives a new one. */
function revision(root: string, folder: boolean): string {
    const hash = createHash("sha256");
    let count = 0;

    const add = (path: string) => {
        try {
            const stats = statSync(path);

            hash.update(`${path}\0${stats.size}\0${stats.mtimeMs}\0`);
        } catch {
            hash.update(`${path}\0gone\0`);
        }
    };

    const walk = (directory: string) => {
        let names: string[];

        try {
            names = readdirSync(directory).sort();
        } catch {
            return;
        }

        for (const name of names) {
            if (count >= MAX_FILES || name.startsWith(".") || name === "node_modules") {
                continue;
            }

            const path = join(directory, name);

            count++;

            try {
                if (statSync(path).isDirectory()) {
                    walk(path);
                    continue;
                }
            } catch {
                continue;
            }

            add(path);
        }
    };

    if (folder) {
        walk(root);
    } else {
        add(root);
    }

    return hash.digest("hex").slice(0, 12);
}
