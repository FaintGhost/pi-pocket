// Dictation into a message box, with the browser's own speech recognition (the Web Speech API). Words show in the box
// as they are heard and stay once the browser settles on them; nothing is ever sent by itself. Chrome sends the audio
// to Google's servers to be recognised; Safari on iOS has it too; Firefox has none, and there the mic does not show.
import { useEffect, useRef, useState } from "preact/hooks";
import { notify } from "./store.js";
import { html, Icon } from "./ui.js";

/** The browser's recognizer, looked up when used (so a page can stand one in), or undefined where there is none. */
const Recognizer = () => globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

export const voiceAvailable = () => typeof Recognizer() === "function";

/** What each of the recognizer's errors means for the person; those not here are named as they are. */
const ERRORS = {
    "not-allowed": "The microphone is blocked. Allow it for this site in the browser's settings.",
    "service-not-allowed": "This browser does not allow dictation here.",
    "no-speech": "No speech heard. Tap the mic and try again.",
    "audio-capture": "No microphone found.",
    network: "Dictation needs the network: the browser recognises speech on its own servers.",
    "language-not-supported": "This browser cannot recognise your language.",
};

/** The dictation that listens now: one at a time, in the whole app. */
let current = null;
/** The boxes that can dictate, newest last: the shortcut (Alt+V) dictates into the newest (PiP's, while open). */
const boxes = [];

/** Alt+V: start or stop dictation in the newest box; false when no box can. */
export function toggleDictation() {
    const box = boxes.at(-1);

    if (!box || !voiceAvailable()) {
        return false;
    }

    box.toggle();

    return true;
}

/** Words heard, put between what the box has before and after them, with a space where words would touch. */
function join(before, words, after) {
    if (words === "") {
        return { value: before + after, at: before.length };
    }

    const start = /\S$/.test(before) ? " " : "";
    const end = /^[^\s.,;:!?)]/.test(after) ? " " : "";
    // A sentence's first word starts with a capital, as the browser leaves some in lower case.
    const capital = before.trim() === "" || /[.!?]\s*$/.test(before);
    const said = capital ? words[0].toUpperCase() + words.slice(1) : words;
    const head = before + start + said;

    return { value: head + end + after, at: head.length };
}

/**
 * Dictation into a textarea (`box`, a ref). `onText(value, caret)` hears each change, as typing does, so the box's own
 * draft saving keeps it. Words go in at the caret while the box has the focus, and after its text when it does not.
 * Returns whether it listens, and `toggle` and `stop` (`stop(true)` drops words not yet settled: for sending, leaving).
 */
export function useDictation(box, onText) {
    const [listening, setListening] = useState(false);
    const hear = useRef(onText);
    const self = useRef(null);

    hear.current = onText;

    if (self.current === null) {
        self.current = {
            recognition: null,
            /** Stop listening: `drop` throws away what is not settled yet, and anything heard after. */
            stop(drop = false) {
                const recognition = this.recognition;

                if (!recognition) {
                    return;
                }

                this.recognition = null;
                setListening(false);

                if (current === this) {
                    current = null;
                }

                if (drop) {
                    recognition.onresult = null;
                    recognition.abort();
                } else {
                    recognition.stop();
                }
            },
            start() {
                const element = box.current;
                const Recognition = Recognizer();

                if (!element || typeof Recognition !== "function") {
                    return;
                }

                current?.stop();
                current = this;

                const recognition = new Recognition();

                recognition.lang = navigator.language || "en-US";
                recognition.continuous = true;
                recognition.interimResults = true;
                this.recognition = recognition;

                // What the box had around the words, the results already in it, and the box as dictation left it.
                let base = null;
                let from = 0;
                let seen = 0;
                let written = null;

                const rebase = () => {
                    const focused = document.activeElement === element;
                    const at = focused ? element.selectionStart : element.value.length;
                    const end = focused ? element.selectionEnd : at;

                    base = { before: element.value.slice(0, at), after: element.value.slice(end) };
                    from = seen;
                };

                rebase();

                recognition.onresult = (event) => {
                    // Typed into meanwhile: what shows stays, and words heard from here on go where the caret is.
                    if (written !== null && element.value !== written) {
                        rebase();
                    }

                    const words = [];

                    for (let index = from; index < event.results.length; index++) {
                        words.push(event.results[index][0].transcript.trim());
                    }

                    seen = event.results.length;
                    const { value, at } = join(
                        base.before,
                        words.filter(Boolean).join(" "),
                        base.after,
                    );

                    written = value;
                    element.value = value;

                    if (document.activeElement === element) {
                        element.setSelectionRange(at, at);
                    }

                    hear.current(value, at);
                };

                recognition.onerror = (event) => {
                    // Aborted is this app's own doing; no speech for a while ends a quiet dictation, said once.
                    if (event.error !== "aborted") {
                        const level = event.error === "no-speech" ? "info" : "error";

                        notify(level, ERRORS[event.error] ?? `Dictation stopped: ${event.error}.`);
                    }
                };

                recognition.onend = () => {
                    if (this.recognition === recognition) {
                        this.stop();
                    }
                };

                try {
                    recognition.start();
                    setListening(true);
                } catch (error) {
                    this.recognition = null;
                    current = null;
                    notify("error", `Dictation did not start: ${error.message ?? error}`);
                }
            },
            toggle() {
                if (this.recognition) {
                    this.stop();
                } else {
                    this.start();
                }
            },
        };
    }

    const dictation = self.current;

    // The newest box takes the shortcut while it shows; leaving it ends dictation, as does the tab going out of sight.
    useEffect(() => {
        const hidden = () => document.hidden && dictation.stop();

        boxes.push(dictation);
        document.addEventListener("visibilitychange", hidden);

        return () => {
            boxes.splice(boxes.indexOf(dictation), 1);
            document.removeEventListener("visibilitychange", hidden);
            dictation.stop(true);
        };
    }, []);

    return {
        listening,
        toggle: () => dictation.toggle(),
        stop: (drop) => dictation.stop(drop),
    };
}

/** The mic: starts dictation, and while it listens, stops it. None where the browser cannot recognise speech. */
export function MicButton({ dictation, class: className = "", size = 17 }) {
    if (!voiceAvailable()) {
        return null;
    }

    const { listening, toggle } = dictation;

    return html`<button
        type="button"
        class=${`icon-button mic-button ${listening ? "listening" : ""} ${className}`}
        aria-label="Dictate"
        aria-pressed=${listening ? "true" : "false"}
        title=${listening ? "Listening: tap to stop (Alt V)" : "Dictate (Alt V)"}
        onMouseDown=${(event) => event.preventDefault()}
        onClick=${toggle}
    >
        <${Icon} name="mic" size=${size} />
    </button>`;
}
