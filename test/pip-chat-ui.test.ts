// PiP's own file composer and the owner's all-project memory queue, in an isolated real browser.
// These tests never select a real provider or use the running server's people, data, or browser profile.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { MemoryDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const BOX = ".pip-composer textarea";
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const requests: { text: string; images: { data: string; mimeType: string }[] }[] = [];
let replyImage = "";
let heldReply: Promise<void> | undefined;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let pip: ConversationId;
let background: ConversationId;
let other: ConversationId;
const project = join(work, "project-alpha");
const elsewhere = join(work, "project-beta");

type Call = {
    url: string;
    body?: {
        text?: string;
        forget?: boolean;
        attachments?: { path: string; name: string; mime: string; size: number }[];
    };
};
const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (condition: string, what: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(Boolean(${condition}))`), what, 20_000);
const value = () =>
    inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}).value)`);
const names = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.pip-attachment-name')].map((each) => each.textContent))`,
    );
const calls = () => inPage<Call[]>(`return JSON.stringify(window.pipTestCalls)`);
const submissions = async () => (await calls()).filter((call) => call.url.endsWith("/submit"));
const settle = () =>
    page.evaluate(`
    await Promise.all(document.getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
    for (let frame = 0; frame < 3; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }
`);

async function tap(selector: string): Promise<void> {
    await settle();
    // back.js deliberately ignores a second pointer tap just after a route/layer transition.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await page.click({ selector });
    await settle();
}

async function text(words: string): Promise<void> {
    await page.evaluate(`
        const box = document.querySelector(${JSON.stringify(BOX)});
        box.value = ${JSON.stringify(words)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await until(async () => (await value()) === words, "PiP draft changed");
}

async function open(): Promise<void> {
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await see(
        `document.querySelector('.pip-panel:not(.leaving)') !== null &&
        (await import('/store.js')).store.state.pipView.conversation?.id === ${Number(pip)}`,
        "PiP's own live view",
    );
    await settle();
}

async function close(): Promise<void> {
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await see(`document.querySelector('.pip-panel') === null`, "PiP closed");
}

async function fresh(viewport: Viewport = VIEWPORTS.desktop, home = false): Promise<void> {
    if (
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}) !== null)`,
        )
    ) {
        await page.evaluate(
            `document.querySelectorAll('.pip-attachment-remove').forEach((button) => button.click())`,
        );
        await text("");
    }

    await page.evaluate(`
        (await import('/store.js')).closeSheet();
        (await import('/pip.js')).closePip();
        localStorage.removeItem('pocket.pip.draft');
    `);
    await settle();
    await page.setViewport(viewport);
    // Reload after a touch/desktop change so the composer reads the right media queries.
    await page.navigate(`${base}/${home ? "" : `s/${background}`}`);
    await see(
        home
            ? `document.querySelector('.home-list') !== null`
            : `document.querySelector('.composer textarea') !== null`,
        "the background screen",
    );
    await settle();
    await page.evaluate(`
        window.pipTestFetch = window.fetch;
        window.pipTestCalls = [];
        window.pipTestGates = [];
        window.pipTestHold = '';
        window.pipTestFail = '';
        window.fetch = (url, init) => {
            const path = String(url);
            const kind = path.includes('/upload?') ? 'upload' : path.endsWith('/submit') ? 'submit' : '';
            window.pipTestCalls.push({ url: path, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
            const send = () => window.pipTestFetch(url, init);
            if (kind && kind === window.pipTestFail) {
                return Promise.reject(new TypeError('test offline'));
            }
            if (kind && kind === window.pipTestHold) {
                return new Promise((resolve, reject) => window.pipTestGates.push({ resolve: () => resolve(send()), reject }));
            }
            return send();
        };
    `);
    await open();
}

/** File API fixtures travel through the real input/paste/drop handlers, then the real upload route. */
async function attach(
    method: "picker" | "paste" | "drop",
    files: { name: string; image?: boolean }[],
): Promise<void> {
    await page.evaluate(`
        const data = new DataTransfer();
        for (const fixture of ${JSON.stringify(files)}) {
            const bytes = fixture.image ? Uint8Array.from(atob(${JSON.stringify(PNG)}), (letter) => letter.charCodeAt(0)) : 'fixture document';
            data.items.add(new File([bytes], fixture.name, { type: fixture.image ? 'image/png' : 'text/plain' }));
        }
        if (${JSON.stringify(method)} === 'picker') {
            const picker = document.querySelector('.pip-file-picker');
            picker.files = data.files;
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (${JSON.stringify(method)} === 'paste') {
            document.querySelector(${JSON.stringify(BOX)}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        } else {
            const wrap = document.querySelector('.pip-composer-wrap');
            wrap.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
            wrap.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
        }
    `);
}

async function uploaded(count: number): Promise<void> {
    await see(
        `document.querySelectorAll('.pip-attachment').length === ${count} &&
        document.querySelector('.pip-attachments .spinner') === null`,
        "uploaded PiP files",
    );
    await see(`!document.querySelector('.pip-send').disabled`, "PiP Send enabled");
}

async function enter(): Promise<void> {
    await page.evaluate(`document.querySelector(${JSON.stringify(BOX)}).focus()`);
    await page.press("Enter");
}

async function idle(): Promise<void> {
    await until(
        async () => {
            const entries = await app.transcripts.allEntries(pip, true);
            const user = entries.findLast((entry) => entry.kind === "user");
            const answer = entries.findLast((entry) => entry.kind === "assistant");

            return (
                !app.isBusy(pip) &&
                user !== undefined &&
                answer !== undefined &&
                answer.id > user.id
            );
        },
        "PiP finished the latest answer",
        20_000,
    );
    await see(`!(await import('/store.js')).store.state.pipView.live.busy`, "PiP's idle view");
}

async function release(): Promise<void> {
    await page.evaluate(
        `window.pipTestHold = ''; window.pipTestGates.splice(0).forEach((gate) => gate.resolve())`,
    );
}

before(async () => {
    if (real.skip) {
        return;
    }

    mkdirSync(project);
    mkdirSync(elsewhere);
    app = await openApp(
        scriptedModel(async (request) => {
            await heldReply;

            const { text } = lastText(request as never);
            const messages = (request as { messages: { role: string; content: unknown }[] })
                .messages;
            const last = messages.findLast((message) => message.role === "user");
            const images = Array.isArray(last?.content)
                ? (last.content.filter((part) => part.type === "image") as {
                      data: string;
                      mimeType: string;
                  }[])
                : [];

            requests.push({ text, images });

            return fauxAssistantMessage([
                fauxText(
                    replyImage
                        ? `![PiP local picture](${replyImage})`
                        : `PiP received ${images.length} images.`,
                ),
            ]);
        }),
    );

    app.watches.gh = async () => {
        throw new Error("No GitHub in PiP UI tests");
    };

    background = await newSession(app, project);
    other = await newSession(app, elsewhere);
    pip = await app.pip.ensure(owner(app));
    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-vision" },
        thinkingLevel: "off",
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "pip-chat-browser-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `(await import('/store.js')).store.state.me?.role === 'owner'`,
        "isolated owner signed in",
    );
});

after(async () => {
    try {
        await browsers?.closeAll({ final: true });
    } finally {
        server?.closeAllConnections();
        server?.close();

        try {
            await app?.close();
        } finally {
            cleanUp();
        }
    }
});

test(
    "PiP drags from its corner and keeps its size without moving the bottom-right anchor",
    real,
    async () => {
        await fresh();
        const rect = () =>
            inPage<{
                x: number;
                y: number;
                width: number;
                height: number;
                right: number;
                bottom: number;
            }>(
                `return JSON.stringify(document.querySelector('.pip-panel').getBoundingClientRect())`,
            );
        const before = await rect();

        await page.input([
            { type: "mouse", action: "down", x: before.x - 2, y: before.y - 2 },
            { type: "mouse", action: "move", x: before.x - 102, y: before.y - 42, pressed: true },
            { type: "mouse", action: "up", x: before.x - 102, y: before.y - 42 },
        ]);
        const after = await rect();

        assert.equal(after.width, before.width + 100);
        assert.equal(after.height, before.height + 40);
        assert.equal(after.right, before.right);
        assert.equal(after.bottom, before.bottom);
        await close();
        await page.navigate(`${base}/s/${background}`);
        await open();
        assert.equal((await rect()).width, after.width);
        await page.evaluate(
            `localStorage.removeItem('pocket.pip.size.' + (await import('/store.js')).store.state.me.id)`,
        );
    },
);

test(
    "PiP pops out with one composer and returns the same draft and attachment",
    real,
    async (t) => {
        await fresh();

        if (
            !(await inPage<boolean>(
                `return JSON.stringify((await import('/pip-popout.js')).canPopOut())`,
            ))
        ) {
            t.skip("Document Picture-in-Picture is not available");

            return;
        }

        await text("keep my draft");
        await attach("picker", [{ name: "floating.txt" }]);
        await uploaded(1);
        // The test browser closes new blank targets after five seconds: exercise the native round trip in one task.
        const result = await inPage<{
            single: boolean;
            model: boolean;
            same: boolean;
            draft: string;
            files: number;
        }>(`
        const original = document.querySelector(${JSON.stringify(BOX)});
        await (await import('/pip-popout.js')).popOutPip();
        const child = documentPictureInPicture.window;
        const doc = child.document;
        const wait = async (check) => {
            for (let n = 0; n < 100 && !check(); n++) await new Promise(r => setTimeout(r, 10));
        };
        const single = !document.querySelector(${JSON.stringify(BOX)}) && doc.querySelector(${JSON.stringify(BOX)}) === original;
        doc.querySelector('.pip-model').click();
        await wait(() => doc.querySelector('[aria-label="Model"]')?.contains(doc.activeElement));
        const model = doc.querySelector('[aria-label="Model"]')?.contains(doc.activeElement) === true;
        child.dispatchEvent(new child.KeyboardEvent('keydown', { key: 'Escape' }));
        child.close();
        await wait(() => document.querySelector(${JSON.stringify(BOX)}) === original);
        return JSON.stringify({ single, model, same: document.querySelector(${JSON.stringify(BOX)}) === original,
            draft: original.value, files: document.querySelectorAll('.pip-attachment').length });
    `);

        assert.deepEqual(result, {
            single: true,
            model: true,
            same: true,
            draft: "keep my draft",
            files: 1,
        });
    },
);

test("PiP's header picker saves to PiP and cannot change a running turn", real, async () => {
    await fresh(VIEWPORTS.mobile, true);
    assert.equal(
        await inPage(`return JSON.stringify(!!document.querySelector('.pip-model'))`),
        true,
    );
    await tap(".pip-model");
    await see(`document.querySelector('[role=dialog][aria-label=Model]')`, "PiP's model picker");
    await tap("[role=option]:nth-child(3)");
    await until(
        async () => (await app.agentState(pip))?.model?.modelId === "faux-2",
        "PiP's model saved",
    );
    assert.equal((await app.agentState(background))?.model?.modelId, "faux-1");
    let releaseReply!: () => void;

    heldReply = new Promise<void>((resolve) => {
        releaseReply = resolve;
    });
    await tap(".pip-model");

    try {
        await app.commands.submit(pip, owner(app), { text: "hold", requestId: "model-chip-hold" });
        await see(`document.querySelector('.pip-model').disabled`, "busy PiP's chip disabled");
        await see(`document.querySelector('[role=option]').disabled`, "open picker locked too");
        await assert.rejects(
            app.commands.configure(pip, owner(app), {
                model: { provider: "faux", modelId: "faux-1" },
                pipPanel: true,
            }),
            { status: 409 },
        );
    } finally {
        releaseReply();
        heldReply = undefined;
    }

    await see(`!document.querySelector('.pip-model').disabled`, "idle PiP's chip enabled");
    await page.evaluate(`(await import('/store.js')).closeSheet()`);
    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-vision" },
    });
});

for (const [device, viewport] of [
    ["desktop", VIEWPORTS.desktop],
    ["touch", VIEWPORTS.mobile],
] as const) {
    test(
        `${device}: picker, paste, and drop send image-only and file-only messages to PiP, not the background project`,
        real,
        async () => {
            await fresh(viewport);
            const backgroundBefore = await app.transcripts.allEntries(background, true);
            const picker = await inPage<{ type: string; multiple: boolean; accept: string }>(`
            const picker = document.querySelector('.pip-file-picker');
            return JSON.stringify({ type: picker.type, multiple: picker.multiple, accept: picker.accept });
        `);

            assert.equal(picker.type, "file");
            assert.equal(picker.multiple, true);
            assert.ok(
                picker.accept === "" ||
                    !picker.accept.split(",").every((type) => type.trim().startsWith("image/")),
                "general files are allowed",
            );
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('[aria-label="Attach files to PiP"]') !== null)`,
                ),
                true,
            );

            for (const method of ["picker", "paste", "drop"] as const) {
                const image = `${device}-${method}.png`;
                const document = `${device}-${method}.txt`;
                const before = requests.length;

                await attach(method, [{ name: image, image: true }, { name: document }]);
                await uploaded(2);
                assert.deepEqual(await names(), [image, document]);
                await tap(`[aria-label="Remove ${document}"]`);
                assert.deepEqual(await names(), [image], "remove one leaves the other");
                await tap(".pip-send");
                await until(() => requests.length > before, "the vision model saw the send");
                await idle();
                const sent = (await submissions()).at(-1)!;

                assert.equal(sent.url, `/api/c/${pip}/submit`);
                assert.equal(sent.body?.text, "");
                assert.deepEqual(
                    sent.body?.attachments?.map((file) => file.name),
                    [image],
                );
                assert.equal(
                    requests.at(-1)?.images.length,
                    1,
                    "the real model request contains the image, not only its path",
                );
                assert.equal(requests.at(-1)?.images[0]?.mimeType, "image/png");
                assert.equal(
                    requests.at(-1)?.images[0]?.data,
                    PNG,
                    "the fixture's actual image bytes reached the model",
                );
                assert.deepEqual(await names(), []);
                await see(
                    `[...document.querySelectorAll('.pip-you .thumb img')].some((image) => image.alt === ${JSON.stringify(image)} && image.complete && image.naturalWidth > 0)`,
                    "sent picture thumbnail loaded",
                );
                assert.equal(
                    await inPage<string>(
                        `return JSON.stringify([...document.querySelectorAll('.pip-you .thumb img')].find((picture) => picture.alt === ${JSON.stringify(image)}).getAttribute('src'))`,
                    ),
                    `/api/c/${pip}/file?path=${encodeURIComponent(sent.body!.attachments![0]!.path)}`,
                    "sent thumbnail uses PiP's explicit CID",
                );

                await attach(method, [{ name: document }]);
                await uploaded(1);
                await tap(".pip-send");
                await until(async () => (await names()).length === 0, "file-only message sent");
                await idle();
                const file = (await submissions()).at(-1)?.body?.attachments?.[0];

                assert.equal(file?.name, document);
                assert.equal(file?.mime, "text/plain");
                assert.equal(file?.size, Buffer.byteLength("fixture document"));
                assert.equal(readFileSync(file!.path, "utf8"), "fixture document");
                await see(
                    `[...document.querySelectorAll('.pip-you .chip')].some((chip) => chip.textContent.includes(${JSON.stringify(document)}))`,
                    "document displayed by name",
                );
                assert.equal(
                    await inPage<boolean>(
                        `return JSON.stringify([...document.querySelectorAll('.pip-you')].some((message) => message.textContent.includes(${JSON.stringify(file!.path)})))`,
                    ),
                    false,
                    "raw upload paths are not shown",
                );
            }

            assert.deepEqual(
                await app.transcripts.allEntries(background, true),
                backgroundBefore,
                "PiP never messages the background conversation",
            );
            assert.ok(
                (await calls())
                    .filter((call) => call.url.includes("/upload?"))
                    .every((call) => call.url.startsWith(`/api/c/${pip}/upload?`)),
            );
            await close();
        },
    );
}

test(
    "native plain-text paste stays unhandled; mixed file paste inserts text at the selected caret",
    real,
    async () => {
        await fresh();
        await text("before SELECT after");
        const native = await inPage<{
            prevented: boolean;
            value: string;
            start: number;
            end: number;
        }>(`
        const box = document.querySelector(${JSON.stringify(BOX)});
        box.setSelectionRange(7, 13);
        const data = new DataTransfer();
        data.setData('text/plain', 'native words');
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        box.dispatchEvent(event);
        return JSON.stringify({ prevented: event.defaultPrevented, value: box.value, start: box.selectionStart, end: box.selectionEnd });
    `);

        // Synthetic ClipboardEvents have no native insertion. Not preventing them is the native-paste contract.
        assert.deepEqual(native, {
            prevented: false,
            value: "before SELECT after",
            start: 7,
            end: 13,
        });
        await page.evaluate(`
        const data = new DataTransfer();
        data.items.add(new File(['fixture document'], 'mixed.txt', { type: 'text/plain' }));
        data.setData('text/plain', 'replacement');
        document.querySelector(${JSON.stringify(BOX)}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    `);
        await uploaded(1);
        assert.equal(await value(), "before replacement after");
        await close();
    },
);

test(
    "uploads block Send and Enter; removed or late uploads cannot reappear; a failed upload keeps other files and text",
    real,
    async () => {
        await fresh();

        try {
            await text("keep this draft");
            await page.evaluate(`window.pipTestHold = 'upload'`);
            await attach("drop", [
                { name: "remove-late.png", image: true },
                { name: "keep-late.txt" },
            ]);
            await see(`window.pipTestGates.length === 2`, "two held uploads");
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.pip-send').disabled)`,
                ),
                true,
            );
            await enter();
            assert.equal((await submissions()).length, 0, "Enter does not bypass pending uploads");
            assert.equal(await value(), "keep this draft");
            await tap('[aria-label="Remove remove-late.png"]');
            await close();
            await release();
            await open();
            await uploaded(1);
            assert.deepEqual(
                await names(),
                ["keep-late.txt"],
                "removed upload stays removed after completion and remount",
            );
            await page.evaluate(`window.pipTestFail = 'upload'`);
            await attach("paste", [{ name: "failed.txt" }]);
            await see(
                `(await import('/store.js')).store.state.notices.some((notice) => notice.message.includes('Upload failed'))`,
                "upload failure notice",
            );
            assert.equal(await value(), "keep this draft");
            assert.deepEqual(
                await names(),
                ["keep-late.txt"],
                "upload failure does not remove another ready file",
            );
        } finally {
            await page.evaluate(`window.pipTestFail = ''`);
            await release();
        }

        await close();
    },
);

test(
    "failed POST retains recoverable text and files; a pending send cannot duplicate and preserves newer typing",
    real,
    async () => {
        await fresh();

        try {
            await attach("picker", [{ name: "recover.png", image: true }, { name: "recover.txt" }]);
            await uploaded(2);
            await text("recover these words");
            await page.evaluate(`window.pipTestFail = 'submit'`);
            await enter();
            await see(
                `(await import('/store.js')).store.state.notices.some((notice) => notice.message.includes('test offline'))`,
                "send failure notice",
            );
            await until(
                async () => (await value()) === "recover these words",
                "failed words restored",
            );
            assert.deepEqual(await names(), ["recover.png", "recover.txt"]);
            await close();
            await open();
            assert.equal(await value(), "recover these words");
            assert.deepEqual(await names(), ["recover.png", "recover.txt"]);
            await page.evaluate(
                `window.pipTestFail = ''; window.pipTestHold = 'submit'; window.pipTestCalls = []`,
            );
            await enter();
            await see(`window.pipTestGates.length === 1`, "submission held");
            await text("newer words while sending");
            await attach("drop", [{ name: "added-during-send.txt" }]);
            await see(
                `document.querySelectorAll('.pip-attachment').length === 3 && document.querySelector('.pip-attachments .spinner') === null`,
                "new file added during the pending send",
            );
            await enter();
            assert.equal((await submissions()).length, 1, "double Enter sends only once");
            await close();
            await open();
            assert.equal(await value(), "newer words while sending");
            await release();
            await until(
                async () => (await names()).length === 1,
                "successful retry removes only its own files",
            );
            assert.deepEqual(
                await names(),
                ["added-during-send.txt"],
                "late success keeps a newer attachment",
            );
            await idle();
            assert.equal(
                await value(),
                "newer words while sending",
                "late success never clears newer typing",
            );
            const sent = (await submissions())[0]!;

            assert.equal(sent.body?.text, "recover these words");
            assert.equal(sent.body?.attachments?.length, 2);
        } finally {
            await page.evaluate(`window.pipTestFail = ''`);
            await release();
        }

        await close();
    },
);

test(
    "late failed POST merges the original words with newer typing and leaves both files available",
    real,
    async () => {
        await fresh();

        try {
            await attach("paste", [{ name: "old-file.txt" }]);
            await uploaded(1);
            await text("older draft");
            await page.evaluate(`window.pipTestHold = 'submit'`);
            await enter();
            await see(`window.pipTestGates.length === 1`, "held submission");
            await text("newer draft");
            await attach("drop", [{ name: "new-file.txt" }]);
            await see(
                `document.querySelectorAll('.pip-attachment').length === 2 && document.querySelector('.pip-attachments .spinner') === null`,
                "new attachment uploaded while send is pending",
            );
            await page.evaluate(
                `window.pipTestHold = ''; window.pipTestGates.splice(0).forEach((gate) => gate.reject(new TypeError('late offline')))`,
            );
            await until(
                async () => (await value()) === "older draft\n\nnewer draft",
                "both drafts recovered",
            );
            assert.deepEqual(await names(), ["old-file.txt", "new-file.txt"]);
        } finally {
            await release();
        }

        await close();
    },
);

test(
    "stored images and local Markdown replies use PiP's CID and open full-size without stealing sheet focus",
    real,
    async () => {
        await fresh();
        const conversation = await app.conversation(pip);
        const submission = await conversation.submit(
            {
                type: "input",
                content: [
                    { type: "text", text: "incoming stored picture" },
                    { type: "image", mimeType: "image/png", data: PNG },
                ],
                requestId: crypto.randomUUID(),
            },
            context,
        );

        await submission.wait(context);
        await idle();
        await see(
            `[...document.querySelectorAll('.pip-you .thumb img')].some((image) => image.getAttribute('src').startsWith('/api/c/${pip}/image/') && image.complete && image.naturalWidth > 0)`,
            "stored PiP image loaded with its own CID",
        );
        const storedSelector = `.pip-you .thumb:has(img[src^="/api/c/${pip}/image/"])`;

        await tap(storedSelector);
        await see(
            `document.querySelector('.lightbox img')?.naturalWidth > 0`,
            "full-size stored image",
        );
        await settle();
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('.lightbox img').getAttribute('src'))`,
            ),
            new RegExp(`^/api/c/${pip}/image/`),
        );
        await page.evaluate(`document.querySelector('.lightbox [aria-label="Close"]').focus()`);
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.activeElement?.closest('.lightbox') !== null)`,
            ),
            true,
            "PiP does not steal image viewer focus",
        );
        await tap('.lightbox [aria-label="Close"]');
        await see(`document.querySelector('.lightbox') === null`, "image viewer closed");

        await attach("picker", [{ name: "markdown.png", image: true }]);
        await uploaded(1);
        const uploadCall = (await calls()).findLast((call) => call.url.includes("/upload?"))!;
        const uploadName = decodeURIComponent(uploadCall.url.split("?name=")[1]!);

        assert.equal(uploadName, "markdown.png");
        // Get the real uploaded path from the file-only/image submission, not a path from the background project.
        await text("markdown image fixture");
        await tap(".pip-send");
        await until(async () => (await names()).length === 0, "Markdown fixture submitted");
        await idle();
        replyImage = (await submissions()).at(-1)!.body!.attachments![0]!.path;

        try {
            await text("show that local picture");
            await tap(".pip-send");
            await idle();
            await see(
                `[...document.querySelectorAll('.pip-reply img')].some((image) => image.alt === 'PiP local picture' && image.complete && image.naturalWidth > 0)`,
                "local Markdown picture loaded",
            );
            const source = await inPage<string>(
                `return JSON.stringify([...document.querySelectorAll('.pip-reply img')].find((image) => image.alt === 'PiP local picture').getAttribute('src'))`,
            );

            assert.equal(source, `/api/c/${pip}/file?path=${encodeURIComponent(replyImage)}`);
        } finally {
            replyImage = "";
        }

        await close();
    },
);

async function clearMemory(): Promise<void> {
    await app.harness.commit(async (tx) => {
        (await tx.doc(MemoryDoc)).items = {};
    }, context);
}

async function review(): Promise<void> {
    const selector = ".pip-memory button, button.pip-memory";

    await see(
        `document.querySelector(${JSON.stringify(selector)}) !== null`,
        "PiP pending-memory shortcut",
    );
    const label = await inPage<string>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-label') ?? document.querySelector(${JSON.stringify(selector)}).textContent)`,
    );

    assert.match(label, /pending memor/i);
    // Observe native focus during the transition, including PiP's 180ms leaving cleanup, not only afterward.
    await page.evaluate(`
        window.pipTestReviewFocus = [];
        const end = performance.now() + 1200;
        const watch = () => {
            const sheet = document.querySelector('.sheet-host:not(.leaving) .sheet');

            if (sheet) {
                window.pipTestReviewFocus.push(sheet === document.activeElement || sheet.contains(document.activeElement));
            }

            if (performance.now() < end) {
                requestAnimationFrame(watch);
            }
        };

        requestAnimationFrame(watch);
    `);
    await tap(selector);
    await see(
        `document.querySelector('.sheet h2')?.textContent === 'Pending memories'`,
        "pending memory sheet",
    );
    await see(`document.querySelector('.pip-panel') === null`, "memory review closes PiP");
    await settle();
}

async function lessonAction(words: string, action: "Approve" | "Discard"): Promise<void> {
    const index = await inPage<number>(
        `return JSON.stringify([...document.querySelectorAll('.sheet .lesson')].findIndex((lesson) => lesson.textContent.includes(${JSON.stringify(words)})))`,
    );

    assert.ok(index >= 0, `lesson containing ${words} is visible`);
    const buttonIndex = await inPage<number>(
        `return JSON.stringify([...document.querySelectorAll('.sheet .lesson')[${index}].querySelectorAll('button')].findIndex((button) => button.textContent.trim() === ${JSON.stringify(action)}))`,
    );

    assert.ok(buttonIndex >= 0, `${action} is offered`);
    await page.evaluate(
        `document.querySelectorAll('.sheet .lesson')[${index}].dataset.pipTestReview = 'current'`,
    );
    await tap(
        `.sheet .lesson[data-pip-test-review="current"] .lesson-actions button:nth-of-type(${buttonIndex + 1})`,
    );
    await page.evaluate(
        `document.querySelectorAll('[data-pip-test-review]').forEach((lesson) => delete lesson.dataset.pipTestReview)`,
    );
}

for (const [device, viewport, home] of [
    ["desktop background project", VIEWPORTS.desktop, false],
    ["touch home", VIEWPORTS.mobile, true],
] as const) {
    test(
        `${device}: pending memories include both projects, everywhere, and edit/forget proposals; review preserves PiP draft`,
        real,
        async () => {
            await clearMemory();
            const person = owner(app);
            const pi = { userId: person.id, byPi: true, name: "Pi" };
            const alpha = await app.memory.add(background, project, pi, {
                text: "Alpha pending lesson.",
                scope: "project",
            });
            const beta = await app.memory.add(other, elsewhere, pi, {
                text: "Beta pending lesson.",
                scope: "project",
            });
            const global = await app.memory.add(other, elsewhere, pi, {
                text: "Everywhere pending lesson.",
                scope: "everywhere",
            });
            const edited = await app.memory.remember(other, person, {
                text: "Original beta lesson.",
            });
            const forgotten = await app.memory.remember(background, person, {
                text: "Forget alpha lesson.",
            });

            await app.memory.remember(other, person, {
                text: "Already approved and not in queue.",
            });
            await app.memory.change(other, elsewhere, pi, edited.id, {
                text: "Proposed beta revision.",
            });
            await app.memory.change(background, project, pi, forgotten.id, "remove");
            await fresh(viewport, home);

            try {
                await text("draft survives memory review");
                await attach("picker", [
                    { name: "memory-draft.png", image: true },
                    { name: "memory-draft.txt" },
                ]);
                await uploaded(2);
                await see(
                    `document.querySelector('.pip-memory')?.textContent.includes('5')`,
                    "all-project pending count",
                );
                await review();
                await see(
                    `document.querySelectorAll('.sheet .lesson').length === 5`,
                    "all five pending rows",
                );
                const content = await inPage<string>(
                    `return JSON.stringify(document.querySelector('.sheet').textContent)`,
                );

                assert.match(content, /To approve\s*·?\s*5/);
                assert.match(content, /project-alpha/);
                assert.match(content, /project-beta/);
                assert.match(content, /everywhere/);
                assert.match(content, /Proposed beta revision/);
                assert.match(content, /proposes forgetting/);
                assert.doesNotMatch(content, /Already approved and not in queue/);
                assert.equal(
                    await inPage<number>(
                        `return JSON.stringify(document.querySelectorAll('.sheet textarea, .sheet .lesson-add').length)`,
                    ),
                    0,
                    "pending-only review cannot add or edit lessons",
                );
                assert.ok(
                    (await calls()).some((call) => call.url === `/api/c/${pip}/memory?pending=all`),
                    "home and background reviews explicitly use PiP's CID",
                );
                await new Promise((resolve) => setTimeout(resolve, 220));
                const focusFrames = await inPage<boolean[]>(
                    `return JSON.stringify(window.pipTestReviewFocus)`,
                );
                const firstFocused = focusFrames.indexOf(true);

                assert.ok(
                    firstFocused >= 0,
                    "the memory sheet receives native focus during the transition",
                );
                assert.ok(
                    focusFrames.slice(firstFocused).every(Boolean),
                    "no later frame returns focus to the background or leaving PiP",
                );
                assert.equal(
                    await inPage<boolean>(
                        `return JSON.stringify(document.activeElement?.closest('.sheet') !== null)`,
                    ),
                    true,
                    "leaving PiP cleanup cannot steal memory sheet focus",
                );

                for (const [words, action, id, body] of [
                    ["Beta pending lesson.", "Approve", beta.id, { text: "Beta pending lesson." }],
                    [
                        "Proposed beta revision.",
                        "Approve",
                        edited.id,
                        { text: "Proposed beta revision." },
                    ],
                    ["Forget alpha lesson.", "Approve", forgotten.id, { forget: true }],
                    ["Alpha pending lesson.", "Discard", alpha.id, {}],
                    ["Everywhere pending lesson.", "Discard", global.id, {}],
                ] as const) {
                    const before = await inPage<number>(
                        `return JSON.stringify(document.querySelectorAll('.sheet .lesson').length)`,
                    );

                    await lessonAction(words, action);
                    await see(
                        `document.querySelectorAll('.sheet .lesson').length === ${before - 1}`,
                        "reviewed row removed",
                    );
                    const call = (await calls()).findLast(
                        (call) =>
                            call.url ===
                            `/api/c/${pip}/memory/${id}/${action.toLowerCase()}?pending=all`,
                    );

                    assert.ok(call, `${action} uses owner all-project route`);
                    assert.deepEqual(
                        call.body,
                        body,
                        "approval sends exactly the text/forget proposal the owner saw",
                    );
                }

                await see(
                    `document.querySelector('.sheet').textContent.includes('No memories waiting for approval.')`,
                    "empty approval queue",
                );
                await page.evaluate(`(await import('/store.js')).closeSheet()`);
                await see(`document.querySelector('.sheet') === null`, "review dismissed");
                await open();
                assert.equal(await value(), "draft survives memory review");
                assert.deepEqual(await names(), ["memory-draft.png", "memory-draft.txt"]);
                await see(
                    `!document.querySelector('.pip-memory')?.textContent.match(/\b[1-9]\d*\b/)`,
                    "shortcut count refreshed to empty",
                );
                // A committed lesson from a different project refreshes the open shortcut through MemoryRev/SSE.
                await app.memory.add(other, elsewhere, pi, {
                    text: "Arrived while PiP open.",
                    scope: "project",
                });
                await see(
                    `document.querySelector('.pip-memory')?.textContent.includes('1')`,
                    "pending count refreshed from another project",
                );
                await review();
                await see(
                    `document.querySelector('.sheet').textContent.includes('Arrived while PiP open.')`,
                    "fresh pending row after reopening",
                );
            } finally {
                await page.evaluate(`(await import('/store.js')).closeSheet()`);
                await clearMemory();
            }
        },
    );
}

for (const [device, viewport] of [
    ["desktop", VIEWPORTS.desktop],
    ["touch", VIEWPORTS.mobile],
] as const) {
    test(
        `${device}: PiP files and memory controls fit without horizontal overflow and have 44px targets`,
        real,
        async () => {
            await fresh(viewport);
            await attach("drop", [
                { name: `${"long-filename-".repeat(12)}.png`, image: true },
                { name: `${"long-document-".repeat(12)}.txt` },
            ]);
            await uploaded(2);
            await text("a draft with attached files");
            await settle();
            const layout = await inPage<{
                fits: boolean;
                pageFits: boolean;
                targets: { label: string; width: number; height: number }[];
            }>(`
            const panel = document.querySelector('.pip-panel');
            const box = panel.getBoundingClientRect();
            return JSON.stringify({ fits: box.left >= -1 && box.right <= innerWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1,
                pageFits: document.documentElement.scrollWidth <= innerWidth + 1,
                targets: [...document.querySelectorAll('.pip-attach, .pip-send, .pip-attachment-remove, .pip-memory button, button.pip-memory')].map((button) => {
                    const rect = button.getBoundingClientRect();
                    return { label: button.getAttribute('aria-label') ?? button.textContent, width: rect.width, height: rect.height };
                }) });
        `);

            assert.equal(layout.fits, true, "PiP panel does not overflow");
            assert.equal(layout.pageFits, true, "document does not overflow");
            assert.ok(
                layout.targets.length >= 5,
                "attach, send, both removals, and memory shortcut measured",
            );

            for (const target of layout.targets) {
                assert.ok(
                    target.width >= 44 && target.height >= 44,
                    `${target.label}: 44px target (${target.width}x${target.height})`,
                );
            }

            await close();
        },
    );
}

test(
    "punctuation-heavy image and document filenames remain readable and use PiP's file access",
    real,
    async () => {
        await fresh();
        const imageName = "picture (copy), 1.png";
        const documentName = "notes, review (copy).txt";

        await attach("picker", [{ name: imageName, image: true }, { name: documentName }]);
        await uploaded(2);
        assert.deepEqual(await names(), [imageName, documentName]);
        await tap(".pip-send");
        await until(async () => (await names()).length === 0, "punctuation-named files sent");
        await idle();
        const files = (await submissions()).at(-1)!.body!.attachments!;

        assert.deepEqual(
            files.map((file) => file.name),
            [imageName.replaceAll(",", "_"), documentName.replaceAll(",", "_")],
            "normal uploads retain the server's filename sanitization",
        );

        // A real stored-file fixture with comma-bearing names (the current upload route normalizes commas).
        // Keep the uploaded-path/name convention, rather than manufacture an unsupported filename alias.
        const originalFiles = files.map((file, index) => {
            const name = index === 0 ? imageName : documentName;
            const path = join(app.workspace.uploadDirectory(pip), name);

            copyFileSync(file.path, path);

            return { ...file, path, name };
        });

        for (const [imageLabel, documentLabel] of [
            [files[0]!.name, files[1]!.name],
            [imageName, documentName],
        ]) {
            if (imageLabel === imageName) {
                // Older/stored metadata and other API clients can keep commas. Exercise the public route with
                // real uploaded files; do not replace the component's private draft or fake transcript rows.
                const attachments = originalFiles;

                await page.evaluate(`
                    const { api, uid } = await import('/store.js');
                    await api('c/${pip}/submit', { text: '', attachments: ${JSON.stringify(attachments)}, requestId: uid() });
                `);
                await idle();
            }

            await see(
                `[...document.querySelectorAll('.pip-you .thumb img')].some((image) => image.alt === ${JSON.stringify(imageLabel)} && image.complete && image.naturalWidth > 0)`,
                "punctuation-named image loaded",
            );
            await see(
                `[...document.querySelectorAll('.pip-you .attachments .chip')].some((chip) => chip.textContent.includes(${JSON.stringify(documentLabel)}))`,
                "punctuation-named document chip",
            );
            const url = await inPage<string>(
                `return JSON.stringify([...document.querySelectorAll('.pip-you .thumb img')].find((image) => image.alt === ${JSON.stringify(imageLabel)}).getAttribute('src'))`,
            );

            const image = imageLabel === imageName ? originalFiles[0]! : files[0]!;

            assert.equal(url, `/api/c/${pip}/file?path=${encodeURIComponent(image.path)}`);
            assert.equal(
                await inPage<number>(
                    `return JSON.stringify((await fetch(${JSON.stringify(url)})).status)`,
                ),
                200,
            );
        }

        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll('.pip-you')].some((message) => ${JSON.stringify([...files, ...originalFiles].map((file) => file.path))}.some((path) => message.textContent.includes(path))))`,
            ),
            false,
        );
        await close();
    },
);

for (const [device, viewport] of [
    ["desktop", VIEWPORTS.desktop],
    ["touch", VIEWPORTS.mobile],
] as const) {
    test(
        `${device}: a typed PiP text draft survives reload while open and while closed`,
        real,
        async () => {
            await fresh(viewport);
            const draft = "Keep this PiP draft across reload.\nSecond line, not a sent message.";

            await tap(BOX);
            await page.type({ selector: BOX }, draft);
            await until(
                async () => (await value()) === draft,
                "native typing saved the text draft",
            );
            await page.navigate(`${base}/s/${background}`);
            await see(
                `(await import('/store.js')).store.state.me?.role === 'owner' && document.querySelector(${JSON.stringify(BOX)}) !== null && (await import('/store.js')).store.state.pipView.conversation?.id === ${Number(pip)}`,
                "PiP restored after reload and sign-in state loaded",
            );
            await settle();
            assert.equal(
                await value(),
                draft,
                "initial unknown authentication cannot erase the saved text draft",
            );
            await close();
            await page.navigate(`${base}/s/${background}`);
            await see(
                `(await import('/store.js')).store.state.me?.role === 'owner' && document.querySelector('.composer textarea') !== null`,
                "background screen reloaded while PiP closed",
            );
            await settle();
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.pip-panel') === null)`,
                ),
                true,
            );
            await open();
            assert.equal(
                await value(),
                draft,
                "a closed-panel reload keeps the saved text until the owner reopens PiP",
            );
            await close();
        },
    );
}

test("text-only models still preview uploaded pictures through PiP's file URL", real, async () => {
    const model = app.models.getModel("faux", "faux-1")!;
    const input = model.input;

    model.input = ["text"];
    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });

    try {
        await fresh();
        await attach("picker", [{ name: "text-model-picture.png", image: true }]);
        await uploaded(1);
        const before = requests.length;

        await text("picture with a text-only model");
        await tap(".pip-send");
        await until(() => requests.length > before, "text-only model answered");
        await idle();
        assert.equal(
            requests.at(-1)?.images.length,
            0,
            "the chosen model receives no inline image",
        );
        const file = (await submissions()).at(-1)!.body!.attachments![0]!;

        await see(
            `[...document.querySelectorAll('.pip-you .thumb img')].some((image) => image.alt === 'text-model-picture.png' && image.complete && image.naturalWidth > 0)`,
            "uploaded picture preview despite text-only model",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify([...document.querySelectorAll('.pip-you .thumb img')].find((image) => image.alt === 'text-model-picture.png').getAttribute('src'))`,
            ),
            `/api/c/${pip}/file?path=${encodeURIComponent(file.path)}`,
        );
        await close();
    } finally {
        model.input = input;
        await app.commands.configure(pip, owner(app), {
            model: { provider: "faux", modelId: "faux-vision" },
        });
    }
});

test(
    "an old server's scoped response cannot masquerade as the all-project approval queue",
    real,
    async () => {
        await clearMemory();
        await fresh();

        try {
            await text("keep my draft through restart guidance");
            await attach("picker", [{ name: "restart-draft.txt" }]);
            await uploaded(1);
            await page.evaluate(`
                const fetched = window.fetch;
                window.fetch = (url, init) => String(url).endsWith('/memory?pending=all') ? Promise.resolve(new Response(JSON.stringify({
                    project: { name: 'old scoped project' }, canWrite: true, owner: true,
                    lessons: [{ id: 'old-scope', text: 'Old scoped pending lesson must not be shown.', pending: true, scope: 'project', mine: true }],
                    limits: { text: 300, project: 40, everywhere: 20 },
                }), { headers: { 'content-type': 'application/json' } })) : fetched(url, init);
                const { store } = await import('/store.js');
                store.set({ memoryRev: (store.state.memoryRev ?? 0) + 1 });
            `);
            await review();
            await see(
                `document.querySelector('.sheet')?.textContent.includes('Restart the server from Menu')`,
                "old-server restart guidance",
            );
            const content = await inPage<string>(
                `return JSON.stringify(document.querySelector('.sheet').textContent)`,
            );

            assert.match(content, /Menu → Restart server/);
            assert.doesNotMatch(
                content,
                /Old scoped pending lesson|To approve|No memories waiting for approval/,
            );
            assert.equal(
                await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll('.sheet .lesson').length)`,
                ),
                0,
            );
            await page.evaluate(`(await import('/store.js')).closeSheet()`);
            await see(`document.querySelector('.sheet') === null`, "restart guidance closed");
            await open();
            assert.equal(await value(), "keep my draft through restart guidance");
            assert.deepEqual(await names(), ["restart-draft.txt"]);
            await close();
        } finally {
            await page.evaluate(
                `window.fetch = window.pipTestFetch; (await import('/store.js')).closeSheet()`,
            );
            await clearMemory();
        }
    },
);

test(
    "memory extension off hides PiP's shortcut and makes no pending-memory request",
    real,
    async () => {
        await app.setExtensionEnabled(owner(app), "memory.ts", false);

        try {
            await fresh();
            await settle();
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.pip-memory') === null)`,
                ),
                true,
            );
            assert.equal(
                (await calls()).filter((call) => call.url.includes("/memory?pending=all")).length,
                0,
            );
            await close();
        } finally {
            await app.setExtensionEnabled(owner(app), "memory.ts", true);
        }
    },
);
