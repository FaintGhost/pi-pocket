# API versions

The extension API has a version of its own, apart from the version of Pi Pocket. This page tells how a module asks for a version, and how it works on an older Pi Pocket. The rules for changes are in [API stability](../policies/api-stability.md).

## The version

`web.api` on the server, and `pocket.version` in the browser, give the version of the extension API. It is 1 now.

The version goes up only when something that modules use changes in a way that breaks them. Additions do not change it.

## Ask for a version

A module can export `pocketApi`, the version that it needs:

```typescript
export const pocketApi = 1;
```

The server module, the browser module, or both can export it. A Pi Pocket with an older version of the API does not set up the module, and says why instead.

The browser checks `pocketApi` after it imports the browser module. So keep the top level of a browser module to declarations, and do its work in the default export.

## Pi Pocket before 0.14.0

The API version, `web`, and browser modules came in Pi Pocket 0.14.0. An older Pi Pocket knows neither `pocketApi` nor `web`. On it, a module that adds to the app fails at its first `web.route` or `web.client`, and the Extensions sheet shows the error.

`web.command` came later than the rest of `web`, in the betas of 0.14.0. A module that must also load on such a beta checks first:

```typescript
if (typeof web.command === "function") {
    web.command("my-words", { … });
}
```

## New members of the host

The host changes only when the server restarts, but modules load again at once. A module that uses a member new to the host must work without it until the restart. See [Using the host](../host.md#check-for-new-members).

## When each part came

Each member in the reference has a line such as `Since 0.14.0 · Stable`: the first release that has it, and how stable it is. These parts came together:

| Part                                               | Since  |
| -------------------------------------------------- | ------ |
| Built-in modules, the host, tools, sections, hooks | 0.1.0  |
| Drop-ins in the drop-in folder                     | 0.3.0  |
| `web`: routes, browser modules, events, cleanups   | 0.14.0 |
| `pocketApi`, `web.api`, and `pocket.version`       | 0.14.0 |
| Slash commands (`web.command`)                     | 0.14.0 |
| `pocket.toolCall`                                  | 0.14.0 |
| `host.linkedSessions`                              | 0.14.0 |
