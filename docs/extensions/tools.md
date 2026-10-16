# Tools

A tool is a function that Pi can call.

`defineTool({ name, description, parameters, execute, replay })`. `parameters` is a TypeBox schema (`Type` from `@earendil-works/pi-ai`); the arguments are checked against it before `execute(args, api, context)` runs.

- Return `{ content: [{ type: "text", text }] }`. Throw an `Error` to give the model an error result with its message.
- `replay: "safe"` only when running the call twice is harmless (reading, or an action keyed so a repeat finds the first one's result). The default is unsafe: a call cut off by a restart comes back to the model as interrupted instead of running again.
- `annotations: { readOnlyHint: true }`, as in Pi's tool definitions, says the tool does not change files or external state: plan mode lets it run. This is the extension author's hint, not a checked guarantee; conversation-only work, such as context management, can use it.
- `api.conversationId`, `api.taskId`, `api.callId` say which call this is. `${api.taskId}:${api.callId}` is a key that stays the same if the call runs again.
- `api.env` is the session folder's files and shell; `(await api.agent(context)).cwd` is the folder.
- `api.output(text)` streams running output, which becomes the result when `execute` returns no `content`.
- `api.memo(name, context)` reads, and `api.memo(name, value, context)` stores, a value kept with this call: a repeat after a restart finds it. Use it for anything that must not happen twice.
- `api.snapshot(Doc, api.conversationId, context)` reads a document, such as Pi Pocket's in `src/server/docs.ts`.

The tool's description and parameters go into every request: keep them short and exact.
