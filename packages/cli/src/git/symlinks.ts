import { joinCapped } from "../listing"
import type { WarnFn } from "../warn"
import type { GitRunner } from "./runner"

export async function warnOnPlainFileLinks(
  git: GitRunner,
  workspaceRoot: string,
  baseRef: string,
  warn: WarnFn,
): Promise<void> {
  // `true` is git's own default: unset, it creates the link, and fails loudly where it cannot.
  const { stdout: symlinks } = await git.run(
    ["config", "--bool", "--default", "true", "core.symlinks"],
    { cwd: workspaceRoot },
  )
  if (symlinks.trim() !== "false") return
  // From the workspace root and without --full-tree, so the paths are the ones the base scan walks.
  const { stdout } = await git.run(["ls-tree", "-r", "-z", baseRef], { cwd: workspaceRoot })
  const links = parseLinkPaths(stdout)
  if (links.length === 0) return
  warn(
    `⚠ The base ref "${baseRef}" holds ${links.length} symbolic link(s): ${joinCapped(links)}. ` +
      "core.symlinks is false, so git checks each out in the base worktree as a plain file holding the link's target, " +
      "and the base scan reads one with a source extension as source, where it passes over a link. " +
      "A working tree checked out the same way is read the same on the head side. " +
      "Set core.symlinks to true where links can be created (on Windows, with Developer Mode) to keep them links.",
  )
}

export function parseLinkPaths(stdout: string): string[] {
  const paths: string[] = []
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t")
    if (tab === -1 || !record.startsWith("120000 ")) continue
    paths.push(record.slice(tab + 1))
  }
  return paths.sort()
}
