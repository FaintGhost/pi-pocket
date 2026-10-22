// What an artifact's page may ask of the app, through `parent.postMessage`: put a follow-up in the person's message
// box, for them to review and send (#88); and load or save a small JSON value of its own, for that person (#89). The
// page keeps its sandbox: it never gets the app, its cookies, or a way to make Pi act. Only the frame's own window is
// heard, only while its session shows, and the app's rights decide, not the page.
import { useLayoutEffect } from "preact/hooks";
import { api, canSteer, insertIntoComposer, notify, store } from "./store.js";

/** The most a follow-up's text and its selection (as JSON) may take, and how often a frame may send one. */
const TEXT_MAX = 2000;
const SELECTION_MAX = 2000;
const FOLLOW_UP_MS = 2000;
const REQUEST_ID = /^[\w.:-]{1,64}$/;

/** A follow-up as it goes into the box: the page's words, then what it is from, and its selection as data. */
export function followUpText(text, selection, source) {
    const from = `From ${source}`;

    if (selection === undefined) {
        return `${text}\n\n(${from}.)`;
    }

    return `${text}\n\n${from}:\n\`\`\`json\n${JSON.stringify(selection, null, 2)}\n\`\`\``;
}

/** Why a follow-up cannot go in, or null when it can: its text and selection, checked. */
export function followUpProblem(data) {
    if (typeof data.text !== "string" || data.text.trim() === "") {
        return "A follow-up needs text";
    }

    if (data.text.length > TEXT_MAX) {
        return `A follow-up's text is up to ${TEXT_MAX} characters`;
    }

    if (data.selection !== undefined) {
        let json;

        try {
            json = JSON.stringify(data.selection);
        } catch {
            return "A selection is JSON";
        }

        if (json === undefined || json.length > SELECTION_MAX) {
            return `A selection is JSON, up to ${SELECTION_MAX} characters`;
        }
    }

    return null;
}

/**
 * Hear the page in the frame `ref`: follow-ups always, saved state only for an artifact (`artifact`, its id). `source`
 * names the page in the box ("the artifact “Plan”"). A frame inside PiP's panel adds nothing to the session's box.
 */
export function useArtifactBridge(ref, { artifact = null, source }) {
    useLayoutEffect(() => {
        const conversationId = store.state.conversationId;
        let lastFollowUp = 0;

        const reply = (message) => ref.current?.contentWindow?.postMessage(message, "*");

        const followUp = (data) => {
            const problem = followUpProblem(data);
            const shown = store.state.conversationId === conversationId;
            const now = Date.now();

            if (problem !== null) {
                return reply({ type: "pocket-follow-up", ok: false, error: problem });
            }

            if (!shown || ref.current?.closest(".pip-panel")) {
                return reply({ type: "pocket-follow-up", ok: false, error: "Not in this session" });
            }

            if (!canSteer()) {
                notify("info", `${capital(source)} offered a message, but you can only view here.`);

                return reply({ type: "pocket-follow-up", ok: false, error: "View only" });
            }

            if (now - lastFollowUp < FOLLOW_UP_MS) {
                return reply({ type: "pocket-follow-up", ok: false, error: "Too soon" });
            }

            lastFollowUp = now;
            insertIntoComposer(followUpText(data.text.trim(), data.selection, source));
            notify(
                "info",
                `${capital(source)} added a message to your box: read it, then send it.`,
            );
            reply({ type: "pocket-follow-up", ok: true });
        };

        const state = async (data) => {
            const requestId = data.requestId;
            const answer = (fields) => reply({ type: "pocket-state", requestId, ...fields });

            if (!REQUEST_ID.test(String(requestId ?? ""))) {
                return;
            }

            if (artifact === null) {
                return answer({ ok: false, error: "Only a saved artifact keeps state" });
            }

            if (store.state.conversationId !== conversationId) {
                return answer({ ok: false, error: "Not in this session" });
            }

            const path = `c/${conversationId}/artifact-state/${encodeURIComponent(artifact)}`;

            try {
                if (data.type === "pocket-state-get") {
                    const query =
                        typeof data.schema === "string"
                            ? `?schema=${encodeURIComponent(data.schema)}`
                            : "";
                    const result = await api(`${path}${query}`);

                    answer({ ok: true, state: result.state, at: result.at });
                } else {
                    const result = await api(path, {
                        state: data.state ?? null,
                        schema: data.schema,
                    });

                    answer({ ok: true, at: result.at });
                }
            } catch (error) {
                answer({ ok: false, error: error.message ?? String(error) });
            }
        };

        const onMessage = (event) => {
            const frame = ref.current;
            const data = event.data;

            if (
                !frame ||
                event.source !== frame.contentWindow ||
                typeof data !== "object" ||
                !data
            ) {
                return;
            }

            if (data.type === "pocket-follow-up") {
                followUp(data);
            } else if (data.type === "pocket-state-get" || data.type === "pocket-state-set") {
                void state(data);
            }
        };

        addEventListener("message", onMessage);

        return () => removeEventListener("message", onMessage);
    }, [artifact, source]);
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
