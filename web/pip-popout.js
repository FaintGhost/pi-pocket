// Adopt the existing PiP UI into a native floating window: one composer, draft and live connection throughout.
import { closeSheet, store } from "./store.js";
import { bindMarkdownEvents } from "./ui.js";
import { stopHiddenDictation } from "./voice.js";

function host() {
    const root = document.createElement("div");
    let home;

    root.style.display = "contents";

    return {
        root,
        mount(node) {
            home = node;

            if (node && root.ownerDocument === document) {
                node.append(root);
            }
        },
        restore() {
            home?.append(root);
        },
    };
}

export const pipHost = host();
export const pipSheets = host();
const wide = matchMedia("(min-width: 768px)");
let floating = null;
let pending = false;
let keys;
let lastSheet;

export const pipKeyHandler = (handler) => (keys = handler);
export const canPopOut = () =>
    isSecureContext &&
    window.top === window &&
    typeof window.documentPictureInPicture?.requestWindow === "function" &&
    wide.matches &&
    navigator.maxTouchPoints === 0 &&
    !/Android|iPad|iPhone/i.test(navigator.userAgent) &&
    !floating;

/** Keep a sheet opened from PiP (and its follow-on sheets) in the same document. */
export function placePipSheets() {
    const sheet = store.state.sheet;

    if (sheet && sheet !== lastSheet) {
        if (floating && (sheet.pipId !== undefined || floating.document.hasFocus())) {
            floating.document.body.append(pipSheets.root);
        } else {
            pipSheets.restore();
        }
    }

    lastSheet = sheet;
}

export async function popOutPip() {
    if (!canPopOut() || pending || !store.state.pipOpen) {
        return;
    }

    pending = true;
    const account = store.state.me?.id;

    try {
        const panel = pipHost.root.querySelector(".pip-panel");
        const rect = panel.getBoundingClientRect();
        const child = await window.documentPictureInPicture.requestWindow({
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        });

        if (!store.state.pipOpen || store.state.me?.id !== account || !wide.matches) {
            child.close();

            return;
        }

        floating = child;
        const doc = child.document;

        const look = () => {
            doc.documentElement.style.cssText = document.documentElement.style.cssText;

            for (const key of Object.keys(doc.documentElement.dataset)) {
                delete doc.documentElement.dataset[key];
            }

            Object.assign(doc.documentElement.dataset, document.documentElement.dataset);
            doc.documentElement.dataset.pipWindow = "";
        };

        const observer = new MutationObserver(look);
        const base = doc.createElement("base");
        const css = doc.createElement("link");

        base.href = document.baseURI;
        css.rel = "stylesheet";
        css.href = new URL("/style.css", location.href).href;
        doc.head.append(base, css);
        doc.title = "PiP · Pi Pocket";
        look();
        observer.observe(document.documentElement, { attributes: true });
        const unbind = bindMarkdownEvents(doc);

        child.addEventListener("keydown", (event) => {
            if (event.isComposing || event.defaultPrevented) {
                return;
            }

            if (event.key === "Escape" && store.state.sheet) {
                event.preventDefault();
                closeSheet();
            } else if (event.key === "Escape" && store.state.launcher) {
                event.preventDefault();
                store.set({ launcher: false });
            } else if (
                event.key === "Escape" ||
                (event.altKey && ["KeyA", "KeyV"].includes(event.code))
            ) {
                keys(event);
            }
        });
        doc.addEventListener("visibilitychange", stopHiddenDictation);
        doc.body.append(pipHost.root);
        panel.querySelector("textarea")?.focus({ preventScroll: true });
        child.addEventListener(
            "pagehide",
            () => {
                observer.disconnect();
                unbind();
                doc.removeEventListener("visibilitychange", stopHiddenDictation);

                if (pipSheets.root.ownerDocument === doc) {
                    store.set({ sheet: null });
                }

                pipHost.restore();
                pipSheets.restore();
                floating = null;
                stopHiddenDictation();
                store.set({});

                if (store.state.pipOpen && !store.state.sheet && !store.state.launcher) {
                    panel.querySelector("textarea")?.focus({ preventScroll: true });
                }
            },
            { once: true },
        );
        store.set({});
    } finally {
        pending = false;
    }
}

store.subscribe((state) => {
    if (!state.pipOpen || !state.me || !state.server?.pip) {
        floating?.close();
    }
});
wide.addEventListener("change", () => {
    if (!wide.matches) {
        floating?.close();
    }

    store.set({});
});
addEventListener("pagehide", () => floating?.close());
