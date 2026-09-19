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
import { assertNever, CliError, errorMessage } from "./errors"

/** Every field of the config that lists plugin refs, and the manifest type each must declare. */
const PLUGIN_FIELDS = {
  languages: "lang",
  frameworks: "framework",
  effects: "effects",
} as const satisfies Record<keyof LoadedPlugins & keyof Config, PluginManifest["type"]>

type PluginField = keyof typeof PLUGIN_FIELDS

export interface LoadedPlugins {
  languages: LanguagePlugin[]
  frameworks: FrameworkPlugin[]
  effects: EffectPlugin[]
  registry: VocabRegistry
}

export interface LoadPluginsOptions {
  config: Config
  /** Workspace root — the base for everything the scan reads out of the config. */
  workspaceRoot: string
  /**
   * Where a relative `./plugins/*.mjs` ref resolves from. Defaults to `workspaceRoot`, and
   * differs from it only for `aburi diff`'s base scan, whose config comes from the head tree
   * while its workspace root is the temporary worktree (`cli-spec.md`, plugin resolution at the
   * base ref).
   */
  pluginRefRoot?: string
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
 * - relative path (`./plugins/x.mjs`) — resolved from `pluginRefRoot`, which is the
 *   workspace root unless the caller says otherwise.
 *
 * Once imported, the loader accepts the following export shapes, first hit wins:
 *   1. `default` export whose value has a `manifest` field
 *   2. named `plugin` export whose value has a `manifest` field
 *   3. any top-level export whose value has a `manifest` field
 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<LoadedPlugins> {
  const registry = new VocabRegistry()
  for (const manifest of options.syntheticPlugins ?? []) registry.register(manifest)

  const loaded: LoadedPlugins = { languages: [], frameworks: [], effects: [], registry }
  const importFn = options.importModule ?? defaultImport
  for (const field of Object.keys(PLUGIN_FIELDS) as PluginField[]) {
    for (const ref of options.config[field] ?? []) {
      const specifier = resolveSpecifier(ref, options.pluginRefRoot ?? options.workspaceRoot)
      const module = await tryImport(importFn, specifier, ref)
      const plugin = pickPlugin(module, ref)
      registry.register(plugin.manifest)
      routePlugin(plugin, field, loaded, ref)
    }
  }
  return loaded
}

function resolveSpecifier(ref: string, pluginRefRoot: string): string {
  if (ref.startsWith("./") || ref.startsWith("../")) {
    return pathToFileURL(resolve(pluginRefRoot, ref)).href
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
  field: PluginField,
  into: LoadedPlugins,
  ref: string,
): void {
  const type = plugin.manifest.type
  if (type !== PLUGIN_FIELDS[field]) {
    throw new CliError(
      `Plugin "${ref}" is listed under ${field} but its manifest declares type "${type}".`,
      "plugin-error",
    )
  }
  switch (field) {
    case "languages":
      into.languages.push(plugin as unknown as LanguagePlugin)
      break
    case "frameworks":
      into.frameworks.push(plugin as unknown as FrameworkPlugin)
      break
    case "effects":
      into.effects.push(plugin as unknown as EffectPlugin)
      break
    default:
      // A fourth plugin-bearing config field is a type error here rather than a ref the loader
      // accepts, reports nothing about, and then never hands to the scan.
      assertNever(field, "plugin field")
  }
}

async function defaultImport(specifier: string): Promise<unknown> {
  return import(specifier)
}
