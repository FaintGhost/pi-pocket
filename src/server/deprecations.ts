/**
 * Members of the extension API that are going (docs/extensions/policies/api-stability.md, "Deprecation"). To deprecate
 * a member of `host` or `web`, add a row here: a module that uses it then shows a warning in the Extensions sheet, once
 * for each version of the module. `pocket`'s members are in `DEPRECATED` in `web/extension-ui.js`.
 */
export interface Deprecation {
    /** `host.<name>` or `web.<name>`: a member of what a module's default export gets. */
    readonly member: string;
    /** The release that deprecated it, such as `0.15.0`. */
    readonly since: string;
    /** The earliest removal, such as `0.17.0, and not before 2027-02-01`. */
    readonly removal: string;
    /** What to use instead. */
    readonly use: string;
}

/** Nothing is deprecated yet. */
export const DEPRECATED: Deprecation[] = [];

/**
 * `target` (`host` or `web`) as a module gets it: the same members, but a deprecated one tells `used` each time it is
 * read. While none of its members is deprecated, `target` itself.
 */
export function watchDeprecated<T extends object>(
    target: T,
    prefix: "host" | "web",
    used: (deprecation: Deprecation) => void,
): T {
    const rows = DEPRECATED.filter(
        (row) =>
            row.member.startsWith(`${prefix}.`) && row.member.slice(prefix.length + 1) in target,
    );

    if (rows.length === 0) {
        return target;
    }

    const members: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(target);

    for (const row of rows) {
        const name = row.member.slice(prefix.length + 1);

        members[name] = {
            enumerable: true,
            get: () => {
                used(row);

                return Reflect.get(target, name);
            },
        };
    }

    const view = Object.create(Object.getPrototypeOf(target), members) as T;

    return Object.isFrozen(target) ? Object.freeze(view) : view;
}
