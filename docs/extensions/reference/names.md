# Names

Installing an extension with a name already installed replaces it, and a tool with the name of another replaces it in every session. So Pi Pocket refuses a drop-in that would take a name it keeps for itself, or one another module already has, and says so in Menu → Extensions:

- Extension names `coding-tools`, `pocket-core`, and anything starting with `pocket-` (`pocket-prompt`, `pocket-guard`, and the rest), whether that built-in is on or off.
- The built-in tools: `read`, `write`, `edit`, `bash`, `artifact`, `browser`, `subagent`, `team`, `schedule`, `codemode`, and `memory`, and PiP's: `sessions`, `session_read`, `session_start`, `session_send`, `session_follow`, `session_stop`, `session_archive`, `session_schedule`, `approvals`, `repo_watch`, and `session_watch_pr`, and the triggers' `watch_pr`.
- An extension or tool name another module installed: the first one in keeps it.

Give every extension and tool a name of your own, with a prefix (`example-clock`, `acme_lookup`). To change how a built-in tool works, wrap it (`wrapTool` in Pi Durable's README) or check its calls with a hook, rather than replacing it.

## Module files

- has a file name no built-in module has (a drop-in named `browser.ts` is not loaded). Files that start with `_` or end in `.test.ts` are not modules: use them for helpers and tests.

What a module adds to the app goes by its file's name: `server-status.ts` is `server-status`, at `/api/x/server-status/` and `/x/server-status/`. File names are unique across both folders, so these never collide; a module that adds to the app needs a name of up to 64 letters, digits, `-`, and `_`, starting with a letter or digit.

## Routes

Each part is letters, digits, and `. _ ~ -` (but not `.` or `..` alone), or `:name`.

## Browser modules

`entry` is the name of a file or folder right beside the module (letters, digits, `.`, `_`, and `-`, starting with a letter, a digit, or `_`), not a link.

## What a browser module adds

Each thing it adds has an `id` of its own (up to 64 letters, digits, and `. _ : -`, starting with a letter or digit), and adding one with the same `id` again replaces it.

## Commands

- `name` is up to 64 lowercase letters, digits, `-`, and `_`, starting with a letter, without the `/`, and has at least one `-`: `acme-status`, not `status`. The app's own commands are one word each, so a new one never takes your name. Give it a prefix of your own. A name another module's command has is refused: the first one in keeps it. A prompt template with the same name wins in the message box.

## Documents, tasks, and entries

- **Your documents are stored data.** Name a document kind after your module (`x.<module>.<name>`, as `x.word-count.totals`), so no other module's ever meets it, and your tasks' names and entries' kinds too. Once anyone has run it, never rename a kind or a name, or change what its fields mean: add new ones beside them.

## Gallery entries

- `<name>.ts`, the module. `<name>` is 2 to 64 lowercase letters, digits, `-`, and `_`, starting with a letter or digit, and is neither a built-in module's name nor starts with `pocket-`; its extensions and tools keep the [names rules](#names).
- `<name>.js` or `<name>.mjs` beside it, or the folder `<name>/`, for its browser module (`web.client("<name>.js")`, or `web.client("<name>")`). Helpers go in that folder too (`import { zones } from "./<name>/zones.ts"`): the folder serves no `.ts` files. Four folders deep at most, with no hidden files and no `node_modules`.
