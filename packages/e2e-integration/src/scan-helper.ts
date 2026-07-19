import { type ScanInput, type ScanResult, scan } from "@aburi/core"
import { nestEffectsPlugin } from "@aburi/effects-nest"
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { Config, EffectPlugin, FrameworkPlugin, LanguagePlugin } from "@aburi/types"

/**
 * Overlay lets a scenario add plugins on top of the default workspace lineup
 * without duplicating the boilerplate. Scenario D layers `prismaEffectsPlugin`
 * over `nestEffectsPlugin` to exercise transitive `db.write` propagation from
 * a Prisma repository up through a Nest service into a boundary controller.
 */
export interface ScanFixturePluginOverlay {
  effects?: readonly EffectPlugin[]
  frameworks?: readonly FrameworkPlugin[]
  languages?: readonly LanguagePlugin[]
}

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
export async function scanFixture(
  workspaceRoot: string,
  config: Config = {},
  overlay: ScanFixturePluginOverlay = {},
): Promise<ScanResult> {
  const languages: LanguagePlugin[] = [langTypescriptPlugin, ...(overlay.languages ?? [])]
  const frameworks: FrameworkPlugin[] = [nestjsFrameworkPlugin, ...(overlay.frameworks ?? [])]
  const effects: EffectPlugin[] = [nestEffectsPlugin, ...(overlay.effects ?? [])]

  const registry = new VocabRegistry()
  for (const plugin of languages) registry.register(plugin.manifest)
  for (const plugin of frameworks) registry.register(plugin.manifest)
  for (const plugin of effects) registry.register(plugin.manifest)

  const input: ScanInput = {
    workspaceRoot,
    config,
    languages,
    frameworks,
    effects,
    registry,
  }
  return scan(input)
}
