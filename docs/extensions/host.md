# Using the host

The host is the first argument of a module's default export. A module gets the app's services only through the host, and adds to the app through `web` ([Adding to the app](app.md)). The host stays the same while modules load again. Its members are in [the host reference](reference/host.md).

## Check for new members

Pi Pocket loads a module again while the server runs, but the host changes only when the server restarts. So a module can run on a server whose host does not have a member yet.

A module that uses a new member must work without it until the restart:

```typescript
const held = typeof host.heldBack === "function" ? host.heldBack(conversationId) : undefined;
```

A module that calls a member that is not there fails when it first uses it, in each session.

## Types

To get the types of the host in your editor, import them from `_pocket.d.ts`. Pi Pocket links this file into the drop-in folder:

```typescript
import type { Host, Web } from "./_pocket.d.ts";

export default function createMyModule(host: Host, web: Web) {
    // …
}
```

Use `import type`. Node removes this import when the module runs, so the path only matters to your editor and the type checker. See [Types for your editor](reference/types.md).
