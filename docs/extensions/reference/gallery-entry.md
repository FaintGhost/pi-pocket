# Gallery entry

The extension gallery's index, read strictly: everything in it comes from elsewhere. An index is one JSON file (the index repository's generated `index.json`): its format, and an entry for each extension, which names the files of one drop-in at a pinned commit of a GitHub repository, with each file's SHA-256, and what the module installs.

Pi Pocket reads it here, and the index repository's checks use these same functions, so an entry they let in is one Pi Pocket reads (they import this file from a Pi Pocket checkout, the loader's lists of reserved names with it). Text is kept to one plain line (no control, invisible, or direction characters), names to the drop-in folder's rules, and sizes to `LIMITS`.

## The index

- `format`: The index format this Pi Pocket reads.
- `name`
- `repo`: The index's repository on GitHub, where entries are submitted.
- `extensions`

## An entry

- `name`: The module's name: its file is `<name>.ts`.
- `title`
- `description`
- `tags`
- `author`: `{ name: string; github?: string }`
- `version`: The author's version, for people: the commit is what counts.
- `source`: A GitHub repository (`owner/name`), the commit the files are pinned to, and the folder in it they are in.
- `files`: each `{ name, sha256, size }`. `name`: Where it goes in the drop-in folder, and where it is in the repository (under `source.path`).
- `pocketApi`: The extension API version it needs (`POCKET_API`).
- `minPocket`: The oldest Pi Pocket it works with: `0.14.0`.
- `declares`
- `revoked`: Commits of it that must not be used: Pi Pocket warns where one is installed.

## What an entry declares

| Field                        | What                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions`                 | The names of the extensions it installs                                                                                                                                                                  |
| `tools`, `readOnlyTools`     | Its tools, and those of them with `readOnlyHint` (plan mode lets them run)                                                                                                                               |
| `hooks`                      | Its hooks' handlers: `beforeTool`, `onYield`, …                                                                                                                                                          |
| `sections`                   | Its prompt sections                                                                                                                                                                                      |
| `wraps`                      | The tools and sections it wraps: `tool bash`, `section memory`                                                                                                                                           |
| `routes`, `client`, `access` | Its routes (`GET status`), who loads its browser module (or `null`), and the widest access of the two (`owner` when it adds nothing to the app)                                                          |
| `commands`                   | Its slash commands, each with its scope, as a route has its method: `conversation clock-zone`, `global clock-reset`. Left out when it has none: a Pi Pocket before 0.14.0 does not read an entry with it |

These are what Menu → Extensions shows for a module that is on, and the index's checks load the module in a test app and compare.
