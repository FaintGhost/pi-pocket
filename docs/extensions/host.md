# Using the host

What the default export receives first. Extensions reach the app only through it (and add to it through `web`, [Adding to the app](app.md)); it stays the same while modules reload. Its members are in [the reference](reference/host.md).

Modules reload into the running server, but the server's own part (the host among it) changes only with a restart. A module that uses a member new to the host must work without it until then: check that it is there (`typeof host.heldBack === "function"`) and do as before when it is not. A module that called a missing member would fail at its first use, in every session.

To type it, import the type by the absolute path of `src/server/host.ts`: `import type { PocketHost } from "/path/to/pi-pocket/src/server/host.ts";`. A type import is gone when the module runs, so the path only matters to the type checker.
