# Writing extensions

An extension gives Pi something new: a **tool** it can call, a **section** of its system prompt, a **hook** that checks or changes its tool calls and answers, or a durable **task**. It can also add to the app itself: **routes** on the server, a **browser module** with rail buttons, pages, sheets, menu rows, and launcher actions, and **commands** people run from the message box without asking Pi ([Adding to the app](extensions/app.md)). Pi Pocket's own features are built this way (`src/server/extensions/`), and the owner can add their own without touching Pi Pocket's code.

Extensions are Pi Durable's. Its README covers the parts in depth: `node_modules/@earendil-works/pi-durable/README.md` in Pi Pocket's folder (Extensions, Tools, System Prompt, Hooks, Your Own State). This page is what Pi Pocket adds, and how to write one that holds up.

## Where to read next

This page is the map. Read it, then only the pages that your task needs.

| To                                                             | Read                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Know what the file must be, and how it loads and fails         | [Modules, loading, and errors](extensions/modules.md)                                                           |
| Give Pi a tool                                                 | [Tools](extensions/tools.md)                                                                                    |
| Add a rule to Pi's system prompt                               | [Prompt sections](extensions/prompt-sections.md)                                                                |
| Check or change Pi's tool calls and answers                    | [Hooks](extensions/hooks.md)                                                                                    |
| Use the app's services, and stay compatible with older servers | [Using the host](extensions/host.md)                                                                            |
| Start sessions, and send messages between them                 | [Starting and messaging sessions](extensions/linked-sessions.md)                                                |
| Add to the app: routes, a browser module, commands             | [Adding to the app](extensions/app.md)                                                                          |
| Answer requests on the server, and say who may use them        | [Routes](extensions/routes.md)                                                                                  |
| Add rail buttons, pages, sheets, menu rows, launcher actions   | [Browser modules](extensions/browser-modules.md)                                                                |
| Run something from the message box, without Pi                 | [Slash commands](extensions/commands.md)                                                                        |
| Say how your tool's calls show                                 | [How tool calls show](extensions/tool-calls.md)                                                                 |
| Send live updates to the browser                               | [Events](extensions/events.md)                                                                                  |
| Stop timers and close connections on reload                    | [Cleanups](extensions/cleanups.md)                                                                              |
| Test a module                                                  | [Testing](extensions/testing.md)                                                                                |
| Share a module, or install one other people wrote              | [Publishing to the gallery](extensions/publishing.md)                                                           |
| Move a module into Pi Pocket itself                            | [Making it built in](extensions/built-in.md)                                                                    |
| Find a member of `host`, `web`, `pocket`, or a command's `ctx` | [The reference](extensions/reference/host.md), and the exact types in [types/pocket.d.ts](../types/pocket.d.ts) |
| Know the rules: core or extension, the API, security, gallery  | [The policies](extensions/policies/index.md)                                                                    |

## Drop-in or built-in

- **Drop-in**: a file in `~/.pi-pocket/extensions/` (the data folder's `extensions/`). It survives updates to Pi Pocket, starts off, and the owner turns it on in Menu → Extensions. Use this for anything one person or one machine wants.

A drop-in runs inside the server, with the owner's rights: it can read `config.json` (the owner's token with it) and every session, and Lancet Guard never sees what its code does. Its browser module, if it has one, runs in the app's own page, with the rights of whoever's tab loads it. Show the owner the whole module, its browser files too, and say what it does, before you ask them to turn it on.

Drop-ins other people wrote come from the gallery, and the owner's own go to it ([Publishing to the gallery](extensions/publishing.md)).

- **Built-in**: a file in `src/server/extensions/`. It is part of Pi Pocket for everyone who uses this copy. Use this only for a change to Pi Pocket itself, and read [self-editing.md](self-editing.md) first.

## A module

One `.ts` file that default-exports a function. Pi Pocket calls it with the host ([Using the host](extensions/host.md)) and `web` (what it adds to the app, [Adding to the app](extensions/app.md)), and installs what it returns: one extension, a list, or nothing, for a module that only adds to the app. It may be `async`: the module is loaded once it settles, and may register with `web` until then. It installs all it returns or none of it: when one extension is refused, the version before stays as it was. An extension without a name, or two of one name, are refused, and so is a module that returns nothing and adds nothing to the app (no route, browser module, command, or cleanup), as it most likely forgot to return its extensions.

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
        content: [
            {
                type: "text" as const,
                text: new Date().toLocaleString("en-US", { timeZone: args.zone }),
            },
        ],
    }),
});

export default function createClock() {
    return defineExtension({ name: "example-clock", tools: [clock] });
}
```

Working examples, tested with every `npm test` (`test/docs-examples.test.ts`):

- [examples/clock.ts](examples/clock.ts): a tool, and a command (`/clock-zone`) that sets the time zone it uses in a session.
- [examples/no-force-push.ts](examples/no-force-push.ts): a hook that blocks some bash calls, and a prompt section that says so.
- [examples/server-status.ts](examples/server-status.ts) with [examples/server-status.js](examples/server-status.js): a page on the rail, with a route that reads the machine's load and memory, and events that keep it live.

The rules for the file, and how it loads: [Modules, loading, and errors](extensions/modules.md).

## Rules that are easy to break

- **Nothing twice.** A restart can run a hook or a safe tool again. Anything that must happen once (a message sent, money spent, a file appended to) goes behind `api.memo` or a key that makes a repeat find the first.
- **No surprise state.** Keep state in Pi Durable documents or memos, not in variables: a reload starts the module over, and a restart starts the process over.
- **Your documents are stored data.** Name a document kind after your module (`x.<module>.<name>`, as `x.word-count.totals`), so no other module's ever meets it, and your tasks' names and entries' kinds too. Once anyone has run it, never rename a kind or a name, or change what its fields mean: add new ones beside them.
- **Do not block.** Tools run in the server process: use async file and process calls, never `execSync` or a busy loop. A slow tool holds up only its call; a blocked event loop holds up everyone.
- **Do not get around a block.** A guard or a person said no for a reason.
- **Secrets stay out.** Text in a section, a tool's description, or a result goes to the model provider.
