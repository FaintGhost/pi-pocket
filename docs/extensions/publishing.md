# Publishing to the gallery

The gallery lists drop-ins that other people wrote. This page tells how it installs them, and how to share yours.

## How the gallery works

Menu → Extensions → **Find extensions** (or **Find extensions** in the launcher) lists drop-ins other people wrote, from an index of reviewed entries: by default the repository [TannerMidd/pi-pocket-extensions](https://github.com/TannerMidd/pi-pocket-extensions), whose `index.json` lists them. The owner can read another index instead, at the bottom of that list: a GitHub repository as `owner/name`, or the https address of an `index.json`. It is the built-in Extension gallery (`gallery.ts`, the extension `pocket-gallery`), the owner's alone; turned off, it reads nothing.

Each entry names one drop-in's files at a pinned commit of a GitHub repository, with the size and SHA-256 of each, and what the module installs (below). Nothing in it is trusted, so Pi Pocket:

- reads it strictly (`src/server/gallery/entry.ts`): every field checked, one plain line of text each (no control, invisible, or direction characters), names in the drop-in folder's rules, sizes in bounds (4 MB of index, 50 files of 512 KB each and 2 MB together). An entry it cannot read is left out, and one for a newer Pi Pocket or extension API is hidden; the list says how many. It draws everything as text, and links only to the GitHub addresses it builds.
- downloads files only over https, from the entry's repository on `raw.githubusercontent.com` at the pinned commit. A file whose size or SHA-256 differs from the entry's installs nothing at all.
- installs it **off**, as every drop-in starts, even under a name that was on before. Only the owner turns it on.
- keeps where it came from beside it, in `<name>.gallery.json` in the drop-in folder: the entry as installed. Updates and removal go by it, so **Uninstall** removes its files and nothing else, and the gallery says which of them were edited since.
- puts a version in place all or none: what it replaces is kept aside until every file is in place, and when that fails, or the server stops in the middle, the version before comes back (at the next start, before extensions load).
- never updates by itself. When the index pins a newer commit, the gallery and the Extensions sheet say **update available**; the update shows what changes in what it declares and a diff of every file, and the owner applies it. One that is on stays on, and its new module loads at once; other code files it imports load at the next restart, which the gallery then asks for.
- warns about revoked versions. The index can revoke a commit of an extension; where that commit is installed, the gallery and the Extensions sheet say so with the reason, and offer to turn it off. Looking again twice a day while extensions from the index are installed, the gallery tells the owner in a notice when a revoked one is on. An entry whose own commit is revoked is withdrawn: it is not offered, and not installed.

Before turning one on, read it: the gallery shows every file, and what its entry declares. **Ask Pi to review** starts a session in the drop-in folder, in plan mode (it is not sent while Plan mode is off in Extensions), that asks Pi to audit the code: what it reads and writes (`config.json`, Pi's sign-ins, other secrets), its network calls, the processes it starts, what its browser module does, and whether it does what it declares. It is a session like any other: people who see every session see it too. The index's checks are no security review either: they check the entry and that the module loads; a maintainer reads the code before an entry goes in.

## Sharing yours

An entry's files are its drop-in's own, named after its module, so they never meet another's:

- `<name>.ts`, the module. `<name>` is 2 to 64 lowercase letters, digits, `-`, and `_`, starting with a letter or digit, and is neither a built-in module's name nor starts with `pocket-`; its extensions and tools keep the [names rules](reference/names.md).
- `<name>.js` or `<name>.mjs` beside it, or the folder `<name>/`, for its browser module (`web.client("<name>.js")`, or `web.client("<name>")`). Helpers go in that folder too (`import { zones } from "./<name>/zones.ts"`): the folder serves no `.ts` files. Four folders deep at most, with no hidden files and no `node_modules`.
- It imports only those, Node's own modules, and the packages Pi Pocket has (`@earendil-works/pi-durable`, `@earendil-works/pi-ai`, …): nothing by its place on this machine, and no code from elsewhere. A type import (`import type … from "/path/to/pi-pocket/src/server/host.ts"`) is fine: it is gone when the module runs.
- Its `/** … */` comment's first paragraph is the entry's description.

To publish it:

1. Put its files in a public GitHub repository with the same names as in your extensions folder, at its top or in a folder of it, and commit them.
2. In Menu → Extensions, tap **Share…** on your drop-in. It checks that the drop-in stands on its own, and drafts its entry: the description from its comment, each file's size and SHA-256, and, while it is on, what it declares. Pi Pocket makes no GitHub calls for this.
3. Fill in what only you know: the repository (`owner/name`), the full ID of the commit with these files, the folder (if not the top), tags, and your GitHub name. **Open a pull request** opens once they would pass the index's checks: it opens GitHub's new-file page in the index repository with the entry filled in, as `entries/<name>.json`. The index's [CONTRIBUTING](https://github.com/TannerMidd/pi-pocket-extensions/blob/main/CONTRIBUTING.md) says the rest.
4. To update it, commit the new files, and send a pull request that changes `source.commit`, `version`, and the files' hashes (**Share…** again gives them). People who have it see the update, with its diff, and choose whether to apply it.
