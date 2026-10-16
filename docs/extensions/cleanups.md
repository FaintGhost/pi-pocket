# Cleanups

A cleanup stops what a version of your module started, when that version goes.

`web.onDispose(run)` runs `run` when this version of the module goes: an edit replaces it, the owner turns it off, or the server stops. Stop timers and close connections there: a reload starts the module over, and the old version's timers would otherwise run on. One registered after the module loaded (from a timer) runs too, and one registered after the version went runs at once. `run` may return a promise: when the server stops, it waits up to 3 s for those, the cleanups of versions still going (replaced or turned off a moment before) and of a version still loading included. `pocket.onDispose` does the same in the browser, but a browser cleanup is not waited for: do what must finish at once.

The new version starts before the old one's cleanups run, so that an edit that fails leaves the old one whole. Something only one of them can hold at a time (a port, a lock) cannot be taken while the module loads: take it at its first use, or try again a moment later.
