/**
 * Text from elsewhere (what a session said, a check's log, a webhook's post) reaches Pi between tags, as data. Nothing
 * inside may end the fence early: every closing tag in it, in any case or spacing, loses its `<`, and attribute values
 * lose what would end them.
 */

/** Text made safe to put between tags: no closing tag of any kind survives in it. */
export function defang(text: string): string {
    return text.replace(/<(\s*\/)/g, "‹$1");
}

/** A value made safe for a tag's attribute: one line, without quotes or angle brackets. */
export function attribute(value: string): string {
    return value.replace(/[<>"\r\n]+/g, " ").trim();
}

/** Text cut to `max` characters, keeping its lines (`snippet` makes one line). */
export function clip(text: string, max: number): string {
    const trimmed = text.trim();

    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
