# Writing extensions

An extension gives Pi something new:

- a **tool** that Pi can call,
- a **section** of Pi's system prompt,
- a **hook** that checks or changes Pi's tool calls and answers,
- or a durable **task**.

A module can also add to the app itself: **routes** on the server, a **browser module** with rail buttons, pages, sheets, panels, status-line items, menu rows, and launcher actions, and **commands** that people run from the message box without Pi ([Adding to the app](extensions/app.md)). Pi Pocket's own features are modules too (`src/server/extensions/`). The owner can add modules of their own, without a change to Pi Pocket's code.

Extensions come from Pi Durable. Its README tells about the parts in depth: `node_modules/@earendil-works/pi-durable/README.md` in Pi Pocket's folder (Extensions, Tools, System Prompt, Hooks, Your Own State). These pages tell what Pi Pocket adds, and how to write an extension that works well. The rules for extensions are in [the policies](extensions/policies/index.md).

## Where to read next

This page is the map. Read all of it, then only the pages that your task needs.

| To                                                             | Read                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Make a first extension, step by step                           | [Your first extension](extensions/first-extension.md)                                                           |
| Know what the file must be, and how it loads and fails         | [Modules, loading, and errors](extensions/modules.md)                                                           |
| Give Pi a tool                                                 | [Tools](extensions/tools.md)                                                                                    |
| Add a rule to Pi's system prompt                               | [Prompt sections](extensions/prompt-sections.md)                                                                |
| Check or change Pi's tool calls and answers                    | [Hooks](extensions/hooks.md)                                                                                    |
| Use the app's services, and work with older servers            | [Using the host](extensions/host.md)                                                                            |
| Start sessions, and send messages between them                 | [Starting and messaging sessions](extensions/linked-sessions.md)                                                |
| Add to the app: routes, a browser module, commands             | [Adding to the app](extensions/app.md)                                                                          |
| Answer requests on the server, and say who may use them        | [Routes](extensions/routes.md)                                                                                  |
| Add rail buttons, pages, sheets, panels, status items, menus   | [Browser modules](extensions/browser-modules.md)                                                                |
| Run something from the message box, without Pi                 | [Slash commands](extensions/commands.md)                                                                        |
| Show your tool's calls in words                                | [How tool calls show](extensions/tool-calls.md)                                                                 |
| Send live updates to the browser                               | [Events](extensions/events.md)                                                                                  |
| Stop timers and close connections when a module loads again    | [Cleanups](extensions/cleanups.md)                                                                              |
| Test a module                                                  | [Testing](extensions/testing.md)                                                                                |
| Share a module, or install one that other people wrote         | [Publishing to the gallery](extensions/publishing.md)                                                           |
| Move a module into Pi Pocket itself                            | [Making it built in](extensions/built-in.md)                                                                    |
| Find a member of `host`, `web`, `pocket`, or a command's `ctx` | [The reference](extensions/reference/host.md), and the exact types in [types/pocket.d.ts](../types/pocket.d.ts) |
| Find a limit, or what a word means                             | [Limits](extensions/reference/limits.md), [Glossary](extensions/reference/glossary.md)                          |
| Know the rules: core or extension, the API, security, gallery  | [The policies](extensions/policies/index.md)                                                                    |

## Drop-in or built-in

**A drop-in** is a file in the drop-in folder, `~/.pi-pocket/extensions/` (the `extensions/` folder in the data folder). Use a drop-in for all that one person or one machine wants.

- It stays when Pi Pocket updates.
- It starts off. The owner turns it on in Menu → Extensions.
- Drop-ins that other people wrote come from the gallery, and the owner can share their own there ([Publishing to the gallery](extensions/publishing.md)).

A drop-in runs inside the server, with the owner's rights. It can read `config.json`, with the owner's token, and each session. Lancet Guard never sees what its code does. Its browser module, if it has one, runs in the app's own page, with the rights of the person whose tab loads it. Before you ask the owner to turn on a drop-in, show the owner the whole module, its browser files too, and say what it does.

**A built-in** is a file in `src/server/extensions/`. It is a part of Pi Pocket for each person who uses this copy. Use a built-in only for a change to Pi Pocket itself, and read [self-editing.md](self-editing.md) first ([Making it built in](extensions/built-in.md)).

## A module

A module is one `.ts` file with a default export: a function. Pi Pocket calls it with the host ([Using the host](extensions/host.md)) and `web`, what the module adds to the app ([Adding to the app](extensions/app.md)). Then it installs what the function returns: one extension, a list of extensions, or nothing, for a module that only adds to the app.

- The function can be `async`. Pi Pocket loads the module when the promise settles, and the module can register with `web` until then.
- Pi Pocket installs all that the module returns, or none of it. When it refuses one extension, the version before stays as it was.
- Pi Pocket refuses an extension without a name, and two extensions with the same name.
- Pi Pocket refuses a module that returns nothing and adds nothing to the app (no route, browser module, command, or cleanup): it most likely did not return its extensions.

```typescript
/**
 * A clock tool: the date and time now, in any time zone. The first sentence of this comment is the module's
 * description in the Extensions sheet.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const clock = defineTool({
    name: "clock",
    description: "The date and time now, in a time zone such as Europe/Berlin.",
    parameters: Type.Object({ zone: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => ({
        output: [
            {
                type: "text" as const,
                text: new Date().toLocaleString("en-US", { timeZone: args.zone }),
            },
        ],
    }),
});

// It returns `output`, so it needs version 2 of the extension API: Pi Pocket 0.18 says so, and does not load it.
export const pocketApi = 2;

export default function createClock() {
    return defineExtension({ name: "example-clock", tools: [clock] });
}
```

The rules for the file, and how it loads, are in [Modules, loading, and errors](extensions/modules.md).

These examples work. `npm test` runs them (`test/docs-examples.test.ts`):

- [examples/my-words.ts](examples/my-words.ts): the module of [Your first extension](extensions/first-extension.md), a tool and a command.
- [examples/clock.ts](examples/clock.ts): a tool, and a command (`/clock-zone`) that sets the time zone that it uses in a session.
- [examples/no-force-push.ts](examples/no-force-push.ts): a hook that stops some bash calls, and a prompt section that tells Pi so.
- [examples/server-status.ts](examples/server-status.ts) with [examples/server-status.js](examples/server-status.js): a page on the rail, with a route that reads the machine's load and memory, and events that keep it live.
- [examples/zh-cn-ui.ts](examples/zh-cn-ui.ts): a data-only Simplified Chinese pack for the app's own labels, with no tools or hooks.

### UI locale packs (data only)

[`examples/zh-cn-ui.ts`](examples/zh-cn-ui.ts) is an optional Simplified Chinese pack. Copy it into the data folder's `extensions/` directory, then turn it on in **Menu → Extensions**. Like other drop-ins, it starts off. Turning it off restores English, including in already-open panels. It adds no tools or hooks and does not change the model's language or a person's content.

The pack covers fixed application strings, labels, and named templates, not every surface: pre-sign-in pages, persisted activity, raw provider/tool errors, and some dynamic status summaries remain English. Missing keys use their English source. Optional server notice metadata supplies a key and parameters for presentation only; its original message and log remain unchanged.

This separate, data-only path translates fixed Pocket UI. It does not translate user-authored text, model output, provider names, or arbitrary HTML.

A Pocket extension may also return optional `uiLocales` data alongside its ordinary tools, sections, hooks, or tasks. The shape is:

```typescript
type PocketUiLocale = {
    locale: string; // a canonical BCP 47 language tag, such as "zh-CN"
    label: string;
    default?: boolean;
    strings: Record<string, string>;
    templates?: Record<string, string>;
};
type PocketExtension = Extension & { uiLocales?: PocketUiLocale[] };
```

Use exact English source strings as keys. `strings` handles a key with no parameters; `templates` handles a source template with named placeholders:

```typescript
import { defineExtension } from "@earendil-works/pi-durable";

export default function createUiLocale() {
    return {
        ...defineExtension({ name: "example-ui-locale" }),
        uiLocales: [
            {
                locale: "zh-CN",
                label: "简体中文",
                default: true,
                strings: { Files: "文件" },
                templates: {
                    "Back to sessions, {{count}} waiting for you":
                        "返回会话列表，{{count}} 项待你处理",
                },
            },
        ],
    };
}
```

The web app translates only where its code explicitly calls `t("Files")` or `t("Back to sessions, {{count}} waiting for you", { count })`. Missing keys stay in English. A source template and its translation must contain the same set of placeholder names; for example, both templates above contain `{{count}}`. Interpolated values are inserted as-is; they are not looked up or translated again. This is not a DOM-wide translation pass: user messages, names, paths, model names, logs, and other dynamic content are not translated automatically.

The loader accepts locale packs only as validated data; their strings and templates are sent to the browser, not extension JavaScript. The same locale cannot be registered by multiple loaded extensions; a conflicting or invalid module is rejected. A drop-in still starts off. Its locale data follows the extension lifecycle: turning it off or removing it removes the pack, editing an enabled module reloads it, and a failed reload leaves the previous extension and pack running.

Only signed-in clients receive the available packs, as `hello.server.uiLocales`. There is no public dictionary endpoint. An unauthenticated page, or a signed-in client with no enabled locale packs, uses English. The browser prefers a pack marked `default: true`, then sorts by the locale string; `default` is only a preference among packs already enabled, not a switch that enables an extension. There is no per-user language choice or saved locale.

The loader's canonical-tag and data validation rules may evolve; write canonical BCP 47 tags and do not rely on undocumented size or entry limits.

## Rules that are easy to break

- **Nothing two times.** A restart can run a hook or a safe tool again. Some work must occur one time only: a message that you send, money that you spend, a line that you add to a file. Put it behind `api.memo`, or behind a key that lets a second run find the first.
- **No hidden state.** Keep state in Pi Durable documents or memos, not in variables. A reload starts the module again, and a restart starts the process again.
- **Your documents are stored data.** Name a document kind after your module (`x.<module>.<name>`, for example `x.word-count.totals`), so that no other module uses the same kind. Name your tasks and your entries' kinds the same way. After anyone has run the module, never rename a kind or a name, and never change what its fields mean. Add new ones beside them.
- **Name your browser data too.** A browser module that keeps data in `localStorage` or `sessionStorage` uses keys that start with `x.<module>.`, for example `x.word-count.open`. Pi Pocket's own keys start with `pocket.`, and it never uses `x.` keys.
- **Do not block.** Tools run in the server process. Use async file and process calls, never `execSync` or a busy loop. A slow tool delays only its call; a blocked event loop delays everyone.
- **Do not get around a block.** A guard or a person said no for a reason.
- **Keep secrets out.** The text of a section, a tool's description, and a result go to the model provider.
