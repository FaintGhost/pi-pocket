# Modules, loading, and errors

An extension module is one file. This page tells what the file must be, and how Pi Pocket loads it, loads it again, and reports its errors.

## The file

The file:

- is TypeScript that Node runs as it is: only erasable syntax (no `enum`, no `namespace`, no constructor parameter properties). Imports of local files end in `.ts`.
- imports `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and the rest of Pi Pocket's packages by name. The drop-in folder has a `node_modules` link to Pi Pocket's own, so a drop-in gets the very modules the server runs.
- has a file name no built-in module has (a drop-in named `browser.ts` is not loaded). Files that start with `_` or end in `.test.ts` are not modules: use them for helpers and tests. A helper is not reloaded when it changes, even when the module that imports it is: a change to it takes a restart. Keep what you will change often in the module itself.
- starts with a `/** … */` comment whose first sentence says what it does.

## Loading, reloading, and errors

- A drop-in shows in Menu → Extensions as soon as its file is there, off. Turning it on loads it; turning it off uninstalls what it installed, its routes and browser module too.
- Saving a module that is on reloads it about 300 ms later. A tool call already running finishes on the old code; the next one gets the new code. Saving a browser module's file has tabs load its new version ([Browser modules](browser-modules.md)).
- The latest choice and the latest version win. A module turned off, removed, or saved again while it still loads (it may wait at its top level, or in an `async` default export) installs nothing when that load ends, and a failure of that load is not reported. A file that is gone for a moment, as some editors save, is no removal: only one still gone 300 ms later is taken away.
- A load may take 30 s at most (the import, and an `async` default export): one that takes longer fails. At the server's start the modules share those 30 s, and each one after has 2 s, so modules that hang hold up the start by 30 s and 2 s for each module after, not 30 s each. A load that fails so is not stopped: what it started (a timer, a connection) runs on until the server restarts, though nothing it registers counts. Do slow work after it loads.
- A module that fails to load (a syntax error, a throw while building) is reported to the owner: in the Extensions sheet, and in a notice when it failed at the server's start or after an edit. Others see only that it failed, as the error can name the server's folders or quote a provider. An edit that fails keeps the previous version running, its routes and browser module included.
- A restart installs every module that is on again. Work an extension's tasks left pending resumes once it is installed.

You cannot turn a drop-in on yourself: ask the owner to, in Menu → Extensions.
