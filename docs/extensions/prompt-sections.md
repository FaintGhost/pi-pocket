# Prompt sections

A prompt section is a part of Pi's system prompt that your module writes.

`section(name, render, { tag })`: `render(input, context)` returns text, or `undefined` to leave the section out. By default it is wrapped in `<name>…</name>`; `{ tag: false }` leaves it bare.

Sections render before every request, and only those that changed are sent again. Return the same text while nothing changed: the date, not the time; no counters. `input.conversationId` and `input.read.snapshot(Doc, input.conversationId, context)` let a section depend on the session.
