import { isAbsolute, resolve, win32 } from "node:path"
import { pathToFileURL } from "node:url"
import { RegistryError, VocabRegistry } from "@aburi/plugin-registry"
import type {
  Config,
  EffectPlugin,
  FrameworkPlugin,
  LanguagePlugin,
  PluginManifest,
} from "@aburi/types"
import { assertNever, CliError, errorMessage } from "./errors"
import { pluginForDetectorId } from "./plugin-catalog"

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
  workspaceRoot: string
  pluginRefRoot?: string
  importModule?: (specifier: string) => Promise<unknown>
  syntheticPlugins?: readonly FrameworkPlugin[]
}

export async function loadPlugins(options: LoadPluginsOptions): Promise<LoadedPlugins> {
  const registry = new VocabRegistry()
  const loaded: LoadedPlugins = { languages: [], frameworks: [], effects: [], registry }
  const importFn = options.importModule ?? defaultImport
  const pluginRefRoot = options.pluginRefRoot ?? options.workspaceRoot
  const refs = (Object.keys(PLUGIN_FIELDS) as PluginField[]).flatMap((field) =>
    (options.config[field] ?? []).map((ref) => ({
      field,
      ref,
      specifier: resolveSpecifier(ref, field, pluginRefRoot),
    })),
  )
  for (const { field, ref, specifier } of refs) {
    const module = await tryImport(importFn, specifier, ref)
    const plugin = pickPlugin(module, ref)
    registerManifest(registry, plugin.manifest)
    routePlugin(plugin, field, loaded, ref)
  }
  for (const plugin of options.syntheticPlugins ?? []) {
    registerHint(registry, plugin.manifest)
    loaded.frameworks.push(plugin)
  }
  return loaded
}

function resolveSpecifier(ref: string, field: PluginField, pluginRefRoot: string): string {
  const refusal =
    windowsDriveRefusal(ref, process.platform, pluginRefRoot) ?? detectorIdRefusal(ref, field)
  if (refusal !== null) throw new CliError(refusal, "config-error")
  if (isAbsolute(ref) || ref.startsWith("./") || ref.startsWith("../")) {
    return pathToFileURL(resolve(pluginRefRoot, ref)).href
  }
  if (ref.startsWith("@") || ref.includes("/")) return ref
  return `@aburi/${ref}`
}

const NAME_PREFIX = {
  languages: "lang-",
  frameworks: "framework-",
  effects: "effects-",
} as const satisfies Record<PluginField, string>

export function detectorIdRefusal(ref: string, field: PluginField): string | null {
  if (!/^[a-z][a-z0-9]*$/.test(ref)) return null
  const prefix = NAME_PREFIX[field]
  const plugin = field === "effects" ? `${prefix}${ref}` : pluginForDetectorId(field, ref)
  const fix =
    plugin === undefined
      ? "Write the plugin's manifest name, its package id or a path to it."
      : `Write "${plugin}".`
  return `Plugin "${ref}" in "${field}" is not a plugin name: a bare name resolves to "@aburi/${ref}", and the plugins there are named "${prefix}<name>". ${fix}`
}

export function windowsDriveRefusal(
  ref: string,
  platform: NodeJS.Platform,
  pluginRefRoot: string,
): string | null {
  const { root } = win32.parse(ref)
  const drive = /^[A-Za-z]:/.exec(root)?.[0]
  const rest = ref.slice(root.length).replaceAll("\\", "/").replace(/^\/+/, "")
  if (platform !== "win32") {
    if (drive === undefined) return null
    return `Plugin "${ref}" names the Windows drive ${drive}, which this platform does not have. Write a path that exists here, or one relative to the workspace root starting with "./".`
  }
  if (root === "/" || root === "\\") {
    const base = win32.parse(win32.resolve(pluginRefRoot)).root.replaceAll("\\", "/")
    return `Plugin "${ref}" names no drive, so it would take the drive of the workspace root. Write the drive in: "${base}${rest}".`
  }
  if (drive !== undefined && root === drive) {
    return `Plugin "${ref}" names drive ${drive} but does not start at its root, so it would resolve against whatever directory is current on that drive. Start it at the root: "${drive}/${rest}".`
  }
  return null
}

function registerHint(registry: VocabRegistry, manifest: PluginManifest): void {
  try {
    registry.registerHint(manifest)
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error
    const [entry] = manifest.provides.frameworks
    throw new CliError(
      `frameworkHints entry "${entry}" cannot be registered: ${error.message}`,
      "config-error",
      { cause: error },
    )
  }
}

function registerManifest(registry: VocabRegistry, manifest: PluginManifest): void {
  try {
    registry.register(manifest)
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error
    throw new CliError(error.message, "plugin-error", { cause: error })
  }
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
      assertNever(field, "plugin field")
  }
}

async function defaultImport(specifier: string): Promise<unknown> {
  return import(specifier)
}
