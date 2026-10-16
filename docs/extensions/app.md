# Adding to the app

A module can add routes, a browser module, and slash commands to the app. The members of `web` are in [the reference](reference/web.md).

A module can add to the app what a tool cannot: a page that shows something without asking Pi, a button on the rail, a row in the menu. Its default export's second argument, `web`, registers three parts while the module loads:

- **Routes** on the server, under `/api/x/<module>/`: what the browser module calls. Credentials and other secrets stay here.
- A **browser module**: a `.js` file the app loads in the tabs of the people it is for. It adds rail buttons, pages, sheets, menu rows, and launcher actions, and says how its tools' calls show, through `pocket`, the app's API for extensions.
- **Commands** for the message box (`/name`), which run on the server and need no browser module ([Slash commands](commands.md)).

They install and go with the module's extensions: an edit swaps them in one step, a version that fails keeps the one before, and turning the module off removes them, closing a page of it that is open. [examples/server-status.ts](../examples/server-status.ts) and [examples/server-status.js](../examples/server-status.js) are a whole one.

```typescript
import type { ExtensionWeb } from "/path/to/pi-pocket/src/server/host.ts";

export default function createUsage(_host: unknown, web: ExtensionWeb) {
    web.route("GET", "usage", async ({ signal }) => fetchUsage(signal)); // GET /api/x/usage/usage
    web.client("usage.js"); // the browser module beside this file
}
```
