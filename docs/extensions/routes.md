# Routes

A route answers requests from your browser module, on the server.

`web.route(method, path, handle, { access })`. `method` is GET, POST, PUT, PATCH, or DELETE. `path` is relative to the module's own: `"status"`, or `"items/:id"`, where `:id` matches one part of the address. Each part is letters, digits, and `. _ ~ -` (but not `.` or `..` alone), or `:name`. Where paths overlap, the most specific wins, whatever the order they were registered in: a fixed part before a `:name` part, from the left (`items/new` before `items/:id`).

`handle(request)` gets `{ method, params, query, body, user, signal }`: the `:name` parts, the query string (`URLSearchParams`, from `pocket.api("usage?days=7")`), the JSON object sent (empty for GET and DELETE), who asked (`{ id, name, role }`), and a signal aborted when the browser stops waiting. What it returns goes back as JSON (`undefined` as `{}`).

- Throw `web.error(status, message)` (a status from 400 to 599) to answer with it and its message, as they are, to whoever asked, guests and viewers too when the route is theirs: `throw web.error(404, "No such item")`. Put nothing in it you would not show them.
- Any other throw is a 500, even an error that carries a `status` of its own (as a provider's SDK's do, with words that can quote a key). The owner sees its message; anyone else sees only that the extension failed. The server log has it whole.
- The app's own checks come first: a sign-in, and the `X-Pocket` header, which a link or form on another site cannot send. A module's routes need it on GET too, so a GET can never be made from elsewhere; `pocket.api` always sends it, and so must anything else that calls them (`curl -H 'X-Pocket: 1'`). Without it, nothing is looked up.
- A route answers only the people its `access` lets in. To anyone else it is not there: the same 404 as a path the module lacks, and a 405 names only the methods they may use. So another route whose path matches may answer them instead (`items/:id` for `items/new`, with `id` `"new"`): give routes whose paths overlap the same `access`, or check `user.role` in the handler.
- A `:name` part is text from outside. The address is decoded before it is split, so the server answers 400 for a part that decodes to `..` (`..%2F`), or has a `\` or NUL in it (`.` and `..` written as they are never reach it: the address resolves them first). Still check a part before you make a file's path of it.
- A handler has no time limit: one that waits holds its request until it answers or the browser stops waiting, which aborts `signal`. Pass `signal` to what it waits for.

## Who may use it

Routes and the browser module are the owner's alone unless their `access` says more:

| `access`            | Who                                                  |
| ------------------- | ---------------------------------------------------- |
| `"owner"` (default) | The owner                                            |
| `"steer"`           | The owner, and guests who can steer every session    |
| `"view"`            | The owner, guests, and viewers who see every session |

Someone invited to one session never may: these belong to the whole app. Each route checks its own `access`, so a browser module for everyone can have a route for the owner alone. `access` holds for every method: a POST route open to `"view"` lets viewers change something through it, though they may not steer a session. Give a route that changes things `"owner"` or `"steer"`. A browser module runs with the rights of whoever's tab loads it, so it can do nothing in a guest's tab that the guest could not.
