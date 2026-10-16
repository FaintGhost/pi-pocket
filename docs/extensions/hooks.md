# Hooks

A hook checks or changes Pi's tool calls and answers.

`hook(ToolTask, { beforeTool, afterTool })` and `hook(GenerationTask, { beforeRequest, afterResponse, onYield, afterTools })`.

- `beforeTool(call, api, context)` sees `call.name` and `call.arguments` before the call runs. Return `{ block: "why" }` to stop it (the model gets the reason as an error), or `undefined` to let it run. Codemode scripts' calls go through it too.
- `onYield(answer, api, context)` runs after Pi's final answer. Return `{ continue: "message" }` to send Pi on with another message, as Done when does (`extensions/goals.ts`).
- A hook can run again after a restart. Keep what must happen once in `api.memo`, as `extensions/guard.ts` does with an approval.
