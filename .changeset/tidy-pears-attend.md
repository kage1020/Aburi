---
"@aburi/core": minor
"@aburi/cli": minor
---

Give paths and qualified names one grammar, applied everywhere they are read

Four places asked overlapping questions about the same strings and answered differently, so
a value could pass every gate and break something that trusted it.

**One path rule.** IR integrity invariant #10 carried its own copy of the workspace-relative
path rule, and that copy checked only backslashes and absolute prefixes. An IR whose
`symbols[].source.file` read `../../../../etc/passwd.ts` — or whose `components[].roots` /
`workspace.managers[].roots` pointed above the workspace — produced zero violations, while
`readIR` uses `assertIRIntegrity` as its only validation gate. `workspace.root` anchors every
path in a Document, so a path that ascends past it names something the Document has no way
to be about. Invariant #10 now calls `posixWorkspaceRelativeViolation`, the rule the Symbol
id constructor calls, and the shared rule additionally rejects an empty path, a
drive-relative `C:a.ts`, and a `.` segment — `./src/a.ts` beside `src/a.ts` is one file with
two spellings, and by §3.1 that is one file with two Symbol ids that invariant #1 cannot see
as a duplicate.

A file path keeps the two restrictions that belong to the id rather than to the path: it
holds neither `:` nor `#` (the id is split on the first of each), and it is never the bare
`.`, which names the workspace root. `toPosixRelative` applies those too, since everything
it returns becomes a `source.file` and the file segment of an id.

**One qualified-name rule, applied to both places one is stored.** `makeSymbolId` dropped
empty segments before validating them, so `A.`, `A..B`, `.` and `::` all built ids and
satisfied `isSymbolId`. Separately, `Symbol.name` carries a qualified name of its own and
nothing checked it at all — and it, not the qname inside the id, is what `apiFingerprint`
and the framework classifiers hand to `lastQnameSegment`, which throws on an empty leaf.
Both are now covered: the constructor refuses an empty segment, and invariant #17 checks
`symbols[].name` alongside `symbols[].id`.

**Producers that could break the tightened rules.** Two existed, and both now report against
the input rather than the Document:

- Glob patterns may ascend (`packages: ['../shared/*']`), and the matches became
  `workspace.managers[].roots` entries containing `..`. The file walk never followed them —
  it globs under the workspace root — so those packages contributed no Symbol, and the entry
  described a directory the scan never opened. `detectManagers` now refuses such a manifest
  with `workspace-root-outside`, naming the tool and the root. Continuing would have produced
  a Document silently missing packages the user declared.
- The config schema's `RelativePath` constrains only `minLength` and "no backslash", so a
  `components[].roots` entry of `"../shared"` was schema-valid and copied into the IR
  verbatim. It is now checked where the config is read, so it is reported against
  `components[id=…].roots` in the config with the input-error exit code, instead of
  surfacing as an integrity violation blaming the Document at the end of the scan.

Workspace and component roots are also normalized to Unicode NFC, matching
`symbols[].source.file`, so one directory is not spelled two ways within one Document.

`@aburi/core` newly exports `posixWorkspaceRelativeViolation`, `isQualifiedName` and the
`GrammarViolation` type, so a consumer building an IR can apply the same rules the integrity
checker will.
