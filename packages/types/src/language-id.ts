/** The `<language>` token grammar, unanchored so that a message can quote it. */
export const LANGUAGE_ID_GRAMMAR = "[a-z][a-z0-9]*"

export const LANGUAGE_ID_PATTERN: RegExp = new RegExp(`^${LANGUAGE_ID_GRAMMAR}$`)

/** A Slice id opens with `slice:`, so a language owning the token would mint ids that read as one. */
export const RESERVED_LANGUAGE_IDS: ReadonlySet<string> = new Set(["slice"])
