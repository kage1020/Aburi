/**
 * Workspace-relative POSIX path cases, and whether the shared rule refuses each one.
 *
 * The Symbol id constructor and IR integrity invariant #10 ask the same question about the
 * same strings — one about a path Aburi is about to write, one about a path it read back
 * off disk — so both suites drive off this single list. A rule that reaches one side and
 * not the other fails here, rather than surfacing as an IR that satisfies every invariant
 * while holding a path that points outside the workspace.
 *
 * The two Symbol id separators (`:` and `#`) are deliberately absent: refusing them is a
 * property of the id's own structure, not of workspace-relative paths, so it belongs to the
 * constructor alone and is asserted there.
 */
export interface WorkspacePathCase {
  path: string
  rejected: boolean
  /** Why the case is here, for the failure message when one side disagrees. */
  why: string
}

export const WORKSPACE_PATH_CASES: readonly WorkspacePathCase[] = [
  { path: "src/a.ts", rejected: false, why: "the ordinary shape" },
  { path: ".", rejected: false, why: "the root component's root" },
  { path: "./src/a.ts", rejected: false, why: "a leading single dot is not an ascent" },
  { path: "apps/billing/src", rejected: false, why: "a directory, not a file" },
  { path: "src/a..b.ts", rejected: false, why: "two dots inside a segment are not an ascent" },
  { path: "", rejected: true, why: "an empty path names nothing" },
  { path: "src\\a.ts", rejected: true, why: "backslashes are not POSIX separators" },
  { path: "\\abs\\a.ts", rejected: true, why: "a leading backslash is absolute on Windows" },
  { path: "/abs/a.ts", rejected: true, why: "absolute POSIX path" },
  { path: "C:/abs/a.ts", rejected: true, why: "absolute Windows path" },
  { path: "C:notabs.ts", rejected: true, why: "drive-relative Windows path" },
  { path: "../escape/a.ts", rejected: true, why: "ascends out of the workspace" },
  { path: "src/../../etc/passwd.ts", rejected: true, why: "ascends after descending" },
  { path: "src/..", rejected: true, why: "ascends in the final segment" },
]
