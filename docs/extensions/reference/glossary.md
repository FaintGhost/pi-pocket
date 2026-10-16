# Glossary

These docs use one word for one thing. This page gives each word, and what it means. The code sometimes uses a different word: this page gives that word too.

## Extensions

| Word                    | Meaning                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **module**              | One `.ts` file that Pi Pocket loads. Its default export gets the host and `web`, and returns extensions. Also "extension module".                            |
| **extension**           | What a module returns: a name, with tools, prompt sections, hooks, and tasks (`defineExtension`). One module can return more than one extension.             |
| **drop-in**             | A module in the drop-in folder. It starts off, and only the owner can turn it on.                                                                            |
| **built-in**            | A module in `src/server/extensions/`: a part of Pi Pocket itself.                                                                                            |
| **drop-in folder**      | The `extensions/` folder in the data folder, usually `~/.pi-pocket/extensions/`.                                                                             |
| **data folder**         | Pi Pocket's own folder for its data: `~/.pi-pocket/`, or `PI_POCKET_DIR`. The code calls it `dataDir`.                                                       |
| **version of a module** | What Pi Pocket loads from the file. Each save makes a new version. The new version starts, then the cleanups of the old one run.                             |
| **host**                | The first argument of a module's default export: the services of the app. See [Using the host](../host.md).                                                  |
| **`web`**               | The second argument of a module's default export: what the module adds to the app. See [Adding to the app](../app.md).                                       |
| **`pocket`**            | What a browser module gets from the app: its API in the browser. See [Browser modules](../browser-modules.md).                                               |
| **browser module**      | A `.js` file, or a folder, that the app loads in the tabs of the people it is for. The code calls it the client (`web.client`).                              |
| **route**               | A function on the server that answers requests to `/api/x/<module>/<path>`.                                                                                  |
| **command**             | A slash command, `/name`, that runs on the server when a person types it in the message box. It does not ask Pi.                                             |
| **event**               | A message from a module on the server to its browser module in the tabs (`web.send`, `pocket.on`).                                                           |
| **cleanup**             | A function that runs when a version of a module goes (`web.onDispose`, `pocket.onDispose`).                                                                  |
| **API version**         | The version of the extension API: `web.api`, `pocket.version`, and what a module asks for with `pocketApi`. It is 1 now. It is not the version of Pi Pocket. |
| **release**             | A version of Pi Pocket, for example 0.14.0. "Since 0.14.0" tells the first release that has a member.                                                        |

## Pi and its work

| Word               | Meaning                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **session**        | A conversation with Pi in Pi Pocket, with its folder and its history. The code calls it a conversation (`conversationId`).                      |
| **tool**           | A function that Pi can call. Its name, description, and parameters go to the model with each request.                                           |
| **tool call**      | One call of a tool by Pi, with its arguments and its result.                                                                                    |
| **prompt section** | A part of Pi's system prompt that a module writes. The code calls it a section.                                                                 |
| **hook**           | A function that runs before or after Pi's tool calls and answers, and can stop a call or send Pi on.                                            |
| **task**           | Durable work that Pi Durable runs, and runs again after a restart.                                                                              |
| **document**       | State that Pi Durable keeps in its store. Its **kind** is its name, for example `x.word-count.totals`.                                          |
| **replay**         | A tool call that runs again after a restart. A tool with `replay: "safe"` runs again; other tools tell the model that the call was interrupted. |
| **memo**           | A value kept with a tool call or a hook (`api.memo`). A replay finds it, so the work is not done two times.                                     |
| **Pi Durable**     | The library that Pi Pocket is built on. It defines tools, sections, hooks, tasks, and documents.                                                |

## People and the app

| Word                   | Meaning                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| **owner**              | The person who runs Pi Pocket. Only the owner turns extensions on and off.                              |
| **guest**              | A person the owner invited, who can steer. An invite can be to one session only.                        |
| **viewer**             | A person who can read, chat, and react, but cannot make Pi do anything.                                 |
| **steer**              | Send messages that make Pi work in a session.                                                           |
| **the owner's rights** | All that the owner can do on the machine. A drop-in runs with them.                                     |
| **tab**                | One browser tab or window of the app.                                                                   |
| **rail**               | The column of buttons at the side of the app, or the home screen on a phone.                            |
| **page**               | A view in the place of the conversation, with a title and a close button.                               |
| **sheet**              | A panel that opens over the app, as Menu → Extensions does.                                             |
| **launcher**           | The search box for actions (Ctrl+K or ⌘+K).                                                             |
| **notice**             | A short message at the edge of the app. The code calls it a toast.                                      |
| **card**               | A command's plain text result in the session, for all the people in it.                                 |
| **safe mode**          | A tab that loads no browser modules (`?noext=1`).                                                       |
| **spend limit**        | A limit on what Pi can spend in a session, or for a person.                                             |
| **plan mode**          | A mode in which Pi plans and asks before it changes something.                                          |
| **Lancet Guard**       | The check on risky tool calls. A call that it does not allow waits for a person's **approval**.         |
| **linked session**     | A session that another session started. Sessions in a team send messages to each other by **address**.  |
| **gallery**            | The list of drop-ins that other people wrote, in Menu → Extensions → Find extensions.                   |
| **index**              | The repository that lists the gallery's **entries**. An entry gives one drop-in's files, at one commit. |

## Words that these docs do not use

| Do not use                    | Use                                     |
| ----------------------------- | --------------------------------------- |
| enable, disable               | turn on, turn off                       |
| plugin, add-on                | extension, or module                    |
| chat, thread (for a session)  | session                                 |
| client (for a browser module) | browser module                          |
| toast                         | notice                                  |
| user (for a person)           | person, or the owner, a guest, a viewer |
