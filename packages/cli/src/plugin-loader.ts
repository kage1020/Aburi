import { isAbsolute, resolve, win32 } from "node:path"
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
 * - absolute path (on POSIX `/opt/plugins/x.mjs`; on Windows `C:/plugins/x.mjs`,
 *   `C:\plugins\x.mjs` or a UNC share `\\server\share\x.mjs`) — normalized, then converted to a
 *   file URL. Unlike a relative ref, where it points does not depend on `pluginRefRoot`.
 * - `file:` URL — contains `/`, so it is used verbatim, as a package subpath would be.
 *
 * A ref whose target would depend on Windows' per-drive state, or that names a Windows drive
 * where there are none, is a config error (`windowsDriveRefusal`). Every ref is resolved before
 * the first import, so a refused ref stops the run before any plugin code has run.
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
  const pluginRefRoot = options.pluginRefRoot ?? options.workspaceRoot
  const refs = (Object.keys(PLUGIN_FIELDS) as PluginField[]).flatMap((field) =>
    (options.config[field] ?? []).map((ref) => ({
      field,
      ref,
      specifier: resolveSpecifier(ref, pluginRefRoot),
    })),
  )
  for (const { field, ref, specifier } of refs) {
    const module = await tryImport(importFn, specifier, ref)
    const plugin = pickPlugin(module, ref)
    registry.register(plugin.manifest)
    routePlugin(plugin, field, loaded, ref)
  }
  return loaded
}

function resolveSpecifier(ref: string, pluginRefRoot: string): string {
  const refusal = windowsDriveRefusal(ref, process.platform, pluginRefRoot)
  if (refusal !== null) throw new CliError(refusal, "config-error")
  if (isAbsolute(ref) || ref.startsWith("./") || ref.startsWith("../")) {
    return pathToFileURL(resolve(pluginRefRoot, ref)).href
  }
  if (ref.startsWith("@") || ref.includes("/")) return ref
  return `@aburi/${ref}`
}

/**
 * Why `ref` is refused as a Windows path, or `null` when it is not. The ref is read with
 * Windows path rules on every platform, so `platform` decides only which forms are refused:
 *
 * - On Windows, a path rooted with no drive (`/opt/x.mjs`, `\x.mjs`) counts as absolute but
 *   takes the drive of `pluginRefRoot`, and a drive with no root (`C:x.mjs`) resolves against
 *   whatever directory is current on that drive. Either names a different file depending on
 *   where Aburi runs.
 * - Anywhere else, a ref naming a drive (`C:/x.mjs`, `C:\x.mjs`) cannot be loaded at all, and
 *   would otherwise reach the ESM resolver as a URL scheme or an `@aburi/` package name.
 */
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
