import { resolve } from "node:path"

export const DIFF_JSON_FILENAME = "diff.json"
export const DIFF_MD_FILENAME = "diff.md"
export const DIFF_FULL_MD_FILENAME = "diff.full.md"
export const IR_JSON_FILENAME = "aburi.ir.json"
export const WORKSPACE_MD_FILENAME = "workspace.md"
export const COMPONENTS_DIRNAME = "components"

export const DEFAULT_OUTPUT_DIRNAME = "out"

export const OUTPUT_DIR_SOURCES = "--output-dir (or output.dir in the config)"

export function resolveOutputDir(
  cwd: string,
  flag: string | undefined,
  configured?: string,
): string {
  return resolve(cwd, flag ?? configured ?? DEFAULT_OUTPUT_DIRNAME)
}
