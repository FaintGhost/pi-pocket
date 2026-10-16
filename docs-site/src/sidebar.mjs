// The site's sidebar, by repository path. A page that is in the repository but not here fails the build, so no page
// is lost; a page here that is not in the repository fails it too, unless it is PENDING.

export const SIDEBAR = [
    {
        label: "Getting started",
        items: [
            ["docs/extensions.md", "Writing extensions"],
            ["docs/customizing.md", "Changes without code"],
        ],
    },
    {
        label: "Policies",
        items: [["SECURITY.md", "Security of Pi Pocket"]],
    },
    {
        label: "Pi Pocket's own code",
        collapsed: true,
        items: [
            ["docs/index.md", "Documentation map"],
            ["CONTRIBUTING.md", "Contributing"],
            ["docs/self-editing.md", "Changing the code"],
            ["docs/map.md", "Project map"],
            ["docs/architecture.md", "Architecture"],
            ["docs/features.md", "Features"],
        ],
    },
];

/**
 * Paths that other branches add: the reference and the types file (docs-reference), the policies and
 * CONTRIBUTING.md (extension-guidelines), and the themes guide (theming, for 0.15). Until they are merged, a link to
 * one is a warning, and the sidebar leaves it out. `npm run check` (DOCS_STRICT=1, as CI runs it) ignores this
 * list. Empty it once they are all merged.
 */
export const PENDING = [
    "docs/extensions/reference/",
    "docs/extensions/policies/",
    "docs/extensions/themes.md",
    "types/",
    "CONTRIBUTING.md",
];

/** Where sections of a page went, so the check can say where a stale link should go. */
export const MOVED = {};
