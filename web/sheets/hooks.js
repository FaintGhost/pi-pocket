// Webhooks: addresses other services post to, each turning every post into a message to Pi in a session, or to PiP.
import { useEffect, useState } from "preact/hooks";
import { pipAvailable } from "../pip.js";
import { api, attempt, closeSheet, navigate, notify, store } from "../store.js";
import { copyText, formatWhen, html, Sheet } from "../ui.js";

/** A hook's full address: the server's public one when it has one, else the one this browser uses. */
const addressOf = (base, hook) => `${(base ?? location.origin).replace(/\/$/, "")}${hook.path}`;

function copy(address) {
    copyText(address).then(
        () => notify("info", "Address copied. Keep it secret: anyone with it can message Pi."),
        () => notify("error", "Could not copy."),
    );
}

/** One hook: where it sends, what Pi is told to do, how it has been used; its address and removing it. */
function HookRow({ hook, base, fresh, onRemove }) {
    const open = (event) => {
        event.preventDefault();
        closeSheet();
        navigate(hook.target);
    };

    const used =
        hook.count === 0
            ? "no posts yet"
            : `${hook.count} post${hook.count === 1 ? "" : "s"}, last ${formatWhen(hook.lastAt)}`;

    return html`<div class=${`hook ${fresh ? "fresh" : ""}`}>
        <div class="hook-head">
            <strong class="grow">${hook.name}</strong>
            <span class="muted small">
                to ${hook.pip ? "PiP" : html`<a href=${`/s/${hook.target}`} onClick=${open}>${hook.targetTitle}</a>`}
            </span>
        </div>
        ${hook.instructions && html`<div class="hook-text">${hook.instructions}</div>`}
        ${fresh && html`<div class="mono small hook-address">${addressOf(base, hook)}</div>`}
        <div class="hook-actions">
            <span class="muted small grow">${used}</span>
            <button class="button small" onClick=${() => copy(addressOf(base, hook))}>
                Copy address
            </button>
            <button class="button small ghost" onClick=${onRemove}>Remove</button>
        </div>
    </div>`;
}

/** The person's webhooks (every one, for the owner), and a form to make one for this session or for PiP. */
export function HooksSheet() {
    const { view, me } = store.state;
    const here =
        view.conversation?.kind === "session" && !view.conversation.pip ? view.conversation : null;
    const [list, setList] = useState(null);
    const [name, setName] = useState("");
    const [instructions, setInstructions] = useState("");
    const [target, setTarget] = useState(here ? "here" : "pip");
    const [fresh, setFresh] = useState(null);
    const steer = me?.role !== "viewer";
    const load = () => attempt(async () => setList(await api("hooks")));
    const targets = [here && ["here", "This session"], pipAvailable() && ["pip", "PiP"]].filter(
        Boolean,
    );

    useEffect(() => void load(), []);

    const make = () =>
        attempt(async () => {
            const hook = await api("hooks", {
                target: target === "pip" ? "pip" : here.id,
                name: name.trim(),
                instructions: instructions.trim(),
            });

            setName("");
            setInstructions("");
            setFresh(hook.id);
            await load();
        });
    const remove = (hook) =>
        attempt(async () => {
            if (
                !confirm(
                    `Remove the webhook “${hook.name}”? Posts to its address stop reaching Pi.`,
                )
            ) {
                return;
            }

            await api(`hooks/${encodeURIComponent(hook.id)}/remove`, {});
            await load();
        });

    return html`<${Sheet} title="Webhooks" onClose=${closeSheet}>
        <p class="muted small">
            Other services (GitHub, a deploy, a monitor) post to a webhook's address, and each post becomes a message to Pi in a session, or to PiP: your instructions, then what came.
        </p>
        ${
            steer &&
            targets.length > 0 &&
            html`<div class="field">
                    <div class="label">Name</div>
                    <input
                        placeholder="Deploys"
                        maxlength="60"
                        value=${name}
                        onInput=${(event) => setName(event.currentTarget.value)}
                    />
                </div>
                <div class="field">
                    <div class="label">What Pi should do with each post</div>
                    <textarea
                        rows="3"
                        maxlength="2000"
                        placeholder="When a deploy fails, find out why and fix it. Ignore the ones that pass."
                        value=${instructions}
                        onInput=${(event) => setInstructions(event.currentTarget.value)}
                    ></textarea>
                </div>
                ${
                    targets.length > 1 &&
                    html`<div class="field">
                        <div class="label">Sends to</div>
                        <div class="segmented">
                            ${targets.map(
                                ([value, label]) => html`<button
                                    class=${target === value ? "on" : ""}
                                    onClick=${() => setTarget(value)}
                                >
                                    ${label}
                                </button>`,
                            )}
                        </div>
                        <div class="muted small">
                            ${target === "pip" ? "PiP decides what to do: start a session, message one, or tell you." : `Pi in “${here?.title}” gets each post.`}
                        </div>
                    </div>`
                }
                <button class="button primary wide" disabled=${name.trim() === ""} onClick=${make}>
                    Make webhook
                </button>`
        }
        ${list === null && html`<p class="muted">Loading…</p>`}
        ${list?.hooks.length === 0 && html`<p class="muted">No webhooks yet.</p>`}
        ${list?.hooks.map(
            (hook) => html`<${HookRow}
                key=${hook.id}
                hook=${hook}
                base=${list.base}
                fresh=${hook.id === fresh}
                onRemove=${() => remove(hook)}
            />`,
        )}
        ${
            list &&
            html`<p class="muted small">
                ${list.base ? "" : `Services post to ${location.origin}, so they must be able to reach it: a tunnel's address works for GitHub. `}For GitHub: the repository's Settings → Webhooks → Add webhook, paste the address, choose application/json, and pick the events. GitHub's secret field may stay empty.
            </p>`
        }
    <//>`;
}
