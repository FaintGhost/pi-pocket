# Making it built in

A built-in extension is part of Pi Pocket itself, for everyone who uses this copy.

A new file in `src/server/extensions/` is loaded into the running server about 300 ms after it is first saved, on, for everyone: there is no way to try it there first. So write it as a drop-in, check it on a copy ([self-editing.md](../self-editing.md#check-it-on-a-copy)), and move it in when it works.

Then, in `src/server/reload.ts`, give it its place in `ORDER` and its title in `TITLES` (and `OFF_BY_DEFAULT` if it should start off), and add its tools' names to `BUILT_IN_TOOLS`, so no drop-in takes them (`test/dropins.test.ts` fails until you do). Name the extension `pocket-…`. `reload.ts` is not an extension: these take effect at the next restart. `test/app.test.ts` asserts the order.
