import type { WarnFn } from "../warn"
import type { GitRunner } from "./runner"

export async function submoduleIgnorePatterns(
  git: GitRunner,
  workspaceRoot: string,
  warn: WarnFn,
): Promise<string[]> {
  const { stdout } = await git.run(["ls-files", "-z", "--stage"], { cwd: workspaceRoot })
  const paths = parseSubmodulePaths(stdout)
  if (paths.length === 0) return []
  warn(
    `⚠ Submodules detected: ${paths.join(", ")}. Submodule-aware diff is not yet supported, so their files are left out of both file scans. Component detection still walks them, so a workspace package inside one can still be reported as a Component added or removed.`,
  )
  return paths.map((path) => `${escapeGlob(path)}/**`)
}

export function parseSubmodulePaths(stdout: string): string[] {
  const paths = new Set<string>()
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t")
    if (tab === -1) continue
    if (!record.startsWith("160000 ")) continue
    paths.add(record.slice(tab + 1))
  }
  return [...paths].sort()
}

function escapeGlob(path: string): string {
  return path.replace(/[\\()[\]{}*?|!+@]/g, "\\$&")
}
