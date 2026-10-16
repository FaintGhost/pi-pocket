# Limits

Pi Pocket puts limits on what a module can do, so that one module cannot stop the app for everyone. This page lists each limit. The guide in the last column tells what happens at the limit, and why.

When you change a limit in Pi Pocket's code, change it here and in its guide in the same commit.

## Loading

| What                                                              | Limit                                                | Guide                           |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------- |
| Time from a save to the reload                                    | About 300 ms                                         | [Modules](../modules.md)        |
| Time that a file can be gone before Pi Pocket removes its module  | 300 ms                                               | [Modules](../modules.md)        |
| Time to load a module (the import, and an `async` default export) | 30 s                                                 | [Modules](../modules.md)        |
| Time to load the modules when the server starts                   | 30 s for all of them, then 2 s for each module after | [Modules](../modules.md)        |
| Time that a stopping server waits for cleanups                    | 3 s                                                  | [Cleanups](../cleanups.md)      |
| The version of the extension API                                  | 1                                                    | [API versions](api-versions.md) |

## Names

| What                                                        | Limit                                                                                    | Guide                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| The name of a module that adds to the app (its file's)      | Up to 64 letters, digits, `-`, and `_`; it starts with a letter or a digit               | [Names](names.md)                        |
| The `id` of a rail button, menu row, action, page, or sheet | Up to 64 letters, digits, `.`, `_`, `:`, and `-`; it starts with a letter or a digit     | [Browser modules](../browser-modules.md) |
| The name of a command                                       | Up to 64 lowercase letters, digits, `-`, and `_`; it starts with a letter, and has a `-` | [Slash commands](../commands.md)         |
| The name of a drop-in in the gallery                        | 2 to 64 lowercase letters, digits, `-`, and `_`; it starts with a letter or a digit      | [Publishing](../publishing.md)           |

## Routes and the browser module

| What                                                   | Limit                                                      | Guide                                    |
| ------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------- |
| The status of an error that a route throws             | 400 to 599                                                 | [Routes](../routes.md)                   |
| The time that a route can take                         | No limit: it stops when the browser stops waiting          | [Routes](../routes.md)                   |
| The size of one file that a browser module serves      | 8 MB                                                       | [Browser modules](../browser-modules.md) |
| Files that count for a new version of a browser module | The first 2000, in up to 500 folders                       | [Browser modules](../browser-modules.md) |
| Folders that Pi Pocket watches for changes             | The first 64                                               | [Browser modules](../browser-modules.md) |
| Rail buttons that show without a scroll                | 4                                                          | [Browser modules](../browser-modules.md) |
| A rail button's badge                                  | A count above 99 shows "99+"; text is cut to 24 characters | [Browser modules](../browser-modules.md) |
| Notices from a module                                  | 5 in each 5 s                                              | [Browser modules](../browser-modules.md) |
| Calls to `pocket` in one task                          | 1000, over more than 1 s; then the module stops            | [Browser modules](../browser-modules.md) |
| Pages or sheets opened and closed                      | 300 in 1 s; then the module stops                          | [Browser modules](../browser-modules.md) |
| The width of a screen with the swipe back              | Up to 699 px                                               | [Browser modules](../browser-modules.md) |

## Events

| What                                    | Limit                                      | Guide                  |
| --------------------------------------- | ------------------------------------------ | ---------------------- |
| The size of one event's data            | 256 KB of JSON                             | [Events](../events.md) |
| Events that a version of a module sends | 100, and 1 MB, in each second              | [Events](../events.md) |
| A tab that takes nothing for 30 s       | Cut off when it is more than 8 MB behind   | [Events](../events.md) |
| Any tab                                 | Cut off when it is more than 128 MB behind | [Events](../events.md) |

## Commands

| What                                              | Limit                                         | Guide                            |
| ------------------------------------------------- | --------------------------------------------- | -------------------------------- |
| Commands in a module                              | 50                                            | [Slash commands](../commands.md) |
| A command's `description`, and its `args` hint    | 200 characters each                           | [Slash commands](../commands.md) |
| The text after the command's name                 | 4000 characters                               | [Slash commands](../commands.md) |
| The message of a notice that a command gives      | 500 characters                                | [Slash commands](../commands.md) |
| The text of a card that a command gives           | The last 30,000 characters are kept           | [Slash commands](../commands.md) |
| Runs of commands at the same time, for one person | 4                                             | [Slash commands](../commands.md) |
| The time that a command can take                  | No limit: the handler must watch `ctx.signal` | [Slash commands](../commands.md) |

## Linked sessions

| What                                                | Limit                    | Guide                                                    |
| --------------------------------------------------- | ------------------------ | -------------------------------------------------------- |
| Sessions that one session can start                 | 10                       | [Starting and messaging sessions](../linked-sessions.md) |
| Messages in a team, after a person last wrote in it | 20                       | [Starting and messaging sessions](../linked-sessions.md) |
| The length of one message                           | 20,000 characters        | [Starting and messaging sessions](../linked-sessions.md) |
| The title of a session                              | One line, 120 characters | [Starting and messaging sessions](../linked-sessions.md) |
| The time that Pi Pocket keeps a call's `key`        | 30 days                  | [Starting and messaging sessions](../linked-sessions.md) |

## The gallery

| What                                             | Limit                                                        | Guide                          |
| ------------------------------------------------ | ------------------------------------------------------------ | ------------------------------ |
| The size of an index                             | 4 MB                                                         | [Publishing](../publishing.md) |
| Files in an entry                                | 50, of 512 KB each, and 2 MB together                        | [Publishing](../publishing.md) |
| Folders in a drop-in's own folder                | 4 deep                                                       | [Publishing](../publishing.md) |
| How often the gallery looks for revoked versions | 2 times a day, while extensions from the index are installed | [Publishing](../publishing.md) |
