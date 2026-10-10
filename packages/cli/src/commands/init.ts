import { resolve } from "node:path"
import {
  CoreError,
  detectComponents,
  detectManagers,
  type UnresolvedDeclaration,
} from "@aburi/core"
import type { Config } from "@aburi/types"
import { CliError, errorMessage } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { pathKind } from "../fs-probe"
import { outputIsADirectory, writeOutputFile } from "../output-file"
import { FRAMEWORK_TO_PLUGIN, LANGUAGE_TO_PLUGIN } from "../plugin-catalog"
import { resolveWorkspaceRoot } from "../workspace-root"

const CONFIG_ARTEFACT = "the config"

const CONFIG_SCHEMA_URL = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

export interface InitOptions {
  respectGitignore?: boolean
  cwd?: string
  output?: string
  force?: boolean
  withSuggestions?: boolean
}

export interface InitReport {
  outputPath: string
  workspaceRoot: string
  detectedManagers: string[]
  detectedLanguages: string[]
  detectedFrameworks: string[]
  componentCount: number
  suggestedPlugins: readonly string[]
  unmappedLanguages: readonly string[]
  unresolvedDeclarations: readonly UnresolvedDeclaration[]
  fellBackToSingleComponent: boolean
  unmappedFrameworks: readonly string[]
  overwrote: boolean
  exitCode: ExitCode
}

export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)
  const outputPath = resolve(cwd, options.output ?? "aburi.json")

  const existing = await pathKind(outputPath)
  if (existing === "directory") {
    throw outputIsADirectory({ command: "init", artefact: CONFIG_ARTEFACT, path: outputPath })
  }
  if (existing === "file" && !options.force) {
    throw new CliError(
      `${outputPath} already exists. Use --force to overwrite or pass --output <path> to write elsewhere.`,
      "input-error",
    )
  }

  const managers = await detectManagers(workspaceRoot)
  let components: Awaited<ReturnType<typeof detectComponents>>
  try {
    components = await detectComponents({
      workspaceRoot,
      ...(options.respectGitignore === undefined
        ? {}
        : { respectGitignore: options.respectGitignore }),
    })
  } catch (error) {
    throw new CliError(
      `Failed to detect components: ${errorMessage(error)}${gitignoreEscapeHatch(error)}`,
      error instanceof CoreError && error.code === "scan-gitignore-unreadable"
        ? "runtime-error"
        : "config-error",
      { cause: error },
    )
  }

  const languageSet = new Set<string>()
  const frameworkSet = new Set<string>()
  for (const component of components) {
    for (const language of component.languages) languageSet.add(language)
    for (const framework of component.frameworks ?? []) frameworkSet.add(framework)
  }

  const suggestions = options.withSuggestions ? suggestPluginsFor(languageSet, frameworkSet) : []
  const contents = renderConfig({
    languages: pluginRefsFor(languageSet, LANGUAGE_TO_PLUGIN),
    frameworks: pluginRefsFor(frameworkSet, FRAMEWORK_TO_PLUGIN),
    components: components.map((component) => ({
      id: component.id,
      name: component.name,
      roots: [...component.roots].sort(),
      languages: [...component.languages].sort(),
      frameworks: [...(component.frameworks ?? [])].sort(),
    })),
    suggestions,
  })

  await writeOutputFile({ command: "init", artefact: CONFIG_ARTEFACT, path: outputPath }, contents)

  return {
    outputPath,
    workspaceRoot,
    detectedManagers: managers.managers.map((manager) => manager.tool),
    detectedLanguages: [...languageSet].sort(),
    detectedFrameworks: [...frameworkSet].sort(),
    componentCount: components.length,
    suggestedPlugins: suggestions,
    unmappedLanguages: unmappedIds(languageSet, LANGUAGE_TO_PLUGIN),
    unmappedFrameworks: unmappedIds(frameworkSet, FRAMEWORK_TO_PLUGIN),
    unresolvedDeclarations: managers.unresolved,
    fellBackToSingleComponent: managers.workspaces.length === 0,
    overwrote: existing === "file",
    exitCode: EXIT.SUCCESS,
  }
}

function pluginRefsFor(
  detected: ReadonlySet<string>,
  table: ReadonlyMap<string, string>,
): string[] {
  const out = new Set<string>()
  for (const id of detected) {
    const ref = table.get(id)
    if (ref !== undefined) out.add(ref)
  }
  return [...out].sort()
}

function suggestPluginsFor(
  languages: ReadonlySet<string>,
  frameworks: ReadonlySet<string>,
): string[] {
  return [
    ...pluginRefsFor(languages, LANGUAGE_TO_PLUGIN),
    ...pluginRefsFor(frameworks, FRAMEWORK_TO_PLUGIN),
  ].map((name) => `@aburi/${name}`)
}

function unmappedIds(detected: ReadonlySet<string>, table: ReadonlyMap<string, string>): string[] {
  return [...detected].filter((id) => !table.has(id)).sort()
}

interface RenderedConfigInput {
  languages: readonly string[]
  frameworks: readonly string[]
  components: readonly {
    id: string
    name: string
    roots: readonly string[]
    languages: readonly string[]
    frameworks: readonly string[]
  }[]
  suggestions: readonly string[]
}

function renderConfig(input: RenderedConfigInput): string {
  const config: Partial<Config> & { $schema: string } = {
    $schema: CONFIG_SCHEMA_URL,
    languages: [...input.languages],
    frameworks: [...input.frameworks],
    components: input.components.map((component) => ({
      id: component.id,
      name: component.name,
      roots: [...component.roots],
      languages: [...component.languages],
      frameworks: [...component.frameworks],
    })),
  }
  const json = JSON.stringify(config, null, 2)
  if (input.suggestions.length === 0) return `${json}\n`
  const banner = input.suggestions
    .map((suggestion) => `// Suggested install: pnpm add -D ${suggestion}`)
    .join("\n")
  const insertion = `\n  ${banner.split("\n").join("\n  ")}`
  return `${json.replace("{\n", `{${insertion}\n`)}\n`
}

function gitignoreEscapeHatch(error: unknown): string {
  if (!(error instanceof CoreError) || error.code !== "scan-gitignore-unreadable") return ""
  return " Pass --no-respect-gitignore to detect components without reading it."
}
