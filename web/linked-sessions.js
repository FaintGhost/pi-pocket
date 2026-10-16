// Links between linked sessions, above the transcript. Only the server's list for this person may name one.
import { navigate, store } from "./store.js";
import { html, Icon } from "./ui.js";

export function LinkedSessions() {
    const { conversationId, sessions, sessionsLoaded } = store.state;

    if (!sessionsLoaded) {
        return null;
    }

    const current = sessions.find((session) => session.id === conversationId);
    const origin =
        current?.linkedFrom && sessions.find((session) => session.id === current.linkedFrom.id);
    const started = sessions.filter((session) => session.linkedFrom?.id === conversationId);

    if (!origin && !current?.linkedOrigin && !current?.linkedFrom && started.length === 0) {
        return null;
    }

    const link = (session, label) => html`<button
        class="breadcrumb"
        key=${session.id}
        onClick=${() => navigate(session.id)}
    >
        <${Icon} name="fork" size=${14} />
        <span>${label}: ${session.title ?? "New session"}</span>
    </button>`;

    return html`<nav class="linked-sessions" aria-label="Linked sessions">
        ${
            origin
                ? link(origin, "Started from")
                : (current?.linkedOrigin || current?.linkedFrom) &&
                  html`<p class="muted small">
                Started from another session
            </p>`
        }
        ${started.map((session) => link(session, "Linked session"))}
    </nav>`;
}
