export const LANGUAGE_ID_PATTERN = /^[a-z][a-z0-9]*$/

/** A Slice id opens with `slice:`, so a language owning the token would mint ids that read as one. */
export const RESERVED_LANGUAGE_IDS: ReadonlySet<string> = new Set(["slice"])
