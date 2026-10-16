# Events

A module sends events from the server to its browser module.

`web.send(event, data, { to })` sends `data` (JSON, up to 256 KB) to the tabs of everyone the browser module's `access` lets in, or only to the tabs of the person whose id is `to`; there `pocket.on(event, run)` hears it. A tab whose browser module has not set up yet misses it. Send once the module has loaded (from a route, a timer, or a watcher), and only from a module with a browser module: events sent while it loads, or by one without, go nowhere. A version that was replaced or turned off sends nothing.

At most 100 events, and 1 MB of them, go out each second for a version of a module; the rest of that second's are dropped. Send what changed, or a summary, not every tick. A tab more than 8 MB behind that takes nothing for 30 s (it does not read its stream, or polls and acknowledges nothing), or any tab more than 128 MB behind, is cut off, and connects again with a fresh view: events are not kept for it. Under 128 MB, a tab that keeps taking is not cut off for being behind, so a slow phone gets everything. `web.send` never throws, as it is mostly called from timers, where a throw would stop the server: an event it cannot send goes to the server's log, once for each kind of mistake in a version.

Events are not kept for a page that was closed: one that opens fetches what is now, then listens, as the example does.
