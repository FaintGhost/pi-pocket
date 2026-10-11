// Model providers: signing in and out, the models subagents may use besides their session's own, and the dialog a
// sign-in uses to ask for a code or a key.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";

/**
 * The owner's choice of the models Pi may start subagents on besides their session's own. None, the default: subagents
 * always run on their session's model, and Pi is offered no model to pick.
 */
function SubagentModels() {
    const { models, server } = store.state;
    const allowed = server?.subagentModels;

    // A server that does not keep the choice sends none.
    if (!Array.isArray(allowed)) {
        return null;
    }

    const save = (next) => attempt(() => api("settings", { subagentModels: next }));
    const find = (spec) => models.find((model) => `${model.provider}/${model.id}` === spec);
    const addable = models.filter((model) => !allowed.includes(`${model.provider}/${model.id}`));

    return html`<div class="subagent-models">
        <div class="label">Models for subagents</div>
        <p class="muted small">
            Subagents always run on their session's model, the one people picked. Pi cannot choose another model unless you allow it here.
        </p>
        ${
            allowed.length === 0
                ? html`<p class="small">None allowed: Pi never picks a model.</p>`
                : allowed.map((spec) => {
                      const model = find(spec);

                      return html`<div class="provider" key=${spec}>
                          <div>
                              <div>${model?.name ?? spec}</div>
                              <div class="muted small">
                                  ${spec}
                                  ${
                                      !model
                                          ? html` · <span class="warn">not signed in</span>`
                                          : model.signIn &&
                                            html` · <span class="warn">needs sign-in</span>`
                                  }
                              </div>
                          </div>
                          <button
                              class="button small ghost"
                              aria-label=${`Stop allowing ${model?.name ?? spec}`}
                              onClick=${() => save(allowed.filter((each) => each !== spec))}
                          >
                              Remove
                          </button>
                      </div>`;
                  })
        }
        ${
            addable.length > 0 &&
            html`<select
                class="subagent-models-add"
                aria-label="Allow a model for subagents"
                value=""
                onChange=${(event) => {
                    const spec = event.currentTarget.value;

                    event.currentTarget.value = "";

                    if (spec) {
                        save([...allowed, spec]);
                    }
                }}
            >
                <option value="">Allow a model for subagents…</option>
                ${addable.map(
                    (model) =>
                        html`<option value=${`${model.provider}/${model.id}`}>
                            ${model.name} (${model.provider})
                        </option>`,
                )}
            </select>`
        }
    </div>`;
}

export function ProvidersSheet() {
    const { me } = store.state;
    const [providers, setProviders] = useState(null);
    const [query, setQuery] = useState("");
    const load = () => attempt(async () => setProviders(await api("providers")));

    useEffect(() => {
        load();
    }, [store.state.models]);
    const owner = me?.role === "owner";
    const login = (provider, type) =>
        attempt(() => api(`providers/${encodeURIComponent(provider.id)}/login`, { type }));
    const logout = (provider) =>
        confirm(
            `Log out of ${provider.name}? Pi uses the same sign-in, so it is signed out too.`,
        ) &&
        attempt(async () => {
            await api(`providers/${encodeURIComponent(provider.id)}/logout`, {});
            load();
        });
    const needle = query.trim().toLowerCase();
    const list = (providers ?? [])
        .filter(
            (provider) =>
                needle === "" || `${provider.id} ${provider.name}`.toLowerCase().includes(needle),
        )
        .sort(
            (a, b) =>
                Number(Boolean(b.needsSignIn)) - Number(Boolean(a.needsSignIn)) ||
                Number(b.configured) - Number(a.configured) ||
                a.name.localeCompare(b.name),
        );

    return html`<${Sheet} title="Providers" onClose=${closeSheet}>
        <p class="muted small">
            Pi Pocket shares Pi's sign-ins (<span class="mono">~/.pi/agent/auth.json</span>). ${owner ? "" : "Only the owner can change them."}
        </p>
        ${owner && html`<${SubagentModels} />`}
        <label class="search">
            <${Icon} name="search" size=${16} />
            <input
                placeholder="Search providers"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
        </label>
        ${providers === null && html`<${Loader} label="Loading providers" />`}
        ${list.map(
            (provider) => html`<div class="provider">
                <div>
                    <div>
                        ${provider.name}
                        ${
                            provider.needsSignIn
                                ? html` <span class="warn">needs sign-in</span>`
                                : provider.configured && html` <span class="ok">✓</span>`
                        }
                    </div>
                    <div class="muted small">
                        ${provider.needsSignIn ? "the sign-in expired and could not be renewed: sign in again. Until then, Pi, subagents, and PiP do not use its models" : provider.configured ? `signed in${provider.label ? ` · ${provider.label}` : provider.source ? ` · ${provider.source}` : ""}` : "not configured"} · ${provider.models} models
                    </div>
                    ${
                        provider.needsSignIn &&
                        html`<div class="muted small mono provider-why">${provider.needsSignIn}</div>`
                    }
                </div>
                ${
                    owner &&
                    html`<div class="provider-actions">
                        ${
                            provider.oauth &&
                            html`<button
                                class="button small"
                                onClick=${() => login(provider, "oauth")}
                            >
                                ${provider.oauth}
                            </button>`
                        }
                        ${
                            provider.apiKey &&
                            html`<button
                                class="button small"
                                onClick=${() => login(provider, "api_key")}
                            >
                                API key
                            </button>`
                        }
                        ${
                            provider.configured &&
                            provider.source === "stored" &&
                            html`<button
                                class="button small ghost"
                                onClick=${() => logout(provider)}
                            >
                                Log out
                            </button>`
                        }
                    </div>`
                }
            </div>`,
        )}
    <//>`;
}

export function AuthDialog() {
    const { auth } = store.state;
    const [value, setValue] = useState("");

    if (!auth) {
        return null;
    }

    const answer = (payload) =>
        attempt(async () => {
            await api(`auth/${auth.flowId}/${auth.prompt.id}`, payload);
            setValue("");
            store.set({ auth: { ...store.state.auth, prompt: null } });
        });

    const close = () => {
        // Stop the sign-in on the server too, also while it waits without a question (an OAuth callback holds a port).
        if (!auth.done) {
            api(`auth/${encodeURIComponent(auth.flowId)}/cancel`, {}).catch(() => {});
        }

        store.set({ auth: null });
    };

    const prompt = auth.prompt;

    return html`<${Sheet} title=${`Sign in: ${auth.providerId}`} onClose=${close}>
        ${auth.events.map((event) => {
            if (event.type === "auth_url") {
                return html`<div class="auth-event">
                    <a class="button primary wide" href=${event.url} target="_blank" rel="noopener">
                        Open the sign-in page
                    </a>
                    ${event.instructions && html`<p class="muted small">${event.instructions}</p>`}
                </div>`;
            }

            if (event.type === "device_code") {
                return html`<div class="auth-event">
                    <p>
                        Enter this code at <a href=${event.verificationUri} target="_blank" rel="noopener">${event.verificationUri}</a>
                    </p>
                    <div class="code-big">${event.userCode}</div>
                </div>`;
            }

            return html`<p class="muted small">
                ${event.message}
                ${event.links?.map(
                    (link) => html` <a href=${link.url} target="_blank" rel="noopener">
     ${link.label ?? link.url}
 </a>`,
                )}
            </p>`;
        })}
        ${
            prompt &&
            (prompt.type === "select"
                ? html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    ${prompt.options.map(
                        (option) =>
                            html`<button
                                class="list-item"
                                onClick=${() => answer({ value: option.id })}
                            >
                                <span>${option.label}</span>
                                <span class="muted small">${option.description ?? ""}</span>
                            </button>`,
                    )}
                </div>`
                : html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    <div class="row">
                        <input
                            type=${prompt.type === "secret" ? "password" : "text"}
                            autocomplete="off"
                            placeholder=${prompt.placeholder ?? ""}
                            value=${value}
                            onInput=${(event) => setValue(event.currentTarget.value)}
                            onKeyDown=${(event) => event.key === "Enter" && answer({ value })}
                        />
                        <button class="button primary" onClick=${() => answer({ value })}>
                            Continue
                        </button>
                    </div>
                </div>`)
        }
        ${!prompt && !auth.done && html`<${Loader} label="Waiting for the provider" />`}
        ${auth.done && !auth.done.ok && html`<div class="error-box">${auth.done.error}</div>`}
    <//>`;
}
