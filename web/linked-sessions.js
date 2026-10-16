// Links between linked sessions, above the transcript. Only the server's list for this person may name one.
import { navigate, store } from "./store.js";
import { html, Icon } from "./ui.js";

export function LinkedSessions() {
    const { conversationId, sessions, sessionsLoaded } = store.state;

    if (!sessionsLoaded) {
        return null;
    }

    const current = sessions.find((chat) => chat.id === conversationId);
    const origin =
        current?.linkedFrom && sessions.find((chat) => chat.id === current.linkedFrom.id);
    const started = sessions.filter((chat) => chat.linkedFrom?.id === conversationId);

    if (!origin && !current?.linkedOrigin && !current?.linkedFrom && started.length === 0) {
        return null;
    }

    const link = (chat, label) => html`<button
        class="breadcrumb"
        key=${chat.id}
        onClick=${() => navigate(chat.id)}
    >
        <${Icon} name="fork" size=${14} />
        <span>${label}: ${chat.title ?? "New session"}</span>
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
        ${started.map((chat) => link(chat, "Linked session"))}
    </nav>`;
}
