import {
  CoreError,
  type CoreErrorCode,
  type DetectManagersResult,
  detectComponents,
  detectManagers,
  type GrammarViolation,
  languageFileDropPatterns,
  makeComponentId,
  makeLanguageId,
  posixSpellingViolation,
  posixWorkspaceRelativeViolation,
  readWorkspacePackages,
  type WorkspacePackage,
} from "@aburi/core"
import type { Component, Config, LanguagePlugin } from "@aburi/types"
import { CliError, errorMessage } from "../errors"
import { frameworkIdForPlugin } from "../plugin-catalog"
import type { LoadedPlugins } from "../plugin-loader"
import type { PluginNamedFramework } from "./scan-report"

export function declaredComponents(config: Partial<Config>): Config["components"] | undefined {
  const declared = config.components
  return declared !== undefined && declared.length > 0 ? declared : undefined
}

export async function resolveManagers(
  config: Partial<Config>,
  workspaceRoot: string,
): Promise<DetectManagersResult> {
  try {
    return await detectManagers(workspaceRoot, { respectGitignore: config.respectGitignore })
  } catch (error) {
    throw isUnreadableTree(error) ? componentResolutionFailure(error) : error
  }
}

// The manager scan meets the tree before the census does, so a tree neither can read is reported
// alike whichever meets it. A manifest fault the manager scan meets keeps its exit 1.
export function isUnreadableTree(error: unknown): error is CoreError {
  return error instanceof CoreError && UNREADABLE_TREE_CODES.has(error.code)
}

export async function resolveComponents(
  config: Partial<Config>,
  workspaceRoot: string,
  languages: readonly LanguagePlugin[],
): Promise<Component[]> {
  const declared = declaredComponents(config)
  try {
    if (declared !== undefined) return declared.map(componentFromConfig)
    return await detectComponents({
      workspaceRoot,
      ignore: [...(config.ignore ?? []), ...languageFileDropPatterns(languages)],
      respectGitignore: config.respectGitignore,
    })
  } catch (error) {
    throw componentResolutionFailure(error)
  }
}

export async function resolveWorkspacePackages(
  workspaceRoot: string,
  managers: DetectManagersResult,
  components: readonly Component[],
): Promise<WorkspacePackage[]> {
  const roots = [
    ...managers.workspaces.map((candidate) => candidate.relativeRoot),
    ...components.flatMap((component) => component.roots),
  ]
  try {
    return await readWorkspacePackages(workspaceRoot, roots)
  } catch (error) {
    throw componentResolutionFailure(error)
  }
}

function componentFromConfig(entry: NonNullable<Config["components"]>[number]): Component {
  const languages = (entry.languages ?? []).map(makeLanguageId)
  const component: Component = {
    id: makeComponentId(entry.id),
    name: entry.name ?? entry.id,
    roots: entry.roots.map((root) =>
      assertSpelling(root, `components[id=${entry.id}] root`, posixWorkspaceRelativeViolation),
    ),
    languages: languages.length > 0 ? languages : [makeLanguageId("ts")],
    description: entry.description ?? null,
  }
  if (entry.publicApi !== undefined && entry.publicApi.length > 0) {
    component.publicApi = entry.publicApi.map((pattern) =>
      assertSpelling(pattern, `components[id=${entry.id}] publicApi entry`, posixSpellingViolation),
    )
  }
  if (entry.frameworks !== undefined && entry.frameworks.length > 0) {
    component.frameworks = [...entry.frameworks]
  }
  return component
}

function assertSpelling(
  value: string,
  subject: string,
  violationOf: (value: string, subject: string) => GrammarViolation | null,
): string {
  const normalized = value.normalize("NFC")
  const violation = violationOf(normalized, subject)
  if (violation !== null) throw new CoreError(violation.message, violation)
  return normalized
}

function componentResolutionFailure(error: unknown): CliError {
  const configFault = error instanceof CoreError && CONFIG_COMPONENT_ERROR_CODES.has(error.code)
  return new CliError(
    `Failed to resolve components: ${errorMessage(error)}`,
    configFault ? "config-error" : "runtime-error",
    { cause: error },
  )
}

const UNREADABLE_TREE_CODES: ReadonlySet<CoreErrorCode> = new Set<CoreErrorCode>([
  "scan-gitignore-unreadable",
  "scan-directory-unreadable",
])

const CONFIG_COMPONENT_ERROR_CODES: ReadonlySet<CoreErrorCode> = new Set<CoreErrorCode>([
  "invalid-component-id",
  "invalid-language-id",
  "non-posix-path",
  "workspace-manifest-malformed",
  "workspace-root-outside",
])

export function pluginNamedFrameworks(
  config: Partial<Config>,
  registry: LoadedPlugins["registry"],
): PluginNamedFramework[] {
  const found: PluginNamedFramework[] = []
  for (const component of declaredComponents(config) ?? []) {
    for (const value of component.frameworks ?? []) {
      if (registry.findFramework(value) !== null) continue
      const manifest = registry.listPlugins().find((plugin) => plugin.name === value)
      const firstParty = frameworkIdForPlugin(value)
      if (manifest !== undefined) {
        found.push({
          component: component.id,
          value,
          frameworkIds: [...manifest.provides.frameworks],
        })
      } else if (firstParty !== undefined) {
        found.push({ component: component.id, value, frameworkIds: [firstParty] })
      }
    }
  }
  return found
}
