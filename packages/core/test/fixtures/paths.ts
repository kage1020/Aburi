export type PathExpectation = { ok: true } | { ok: false; reason: string }

export interface WorkspacePathCase {
  path: string
  /** As a component or workspace-manager root, or any other path a Document records. */
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
    path: "src/v#1/util.ts",
    root: ok,
    symbolPath: no("Symbol id separators"),
    why: "a directory's name holds a separator as readily as a file's",
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
