# web

A module can add to the app what a tool cannot: a page that shows something without asking Pi, a button on the rail, a row in the menu. Its default export's second argument, `web`, registers three parts while the module loads.

## Members

### `api`

```ts
readonly api: number
```

Since 0.14.0 · Stable

The version of this API (1)

### `module`

```ts
readonly module: string
```

Since 0.14.0 · Stable

the module's name, its file's without `.ts`

### `route`

```ts
route(method: WebMethod, path: string, handle: WebHandler, options?: { access?: WebAccess }): void
```

Since 0.14.0 · Stable

A route under `/api/x/<module>/` ([Routes](#routes))

`web.route(method, path, handle, { access })`. `method` is GET, POST, PUT, PATCH, or DELETE. `path` is relative to the module's own: `"status"`, or `"items/:id"`, where `:id` matches one part of the address. Each part is letters, digits, and `. _ ~ -` (but not `.` or `..` alone), or `:name`. Where paths overlap, the most specific wins, whatever the order they were registered in: a fixed part before a `:name` part, from the left (`items/new` before `items/:id`).

### `client`

```ts
client(entry: string, options?: { access?: WebAccess }): void
```

Since 0.14.0 · Stable

The browser module ([The browser module](#the-browser-module))

`web.client(entry, { access })`. `entry` is the name of a file or folder right beside the module (letters, digits, `.`, `_`, and `-`, starting with a letter, a digit, or `_`), not a link: a `.js` or `.mjs` file, served alone, or a folder, whose `index.js` loads first and may import the folder's other files.

### `command`

```ts
command(name: string, command: Command): void
```

Since 0.14.0 · Stable

A command for the message box ([Commands](#commands))

`web.command(name, { description, args, scope, handler })` adds `/name` to the message box's suggestions, for the people who may run it. It runs on the server and does not ask Pi.

### `send`

```ts
send(event: string, data?: unknown, options?: { to?: string }): void
```

Since 0.14.0 · Stable

An event to the browser module ([Events](#events))

`web.send(event, data, { to })` sends `data` (JSON, up to 256 KB) to the tabs of everyone the browser module's `access` lets in, or only to the tabs of the person whose id is `to`; there `pocket.on(event, run)` hears it.

`web.send` never throws, as it is mostly called from timers, where a throw would stop the server: an event it cannot send goes to the server's log, once for each kind of mistake in a version.

### `error`

```ts
error(status: number, message: string): Error
```

Since 0.14.0 · Stable

An error a route throws to answer with its status and words

Throw `web.error(status, message)` (a status from 400 to 599) to answer with it and its message, as they are, to whoever asked, guests and viewers too when the route is theirs: `throw web.error(404, "No such item")`. Put nothing in it you would not show them.

### `onDispose`

```ts
onDispose(dispose: () => unknown): void
```

Since 0.14.0 · Stable

Run `run` when this version goes ([Cleanups](#cleanups))

## Requests

### `WebRequest`

Since 0.14.0 · Stable

`handle(request)` gets `{ method, params, query, body, user, signal }`: the `:name` parts, the query string (`URLSearchParams`, from `pocket.api("usage?days=7")`), the JSON object sent (empty for GET and DELETE), who asked (`{ id, name, role }`), and a signal aborted when the browser stops waiting. What it returns goes back as JSON (`undefined` as `{}`).

## Access

### `WebAccess`

Since 0.14.0 · Stable

Routes and the browser module are the owner's alone unless their `access` says more:

| `access`            | Who                                                  |
| ------------------- | ---------------------------------------------------- |
| `"owner"` (default) | The owner                                            |
| `"steer"`           | The owner, and guests who can steer every session    |
| `"view"`            | The owner, guests, and viewers who see every session |

Someone invited to one session never may: these belong to the whole app.
