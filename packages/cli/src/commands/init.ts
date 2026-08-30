import { access, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  CoreError,
  detectComponents,
  detectManagers,
  detectWorkspaceRoot,
  type UnresolvedDeclaration,
} from "@aburi/core"
import type { Config } from "@aburi/types"
import { CliError, errorMessage } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"

const CONFIG_SCHEMA_URL = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

export interface InitOptions {
  /**
   * Whether to honour `.gitignore` while counting a component's languages. Absent means the
   * default, which is to honour it — `aburi scan` reads this from the config, and this command
   * runs before there is one.
   */
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
  /**
   * Detected language ids with no first-party plugin. Non-empty means the written config
   * names no language plugin, so `aburi scan` cannot parse anything and will say so.
   */
  unmappedLanguages: readonly string[]
  /**
   * Manifests that declared package patterns and resolved none of them.
   *
   * The config this command writes describes the workspace it found, so a manifest that named
   * packages and produced none makes that description wrong before it is ever read — and
   * `components[]` is the one part of it a reader cannot check against anything else.
   */
  unresolvedDeclarations: readonly UnresolvedDeclaration[]
  /** Whether the written config's single component is the whole repository, for want of any. */
  fellBackToSingleComponent: boolean
  /** Detected framework ids with no first-party plugin; classification is simply narrower. */
  unmappedFrameworks: readonly string[]
  overwrote: boolean
  exitCode: ExitCode
}

/**
 * §4 — `aburi init`. Runs the autodetect chain (workspace root → managers → components),
 * writes an `aburi.json` (or the caller's `--output` path), and returns a structured
 * report so tests can assert on outcome without parsing stdout.
 *
 * Refuses to overwrite an existing file unless `--force` is set; the design (§4.4) uses
 * `exit 2` for that branch, mirrored here through the `InputError` -> `EXIT.INPUT_ERROR`
 * bridge in the caller.
 */
export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)
  const outputPath = resolve(cwd, options.output ?? "aburi.json")

  const existed = await pathExists(outputPath)
  if (existed && !options.force) {
    throw new CliError(
      `${outputPath} already exists. Use --force to overwrite or pass --output <path> to write elsewhere.`,
      "input-error",
    )
  }

  const managers = await detectManagers(workspaceRoot)
  // Same wrapping rationale as `resolveComponents` in scan.ts: an id the detection cannot
  // derive is a property of the project, and belongs in the input-error exit code.
  //
  // There is no config to read `respectGitignore` from — this command is what writes the first
  // one — so the flag is the only way to say it, and honouring `.gitignore` is the default
  // because a vendored or generated tree otherwise skews the languages of the config being
  // generated.
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
  for (const c of components) for (const l of c.languages) languageSet.add(l)
  const frameworkSet = new Set<string>()
  for (const c of components) for (const f of c.frameworks ?? []) frameworkSet.add(f)

  const suggestions = options.withSuggestions ? suggestPluginsFor(languageSet, frameworkSet) : []
  const contents = renderConfig({
    languages: pluginRefsFor(languageSet, LANGUAGE_TO_PLUGIN),
    frameworks: pluginRefsFor(frameworkSet, FRAMEWORK_TO_PLUGIN),
    components: components.map((c) => ({
      id: c.id,
      name: c.name,
      roots: [...c.roots].sort(),
      languages: [...c.languages].sort(),
      frameworks: [...(c.frameworks ?? [])].sort(),
    })),
    suggestions,
  })

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, contents, "utf8")

  return {
    outputPath,
    workspaceRoot,
    detectedManagers: managers.managers.map((m) => m.tool),
    detectedLanguages: [...languageSet].sort(),
    detectedFrameworks: [...frameworkSet].sort(),
    componentCount: components.length,
    suggestedPlugins: suggestions,
    unmappedLanguages: unmappedIds(languageSet, LANGUAGE_TO_PLUGIN),
    unmappedFrameworks: unmappedIds(frameworkSet, FRAMEWORK_TO_PLUGIN),
    unresolvedDeclarations: managers.unresolved,
    // `aburi init` has no `components[]` to defer to — it is the command that writes the
    // first one — so an empty candidate list is always detection's own answer here.
    fellBackToSingleComponent: managers.workspaces.length === 0,
    overwrote: existed,
    exitCode: EXIT.SUCCESS,
  }
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  try {
    return await detectWorkspaceRoot({ cwd })
  } catch {
    // §4.3: fall back to `cwd` when no marker exists (single-project workspace).
    return resolve(cwd)
  }
}

/**
 * Existence probe that only treats "file is not here" as absence. EACCES / EIO / ELOOP
 * are re-thrown as CliError so a permission-denied on `aburi.json` cannot silently
 * bypass the overwrite guard (which would let `writeFile` clobber whatever the user is
 * unable to read).
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isBenignErrno(error)) return false
    throw new CliError(`Failed to probe ${path}: ${errorMessage(error)}`, "runtime-error", {
      cause: error,
    })
  }
}

const BENIGN_ERRNOS = new Set(["ENOENT", "ENOTDIR"])

function isBenignErrno(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && BENIGN_ERRNOS.has(code)
}

/**
 * Detector vocabulary → plugin manifest name. The detectors speak `LanguageId` /
 * framework ids (`ts`, `tsx`, `nestjs`); the top-level `languages` / `frameworks` fields
 * of `aburi.json` are `PluginRef`s that the plugin loader resolves as module specifiers.
 * Writing a detector id into those fields makes the loader look for `@aburi/ts`.
 *
 * Kept tiny on purpose; a large plugin catalog belongs outside the CLI so autodetect
 * stays language-agnostic. Only the plugins that ship in this monorepo are listed, and a
 * detected id with no entry is omitted rather than guessed at — an unresolvable ref would
 * fail the very next `aburi scan`.
 */
const LANGUAGE_TO_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["ts", "lang-typescript"],
  ["tsx", "lang-typescript"],
  ["js", "lang-typescript"],
  ["jsx", "lang-typescript"],
])

const FRAMEWORK_TO_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["nestjs", "framework-nestjs"],
  // `nextjs`, not `next`: the npm dependency `next` is normalised to the framework id
  // `nextjs` by the detector, and this table's left column is the detector's vocabulary.
  ["nextjs", "framework-next"],
  ["react", "framework-react"],
  ["express", "framework-express"],
])

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

/**
 * §4.6 tail — the `--with-suggestions` banner. Install instructions name the npm package,
 * so these carry the `@aburi/` scope that `PluginRef` leaves implicit.
 *
 * Languages come first and are included unconditionally, per `cli-spec.md` §4.6: the
 * language plugin `init` just wrote into `languages` is a hard requirement for the next
 * `aburi scan`, where a framework plugin only adds classification.
 */
function suggestPluginsFor(
  languages: ReadonlySet<string>,
  frameworks: ReadonlySet<string>,
): string[] {
  return [
    ...pluginRefsFor(languages, LANGUAGE_TO_PLUGIN),
    ...pluginRefsFor(frameworks, FRAMEWORK_TO_PLUGIN),
  ].map((name) => `@aburi/${name}`)
}

/**
 * Detected ids this CLI has no plugin for. They stay in `components[].languages` /
 * `components[].frameworks` — that is the detector's own vocabulary and remains accurate —
 * but they cannot appear in the top-level plugin-ref arrays, so the caller surfaces them:
 * an unmapped *language* means the generated config resolves no language plugin at all, and
 * `aburi scan` will refuse to run until one is added.
 */
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

/**
 * Emits the JSONC form of `aburi.json`. Values that the autodetector could not fill are
 * left as empty arrays instead of `undefined` because the schema uses `[]`-default
 * semantics; comments encode the suggestion list so `--with-suggestions` output stays
 * readable.
 */
function renderConfig(input: RenderedConfigInput): string {
  const config: Partial<Config> & { $schema: string } = {
    $schema: CONFIG_SCHEMA_URL,
    languages: [...input.languages],
    frameworks: [...input.frameworks],
    components: input.components.map((c) => ({
      id: c.id,
      name: c.name,
      roots: [...c.roots],
      languages: [...c.languages],
      frameworks: [...c.frameworks],
    })),
  }
  const json = JSON.stringify(config, null, 2)
  if (input.suggestions.length === 0) return `${json}\n`
  const banner = input.suggestions.map((s) => `// Suggested install: pnpm add -D ${s}`).join("\n")
  // Insert the comment banner right after the opening `{` so the JSON stays valid JSONC.
  const insertion = `\n  ${banner.split("\n").join("\n  ")}`
  return `${json.replace("{\n", `{${insertion}\n`)}\n`
}

/**
 * The one recovery for a `.gitignore` this command cannot read.
 *
 * `aburi scan` can be told to leave `.gitignore` alone through the config; this command is what
 * writes that config, so the flag is the whole of the escape hatch and the message has to name
 * it. Silently carrying on instead would put a vendored tree's language into the file the user
 * is about to keep.
 */
function gitignoreEscapeHatch(error: unknown): string {
  if (!(error instanceof CoreError) || error.code !== "scan-gitignore-unreadable") return ""
  return " Pass --no-respect-gitignore to detect components without reading it."
}
