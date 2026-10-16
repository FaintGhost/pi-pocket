# Slash commands

A command runs on the server when someone types `/name` in the message box. It does not ask Pi.

`web.command(name, { description, args, scope, handler })` adds `/name` to the message box's suggestions, for the people who may run it. It runs on the server and does not ask Pi. The [clock example](../examples/clock.ts) has one: `/clock-zone Europe/Berlin` sets the session's time zone, and `/clock-zone` shows it.

```typescript
web.command("acme-status", {
    description: "Show this session's folder",
    scope: "conversation",
    handler: (_args, ctx) => ({ type: "card", output: ctx.cwd }),
});
```

- `name` is up to 64 lowercase letters, digits, `-`, and `_`, starting with a letter, without the `/`, and has at least one `-`: `acme-status`, not `status`. The app's own commands are one word each, so a new one never takes your name. Give it a prefix of your own. A name another module's command has is refused: the first one in keeps it. A prompt template with the same name wins in the message box.
- `description` shows in the suggestions. `args` is an optional hint in words, such as `"[zone]"`. Each is 200 characters at most, and a module has 50 commands at most.
- `handler(args, ctx)` gets everything after the name as one string (up to 4000 characters). `ctx.user` is who ran it (`{ id, name, role }`), `ctx.conversationId` and `ctx.cwd` the session and its folder. Read a document with `ctx.snapshot(Doc, ctx.conversationId, ctx.context)`, and change documents with `await ctx.commit(async (tx) => …)`, which answers what its function returns; keep work outside Pi Pocket out of the commit.

What it returns:

- `{ type: "toast", level, message }`: a notice (`"info"`, `"warning"`, or `"error"`) for the person who ran it, in that tab alone. A message is cut to 500 characters.
- `{ type: "card", output }`: plain text in the session the command was typed in, for everyone who sees it. Pi never gets it, and it does not change whom Pi works for. Find in session and export include it. Only its last 30,000 characters are kept, as for a `!` command. Put no secrets in it.

To refuse, throw `web.error(status, message)` (or let the app's own errors through): the person who ran it reads `message`. Any other throw tells them only "The command failed.", and the owner gets its words in a notice, as they can name the server's folders or quote a secret.

A conversation command is offered to everyone who can steer that session, people invited to only that session included, and its handler runs with the owner's rights, as all of the module does. Its `args` are untrusted text: check them, and check `ctx.user.role` and `ctx.conversationId` before you change anything beyond that session.

Who may run it (`scope`):

- `"conversation"`: anyone who may steer the session, and only whoever drives while people take turns. Guests invited to one session may run it there.
- `"global"`: the owner alone, in any session they see. While someone else drives, the app shows the owner no message box there, so they run it from another session or take the wheel first. Use it for settings of the whole app. Its card still goes to the session it was typed in, for everyone there.
- Viewers run none, and see none in the suggestions.

Each run is a durable task, kept by who ran it, the session, and the request's id. When a reply gets lost, sending the same text again from the same tab finds the first run and gets its result: the handler runs once. A server restart never runs a handler again: the person hears that it was cut off, as it may have done part of its work. Menu → **Running now** shows a command while it runs, and stops it: steerers stop conversation commands, the owner global ones. Stopping aborts `ctx.signal` and does not undo what the handler did; a stop that comes just after the card was written leaves the card, and the run says it was stopped.

There is no time limit: a handler must watch `ctx.signal` and end when it aborts. One person may have 4 runs going at once, over every session; a fifth is refused until one ends, so a handler that never ends holds one of them until the server restarts. The arguments and the result are stored with the task, so a command is no place to type a password.

Commands install and go with the module's version, as routes do: an edit swaps them in one step, a version that fails keeps the ones before, and turning the module off removes them. A run that started keeps the handler it started with. Menu → **Extensions** lists a module's commands, each with its scope.
