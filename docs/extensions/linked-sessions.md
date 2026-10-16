# Starting and messaging sessions

A tool can start sessions, and send messages between them.

`host.linkedSessions` lets a tool start a session from the one it runs in, and send messages between such sessions, as Agent Teams (`extensions/agent-teams.ts`) does. Its shapes are `LinkedSessionsApi` and `LinkedSession` in `host.ts`. A linked session is an ordinary session: it shows in the list under the one that started it. It works in the source's folder, with no worktree of its own, and starts with a copy of the source's agent settings but not its history, plan mode, or budget: the source's budget covers it (below). The link (`linkedFrom` in its session entry) gives no access and owns nothing.

- `start(source, { title?, message, model?, thinking? }, key)` makes the session and sends it `message` as its first message, and returns `{ session, address }`: its id, and the source's address for it. A title left out is the message's first line. `model` (`provider/modelId`) must be the source's own or one the owner allows for subagents (Menu → Providers → Models for subagents); left out, it is the source's. `thinking` is at most the source's level (left out, the source's), lowered to the highest the model has. A model that cannot be used now is refused before anything is made.
- `send(source, { to, message, steer? }, key)` sends `message` to the linked session at address `to`, as a follow-up, or with `steer` at its next pause. It returns once the message is taken, not answered. The session that gets it reads it fenced, after words that say another session's agent wrote it and that it is a request, not a person's order, with the address to reply to.
- `list(source)` gives the sessions linked to it, at any distance, that the person Pi works for sees: each with an `address` of the source's own (so no session's id goes into its transcript), and its title, folder, and state only when everyone who sees the source sees it too.

Addresses belong to the session that holds them. A fork starts with none, so it leaves the team: the addresses in the history it inherited do not resolve there.

Both act as the person Pi works for in the source: they need that person's access and steering rights (and, to start, access to every session), and are refused while the source is in plan mode, past a spend limit, or while someone else has the turn. `send` also needs the turn and room under the spend limit in the target. Core keeps a team small and bounded, and refuses past these, each with a plain error:

- A linked session may message its peers, but may not start sessions; a session may start at most 10.
- After 20 messages between the sessions of a team since a person last wrote in any of them, no more go until a person writes.
- The budget of the session that started a team covers it all: what its linked sessions spend counts toward it.
- A message is at most 20,000 characters; a title is one line of at most 120, without invisible or direction characters.

Pass a `key` that stays the same when the call runs again, `${api.taskId}:${api.callId}`: a start or send with a key it saw before returns what the first did, so a replay makes one session and one message. Its record is kept 30 days. Errors say what is wrong, not what Pi should do about it: that is for the tool to say.
