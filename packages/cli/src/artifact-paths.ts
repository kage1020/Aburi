import { resolve } from "node:path"

export const DIFF_JSON_FILENAME = "diff.json"
export const DIFF_MD_FILENAME = "diff.md"
export const DIFF_FULL_MD_FILENAME = "diff.full.md"
export const IR_JSON_FILENAME = "aburi.ir.json"
export const WORKSPACE_MD_FILENAME = "workspace.md"
export const COMPONENTS_DIRNAME = "components"

export const DEFAULT_OUTPUT_DIRNAME = ".aburi"

/** Lets a first scan in a repository leave `git status` clean, without an entry in the user's .gitignore. */
export const OUTPUT_DIR_GITIGNORE =
  "# Written by aburi: everything in this directory is generated.\n*\n"

export const OUTPUT_DIR_SOURCES = "--output-dir (or output.dir in the config)"

/** By place, not spelling: naming the default in the flag or the config changes nothing, as a schema default must not. */
export function isDefaultOutputDir(cwd: string, outputDir: string): boolean {
  return outputDir === resolveOutputDir(cwd, undefined)
}

export function resolveOutputDir(
  cwd: string,
  flag: string | undefined,
  configured?: string,
): string {
  return resolve(cwd, flag ?? configured ?? DEFAULT_OUTPUT_DIRNAME)
}
