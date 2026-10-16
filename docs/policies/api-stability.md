# The public API and how it changes

> **Draft for the owner's review.** Items marked **OWNER DECISION** are proposals. They are not rules yet.

This page tells which interfaces of Pi Pocket are for extensions, what Pi Pocket promises about them, and how they change. [extensions.md](../extensions.md) tells how each interface works. This page does not repeat it.

## Terms

- **Public:** an interface in the list below. Pi Pocket keeps it, or changes it only by the rules on this page.
- **Internal:** all other code and data. It can change in any release, with no notice.
- **Stable:** public, and not experimental or deprecated. All public interfaces are stable unless the docs mark them.
- **Experimental:** public, but it can change or go in any minor release.
- **Deprecated:** public, but it will go. A replacement is available.
- **Breaking change:** a change after which a module that obeys the docs can fail, or work differently.
- **Addition:** a change after which every such module works as before.

## What is public

Each item below is public as [extensions.md](../extensions.md) describes it: its names, its shapes, its behavior, and the limits that the docs give.

### 1. The module

- A `.ts` file in the drop-in folder (`extensions/` in the data folder), with the `node_modules` link to Pi Pocket's packages.
- The default export `(host, web)`. It can be `async`. It returns one extension, a list, or nothing. Pi Pocket installs all of it or none of it.
- `export const pocketApi`.
- The first sentence of the module's `/** … */` comment, which is its description.
- Files that start with `_` or end in `.test.ts` are not modules.
- Loading, reloading, and errors ([extensions.md](../extensions.md#loading-reloading-and-errors)), with the times there: 300 ms, 30 s, and 2 s.
- These types from `src/server/host.ts`: `PocketHost` (only its public members, below), `ExtensionWeb`, `ExtensionModule`, `ExtensionCommand`, `CommandContext`, `CommandResult`, `WebRequest`, `WebHandler`, `WebAccess`, `WebMethod`, `LinkedSessionsApi`, and `LinkedSession`. The types are public. The path of the file is not: import them with `import type`, which goes away at run time.

### 2. Names

- The names that Pi Pocket keeps for itself ([extensions.md](../extensions.md#names)): extension names that start with `pocket-`, the extension name `coding-tools`, the names of built-in modules, and the names of built-in tools.
- The rules for the names of modules, tools, commands, routes, and the IDs of what a browser module adds.
- The paths of a module's routes, `/api/x/<module>/`, and of its browser files, `/x/<module>/`.
- **Promises:** the names of Pi Pocket's own extensions start with `pocket-` (or are `coding-tools`). Its own commands never have a `-`. Its own document kinds and task names never start with `x.`.

### 3. `host`

These members are public:

- `dataDir`, `agentDir`
- `notice(level, message, id?)`
- `resolveModel(spec)`, `subagentModels()`, `modelProblem(ref, fresh?)`
- `requesterOf(conversationId)`
- `skillPaths()`, `skills(cwd)`
- `heldBack(conversationId)`, `onLimitsChanged(listener)`
- `linkedSessions`: `start`, `send`, `list`
- `text`: `quoted`, `defang`
- `thinkingLevels`

These members are on `host` for Pi Pocket's own built-in extensions: `guard`, `approvals`, `schedules`, `goals`, `browsers`, `memory`, `watches`, `repoWatches`, `gallery`, `pip`, and `pipCompaction`. They are **internal**. A drop-in can read them, but their shapes can change in any release.

> **OWNER DECISION D3:** Which `host` members are public. **Proposed:** the fourteen above. The eleven for built-in extensions stay internal. A member moves to the public list only through an extension point request ([core-or-extension.md](core-or-extension.md#ask-for-a-new-extension-point)). `approvals` (to ask a person before an action) is the most likely first request.

The host is the same object while modules reload. A new member comes only after a restart, so a module that uses a new member must check that it is there ([extensions.md](../extensions.md#the-host)).

### 4. `web`

- `api`, `module`, `route`, `client`, `command`, `send`, `error`, and `onDispose`.
- What a route handler gets (`WebRequest`: `method`, `params`, `query`, `body`, `user`, `signal`), and what its answer does.
- The route paths, the methods, the `access` values (`owner`, `steer`, `view`), and the `X-Pocket` header that every call to a route must have.

### 5. A command's `ctx` and result

- `ctx`: `user`, `conversationId`, `cwd`, `signal`, `snapshot`, `context`, and `commit`.
- The results `{ type: "toast", level, message }` and `{ type: "card", output }`.
- The scopes `conversation` and `global`, and who may run each.

### 6. `pocket`

- `version`, `module`, `title`.
- `h`, `html`, `Fragment`, and the hooks: `useState`, `useEffect`, `useLayoutEffect`, `useRef`, `useMemo`, `useCallback`, and `useReducer`.
- The pieces `Icon`, `Loader`, `Spinner`, `Markdown`, and `Switch`, with the props that extensions.md gives.
- `api`, `on`, `rail`, `menu`, `launcher`, `page`, `sheet`, `toolCall`, `openPage`, `closePage`, `openSheet`, `closeSheet`, `notify`, `me`, `conversationId`, `style`, and `onDispose`.
- What a page's or a sheet's component gets: `pocket`, `close`, and a sheet's `props`.
- The icon names that extensions.md lists. Other icon names can go. An unknown name shows `grid`, so a module does not fail.
- Safe mode: `?noext=1` and `?noext=0` on the app's address.

### 7. CSS

- The variables `--text`, `--muted`, `--accent`, `--bg`, `--card`, `--line`, `--err`, `--warn`, and `--ok`. They follow the theme.
- The classes `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting`.
- All other CSS is internal: other classes, other variables, the structure of the page, and the IDs of its elements. The planned themes can add to this list.

### 8. Events

- `web.send(event, data, { to })` on the server and `pocket.on(event, run)` in the browser, with their limits.
- A module's events are its own. An event goes only to the browser module of the module that sent it. Pi Pocket does not keep any event name for itself, and it reads none of them.
- The app's own events between the server and its tabs (`hello`, `view`, `chat`, `ext`, and the others) are internal.

### 9. Names for stored data

- Name a document kind, a task, and an entry kind after the module: `x.<module>.<name>`, as `x.word-count.totals`. Core uses `pocket.` and never `x.`.
- After people have used a name, do not change it, and do not change what its fields mean. Add new fields next to them.
- In the browser, use storage keys that start with `x.<module>.`. Core's keys start with `pocket.`.

> **OWNER DECISION D4:** The rule for browser storage keys is new. extensions.md does not have it yet. **Proposed:** add it to extensions.md, and promise that core never uses `x.` keys.

### 10. The gallery entry format

- Index format 1, and the fields of an entry, as the index's [README](https://github.com/TannerMidd/pi-pocket-extensions#an-entry) gives them. Where the README and `src/server/gallery/entry.ts` do not agree, `entry.ts` is correct.
- Pi Pocket refuses an entry with a field that it does not know. So an entry can use a new field only when its `minPocket` is a release that reads that field. Tools that make entries (**Share…**) leave a new field out when it is empty, as they do with `declares.commands`.
- A change to the meaning of a field, or a new field that is necessary, needs a new index format. Pi Pocket reads only its own format.
- The `<name>.gallery.json` file next to an installed drop-in, the gallery's routes, and its screens are internal.

## What is internal

- All files under `src/` and `web/`, and what they export, except the types in [The module](#1-the-module).
- The app's HTTP API, other than a module's own routes under `/api/x/<module>/`.
- The events between the server and its tabs, and the `pocket.*` keys in browser storage.
- Pi Pocket's document kinds (`pocket.*`), and the shapes of its documents, entries, and tasks. A module can read them with `api.snapshot`, but their fields can change.
- `config.json`, `pocket.sqlite`, and the rest of the data folder, except `extensions/`.
- All CSS that is not in [CSS](#7-css).
- The words of errors, notices, logs, and the system prompt.
- The tools of built-in extensions: their arguments and results. Only their names are public, as reserved names.
- The `host` members for built-in extensions ([host](#3-host)).
- The test helpers in `test/`. The index's checks use them, and pin the Pi Pocket version they use.

## Packages from Earendil

Extensions import `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and the other packages that Pi Pocket has. Earendil makes them, not Pi Pocket. Pi Durable is experimental, and its API can change between its releases. Pi Pocket pins their versions in `package.json`, and a drop-in gets the same versions through the `node_modules` link.

- **A1. The release notes name each update of a pinned package** in "For extension authors".\
  _Reason:_ an author can then find the cause when a module breaks after an update.
- **A2. When an update breaks a use that extensions.md documents** (`defineTool`, `section`, `hook`, `api.memo`, `api.snapshot`, `wrapTool`, and the others), the notes tell what changed and how to change a module.\
  _Reason:_ authors learn these uses from Pi Pocket's docs, so Pi Pocket must tell them when they change.

> **OWNER DECISION D5:** Does such an update raise `pocketApi`? **Proposed:** yes, when it breaks a use that extensions.md documents. Authors then check one number for all that a module uses.

## Stability levels

### Stable

All public interfaces are stable, unless the docs mark them experimental or deprecated.

### Experimental

- **A3. The docs mark an experimental member.** extensions.md writes "**Experimental.**" at the member. In `host.ts`, its comment has `@experimental`.\
  _Reason:_ authors must know before they use it.
- **A4. An experimental member can change or go in any minor release, with no deprecation.** The release notes say so.\
  _Reason:_ a new interface must be able to change while its first users find its problems.
- **A5. An experimental member becomes stable when the release notes say so.**\
  _Reason:_ the change of status is then easy to find.
- **A6. A gallery entry that uses an experimental member should say so in its description.**\
  _Reason:_ the owner then knows that an update of Pi Pocket can break it.

> **OWNER DECISION D6:** Which members are experimental in 0.14. **Proposed:** only `host.linkedSessions`, through all 0.14 releases. It changed a lot in the betas, and Agent Teams is its only user. It becomes stable in 0.15 if it does not have to change. All other public members of 0.14 are stable.

### Deprecated

See [Deprecation](#deprecation).

## Version rules

### `pocketApi`

- `POCKET_API` is one number for the whole public API, on the server and in the browser. `web.api` and `pocket.version` give it. It is 1 from Pi Pocket 0.14.0.
- **A7. `pocketApi` goes up by one in a release that has a breaking change to a stable member.** A release with many breaking changes adds one.\
  _Reason:_ one number tells if a module can work, with no need to compare release numbers.
- **A8. Additions do not change `pocketApi`. Changes to experimental members do not change it.**\
  _Reason:_ a number that moves for each addition says nothing about breaks.
- A module's `pocketApi` export is the API version that the module was written for. Pi Pocket does not load a module that needs a newer API. It says so in the Extensions sheet. A gallery entry's `pocketApi` is the same number. The gallery hides an entry that needs a newer API.
- Pi Pocket now loads a module that was written for an older API. [Implementation notes](#implementation-notes) propose an oldest version.

> **OWNER DECISION D7:** How long Pi Pocket supports modules that were written for the previous `pocketApi`. **Proposed:** for at least the deprecation period ([Minimum time](#minimum-time)). After that, Pi Pocket refuses them with a clear error. A module with no `pocketApi` export counts as version 1.

### `minPocket` and additions

- **A9. A module that uses an addition checks for it at run time,** as `typeof web.command === "function"`. In the gallery, it also sets `minPocket` to the release that added it.\
  _Reason:_ the server's part changes only after a restart, so a running server can have an older `host` and `web` than its files.
- **A10. `minPocket` names a release, such as `0.15.0`, not a pre-release.** Pi Pocket counts `0.15.0-beta.2` as `0.15.0`.\
  _Reason:_ a beta can change before the release, and an entry for a beta can break on the release.

### Breaking changes

These are breaking changes when they touch a stable member:

- remove or rename a member, a field, an option, an `access` value, or a CSS name;
- change the type or the meaning of a parameter, a field, or a result;
- make an optional parameter or field necessary;
- accept less than before: a stricter check, a lower limit, or a shorter time limit;
- give a module less than before: fewer fields, or a narrower `access`;
- change a default, such as the `owner` default of `access`;
- change when Pi Pocket calls a module's code, where the docs say when;
- change a naming rule for stored data, or the paths of routes;
- change the gallery entry format so that Pi Pocket refuses a valid entry.

### Additions

- a new member, option, field, icon, or CSS name;
- a higher limit, or a longer time limit;
- a new optional field in the gallery entry, used with `minPocket` ([The gallery entry format](#10-the-gallery-entry-format));
- a fix that makes the behavior agree with the docs.

### Not covered

These can change in any release: the words of errors and notices, timing that the docs do not give, speed, the look of the app beyond the CSS names, and all that is internal.

### Reserved names

- **A11. Pi Pocket can keep a new name for itself in any minor release:** a module, an extension, a tool, or a command. The release notes list it.\
  _Reason:_ new built-in features need names. A module with its own prefix ([extensions.md](../extensions.md#names)) never meets them.
- When a new reserved name is the name of a drop-in, Pi Pocket refuses the drop-in, and the Extensions sheet says why. For example, 0.14 keeps the tool `team` and the module `agent-teams`.

### Security fixes

> **OWNER DECISION D8:** A security fix can change or remove a stable member with no deprecation period, in any release, a patch included. The release notes say so under "Security". **Proposed:** yes. Pi Pocket keeps the change as small as the fix permits.

### Pi Pocket's version and `pocketApi`

- Pi Pocket's version is `0.Y.Z` before 1.0. `Y` is the minor release. `Z` is the patch.
- **A12. A patch release (`0.14.1`) has fixes only.** It has no breaking changes to stable members and no new deprecations.\
  _Reason:_ an owner must be able to take a patch with no risk to their extensions.
- **A13. A minor release (`0.15.0`) can add, deprecate, and change experimental members.** It can remove a deprecated member after its minimum time. Then `pocketApi` goes up.\
  _Reason:_ authors then read the notes of minor releases only, to know what changes.
- **A14. Pre-releases (`0.15.0-beta.1`) have no promise.** Members can change from one beta to the next.\
  _Reason:_ betas are for tests of new interfaces before they become stable.
- The two numbers move apart. Many releases of Pi Pocket can have `pocketApi` 1. `pocketApi` tells if a module can work. `minPocket` tells from which release.

> **OWNER DECISION D9:** Can patch releases add public members? **Proposed:** no. Additions come in minor releases. Then each `minPocket` is a `.0` release, and the gallery's checks need only one Pi Pocket per minor release.

### Before 1.0

- Pi Pocket is young. Its public API is small, and it will grow.
- The rules on this page are in force before 1.0. They can change in a minor release. A change that gives authors less is told as a breaking change is.
- Pi Durable is experimental (see Limitations in the [README](../../README.md#limitations)).
- At 1.0, Pi Pocket plans to follow semantic versioning: breaking changes only in a major release. This page will say so then.

## Deprecation

### How a member is deprecated

1. The replacement ships first, or in the same release. If the feature goes with no replacement, the notes say so.
2. extensions.md marks the member: "**Deprecated in 0.15.0.** Use `web.example`. It goes in 0.17.0 or later, and not before 2027-02-01."
3. In `host.ts`, the member's comment gets `@deprecated` with the same words. Editors then show it.
4. The Extensions sheet shows a warning on the row of each module that uses it ([Implementation notes](#implementation-notes)).
5. The release notes list it under "Deprecated", in "For extension authors".

### Minimum time

> **OWNER DECISION D10:** The minimum time from the first stable release that deprecates a member to the release that removes it. **Proposed:** at least one minor release and at least 90 days. The later of the two applies. Experimental members have no minimum (A4). Security fixes have none (D8).

### Removal

- **A15. A deprecated member goes only in a minor release, after its minimum time.** That release raises `pocketApi` by one.\
  _Reason:_ authors then know when to look, and one number shows the break.
- The release notes list it under "Removed", with what to use instead.

## Release notes: "For extension authors"

- **A16. The notes of each release have a section "For extension authors".** The 0.14 betas already have it. It uses these headings, in this order, with one line and a link for each item:
    - **Added**
    - **Changed:** changes to experimental members, and fixes that authors can see.
    - **Deprecated:** each with its replacement and its earliest removal.
    - **Removed:** and the new `pocketApi`.
    - **Reserved names**
    - **Security:** changes with no deprecation period (D8).
    - **Packages:** updates of the pinned packages from Earendil (A1).

    When nothing changed, the section says "No changes."\
    _Reason:_ authors read one place, and "No changes" is also information.

## Implementation notes

A proposal for warnings at run time, not yet built.

1. **One table for each side.** `src/server/deprecations.ts` lists the deprecated `host` and `web` members: `{ member, since, removal, replacement }`. `web/extension-ui.js` lists the deprecated `pocket` members in the same shape. Each side has only its own members, so nothing is copied.
2. **`host`: one view for each module.** The loader gives each module `Object.create(host)`, with a getter for each deprecated member only. The getter records the module and the member, then gives the real value. The view is made once for each module file, so the host stays the same object while the module reloads. Members that are not deprecated cost nothing. Before this, make sure that no `host` member uses `this`.
3. **`web`: in its own object.** `ExtensionWebs` already makes a `web` for each version of a module. Wrap the deprecated members there, and record their first use.
4. **What the owner sees.** `ExtensionInfo` gets `deprecated?: { member, removal, replacement }[]`. The Extensions sheet shows one line for each member on the module's row: "Uses web.example, which goes in 0.17.0. Use web.other." The server log gets one line for each module version and member. There is no notice, so the warning does not become noise.
5. **The browser.** `pocket` is made for each module in `web/extension-ui.js`. Add getters for the deprecated keys. The first use logs one `console.warn`, and adds the member to the module's "In this browser" line in the Extensions sheet, as a failure does now.
6. **Limits.** A getter sees a use only when the code runs, so a use in a rare path shows late. A text search of the module for the member's name can give an early hint in **Share…** and in the index's checks. It is a hint only: a common name gives false matches.
7. **The index's checks.** After the load test, `scripts/validate.ts` can read `deprecated` from `app.extensions(owner)` and print a warning, not a failure. The maintainers can then ask the author to update.
8. **The oldest API (D7).** Add `POCKET_API_OLDEST` next to `POCKET_API`, on the server and in the browser. Refuse a module whose `pocketApi` is lower, with the error "written for version N of the extension API, which this Pi Pocket no longer supports: update the module". While two versions are supported, Pi Pocket can keep a removed member for modules that declare the old version, when that is easy. The gallery's `compatibility()` gives `"older"` for an entry below the oldest, and the list hides it and counts it, as it does with newer entries.
9. **One test.** A drop-in that reads a deprecated `host` member shows it in `app.extensions(owner)`.
