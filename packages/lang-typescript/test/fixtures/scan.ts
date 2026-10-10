import type { ScanResult } from "@aburi/core"
import { scanWith } from "@aburi/test-harness"
import type { Config } from "@aburi/types"
import { langTypescriptPlugin } from "../../src/index"

/** A real scan of `workspaceRoot` with this plugin as the only one. */
export function scanTypeScript(workspaceRoot: string, config: Config = {}): Promise<ScanResult> {
  return scanWith(workspaceRoot, { languages: [langTypescriptPlugin] }, config)
}
