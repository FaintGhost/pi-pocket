# host

What the default export receives first. Extensions reach the app only through it (and add to it through `web`, [above](#adding-to-the-app)); it stays the same while modules reload.

## Public members

### `dataDir`

```ts
readonly dataDir: string
```

Since 0.1.0 · Stable

Pi Pocket's data folder

### `agentDir`

```ts
readonly agentDir: string
```

Since 0.1.0 · Stable

Pi's (`~/.pi/agent`)

### `skillPaths`

```ts
skillPaths(): string[]
```

Since 0.1.0 · Stable

The extra skill folders in Pi's settings

Pi's configured extra skill paths, from its settings.

### `skills`

```ts
skills(cwd: string): Skill[]
```

Since 0.12.0 · Stable

Pi's skills for a session working in `cwd`, from every place Pi looks

### `resolveModel`

```ts
resolveModel(spec: string): ModelRef
```

Since 0.1.0 · Stable

`provider/modelId` (or a bare id) to a signed-in model whose sign-in works, or an error that names no other models

`provider/modelId` (or a bare model id) to a signed-in model whose sign-in has not expired, or an error that says it is not available. The error names no other models: models are a person's to choose.

### `subagentModels`

```ts
subagentModels(): readonly string[]
```

Since 0.13.1 · Stable

The models the owner allows subagents besides their session's own (`provider/modelId`); empty by default

### `modelProblem`

```ts
modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>
```

Since 0.13.1 · Stable

Why a model may not be used now (not signed in, its sign-in expired), or `undefined`; `fresh` asks its provider again

Why Pi may not use a model now, in words for Pi to pass on (not known here, its provider not signed in, or its sign-in expired), or undefined when it may. `fresh` asks the provider's sign-in again first.

### `requesterOf`

```ts
requesterOf(conversationId: ConversationId): string | undefined
```

Since 0.3.0 · Stable

The id of the person Pi works for in a session now

Who Pi works for in a conversation now: whose message led to its current work.

### `notice`

```ts
notice(level: "info" | "warning" | "error", message: string, conversationId?: ConversationId): void
```

Since 0.1.0 · Stable

Report something to the server log and the app (`"info"`, `"warning"`, `"error"`); with a conversation's id, to its tabs only

### `heldBack`

```ts
heldBack(conversationId: ConversationId): string | undefined
```

Since 0.12.0 · Stable

Why work Pi would start there with nobody asking may not start now (a spend limit), or `undefined`

Why work Pi would start in a conversation with nobody asking (a subagent's report, say) may not start now: the spend limit its session or whoever pays there reached. Undefined when it may.

### `onLimitsChanged`

```ts
onLimitsChanged(listener: () => void): () => void
```

Since 0.12.0 · Stable

Call `listener` when the owner changes a spend limit; returns how to stop

### `linkedSessions`

```ts
readonly linkedSessions: LinkedSessions
```

Since 0.14.0 · Experimental

Sessions that a session starts and messages, as Agent Teams does: `start`, `send`, `list` ([below](#starting-and-messaging-sessions))

Sessions that a session starts and messages (`linked-sessions.ts`): each one is an ordinary session, linked to the one that started it. The checks of the person Pi works for apply, and a call repeated with its key acts once.

#### `linkedSessions.start`

```ts
start(
    source: ConversationId,
    request: { title?: string; message: string; model?: string; thinking?: string },
    key: string,
): Promise<{ session: ConversationId; address: string }>
```

Since 0.14.0 · Experimental

`start(source, { title?, message, model?, thinking? }, key)` makes the session and sends it `message` as its first message, and returns `{ session, address }`: its id, and the source's address for it. A title left out is the message's first line. `model` (`provider/modelId`) must be the source's own or one the owner allows for subagents (Menu → Providers → Models for subagents); left out, it is the source's. `thinking` is at most the source's level (left out, the source's), lowered to the highest the model has. A model that cannot be used now is refused before anything is made.

#### `linkedSessions.send`

```ts
send(
    source: ConversationId,
    request: { to: string; message: string; steer?: boolean },
    key: string,
): Promise<void>
```

Since 0.14.0 · Experimental

`send(source, { to, message, steer? }, key)` sends `message` to the linked session at address `to`, as a follow-up, or with `steer` at its next pause. It returns once the message is taken, not answered. The session that gets it reads it fenced, after words that say another session's agent wrote it and that it is a request, not a person's order, with the address to reply to.

#### `linkedSessions.list`

```ts
list(source: ConversationId): Promise<LinkedSession[]>
```

Since 0.14.0 · Experimental

`list(source)` gives the sessions linked to it, at any distance, that the person Pi works for sees: each with an `address` of the source's own (so no session's id goes into its transcript), and its title, folder, and state only when everyone who sees the source sees it too.

#### `LinkedSession`

```ts
interface LinkedSession {
    address: string;
    title?: string;
    cwd?: string;
    busy?: boolean;
    archived?: boolean;
}
```

Since 0.14.0 · Experimental

A session linked to another, as `host.linkedSessions.list` gives it to the session that asks. `address`: What the asking session calls it: an address of its own, never the session's id. `title`: Only when everyone who sees the asking session sees this one too.

### `text`

```ts
readonly text: {
    quoted(text: string, max?: number): string;
    defang(text: string): string;
}
```

Since 0.14.0 · Stable

Text from elsewhere made safe for Pi to read: `quoted(text, max)`, one line in quotes it cannot close; `defang(text)`, with no closing tag left in it, for text between tags of your own

Text from elsewhere made safe for Pi to read (`fence.ts`): `quoted` gives one line, cut to `max`, without invisible characters or any tag, in quotes it cannot close; `defang` keeps the lines, but no closing tag survives, for text put between tags of your own. Tell Pi in the same place that it is data.

### `thinkingLevels`

```ts
readonly thinkingLevels: readonly ModelThinkingLevel[]
```

Since 0.14.0 · Stable

The thinking levels, lowest first, as models and sessions name them

## Internal members

| Member                           | What it is                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `approvals`, `guard`             | Calls waiting for a person to allow them; Lancet Guard                                        |
| `schedules`, `goals`, `browsers` | Scheduled messages, Done when, and the built-in browser, as their extensions use them         |
| `memory`                         | Lessons Pi keeps across sessions: their projects, the ones in force, saving and changing them |
| `watches`                        | Sessions' PR watches: starting, stopping, and reading one, and the task that looks            |
| `repoWatches`                    | Repository watches' task, which the triggers extension installs                               |
| `gallery`                        | The extension gallery, which its extension's routes use ([below](#the-gallery))               |
| `pip`                            | PiP, the owner's assistant: what its tools do, each as PiP's person (`pip.ts`).               |
| `pipCompaction`                  | PiP's compactions: its extension's hook has PiP write its own summaries.                      |
