import { mkdtempSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COMPONENTS_DIRNAME,
  DIFF_JSON_FILENAME,
  DIFF_MD_FILENAME,
  IR_JSON_FILENAME,
  WORKSPACE_MD_FILENAME,
} from "@aburi/cli"
import type { DiffResult, IR, SymbolChange } from "@aburi/types"
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { type AburiRun, runAburi } from "./aburi-run"
import { removeLeftovers } from "./leftovers"

export interface AburiServerOptions {
  /** Where every run starts, so the workspace the server answers about. */
  readonly cwd: string
  /** Given to every run as `--config`. */
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly version: string
  /** Told what the server could not remove, a line at a time; stderr by default. */
  readonly warn?: (line: string) => void
}

export interface AburiServer {
  /** A protocol server for one connection. Every one answers from the same scans. */
  server(): McpServer
  /** The directory every scan and report is written in. */
  readonly directory: string
  /** Ends the runs still going and removes the directory. */
  close(): Promise<void>
}

interface Scan {
  readonly id: string
  readonly directory: string
  readonly components: readonly string[]
  /** The run that wrote it, quoted when a page it should hold is not there. */
  readonly run: AburiRun
}

/** A scan a call answers from, and the runs the call made: none when it named the scan. */
type Found = { readonly scan: Scan; readonly runs: readonly AburiRun[] }

const SCAN_ID = /^scan-[1-9][0-9]*$/

/** The exit codes of a scan or a diff that wrote its answer: `3` withdrew a file or tripped a gate. */
const ANSWERED = new Set([0, 3])

const RUN = z.object({
  bin: z.string().describe("The aburi CLI it started: the workspace's own, or the server's"),
  argv: z.array(z.string()).describe("The arguments `aburi` was run with"),
  exitCode: z.number().int().nullable().describe("Its exit code; null when a signal ended it"),
  stderr: z.string().describe("What it wrote on stderr"),
})

const ANSWER = {
  answer: z.string().describe("The answer: the text the first content block holds"),
  runs: z.array(RUN).describe("The runs of the aburi CLI this call made, in order"),
}

const SCAN_INPUT = z
  .string()
  .optional()
  .describe(
    "The id of an earlier scan to answer from (scan-1, scan-2, ...). Without it the tool scans the working tree first.",
  )

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const

export function createAburiServer(options: AburiServerOptions): AburiServer {
  const directory = mkdtempSync(join(tmpdir(), "aburi-mcp-"))
  const env = options.env ?? process.env
  const warn = options.warn ?? ((line: string) => process.stderr.write(`aburi-mcp: ${line}\n`))
  const config = options.configPath === undefined ? [] : ["--config", options.configPath]
  const scans = new Map<string, Scan>()
  const stopping = new AbortController()
  let made = 0
  let queue: Promise<unknown> = Promise.resolve()

  // Each run sizes its work as the only one on the machine, and scan ids follow the calls.
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task)
    queue = next.catch(() => {})
    return next
  }

  const remove = (path: string): Promise<void> =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      (error: unknown) => warn(`could not remove ${path}: ${messageOf(error)}`),
    )

  const run = async (argv: readonly string[], signal: AbortSignal): Promise<AburiRun> => {
    // Its temporary files, a diff's base worktree among them, go where the server finds what a
    // run killed before its own cleanup left.
    const temporary = await mkdtemp(join(directory, "run-"))
    try {
      return await runAburi(argv, {
        cwd: options.cwd,
        env: { ...env, TMPDIR: temporary, TEMP: temporary, TMP: temporary },
        signal: AbortSignal.any([signal, stopping.signal]),
      })
    } finally {
      for (const problem of await removeLeftovers(temporary, options.cwd, env)) warn(problem)
    }
  }

  const outputDirectory = (kind: string): string => {
    made += 1
    return join(directory, `${kind}-${made}`)
  }

  const scanTree = async (signal: AbortSignal): Promise<Scan | CallToolResult> => {
    const output = outputDirectory("scan")
    const scanned = await run(["scan", "--output-dir", output, "--quiet", ...config], signal)
    const read = await componentsOf(scanned, output, signal)
    if (!("components" in read)) {
      await remove(output)
      return unanswered(scanned, { lack: read.lack })
    }
    const scan: Scan = {
      id: `scan-${scans.size + 1}`,
      directory: output,
      components: read.components,
      run: scanned,
    }
    scans.set(scan.id, scan)
    return scan
  }

  const named = (id: string): Scan | string => {
    const scan = scans.get(id)
    if (scan !== undefined) return scan
    const made = [...scans.keys()]
    return made.length === 0
      ? `No scan is named "${id}": this server has made none. Name no scan to scan the working tree.`
      : `No scan is named "${id}": this server has made ${made.join(", ")}.`
  }

  /** The scan a call names, or a new one, with the run that made it when it is new. */
  const scanFor = async (
    id: string | undefined,
    signal: AbortSignal,
  ): Promise<Found | CallToolResult> => {
    if (id === undefined) {
      const scan = await scanTree(signal)
      return "content" in scan ? scan : { scan, runs: [scan.run] }
    }
    const scan = named(id)
    return typeof scan === "string" ? refused(scan) : { scan, runs: [] }
  }

  const pageOf = async (found: Found, rel: string): Promise<CallToolResult> => {
    const page = await readAnswer(found.scan.directory, rel)
    return "lack" in page
      ? unanswered(found.scan.run, { runs: found.runs, scan: found.scan.id, lack: page.lack })
      : answered(page.text, found.runs, { scan: found.scan.id })
  }

  const register = (server: McpServer): McpServer => {
    server.registerTool(
      "scan",
      {
        title: "Scan the working tree",
        description:
          "Runs `aburi scan` over the working tree and answers with its census lines. The scan's id names it to `workspace`, `component`, `explain` and `diff`, so several questions can be asked of one scan.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          ...ANSWER,
          scan: z.string().describe("The scan's id"),
          components: z.array(z.string()).describe("The ids of the scan's Components"),
        }),
        annotations: READ_ONLY,
      },
      (_input, ctx) =>
        serially(async () => {
          const scan = await scanTree(ctx.mcpReq.signal)
          if ("content" in scan) return scan
          return answered(scan.run.stdout, [scan.run], {
            scan: scan.id,
            components: [...scan.components],
          })
        }),
    )

    server.registerTool(
      "workspace",
      {
        title: "Describe the workspace",
        description:
          "The workspace overview `aburi scan` writes as workspace.md: its Components, the dependencies between them and the effects they reach.",
        inputSchema: z.object({ scan: SCAN_INPUT }),
        outputSchema: z.object({ ...ANSWER, scan: z.string() }),
        annotations: READ_ONLY,
      },
      ({ scan }, ctx) =>
        serially(async () => {
          const found = await scanFor(scan, ctx.mcpReq.signal)
          if ("content" in found) return found
          return pageOf(found, WORKSPACE_MD_FILENAME)
        }),
    )

    server.registerTool(
      "component",
      {
        title: "Describe one Component",
        description:
          "The page `aburi scan` writes for one Component: its public API, its Symbols with their rules and calls, and the effects they reach.",
        inputSchema: z.object({
          id: z.string().describe("The Component's id, as `scan` lists them"),
          scan: SCAN_INPUT,
        }),
        outputSchema: z.object({ ...ANSWER, scan: z.string() }),
        annotations: READ_ONLY,
      },
      ({ id, scan }, ctx) =>
        serially(async () => {
          const found = await scanFor(scan, ctx.mcpReq.signal)
          if ("content" in found) return found
          if (!found.scan.components.includes(id)) {
            return refused(
              `${found.scan.id} holds no component "${id}"; it holds ${found.scan.components.join(", ") || "none"}.`,
              { runs: found.runs, scan: found.scan.id },
            )
          }
          return pageOf(found, join(COMPONENTS_DIRNAME, `${id}.md`))
        }),
    )

    server.registerTool(
      "explain",
      {
        title: "Explain a Symbol, a file or a name",
        description:
          "Runs `aburi explain`: a full Symbol id (ts:src/a.ts#Service.create) answers with that Symbol, a file path with every Symbol in the file, and any other text with the Symbol whose qualified name holds it, or with the candidates when several do.",
        inputSchema: z.object({
          target: z.string().describe("A full Symbol id, a file path, or part of a qualified name"),
          scan: SCAN_INPUT,
        }),
        outputSchema: z.object({ ...ANSWER, scan: z.string() }),
        annotations: READ_ONLY,
      },
      ({ target, scan }, ctx) =>
        serially(async () => {
          const found = await scanFor(scan, ctx.mcpReq.signal)
          if ("content" in found) return found
          const explained = await run(
            [
              "explain",
              "--ir",
              join(found.scan.directory, IR_JSON_FILENAME),
              ...config,
              "--",
              target,
            ],
            ctx.mcpReq.signal,
          )
          const runs = [...found.runs, explained]
          if (explained.exitCode === null || explained.stdout.length === 0) {
            return unanswered(explained, { runs, scan: found.scan.id })
          }
          return answered(explained.stdout, runs, { scan: found.scan.id })
        }),
    )

    server.registerTool(
      "diff",
      {
        title: "Report what a change did",
        description:
          "Runs `aburi diff` and answers with its report: the Symbols added, removed, moved and changed, grouped into Slices along the call graph. Compare two git refs with `refspec` (the head is read from the working tree, so HEAD..HEAD is what the uncommitted edits did), or two scans or IR files with `base` and `head`.",
        inputSchema: z.object({
          refspec: z.string().optional().describe("<base>..<head>, as `aburi diff` takes it"),
          base: z.string().optional().describe("A scan's id or an IR file, with `head`"),
          head: z.string().optional().describe("A scan's id or an IR file, with `base`"),
          format: z
            .enum(["markdown", "json"])
            .optional()
            .describe("diff.md (the default) or diff.json"),
          failOn: z
            .array(z.string())
            .optional()
            .describe("--fail-on values, such as removed or changed:>10"),
          failOnScope: z.enum(["all", "non-test"]).optional().describe("--fail-on-scope"),
          maxBytes: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Cap diff.md at this many bytes. The uncapped report a capped one points to is not returned: ask again without maxBytes, or for the JSON, to read every change.",
            ),
          symbol: z
            .string()
            .optional()
            .describe("A Symbol id: answer with the Slice holding it and its members' changes"),
        }),
        outputSchema: z.object(ANSWER),
        annotations: READ_ONLY,
      },
      (input, ctx) =>
        serially(async () => {
          const sides: string[] = []
          for (const flag of ["base", "head"] as const) {
            const side = input[flag]
            if (side === undefined) continue
            if (!SCAN_ID.test(side)) {
              sides.push(`--${flag}`, side)
              continue
            }
            const scan = named(side)
            if (typeof scan === "string") return refused(scan)
            sides.push(`--${flag}`, join(scan.directory, IR_JSON_FILENAME))
          }
          const output = outputDirectory("diff")
          try {
            const diffed = await run(
              [
                "diff",
                ...sides,
                "--output-dir",
                output,
                "--format",
                "both",
                ...(input.failOn ?? []).flatMap((value) => ["--fail-on", value]),
                ...(input.failOnScope === undefined ? [] : ["--fail-on-scope", input.failOnScope]),
                ...(input.maxBytes === undefined ? [] : ["--max-bytes", String(input.maxBytes)]),
                ...config,
                ...(input.refspec === undefined ? [] : ["--", input.refspec]),
              ],
              ctx.mcpReq.signal,
            )
            if (!wroteAnswer(diffed)) return unanswered(diffed)
            const json = await readAnswer(output, DIFF_JSON_FILENAME)
            if ("lack" in json) return unanswered(diffed, { lack: json.lack })
            if (input.symbol !== undefined) {
              let slice: ReturnType<typeof sliceHolding>
              try {
                slice = sliceHolding(JSON.parse(json.text) as DiffResult, input.symbol)
              } catch (error) {
                return unanswered(diffed, {
                  lack: `${DIFF_JSON_FILENAME} is not a diff: ${messageOf(error)}`,
                })
              }
              if (slice === null) {
                return refused(`No Slice of this diff holds "${input.symbol}".`, { runs: [diffed] })
              }
              return answered(`${JSON.stringify(slice, null, 2)}\n`, [diffed], {})
            }
            const report =
              input.format === "json" ? json : await readAnswer(output, DIFF_MD_FILENAME)
            if ("lack" in report) return unanswered(diffed, { lack: report.lack })
            return answered(report.text, [diffed], {})
          } finally {
            await remove(output)
          }
        }),
    )

    return server
  }

  return {
    server: () => register(new McpServer({ name: "aburi", version: options.version })),
    directory,
    async close() {
      stopping.abort()
      await queue
      await remove(directory)
    },
  }
}

/** The ids of the Components a scan wrote, or what keeps the run from being an answer. */
async function componentsOf(
  scanned: AburiRun,
  output: string,
  signal: AbortSignal,
): Promise<{ readonly components: string[] } | { readonly lack?: string }> {
  // The call a cancelled run served has ended, so even a whole IR is given no id.
  if (signal.aborted || !wroteAnswer(scanned)) return {}
  const ir = await readAnswer(output, IR_JSON_FILENAME)
  if ("lack" in ir) return ir
  try {
    return { components: (JSON.parse(ir.text) as IR).components.map((component) => component.id) }
  } catch (error) {
    return { lack: `${IR_JSON_FILENAME} is not an IR: ${messageOf(error)}` }
  }
}

function wroteAnswer(run: AburiRun): boolean {
  return run.exitCode !== null && ANSWERED.has(run.exitCode)
}

/** `rel` is named relative to the run's output directory, which the server removes. */
async function readAnswer(
  directory: string,
  rel: string,
): Promise<{ text: string } | { lack: string }> {
  try {
    return { text: await readFile(join(directory, rel), "utf8") }
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT"
    return {
      lack: missing ? `it wrote no ${rel}` : `${rel} could not be read: ${messageOf(error)}`,
    }
  }
}

function sliceHolding(
  diff: DiffResult,
  symbol: string,
): { slice: DiffResult["slices"][number]; changes: SymbolChange[] } | null {
  const slice = diff.slices.find((candidate) =>
    candidate.members.some((member) => member === symbol),
  )
  if (slice === undefined) return null
  const members = new Set<string>(slice.members)
  return {
    slice,
    changes: diff.symbols.filter((change) => idsOf(change).some((id) => members.has(id))),
  }
}

function idsOf(change: SymbolChange): string[] {
  return "symbol" in change ? [change.symbol.id] : [change.before.id, change.after.id]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function said(runs: readonly AburiRun[]): CallToolResult["content"] {
  return runs
    .filter((run) => run.stderr.length > 0)
    .map((run) => ({
      type: "text" as const,
      text: `aburi ${run.argv[0]} wrote on stderr (exit ${run.exitCode}):\n${run.stderr}`,
    }))
}

function described(runs: readonly AburiRun[]) {
  return runs.map((run) => ({
    bin: run.bin,
    argv: [...run.argv],
    exitCode: run.exitCode,
    stderr: run.stderr,
  }))
}

function answered(
  answer: string,
  runs: readonly AburiRun[],
  rest: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: answer }, ...said(runs)],
    structuredContent: { answer, runs: described(runs), ...rest },
  }
}

interface Failure {
  /** The runs this call made; the failed one alone by default. */
  readonly runs?: readonly AburiRun[]
  readonly scan?: string
}

/** `lack` says what a run whose code says it answered did not write. */
function unanswered(
  failed: AburiRun,
  { runs = [failed], scan, lack }: Failure & { readonly lack?: string | undefined } = {},
): CallToolResult {
  const ended = failed.exitCode === null ? "ended on a signal" : `exited ${failed.exitCode}`
  const why = lack === undefined ? "" : `: ${lack}`
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `aburi ${failed.argv[0]} ${ended} without an answer${why}.\n${failed.stderr}`,
      },
    ],
    structuredContent: {
      answer: "",
      runs: described(runs),
      ...(scan === undefined ? {} : { scan }),
    },
  }
}

function refused(reason: string, { runs = [], scan }: Failure = {}): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: reason }],
    structuredContent: {
      answer: "",
      runs: described(runs),
      ...(scan === undefined ? {} : { scan }),
    },
  }
}
