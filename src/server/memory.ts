/**
 * Memory: short lessons Pi keeps across sessions, each for one project or for everywhere, and linked to the session it
 * came from. A project is a git repository with all its worktrees (they share one git folder), or a folder outside
 * any repository. Pi saves lessons with its memory tool and gets those that apply in its system prompt
 * (`extensions/memory.ts`); people see, add, change, and remove them in the Memory sheet.
 *
 * A lesson added or changed for someone who is not the owner waits for the owner's approval before Pi uses it: a guest
 * could otherwise write instructions into every later session.
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { addActivity } from "./collab.ts";
import type { User } from "./config.ts";
import { ChatDoc, type Lesson, MemoryDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { git } from "./git.ts";
import { snippet } from "./projection.ts";

const context: Context = BACKGROUND_CONTEXT;

/** Memory's extension: the tool and the prompt section. */
export const MEMORY_EXTENSION = "pocket-memory";
/** How long a lesson may be. */
export const MAX_LESSON = 300;
/** Lessons a project keeps, and lessons for everywhere, approved ones: pending ones do not take their room. */
export const MAX_PROJECT_LESSONS = 40;
export const MAX_EVERYWHERE_LESSONS = 30;
/** Lessons waiting for approval that one person (or Pi for them) may have, so nobody fills the owner's list. */
export const MAX_PENDING = 10;
/** How long a folder's project is kept before git is asked again (a folder can become a repository). */
const PROJECT_FOR_MS = 60_000;

export type Project = { key: string; name: string };
export type LessonScope = "project" | "everywhere";

/** Who writes: a person, or Pi working for one (`userId` undefined when nobody is known). */
export type Writer = { userId: string | undefined; byPi: boolean; name: string };

/** A lesson as a person's Memory sheet shows it. */
export type LessonView = {
    id: string;
    text: string;
    scope: LessonScope;
    byPi: boolean;
    by: string;
    byName: string;
    createdAt: number;
    updatedAt?: number;
    pending: boolean;
    /** The session it came from, when this person may see it. */
    from?: { id: number; title: string };
    /** Whether this person may change or remove it. */
    mine: boolean;
};

export type MemoryView = {
    /** This session's project; null for PiP, which has none. */
    project: { name: string } | null;
    lessons: LessonView[];
    owner: boolean;
    canWrite: boolean;
    limits: { project: number; everywhere: number; text: number };
};

/** A plain copy of a lesson out of a commit's document. */
const copy = (lesson: Lesson): Lesson => JSON.parse(JSON.stringify(lesson)) as Lesson;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const ordered = (lessons: Lesson[]) =>
    lessons.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

/** The project a folder belongs to: its repository's shared git folder, or the folder itself. */
async function projectOf(cwd: string): Promise<Project> {
    const folder = await realpath(cwd).catch(() => resolve(cwd));
    const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .catch(() => git(folder, ["rev-parse", "--git-common-dir"]))
        .then(
            (out) => out.trim(),
            () => "",
        );

    if (common === "") {
        return { key: folder, name: basename(folder) || folder };
    }

    const key = await realpath(resolve(folder, common)).catch(() => resolve(folder, common));
    // `repo/.git` is named for `repo`; a bare repository (`repo.git`) for itself.
    const name =
        basename(key) === ".git" ? basename(dirname(key)) : basename(key).replace(/\.git$/, "");

    return { key, name: name || key };
}

export class Memory {
    readonly #app: PocketApp;
    readonly #projects = new Map<string, { at: number; project: Promise<Project> }>();
    #timer: NodeJS.Timeout | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The project of a conversation working in `cwd`; undefined for PiP, which has lessons for everywhere only. */
    async project(
        conversationId: ConversationId,
        cwd: string | undefined,
    ): Promise<Project | undefined> {
        const app = this.#app;

        if (app.sessionMeta(app.rootOf(conversationId))?.pip !== undefined) {
            return undefined;
        }

        const folder = cwd ?? app.cwdOf(conversationId);

        const now = this.#app.now();
        let cached = this.#projects.get(folder);

        if (cached === undefined || now - cached.at > PROJECT_FOR_MS) {
            cached = { at: now, project: projectOf(folder) };
            this.#projects.set(folder, cached);
        }

        return cached.project;
    }

    async #all(): Promise<Lesson[]> {
        const doc = await this.#app.harness.snapshot(MemoryDoc, context);

        return Object.values(doc?.items ?? {});
    }

    /** The lessons that apply in a project (and everywhere's), oldest first, pending ones included. */
    async applying(project: Project | undefined): Promise<Lesson[]> {
        return ordered(
            (await this.#all()).filter(
                (lesson) => lesson.project === undefined || lesson.project === project?.key,
            ),
        );
    }

    /** What Pi's prompt has: the lessons in force for a conversation working in `cwd`, and its project. */
    async inForce(
        conversationId: ConversationId,
        cwd: string | undefined,
    ): Promise<{ project: Project | undefined; lessons: Lesson[] }> {
        const project = await this.project(conversationId, cwd);
        const lessons = (await this.applying(project)).filter((lesson) => lesson.pending !== true);

        return { project, lessons };
    }

    #isOwner(userId: string | undefined): boolean {
        return userId !== undefined && this.#app.config.userById(userId)?.role === "owner";
    }

    /**
     * Whether a write waits for the owner: one for anyone else; Pi's on a message nobody wrote themselves (a webhook's
     * post, a PR watch's comments, PiP's errand, a subagent's report), whose words may not be its person's; and every
     * lesson Pi saves for everywhere, which would reach every session and PiP.
     */
    #held(conversationId: ConversationId, writer: Writer, everywhere: boolean): boolean {
        return (
            !this.#isOwner(writer.userId) ||
            (writer.byPi && (everywhere || !this.#app.attribution.personWrote(conversationId)))
        );
    }

    #mayChange(lesson: Lesson, userId: string | undefined): boolean {
        return this.#isOwner(userId) || (userId !== undefined && lesson.by === userId);
    }

    /** A lesson that applies here, or a 404. */
    #find(
        doc: { items: Record<string, Lesson> },
        project: Project | undefined,
        id: string,
    ): Lesson {
        const lesson = doc.items[id.trim().replace(/^\[|\]$/g, "")];

        if (
            lesson === undefined ||
            (lesson.project !== undefined && lesson.project !== project?.key)
        ) {
            throw new HttpError(404, `There is no lesson ${id} here.`);
        }

        return lesson;
    }

    /** A line in the session's chat, as people see the rest of what changes. */
    async #activity(tx: Tx, conversationId: ConversationId, writer: Writer, text: string) {
        const root = this.#app.rootOf(conversationId);

        addActivity(
            await tx.doc(ChatDoc, root),
            writer.byPi
                ? { id: "pi", name: "Pi" }
                : { id: writer.userId ?? "someone", name: writer.name },
            text,
        );
    }

    #text(text: unknown): string {
        if (typeof text !== "string" || flat(text) === "") {
            throw new HttpError(400, "Say what to remember.");
        }

        const lesson = flat(text);

        if (lesson.length > MAX_LESSON) {
            throw new HttpError(
                413,
                `A lesson is ${String(MAX_LESSON)} characters at most (this one is ${String(lesson.length)}): make it shorter.`,
            );
        }

        return lesson;
    }

    /**
     * Save a lesson. The same `key` saves it once: a tool call run again finds the one it made. Throws an HttpError a
     * person (or Pi) can act on when it will not do.
     */
    async add(
        conversationId: ConversationId,
        cwd: string | undefined,
        writer: Writer,
        request: { text: unknown; scope: LessonScope; key?: string },
    ): Promise<Lesson> {
        const app = this.#app;
        const text = this.#text(request.text);
        const project =
            request.scope === "project" ? await this.project(conversationId, cwd) : undefined;
        const root = app.rootOf(conversationId);
        const meta = app.sessionMeta(root);
        const by = writer.userId ?? meta?.createdBy ?? "";
        const pending = this.#held(conversationId, writer, project === undefined);

        return app.harness.commit(async (tx) => {
            const doc = await tx.doc(MemoryDoc);
            const items = Object.values(doc.items);
            const same =
                request.key === undefined
                    ? undefined
                    : items.find((item) => item.key === request.key);

            if (same !== undefined) {
                return copy(same);
            }

            const max = project === undefined ? MAX_EVERYWHERE_LESSONS : MAX_PROJECT_LESSONS;

            if (
                pending &&
                items.filter((item) => item.pending === true && item.by === by).length >=
                    MAX_PENDING
            ) {
                throw new HttpError(
                    409,
                    `${String(MAX_PENDING)} lessons wait for the owner's approval already: wait for them first.`,
                );
            }

            if (
                !pending &&
                items.filter((item) => item.project === project?.key && item.pending !== true)
                    .length >= max
            ) {
                throw new HttpError(
                    409,
                    `${project === undefined ? "Lessons for everywhere" : `${project.name}'s lessons`} are full (${String(max)}): forget one first, or fold two into one.`,
                );
            }

            let id = randomUUID().slice(0, 5);

            while (Object.hasOwn(doc.items, id)) {
                id = randomUUID().slice(0, 5);
            }

            const lesson: Lesson = {
                id,
                text,
                ...(project === undefined
                    ? {}
                    : { project: project.key, projectName: project.name }),
                ...(meta === undefined
                    ? {}
                    : { from: { conversationId: Number(root), title: meta.title ?? "Untitled" } }),
                by,
                byPi: writer.byPi,
                createdAt: this.#app.now(),
                ...(pending ? { pending: true } : {}),
                ...(request.key === undefined ? {} : { key: request.key }),
            };

            doc.items[id] = lesson;
            await this.#activity(
                tx,
                conversationId,
                writer,
                `saved a lesson for ${project === undefined ? "everywhere" : project.name}: “${snippet(text, 80)}”${pending ? ", for the owner to approve" : ""}`,
            );

            return copy(lesson);
        }, context);
    }

    /**
     * Change a lesson's text, remove it, or approve it. Only the owner, or whoever saved it, changes or removes one; only
     * the owner approves. A change for anyone but the owner waits for approval again.
     */
    async change(
        conversationId: ConversationId,
        cwd: string | undefined,
        writer: Writer,
        id: string,
        change: { text: unknown } | "remove" | "approve",
    ): Promise<Lesson> {
        const text = typeof change === "object" ? this.#text(change.text) : undefined;
        const project = await this.project(conversationId, cwd);

        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(MemoryDoc);
            const lesson = this.#find(doc, project, id);
            const before = copy(lesson);

            if (change === "approve") {
                if (writer.byPi || !this.#isOwner(writer.userId)) {
                    throw new HttpError(403, "Only the owner approves lessons.");
                }

                if (lesson.pending === true) {
                    const max =
                        lesson.project === undefined ? MAX_EVERYWHERE_LESSONS : MAX_PROJECT_LESSONS;
                    const kept = Object.values(doc.items).filter(
                        (item) => item.project === lesson.project && item.pending !== true,
                    ).length;

                    if (kept >= max) {
                        throw new HttpError(
                            409,
                            `${lesson.project === undefined ? "Lessons for everywhere" : `${lesson.projectName ?? "This project"}'s lessons`} are full (${String(max)}): forget one first.`,
                        );
                    }

                    delete lesson.pending;
                    await this.#activity(
                        tx,
                        conversationId,
                        writer,
                        `approved the lesson “${snippet(lesson.text, 80)}”`,
                    );
                }

                return copy(lesson);
            }

            if (!this.#mayChange(lesson, writer.userId)) {
                throw new HttpError(
                    403,
                    "Only the owner, or whoever saved it, can change or forget this lesson.",
                );
            }

            if (change === "remove") {
                // Forgetting cannot wait for approval, so it waits for a person's own words.
                if (writer.byPi && !this.#app.attribution.personWrote(conversationId)) {
                    throw new HttpError(
                        403,
                        "Pi forgets lessons only when a person asks it to in their own message: say which one and why.",
                    );
                }

                delete doc.items[lesson.id];
                await this.#activity(
                    tx,
                    conversationId,
                    writer,
                    `forgot the lesson “${snippet(lesson.text, 80)}”`,
                );

                return before;
            }

            if (text === lesson.text) {
                return before;
            }

            lesson.text = text!;
            lesson.updatedAt = this.#app.now();

            if (this.#held(conversationId, writer, lesson.project === undefined)) {
                lesson.pending = true;
            } else {
                delete lesson.pending;
            }

            await this.#activity(
                tx,
                conversationId,
                writer,
                `changed a lesson to “${snippet(lesson.text, 80)}”${lesson.pending === true ? ", for the owner to approve" : ""}`,
            );

            return copy(lesson);
        }, context);
    }

    // ─── People ────────────────────────────────────────────────────────────

    #person(user: User): Writer {
        return { userId: user.id, byPi: false, name: user.name };
    }

    /** The lessons that apply in a session, as this person's Memory sheet shows them. */
    async view(id: ConversationId, user: User): Promise<MemoryView> {
        const app = this.#app;

        app.requireSee(user, id);
        const owner = user.role === "owner";
        const project = await this.project(id, app.cwdOf(id));
        const lessons = (await this.applying(project))
            .filter((lesson) => lesson.pending !== true || owner || lesson.by === user.id)
            .map((lesson): LessonView => {
                const from = lesson.from;
                const source =
                    from === undefined
                        ? undefined
                        : (from.conversationId as unknown as ConversationId);
                const seen = source !== undefined && app.sessionMeta(source) !== undefined;

                return {
                    id: lesson.id,
                    text: lesson.text,
                    scope: lesson.project === undefined ? "everywhere" : "project",
                    byPi: lesson.byPi,
                    by: lesson.by,
                    byName: app.config.userById(lesson.by)?.name ?? "someone",
                    createdAt: lesson.createdAt,
                    ...(lesson.updatedAt === undefined ? {} : { updatedAt: lesson.updatedAt }),
                    pending: lesson.pending === true,
                    ...(seen && app.canSee(user, source)
                        ? {
                              from: {
                                  id: from!.conversationId,
                                  title: app.sessionMeta(source)?.title ?? from!.title,
                              },
                          }
                        : {}),
                    mine: user.role !== "viewer" && this.#mayChange(lesson, user.id),
                };
            });

        return {
            project: project === undefined ? null : { name: project.name },
            lessons,
            owner,
            canWrite: user.role !== "viewer",
            limits: {
                project: MAX_PROJECT_LESSONS,
                everywhere: MAX_EVERYWHERE_LESSONS,
                text: MAX_LESSON,
            },
        };
    }

    /** A person saves a lesson by hand. */
    async remember(
        id: ConversationId,
        user: User,
        request: { text?: unknown; scope?: unknown },
    ): Promise<Lesson> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        return this.add(id, app.cwdOf(id), this.#person(user), {
            text: request.text,
            scope: request.scope === "everywhere" ? "everywhere" : "project",
        });
    }

    /** A person changes, forgets, or approves a lesson. */
    async edit(
        id: ConversationId,
        user: User,
        lessonId: string,
        change: { text: unknown } | "remove" | "approve",
    ): Promise<Lesson> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        return this.change(id, app.cwdOf(id), this.#person(user), lessonId, change);
    }

    // ─── Tabs ──────────────────────────────────────────────────────────────

    /** Lessons changed: tabs showing them fetch them again. */
    committed(): void {
        if (this.#timer !== undefined) {
            return;
        }

        this.#timer = setTimeout(() => {
            this.#timer = undefined;

            for (const client of this.#app.clients) {
                client.send("memory", {});
            }
        }, 200);
        this.#timer.unref();
    }
}
