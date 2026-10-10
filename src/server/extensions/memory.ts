/**
 * Memory gives Pi short lessons that last across sessions, for a project or for everywhere: Pi saves them with its
 * memory tool, and every later session in the same project gets them in its system prompt. People see and change them
 * in Menu → Memory; a lesson saved for a guest waits for the owner's approval.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Lesson } from "../docs.ts";
import type { PocketHost } from "../host.ts";
import { MAX_LESSON, MEMORY_EXTENSION, type Project } from "../memory.ts";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

const GUIDE = `Save a lesson with the memory tool when you learn something that will help later sessions here: how to build, test, or run the project; a gotcha you hit; a convention; a preference someone states ("always…", "remember that…"). Write one or two specific sentences. Never save secrets, anything already in AGENTS.md or obvious from the code, or anything true only for this task. Use scope everywhere only for a person's general preferences. When a lesson turns out wrong or out of date, update or remove it.`;

function where(lesson: Lesson): string {
    return lesson.project === undefined ? "everywhere" : (lesson.projectName ?? "this project");
}

/** The section's text: the same while the lessons are the same. */
function render(project: Project | undefined, lessons: Lesson[]): string {
    const head =
        project === undefined
            ? "Lessons kept from earlier sessions, for everywhere (you have no project: save with scope everywhere)."
            : `Lessons kept from earlier sessions in ${project.name} and everywhere.`;
    const list =
        lessons.length === 0
            ? "None yet."
            : `Follow them unless someone here says otherwise:\n${lessons.map((lesson) => `- [${lesson.id}] (${where(lesson)}) ${lesson.text}`).join("\n")}`;

    return `${head} ${list}\n\n${GUIDE}`;
}

export default function createMemory(host: PocketHost) {
    // A server started before memory has no `host.memory`: the module installs nothing until it restarts.
    const memory = (host as Partial<PocketHost>).memory;

    if (memory === undefined) {
        return defineExtension({ name: MEMORY_EXTENSION });
    }

    const tool = defineTool({
        name: "memory",
        description:
            "Lessons you keep across sessions, for this project or everywhere. Actions: add (text, scope), update (id, text), remove (id), list.",
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("add"),
                Type.Literal("update"),
                Type.Literal("remove"),
                Type.Literal("list"),
            ]),
            text: Type.Optional(
                Type.String({
                    description: `add, update: the lesson, one or two sentences (${String(MAX_LESSON)} characters at most)`,
                }),
            ),
            scope: Type.Optional(
                Type.Union([Type.Literal("project"), Type.Literal("everywhere")], {
                    description: "add: project (default) or everywhere",
                }),
            ),
            id: Type.Optional(Type.String({ description: "update, remove: the lesson's id" })),
        }),
        // Safe to run again: an add finds the lesson this very call saved, an update sets the same text, and removing one
        // that is gone changes nothing.
        replay: "safe",
        execute: async (args, api, context) => {
            const cwd = (await api.agent(context)).cwd;
            const requester = host.requesterOf(api.conversationId);
            const writer = { userId: requester, byPi: true, name: "Pi" };

            if (args.action === "list") {
                const project = await memory.project(api.conversationId, cwd);
                const lessons = await memory.applying(project);

                return reply(
                    lessons.length === 0
                        ? "No lessons yet."
                        : lessons
                              .map(
                                  (lesson) =>
                                      `[${lesson.id}] (${where(lesson)}) ${lesson.text}${lesson.pending === true ? " (waiting for the owner's approval)" : ""}`,
                              )
                              .join("\n"),
                );
            }

            if (args.action === "add") {
                if (args.text === undefined) {
                    throw new Error("add needs text.");
                }

                const project = await memory.project(api.conversationId, cwd);
                const scope = project === undefined ? "everywhere" : (args.scope ?? "project");
                const lesson = await memory.add(api.conversationId, cwd, writer, {
                    text: args.text,
                    scope,
                    key: `${api.taskId}:${api.callId}`,
                });

                return reply(
                    `Saved [${lesson.id}] for ${where(lesson)}${lesson.pending === true ? "; it waits for the owner's approval before sessions get it" : ""}.`,
                );
            }

            if (args.id === undefined) {
                throw new Error(`${args.action} needs the lesson's id.`);
            }

            if (args.action === "remove") {
                try {
                    const gone = await memory.change(
                        api.conversationId,
                        cwd,
                        writer,
                        args.id,
                        "remove",
                    );

                    return reply(`Forgot [${gone.id}].`);
                } catch (error) {
                    // Run again after a restart, the first run's removal is what left nothing to remove.
                    if ((error as { status?: number }).status === 404) {
                        return reply(`There is no lesson ${args.id} (anymore).`);
                    }

                    throw error;
                }
            }

            if (args.text === undefined) {
                throw new Error("update needs text.");
            }

            const lesson = await memory.change(api.conversationId, cwd, writer, args.id, {
                text: args.text,
            });

            return reply(
                `Updated [${lesson.id}]${lesson.pending === true ? "; it waits for the owner's approval" : ""}.`,
            );
        },
    });

    return defineExtension({
        name: MEMORY_EXTENSION,
        tools: [tool],
        sections: [
            section("memory", async (input) => {
                const { project, lessons } = await memory.inForce(
                    input.conversationId,
                    input.agent.cwd,
                );

                return render(project, lessons);
            }),
        ],
    });
}
