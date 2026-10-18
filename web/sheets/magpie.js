// Magpie: the model gateway's catalog — its models and routing groups — and what its own sign-ins have left.
//
// The gateway is one provider to Pi (`magpie`), and Pi Pocket reads its list rather than keeping one: a model or a
// routing group magpie gains shows up here after a refresh, and the quotas are magpie's own reading of the plans
// behind it, which no single provider could tell us.
import { t } from "../i18n.js";
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

/** A token count as people read it: 1M, 393k, 8192. */
function tokens(count) {
    if (!count) {
        return "—";
    }

    if (count >= 1_000_000) {
        return `${Math.round(count / 100_000) / 10}M`;
    }

    if (count >= 1_000) {
        return `${Math.round(count / 1_000)}k`;
    }

    return String(count);
}

/** When a window renews, in the reader's own clock; an unreadable time stays as it came. */
function when(text) {
    const at = new Date(text ?? "");

    if (Number.isNaN(at.getTime())) {
        return text ?? "";
    }

    return at.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/** One plan's window: how much of it is used, and when it renews. */
function Window({ window }) {
    const used = typeof window.used === "number" ? Math.max(0, Math.min(100, window.used)) : null;
    const heavy = used !== null && used >= 90;

    return html`<div class="quota-window">
        <div class="muted small">
            ${window.name}${window.resetsAt ? html` · ${t("renews {{when}}", { when: when(window.resetsAt) })}` : null}
            <span class=${heavy ? "warn" : ""}> ${used === null ? "" : `${Math.round(used)}%`}</span>
        </div>
        ${
            used === null
                ? null
                : html`<div
                      class="quota-bar"
                      role="progressbar"
                      aria-valuenow=${Math.round(used)}
                      aria-valuemin="0"
                      aria-valuemax="100"
                      style="height:4px;border-radius:2px;background:var(--line);overflow:hidden"
                  >
                      <div
                          style=${`height:100%;width:${used}%;background:${
                              heavy ? "var(--danger, #d9534f)" : "var(--accent, #6a9fb5)"
                          }`}
                      ></div>
                  </div>`
        }
    </div>`;
}

/** One account magpie holds a sign-in for. */
function Quota({ card }) {
    return html`<div class="sheet-row quota">
        <div>
            <strong>${card.name}</strong>
            <span class="muted small">
                ${card.plan ? ` · ${card.plan}` : ""}${card.user ? ` · ${card.user}` : ""}
            </span>
        </div>
        ${card.windows.map((window) => html`<${Window} window=${window} />`)}
        ${card.readAt ? html`<div class="muted small">${t("read {{when}}", { when: when(card.readAt) })}</div>` : null}
    </div>`;
}

/** One model or routing group the gateway serves. */
function Model({ model }) {
    return html`<div class="sheet-row">
        <div>
            <strong>${model.name}</strong>
            ${model.group ? html`<span class="muted small"> · ${t("routing group")}</span>` : null}
        </div>
        <div class="muted small mono">${model.id}</div>
        <div class="muted small">
            ${t("{{tokens}} context · {{out}} out", {
                tokens: tokens(model.contextWindow),
                out: tokens(model.maxTokens),
            })}
            ${model.reasoning ? html` · ${t("reasoning")}` : null} ${model.images ? html` · ${t("images")}` : null}
        </div>
    </div>`;
}

/** The Magpie sheet: what the gateway serves, what is left on each plan, and what it has sent lately. */
export function MagpieSheet() {
    const [state, setState] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = async (again = false) => {
        setBusy(true);
        setProblem(null);

        await attempt(async () => {
            try {
                setState(again ? await api("magpie/refresh", {}) : await api("magpie"));
            } catch (error) {
                setProblem(error instanceof Error ? error.message : String(error));
            }
        });
        setBusy(false);
    };

    useEffect(() => {
        void load();
    }, []);

    if (state === null) {
        return html`<${Sheet} title="Magpie" onClose=${closeSheet}>
            ${problem === null ? html`<${Loader} />` : html`<div class="warn">${problem}</div>`}
        <//>`;
    }

    const usage = state.usage;

    return html`<${Sheet} title="Magpie" onClose=${closeSheet} wide>
        <div class="sheet-list">
            <div class="sheet-row">
                <div class="muted small mono">${state.url}</div>
                <div class="muted small">
                    ${
                        state.reachable
                            ? t("{{models}} models · {{groups}} routing groups", {
                                  models: state.models.length,
                                  groups: state.groups.length,
                              })
                            : t("Not reachable from here")
                    }
                    ${state.readAt ? ` · ${t("read {{when}}", { when: when(state.readAt) })}` : ""}
                </div>
                ${state.error ? html`<div class="warn small">${state.error}</div>` : null}
            </div>

            ${
                state.groups.length === 0
                    ? null
                    : html`<div class="label">${t("Routing groups")}</div>
                          ${state.groups.map((group) => html`<${Model} model=${group} />`)}`
            }

            <div class="label">${t("Models")}</div>
            ${state.models.filter((model) => !model.group).map((model) => html`<${Model} model=${model} />`)}

            ${
                state.quotas.length === 0
                    ? null
                    : html`<div class="label">${t("Quotas")}</div>
                          ${state.quotas.map((card) => html`<${Quota} card=${card} />`)}`
            }

            ${
                usage === undefined
                    ? null
                    : html`<div class="label">${t("Sent lately")}</div>
                          <div class="sheet-row muted small">
                              ${usage.period ? `${usage.period}: ` : ""}
                              ${
                                  usage.calls === undefined
                                      ? null
                                      : html`${t("{{count}} calls", { count: usage.calls.toLocaleString() })}`
                              }
                              ${
                                  usage.errors === undefined
                                      ? null
                                      : html` · ${t("{{count}} errors", { count: usage.errors.toLocaleString() })}`
                              }
                              ${
                                  usage.retried === undefined
                                      ? null
                                      : html` · ${t("{{count}} retried", { count: usage.retried.toLocaleString() })}`
                              }
                              <div>
                                  ${
                                      usage.input === undefined
                                          ? null
                                          : html`${t("{{count}} in", { count: usage.input.toLocaleString() })}`
                                  }
                                  ${
                                      usage.output === undefined
                                          ? null
                                          : html` · ${t("{{count}} out", { count: usage.output.toLocaleString() })}`
                                  }
                                  ${
                                      usage.cacheRead === undefined
                                          ? null
                                          : html` · ${t("{{count}} cached", { count: usage.cacheRead.toLocaleString() })}`
                                  }
                              </div>
                          </div>`
            }

            <div class="sheet-row">
                <button class="button small" disabled=${busy} onClick=${() => void load(true)}>
                    ${busy ? t("Reading…") : t("Refresh catalog and quotas")}
                </button>
            </div>
        </div>
    <//>`;
}
