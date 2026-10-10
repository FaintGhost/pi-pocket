// Memory: the lessons Pi keeps across sessions, for this session's project and for everywhere.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, navigate, notify, store } from "../store.js";
import { html, Sheet, timeAgo } from "../ui.js";

/** Memory needs its extension, and a conversation to say which project. */
export const memoryAvailable = () =>
    store.state.conversationId !== null &&
    store.state.server?.extensions?.includes("pocket-memory") === true;

const path = (id, rest = "") => `c/${id}/memory${rest}`;

/** The lessons last fetched, `{ id, data }`: the menu shows its hint from them at once while it asks again. */
let last = null;

/** The lessons that apply in this conversation, fetched when it shows and again whenever they change on the server. */
export function useMemory() {
    const id = store.state.conversationId;
    const rev = store.state.memoryRev ?? 0;
    const on = memoryAvailable();
    const [data, setData] = useState(last?.id === id ? last.data : null);

    useEffect(() => {
        let live = true;

        if (!on) {
            return undefined;
        }

        api(path(id)).then(
            (fetched) => {
                last = { id, data: fetched };

                if (live) {
                    setData(fetched);
                }
            },
            () => {},
        );

        return () => {
            live = false;
        };
    }, [id, rev, on]);

    return last?.id === id ? (data ?? last.data) : data;
}

/** Fetch again after a write here, without waiting for the server's word. */
function refresh() {
    store.set((state) => ({ memoryRev: (state.memoryRev ?? 0) + 1 }));
}

/** The menu's hint: how many lessons apply here and everywhere, and for the owner how many wait for approval. */
export function memoryHint(data) {
    if (!data) {
        return "";
    }

    const live = data.lessons.filter((lesson) => !lesson.pending);
    const here = live.filter((lesson) => lesson.scope === "project").length;
    const everywhere = live.length - here;
    const waiting = data.owner ? data.lessons.length - live.length : 0;
    const parts = [
        data.project ? `${here} here` : null,
        `${everywhere} everywhere`,
        waiting > 0 ? `${waiting} to approve` : null,
    ];

    return parts.filter(Boolean).join(" · ");
}

/** Save a lesson by hand: for this project, or everywhere. */
export async function remember(text, scope = "project") {
    const id = store.state.conversationId;
    const lesson = await api(path(id), { text, scope });

    refresh();

    return lesson;
}

/** Who saved a lesson, and where it came from, in a line. */
function Source({ lesson }) {
    const { me } = store.state;
    const who = lesson.byPi ? "Pi" : lesson.by === me?.id ? "you" : lesson.byName;

    const open = (event) => {
        event.preventDefault();
        closeSheet();
        navigate(lesson.from.id);
    };

    return html`<div class="muted small lesson-source">
        <span>${who}</span>
        ${lesson.byPi && lesson.by !== me?.id && html`<span> for ${lesson.byName}</span>`}
        ${
            lesson.from &&
            html` · <a href=${`/s/${lesson.from.id}`} onClick=${open}>${lesson.from.title}</a>`
        }
        <span> · ${timeAgo(lesson.updatedAt ?? lesson.createdAt)}</span>
    </div>`;
}

/** One lesson: its text, where it came from, and what this person may do with it. */
function Lesson({ lesson, data }) {
    const id = store.state.conversationId;
    const [draft, setDraft] = useState(null);
    const [forgetting, setForgetting] = useState(false);
    const act = (rest, body = {}, done = "") =>
        attempt(async () => {
            await api(path(id, `/${encodeURIComponent(lesson.id)}${rest}`), body);
            setDraft(null);
            setForgetting(false);
            refresh();

            if (done) {
                notify("info", done);
            }
        });
    const approving = data.owner && lesson.pending;

    if (draft !== null) {
        return html`<div class="lesson">
            <textarea
                rows="3"
                autofocus
                maxlength=${data.limits.text}
                value=${draft}
                onInput=${(event) => setDraft(event.currentTarget.value)}
            ></textarea>
            <div class="row lesson-actions">
                <button class="button small ghost" onClick=${() => setDraft(null)}>Cancel</button>
                <button
                    class="button small primary"
                    disabled=${draft.trim() === ""}
                    onClick=${() => act("", { text: draft })}
                >
                    Save
                </button>
            </div>
        </div>`;
    }

    return html`<div class=${`lesson ${lesson.pending ? "pending" : ""}`}>
        <div class="lesson-text">${lesson.text}</div>
        ${
            lesson.pending &&
            !data.owner &&
            html`<div class="muted small">Waits for the owner's approval before Pi uses it.</div>`
        }
        <div class="lesson-foot">
            <${Source} lesson=${lesson} />
            ${
                (lesson.mine || approving) &&
                html`<div class="row lesson-actions">
                    ${
                        approving &&
                        html`<button
                            class="button small primary"
                            onClick=${() => act("/approve", {}, "Approved: Pi uses it from its next message.")}
                        >
                            Approve
                        </button>`
                    }
                    ${
                        lesson.mine &&
                        html`<button
                            class="button small ghost"
                            onClick=${() => setDraft(lesson.text)}
                        >
                            Edit
                        </button>`
                    }
                    ${
                        lesson.mine &&
                        html`<button
                            class=${`button small ghost ${forgetting ? "danger" : ""}`}
                            onClick=${() => (forgetting ? act("/remove") : setForgetting(true))}
                            onBlur=${() => setForgetting(false)}
                        >
                            ${approving ? (forgetting ? "Discard it" : "Discard") : forgetting ? "Forget it" : "Forget"}
                        </button>`
                    }
                </div>`
            }
        </div>
    </div>`;
}

/** A group of lessons with its title, or nothing when it has none. */
function Group({ title, lessons, data, empty }) {
    return html`<div class="group">
        <div class="group-title">${title}</div>
        ${lessons.length === 0 && empty && html`<p class="muted small">${empty}</p>`}
        ${lessons.map((lesson) => html`<${Lesson} key=${lesson.id} lesson=${lesson} data=${data} />`)}
    </div>`;
}

/** The lessons Pi keeps: what waits for approval, this project's, and everywhere's; and one added by hand. */
export function MemorySheet({ draft: initial = "" }) {
    const data = useMemory();
    const [text, setText] = useState(initial);
    const [scope, setScope] = useState("project");
    const [busy, setBusy] = useState(false);

    if (!data) {
        return html`<${Sheet} title="Memory" onClose=${closeSheet}>
            <p class="muted">Loading…</p>
        <//>`;
    }

    const project = data.project;
    const chosen = project ? scope : "everywhere";
    const waiting = data.owner ? data.lessons.filter((lesson) => lesson.pending) : [];
    const shown = data.lessons.filter((lesson) => !waiting.includes(lesson));

    const add = () => {
        if (busy || text.trim() === "") {
            return;
        }

        setBusy(true);
        attempt(async () => {
            const lesson = await remember(text, chosen);

            setText("");
            notify(
                "info",
                lesson.pending
                    ? "Saved. Pi uses it once the owner approves it."
                    : "Saved. Pi gets it from its next message.",
            );
        }).finally(() => setBusy(false));
    };

    return html`<${Sheet} title="Memory" onClose=${closeSheet}>
        <p class="muted small">
            Short lessons Pi keeps across sessions: how to build and test, gotchas, conventions, preferences. ${project ? html`Those for <b>${project.name}</b> go to every session in it, worktrees too; the rest go everywhere.` : "PiP keeps lessons for everywhere."} Pi saves them as it learns; you can too.
        </p>
        ${
            data.canWrite &&
            html`<div class="lesson-add">
                <textarea
                    rows="2"
                    placeholder="e.g. Run the tests with npm test; the browser tests need Chromium."
                    maxlength=${data.limits.text}
                    value=${text}
                    onInput=${(event) => setText(event.currentTarget.value)}
                    onKeyDown=${(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            add();
                        }
                    }}
                ></textarea>
                <div class="row">
                    ${
                        project &&
                        html`<div class="segmented grow" role="radiogroup" aria-label="For">
                            <button
                                role="radio"
                                aria-checked=${chosen === "project" ? "true" : "false"}
                                class=${chosen === "project" ? "on" : ""}
                                onClick=${() => setScope("project")}
                            >
                                This project
                            </button>
                            <button
                                role="radio"
                                aria-checked=${chosen === "everywhere" ? "true" : "false"}
                                class=${chosen === "everywhere" ? "on" : ""}
                                onClick=${() => setScope("everywhere")}
                            >
                                Everywhere
                            </button>
                        </div>`
                    }
                    <button
                        class="button primary"
                        disabled=${busy || text.trim() === ""}
                        onClick=${add}
                    >
                        Remember
                    </button>
                </div>
            </div>`
        }
        ${
            waiting.length > 0 &&
            html`<${Group} title=${`To approve · ${waiting.length}`} lessons=${waiting} data=${data} />`
        }
        ${
            project &&
            html`<${Group}
                title=${`This project: ${project.name}`}
                lessons=${shown.filter((lesson) => lesson.scope === "project")}
                data=${data}
                empty="Nothing yet."
            />`
        }
        <${Group}
            title="Everywhere"
            lessons=${shown.filter((lesson) => lesson.scope === "everywhere")}
            data=${data}
            empty="Nothing yet."
        />
    <//>`;
}
