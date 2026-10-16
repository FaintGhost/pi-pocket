# Gallery entries and their review

> **Draft for the owner's review.** Items marked **OWNER DECISION** are proposals. They are not rules yet.

The gallery lists drop-ins that other people wrote. Each entry in the index, [TannerMidd/pi-pocket-extensions](https://github.com/TannerMidd/pi-pocket-extensions), points to the files of one drop-in at one commit of a GitHub repository. Three checks stand between an author and an owner:

1. **The index's checks (CI)** check the entry, the files, and that the module loads and declares the truth.
2. **A maintainer** reads all the code at the pinned commit.
3. **Pi Pocket** checks each file's size and SHA-256 when it installs, installs everything off, and never updates by itself ([extensions.md](../extensions.md#the-gallery)).

None of them replaces the owner's own read. SECURITY.md says so too ("The extension gallery").

This page is for the default index. An owner can read another index, with its own rules.

Sources: the index's [README](https://github.com/TannerMidd/pi-pocket-extensions#readme), [CONTRIBUTING](https://github.com/TannerMidd/pi-pocket-extensions/blob/main/CONTRIBUTING.md), `schema/`, and `scripts/validate.ts`; Pi Pocket's `src/server/gallery/entry.ts`. Where they do not agree, `entry.ts` is correct.

## The entry

- **G1. One pull request adds or changes one entry: `entries/<name>.json`.** The file's name is the entry's `name`. Do not edit `index.json`: CI makes it after the merge.\
  _Reason:_ one entry for each review keeps the review small.
- **G2. Give every field.** Only `author.github`, `source.path`, `revoked`, and `declares.commands` are optional. Other fields are not permitted. Each text field is one line, with no spaces at its start or end, and no control, invisible, or direction characters.\
  _Reason:_ Pi Pocket refuses an entry that does not obey these rules.
- **G3. Use a name of your own.** The module's `name` has 2 to 64 characters: `a-z`, `0-9`, `-`, and `_`, and starts with a letter or a digit. It does not start with `pocket-`, and it is not the name of a built-in module. Its extensions and tools obey the rules in [extensions.md](../extensions.md#names). No other entry has the same module, extension, or tool name: the first entry keeps a name.\
  _Reason:_ two modules with one name replace each other.
- **G4. Pin the files.** `source.repo` is a public GitHub repository. `source.commit` is a full commit ID (40 hex characters). `source.path` is at most four folders deep. The files have the names that they have in the drop-in folder: `<name>.ts` (necessary), and `<name>.js`, `<name>.mjs`, or files in `<name>/`. No hidden files, no `node_modules`, no names that end with a dot, no Windows device names (such as `con`), no file with the name of a folder, and no two names that differ only in case.\
  _Reason:_ the code that the owner installs must be the code that the maintainer read.
- **G5. Stay in the limits:** 50 files, 512 KiB for each file, and 2 MiB for all files of an entry. The index has at most 2000 entries and 4 MiB. An entry has at most 50 revoked commits, each with a reason of at most 300 characters.\
  _Reason:_ Pi Pocket reads the index and the files on phones too.
- **G6. Give `pocketApi` and `minPocket`.** `pocketApi` is the extension API that the module needs. `minPocket` is the oldest release that it works with, not a pre-release ([api-stability.md](api-stability.md#minpocket-and-additions)).\
  _Reason:_ Pi Pocket hides an entry that needs a newer API or release.
- **G7. Declare what the module installs, all of it.** `declares` must be the same as what the module installs when it loads.\
  _Reason:_ the owner sees `declares` before the install.
- **G8. Import only the module's own files, Node's built-in modules, and the packages that Pi Pocket has.** A type import from Pi Pocket's files is permitted. Import nothing by its place on a machine, and no code from elsewhere.\
  _Reason:_ the module must work on every machine, with only the reviewed files.
- **G9. Make the description agree with the module's `/** … */` comment.** **Share…** in Pi Pocket makes it from the comment's first paragraph.\
  _Reason:_ the owner sees the same words in the gallery and in the Extensions sheet.
- **G10. Send the pull request from the GitHub account in `author.github`, or from an owner of `source.repo`.**\
  _Reason:_ anyone can type a name in `author`, so the maintainer checks who sent it.

## What CI checks

`scripts/validate.ts` does these checks:

- the entry agrees with the JSON Schema;
- Pi Pocket's own reader (`parseEntry`) accepts it;
- its file's name is `<name>.json`;
- no other entry has the same module, extension, or tool name;
- the files at the pinned commit have the sizes and SHA-256 hashes of the entry (it downloads only over https, and follows at most three redirects on the same host);
- the module loads in a test Pi Pocket with no errors;
- `declares` is the same as what the module installs;
- the index made of all entries is one that Pi Pocket reads, in its limits;
- the entry does not need a newer Pi Pocket than the one CI uses (`POCKET_REF`).

For a pull request, CI downloads and loads only the entries that it changes. On `main`, it checks all entries.

**CI does not do a security review.** It does not look at what the code does, which hosts it contacts, or which files it reads.

## What the maintainer checks

A maintainer reads all the code at the pinned commit before the merge. The pull request must tell:

- what the extension does;
- why it needs each tool, hook, wrap, route, and command;
- each secret and each file outside its own data that it reads, and why;
- each network host that it contacts, what it sends, and when.

The maintainer checks that the code does only what the description says, and the rules in [security-model.md](security-model.md).

### What gets refused

- **G11. Obfuscated or minified code.** This includes packed code; code in strings (base64, hex, or character codes) that is decoded and run; `eval`, `new Function`, or `vm` with text; and generated code without its source and the steps to make it.\
  _Reason:_ the maintainer and the owner must be able to read all of the code.

    > **OWNER DECISION D12:** Code copied from another project (a library). **Proposed:** permitted when it is not minified, keeps its license and credit, and names its project and version. It counts toward the size limits. Minified copies are refused.

- **G12. Network use that the description does not tell.** The description names each host that the module contacts (from the server or the browser), what it sends, and when. The owner's data (sessions, files, settings, sign-ins, and tokens) goes only to the service that it is for.\
  _Reason:_ a drop-in can send anything anywhere, and only the description tells the owner.

    > **OWNER DECISION D13:** The index's CONTRIBUTING permits data sent elsewhere when "the owner can control it". What that means. **Proposed:** the owner's data leaves the machine only after an action of the owner (they open a page, run a command, or press a button), or after a setting that starts off. A request that sends none of the owner's data (for example, a public feed) needs only the description.

- **G13. Reads or writes outside the module's own data that the description does not tell.** The module's own data is its files in the drop-in folder, a folder of its own under the data folder, and its `x.<module>.*` documents. Outside are `config.json`, Pi's sign-ins, other modules' data, other sessions, the person's files outside the session's folder, and environment variables with secrets.\
  _Reason:_ these reads are where a module can take the owner's secrets.
- **G14. Code fetched at run time.** This includes an import from an address, text that is downloaded and run, `npm install` or `npx` at run time, a binary that is downloaded and run, a browser module that tries to load scripts from elsewhere, and a module that updates itself. To run a program that is already on the machine (such as `git` or `gh`) is permitted when the description says so.\
  _Reason:_ the reviewed commit must be all of the code that runs.
- **G15. A misleading entry.** This includes a description that does not tell what the code does; a hook or wrap that the description does not explain; a name or title that copies a built-in or another entry, or says it is official; `readOnlyHint` on a tool that changes something; and a tool description that tells Pi to do more than the tool's work ("always call this tool first").\
  _Reason:_ the owner decides by what the entry says.
- **G16. Copied work without its license.** Code from another project keeps its license and its credit. A fork of another entry credits it and has a name of its own.\
  _Reason:_ authors keep the rights to their work, and the index must not take them.

    > **OWNER DECISION D14:** Must the source repository have a license? **Proposed:** yes, an OSI-approved license, in a `LICENSE` file at the pinned commit.

- **G17. A way around Pi Pocket's protections.** This includes a tool that runs commands or writes files that the model chose; a hook that answers, skips, or turns off Lancet Guard or approvals; a change to another module's tools or sections that is not declared in `wraps` and explained; a change to core's objects at run time; and the owner's token used to call the app's API.\
  _Reason:_ these remove the checks that the owner relies on ([security-model.md](security-model.md#s8-what-lancet-guard-does-not-see)).
- **G18. Use of internal interfaces.** This includes the `host` members for built-in extensions, and Pi Pocket's internal files at run time ([api-stability.md](api-stability.md#what-is-internal)).\
  _Reason:_ they can change in any release, and the entry then breaks for every owner.

    > **OWNER DECISION D15:** Is G18 a reason to refuse? **Proposed:** yes. An author who needs an internal member asks for an extension point first ([core-or-extension.md](core-or-extension.md#ask-for-a-new-extension-point)).

- **G19. Telemetry or analytics.**\
  _Reason:_ an owner who installs a tool does not expect it to report on them.

    > **OWNER DECISION D16:** **Proposed:** refuse all telemetry that is on by default. Permit it only when it starts off, the description tells what it sends and to whom, and the owner turns it on.

- **G20. Secrets in places that others see.** This includes secrets in prompt sections, tool descriptions, tool results, cards, events for everyone, `web.error` messages, and notices ([security-model.md](security-model.md#s6-secrets)).\
  _Reason:_ they leave the server, to the model provider or to other people.

### What gets changes asked for

The maintainer asks for a change, and refuses the entry when it does not come:

- the module breaks a rule in [Rules that are easy to break](../extensions.md#rules-that-are-easy-to-break): it does an action twice on a replay, keeps state in variables, blocks the server, or does not name its stored data;
- text from outside goes to Pi without a fence (`host.text`);
- an experimental member is used, and the description does not say so.

### The decision

- One maintainer reads the code and decides. The index promises no time for a review.
- A maintainer can close a pull request. They do not always give a reason (the index's CONTRIBUTING).

> **OWNER DECISION D17:** Do maintainers name the rule when they refuse? **Proposed:** yes, they name the rule (for example, G14), except for code that is malicious.

## Updates

- **G21. An update is a pull request that changes `source.commit`, `version`, the files' sizes and hashes, and `declares` when it changes.** **Share…** gives these values.\
  _Reason:_ each new commit needs its own review.
- **G22. Only the author sends updates** (G10), or another person with the author's agreement in the pull request.\
  _Reason:_ someone else could point the entry at their own code.
- **G23. Tell, in the pull request, what the update adds:** new hosts, new secrets or files that it reads, wider `access`, and new hooks, wraps, tools, routes, or commands.\
  _Reason:_ these change what the owner agreed to.
- **G24. An update that moves the entry to another repository, or to another author, says why.** Pi Pocket shows the change of repository in its update view.\
  _Reason:_ a change of hands is a common way to put bad code into a trusted extension.
- Pi Pocket never applies an update by itself. Each owner sees the diff and chooses.

> **OWNER DECISION D18:** How much of an update the maintainer reads. **Proposed:** the diff from the commit before. All of the code again when the update widens what the module does (G23), or changes its repository or author (G24).

## Abandoned entries

An entry is abandoned when it has a problem, the maintainers open an issue about it, and its author does not answer in the notice period. A problem is a bug, a failure of the full check with the Pi Pocket that the index uses, or the use of a member that is removed. A security problem does not wait: see [Revoke, withdraw, and remove](#revoke-withdraw-and-remove).

1. The maintainer opens an issue in the index and mentions `author.github`. When possible, they also open an issue in `source.repo`.
2. After the notice period, the maintainer withdraws the entry, with the reason "Unmaintained: <the problem>".
3. Another author can publish a fork as a new entry, with a name of its own and credit to the first author. They get the old name only with the first author's agreement.

When a new Pi Pocket release breaks entries, the maintainers open an issue for each one. They move `POCKET_REF` when the entries pass, or at the end of the notice period, after they withdraw the entries that still fail.

> **OWNER DECISION D19:** The notice period, and who gets an abandoned name. **Proposed:** 30 days. The name goes to another author only with the first author's agreement.

Note: today, `scripts/validate.ts` downloads and loads withdrawn entries too. A withdrawn entry that does not load then stops the checks on `main`. For step 2 to work, the checks must not load an entry whose `source.commit` is revoked.

## Revoke, withdraw, and remove

- **G25. Revoke a commit that has a security problem or a bad bug.** Add it to `revoked`, with a short reason (the index's README, "Revoke a version"). If there is a good commit, point `source` to it, and Pi Pocket offers it as an update. Pi Pocket warns each owner who has the revoked commit, and tells them to turn it off when it is on.\
  _Reason:_ the owners who installed it must learn of the problem.
- **G26. Do not wait for the author when owners are at risk.** Revoke first. For a mistake that is not malicious, tell the author in private, and keep the public reason general until a fix is out.\
  _Reason:_ each day of waiting is a day of risk for each owner who has it.
- **G27. Withdraw an entry that has no good commit:** put its `source.commit` in `revoked` too. Pi Pocket then does not show it in search, and does not install it.\
  _Reason:_ a withdrawn entry still warns the owners who have it.
- **G28. Do not delete an entry that has revoked commits.**\
  _Reason:_ when the entry is gone, Pi Pocket cannot warn about its revoked commits.
- **G29. For malicious code, revoke all of the entry's commits at once, and withdraw it.**\
  _Reason:_ no version of it is safe.

> **OWNER DECISION D20:** An author asks to remove their entry. **Proposed:** the maintainers delete it when it has no revoked commits, and keep its names for that author. They refuse a new entry with those names from someone else. Installed copies keep their files, with no more updates.

> **OWNER DECISION D21:** An author who published malicious code. **Proposed:** the maintainers refuse all their future entries.
