import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { VocabRegistry } from "@aburi/plugin-registry"
import type {
  Config,
  EffectPlugin,
  FrameworkPlugin,
  LanguagePlugin,
  PluginManifest,
} from "@aburi/types"
import { CliError } from "./errors"

export interface LoadedPlugins {
  languages: LanguagePlugin[]
  frameworks: FrameworkPlugin[]
  effects: EffectPlugin[]
  registry: VocabRegistry
}

export interface LoadPluginsOptions {
  config: Config
  /** Workspace root — used to resolve relative `./plugins/*.mjs` refs. */
  workspaceRoot: string
  /** Dynamic import hook for testing (default: real ESM import). */
  importModule?: (specifier: string) => Promise<unknown>
  /**
   * Synthetic manifests from `@aburi/config`'s `frameworkHints` normalisation. Loaded
   * straight into the registry so hint-declared vocab is available without a real plugin
   * package on disk.
   */
  syntheticPlugins?: readonly PluginManifest[]
}

/**
 * Resolve every plugin ref in `config.{languages,frameworks,effects}` to a live plugin
 * object, register its manifest with a fresh `VocabRegistry`, and bucket by type.
 *
 * A ref may be one of:
 * - manifest name (`effects-prisma`) — resolved against `node_modules` via the runtime's
 *   ESM resolver, prefixed with `@aburi/` when no scope is present.
 * - npm package (`@aburi/lang-typescript`) — resolved verbatim.
 * - relative path (`./plugins/x.mjs`) — resolved from the workspace root.
 *
 * Once imported, the loader accepts the following export shapes:
 *   1. `default` export whose value has a `manifest` field
 *   2. named `plugin` export whose value has a `manifest` field
 *   3. any top-level export whose value has a `manifest` field
 * The first hit wins. Plugin packages authored inside this monorepo use pattern 3 (named
 * plugin like `langTypescriptPlugin`) — no change to their surface is required.
 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<LoadedPlugins> {
  const registry = new VocabRegistry()
  for (const manifest of options.syntheticPlugins ?? []) registry.register(manifest)

  const languages: LanguagePlugin[] = []
  const frameworks: FrameworkPlugin[] = []
  const effects: EffectPlugin[] = []

  const importFn = options.importModule ?? defaultImport
  const refs = collectRefs(options.config)
  for (const { ref, bucket } of refs) {
    const specifier = resolveSpecifier(ref, options.workspaceRoot)
    const module = await tryImport(importFn, specifier, ref)
    const plugin = pickPlugin(module, ref)
    registry.register(plugin.manifest)
    routePlugin(plugin, bucket, languages, frameworks, effects, ref)
  }
  return { languages, frameworks, effects, registry }
}

interface RefEntry {
  ref: string
  bucket: "lang" | "framework" | "effects"
}

function collectRefs(config: Config): RefEntry[] {
  const out: RefEntry[] = []
  for (const ref of config.languages ?? []) out.push({ ref, bucket: "lang" })
  for (const ref of config.frameworks ?? []) out.push({ ref, bucket: "framework" })
  for (const ref of config.effects ?? []) out.push({ ref, bucket: "effects" })
  return out
}

function resolveSpecifier(ref: string, workspaceRoot: string): string {
  if (ref.startsWith("./") || ref.startsWith("../")) {
    return pathToFileURL(resolve(workspaceRoot, ref)).href
  }
  if (ref.startsWith("@") || ref.includes("/")) return ref
  return `@aburi/${ref}`
}

async function tryImport(
  importFn: (specifier: string) => Promise<unknown>,
  specifier: string,
  originalRef: string,
): Promise<Record<string, unknown>> {
  try {
    const value = await importFn(specifier)
    if (value === null || typeof value !== "object") {
      throw new CliError(
        `Plugin "${originalRef}" resolved to a ${typeof value}, not a module.`,
        "plugin-error",
      )
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(
      `Failed to import plugin "${originalRef}" (resolved to "${specifier}"): ${errorMessage(error)}`,
      "plugin-error",
      { cause: error },
    )
  }
}

interface AnyPlugin {
  manifest: PluginManifest
  [key: string]: unknown
}

function pickPlugin(module: Record<string, unknown>, ref: string): AnyPlugin {
  const candidates: unknown[] = []
  if ("default" in module) candidates.push(module.default)
  if ("plugin" in module) candidates.push(module.plugin)
  for (const value of Object.values(module)) candidates.push(value)
  for (const candidate of candidates) {
    if (isPluginLike(candidate)) return candidate
  }
  throw new CliError(
    `Plugin "${ref}" module has no export carrying a \`manifest\` field. Export the plugin object as default, as \`plugin\`, or under any name.`,
    "plugin-error",
  )
}

function isPluginLike(value: unknown): value is AnyPlugin {
  if (typeof value !== "object" || value === null) return false
  const manifest = (value as { manifest?: unknown }).manifest
  if (typeof manifest !== "object" || manifest === null) return false
  const name = (manifest as { name?: unknown }).name
  const type = (manifest as { type?: unknown }).type
  return typeof name === "string" && typeof type === "string"
}

function routePlugin(
  plugin: AnyPlugin,
  bucket: RefEntry["bucket"],
  languages: LanguagePlugin[],
  frameworks: FrameworkPlugin[],
  effects: EffectPlugin[],
  ref: string,
): void {
  const type = plugin.manifest.type
  if (bucket === "lang" && type !== "lang") {
    throw new CliError(
      `Plugin "${ref}" is listed under languages but its manifest declares type "${type}".`,
      "plugin-error",
    )
  }
  if (bucket === "framework" && type !== "framework") {
    throw new CliError(
      `Plugin "${ref}" is listed under frameworks but its manifest declares type "${type}".`,
      "plugin-error",
    )
  }
  if (bucket === "effects" && type !== "effects") {
    throw new CliError(
      `Plugin "${ref}" is listed under effects but its manifest declares type "${type}".`,
      "plugin-error",
    )
  }
  if (bucket === "lang") languages.push(plugin as unknown as LanguagePlugin)
  else if (bucket === "framework") frameworks.push(plugin as unknown as FrameworkPlugin)
  else effects.push(plugin as unknown as EffectPlugin)
}

async function defaultImport(specifier: string): Promise<unknown> {
  return import(specifier)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
