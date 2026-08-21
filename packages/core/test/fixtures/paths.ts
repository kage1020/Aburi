/**
 * Path cases and what each of the two path grammars says about them.
 *
 * The Symbol id constructor and IR integrity invariant #10 ask overlapping questions about
 * the same strings — one about a path Aburi is about to write, one about a path it read
 * back off disk — so both suites drive off this single list. A rule that reaches one side
 * and not the other fails here, rather than surfacing as an IR that satisfies every
 * invariant while holding a path that names somewhere outside the workspace.
 *
 * The two grammars are *not* the same, which is why every case states both outcomes rather
 * than one shared verdict:
 *
 * - `root` is the shared rule, as applied to `components[].roots` and
 *   `workspace.managers[].roots`. A root may be `.` (the workspace root itself) and may
 *   hold `:` or `#`, because nothing splits a root on anything.
 * - `symbolPath` is that rule plus what the id adds. A `symbols[].source.file` is never a
 *   directory, so `.` is out, and it may not hold the id's own `:` / `#` separators,
 *   because the id is split on the first of each.
 *
 * `reason` is a fragment of the rejection message. Asserting the code alone would let a
 * case pass for the wrong reason — `C:notabs.ts` is refused by two different clauses with
 * one shared code, so a narrower absolute-path pattern would still leave every assertion
 * green.
 */
export type PathExpectation = { ok: true } | { ok: false; reason: string }

export interface WorkspacePathCase {
  path: string
  /** As a component root or a workspace-manager root. */
  root: PathExpectation
  /** As a `symbols[].source.file`, and as the file segment of the id built from it. */
  symbolPath: PathExpectation
  /** Why the case is here, for the failure message when a side disagrees. */
  why: string
}

const ok: PathExpectation = { ok: true }
const no = (reason: string): PathExpectation => ({ ok: false, reason })

export const WORKSPACE_PATH_CASES: readonly WorkspacePathCase[] = [
  { path: "src/a.ts", root: ok, symbolPath: ok, why: "the ordinary shape" },
  { path: "apps/billing/src", root: ok, symbolPath: ok, why: "a directory, not a file" },
  {
    path: "src/a..b.ts",
    root: ok,
    symbolPath: ok,
    why: "two dots inside a segment are not an ascent",
  },
  {
    path: ".",
    root: ok,
    symbolPath: no("names the workspace root"),
    why: "the root component's root, and never a source file",
  },
  {
    path: "src/a:b.ts",
    root: ok,
    symbolPath: no("Symbol id separators"),
    why: "a root is not split on anything; an id is split on the first colon",
  },
  {
    path: "src/a#b.ts",
    root: ok,
    symbolPath: no("Symbol id separators"),
    why: "likewise for the hash",
  },
  {
    path: "",
    root: no("is empty"),
    symbolPath: no("is empty"),
    why: "an empty path names nothing",
  },
  {
    path: "src\\a.ts",
    root: no("contains a backslash"),
    symbolPath: no("contains a backslash"),
    why: "backslashes are not POSIX separators",
  },
  {
    path: "src/weird\\name.ts",
    root: no("contains a backslash"),
    symbolPath: no("contains a backslash"),
    why: "a legal POSIX filename character the Document has no spelling for, refused rather than rewritten into a separator",
  },
  {
    path: "\\abs\\a.ts",
    root: no("contains a backslash"),
    symbolPath: no("contains a backslash"),
    why: "a leading backslash is absolute on Windows, and the backslash is reported first",
  },
  {
    path: "/abs/a.ts",
    root: no("is absolute"),
    symbolPath: no("is absolute"),
    why: "absolute POSIX path",
  },
  {
    path: "C:/abs/a.ts",
    root: no("is absolute"),
    symbolPath: no("is absolute"),
    why: "absolute Windows path",
  },
  {
    path: "C:notabs.ts",
    root: no("is absolute"),
    symbolPath: no("is absolute"),
    why: "drive-relative Windows path — absolute, not merely colon-bearing",
  },
  {
    path: "../escape/a.ts",
    root: no('".." segment'),
    symbolPath: no('".." segment'),
    why: "leaves the workspace",
  },
  {
    path: "src/../../etc/passwd.ts",
    root: no('".." segment'),
    symbolPath: no('".." segment'),
    why: "leaves the workspace after descending",
  },
  {
    path: "src/..",
    root: no('".." segment'),
    symbolPath: no('".." segment'),
    why: "ascends in the final segment",
  },
  {
    path: "./src/a.ts",
    root: no('"." segment'),
    symbolPath: no('"." segment'),
    why: "a second spelling of src/a.ts, which would give one file two ids",
  },
  {
    path: "src/./a.ts",
    root: no('"." segment'),
    symbolPath: no('"." segment'),
    why: "the same, in the middle",
  },
]
