# Command context

`web.command(name, { description, args, scope, handler })` adds `/name` to the message box's suggestions, for the people who may run it.

## The command

- `description` shows in the suggestions. `args` is an optional hint in words, such as `"[zone]"`. Each is 200 characters at most, and a module has 50 commands at most.
- `handler(args, ctx)` gets everything after the name as one string (up to 4000 characters).

## `ctx`

`ctx.user` is who ran it (`{ id, name, role }`), `ctx.conversationId` and `ctx.cwd` the session and its folder. Read a document with `ctx.snapshot(Doc, ctx.conversationId, ctx.context)`, and change documents with `await ctx.commit(async (tx) => …)`, which answers what its function returns; keep work outside Pi Pocket out of the commit.

Stopping aborts `ctx.signal` and does not undo what the handler did.

Who ran a command and where, with the durable task that runs it: read and change documents through it.

## Results

What it returns:

- `{ type: "toast", level, message }`: a notice (`"info"`, `"warning"`, or `"error"`) for the person who ran it, in that tab alone. A message is cut to 500 characters.
- `{ type: "card", output }`: plain text in the session the command was typed in, for everyone who sees it. Pi never gets it, and it does not change whom Pi works for. Find in session and export include it. Only its last 30,000 characters are kept, as for a `!` command. Put no secrets in it.

## Scopes

Who may run it (`scope`):

- `"conversation"`: anyone who may steer the session, and only whoever drives while people take turns. Guests invited to one session may run it there.
- `"global"`: the owner alone, in any session they see. While someone else drives, the app shows the owner no message box there, so they run it from another session or take the wheel first. Use it for settings of the whole app. Its card still goes to the session it was typed in, for everyone there.
- Viewers run none, and see none in the suggestions.
