---
"@aburi/lang-typescript": patch
---

An `import("…")` type in a call's type arguments or before `[]` no longer breaks the parse

The grammar reads `import("./m")` as a call, so `importActual<typeof import("./m")>()` — how
`vi.mock` keeps a module's originals — and `import("./m").Rule[]` were recoverable parse errors,
and at module level `export const b = g<typeof import("./m")>()` took the declaration after it
down too. Such a file is now parsed once more with each of those `import(…)` replaced by a name of
the same length, and the tree still reads the original text. Files that carried only this error
leave the recoverable-parse-error listing.
