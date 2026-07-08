import { type ScanInput, type ScanResult, scan } from "@aburi/core"
import { nestEffectsPlugin } from "@aburi/effects-nest"
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { Config } from "@aburi/types"

/**
 * Drive `@aburi/core`'s `scan` with the workspace plugins wired straight from disk.
 *
 * The CLI's `runScan` normally resolves plugin names against the fixture's
 * `node_modules` — but the fixture is copied to a tmpdir with no `node_modules`, so
 * `runScan` would fail resolution. Using the low-level API instead lets us keep the
 * fixture free of a synthetic install step while still exercising the exact same
 * scan pipeline the CLI uses (discovery → parse → classify → drop → fingerprint →
 * integrity). Plugin-name resolution is already covered by
 * `packages/cli/test/plugin-loader.test.ts`.
 */
export async function scanFixture(workspaceRoot: string, config: Config = {}): Promise<ScanResult> {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  registry.register(nestjsFrameworkPlugin.manifest)
  registry.register(nestEffectsPlugin.manifest)

  const input: ScanInput = {
    workspaceRoot,
    config,
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
    effects: [nestEffectsPlugin],
    registry,
  }
  return scan(input)
}
