import { mkdtempSync } from "node:fs"
import { access, readFile, rm } from "node:fs/promises"
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

export interface AburiServerOptions {
  /** Where every run starts, so the workspace the server answers about. */
  readonly cwd: string
  /** Given to every run as `--config`. */
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly version: string
}

export interface AburiServer {
  readonly server: McpServer
  /** The directory every scan and report is written in. */
  readonly directory: string
  /** Ends the runs still going and removes the directory. */
  close(): Promise<void>
}

interface Scan {
  readonly id: string
  readonly directory: string
  readonly components: readonly string[]
}

const SCAN_ID = /^scan-[1-9][0-9]*$/

const RUN = z.object({
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
  const config = options.configPath === undefined ? [] : ["--config", options.configPath]
  const scans = new Map<string, Scan>()
  const stopping = new AbortController()
  let made = 0
  let queue: Promise<unknown> = Promise.resolve()

  // One run at a time: two diffs of one repository would contend for its base worktree.
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task)
    queue = next.catch(() => {})
    return next
  }

  const run = (argv: readonly string[], signal: AbortSignal): Promise<AburiRun> =>
    runAburi(argv, {
      cwd: options.cwd,
      env,
      signal: AbortSignal.any([signal, stopping.signal]),
    })

  const outputDirectory = (kind: string): string => {
    made += 1
    return join(directory, `${kind}-${made}`)
  }

  const scanTree = async (signal: AbortSignal): Promise<{ scan: Scan | null; run: AburiRun }> => {
    const output = outputDirectory("scan")
    const scanned = await run(["scan", "--output-dir", output, ...config], signal)
    const ir = await readIfPresent(join(output, IR_JSON_FILENAME))
    if (ir === null) {
      await rm(output, { recursive: true, force: true })
      return { scan: null, run: scanned }
    }
    const scan: Scan = {
      id: `scan-${scans.size + 1}`,
      directory: output,
      components: (JSON.parse(ir) as IR).components.map((component) => component.id),
    }
    scans.set(scan.id, scan)
    return { scan, run: scanned }
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
  ): Promise<{ scan: Scan; runs: AburiRun[] } | CallToolResult> => {
    if (id !== undefined) {
      const scan = named(id)
      return typeof scan === "string" ? refused(scan) : { scan, runs: [] }
    }
    const { scan, run: scanned } = await scanTree(signal)
    return scan === null ? unanswered(scanned) : { scan, runs: [scanned] }
  }

  const server = new McpServer({ name: "aburi", version: options.version })

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
        const { scan, run: scanned } = await scanTree(ctx.mcpReq.signal)
        if (scan === null) return unanswered(scanned)
        return answered(scanned.stdout, [scanned], {
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
        const page = await readFile(join(found.scan.directory, WORKSPACE_MD_FILENAME), "utf8")
        return answered(page, found.runs, { scan: found.scan.id })
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
          )
        }
        const page = await readFile(
          join(found.scan.directory, COMPONENTS_DIRNAME, `${id}.md`),
          "utf8",
        )
        return answered(page, found.runs, { scan: found.scan.id })
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
          ["explain", target, "--ir", join(found.scan.directory, IR_JSON_FILENAME), ...config],
          ctx.mcpReq.signal,
        )
        const runs = [...found.runs, explained]
        if (explained.stdout.length === 0) return unanswered(explained, runs)
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
        maxBytes: z.number().int().positive().optional().describe("Cap diff.md at this many bytes"),
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
              ...(input.refspec === undefined ? [] : [input.refspec]),
              ...sides,
              "--output-dir",
              output,
              "--format",
              "both",
              ...(input.failOn ?? []).flatMap((value) => ["--fail-on", value]),
              ...(input.failOnScope === undefined ? [] : ["--fail-on-scope", input.failOnScope]),
              ...(input.maxBytes === undefined ? [] : ["--max-bytes", String(input.maxBytes)]),
              ...config,
            ],
            ctx.mcpReq.signal,
          )
          const json = await readIfPresent(join(output, DIFF_JSON_FILENAME))
          if (json === null) return unanswered(diffed)
          if (input.symbol !== undefined) {
            const slice = sliceHolding(JSON.parse(json) as DiffResult, input.symbol)
            if (slice === null) {
              return refused(`No Slice of this diff holds "${input.symbol}".`, [diffed])
            }
            return answered(`${JSON.stringify(slice, null, 2)}\n`, [diffed], {})
          }
          const report =
            input.format === "json" ? json : await readFile(join(output, DIFF_MD_FILENAME), "utf8")
          return answered(report, [diffed], {})
        } finally {
          await rm(output, { recursive: true, force: true })
        }
      }),
  )

  return {
    server,
    directory,
    async close() {
      stopping.abort()
      await queue
      await rm(directory, { recursive: true, force: true })
    },
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

async function readIfPresent(path: string): Promise<string | null> {
  try {
    await access(path)
  } catch {
    return null
  }
  return readFile(path, "utf8")
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
  return runs.map((run) => ({ argv: [...run.argv], exitCode: run.exitCode, stderr: run.stderr }))
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

function unanswered(failed: AburiRun, runs: readonly AburiRun[] = [failed]): CallToolResult {
  const ended = failed.exitCode === null ? "ended on a signal" : `exited ${failed.exitCode}`
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `aburi ${failed.argv[0]} ${ended} without an answer:\n${failed.stderr}`,
      },
    ],
    structuredContent: { answer: "", runs: described(runs) },
  }
}

function refused(reason: string, runs: readonly AburiRun[] = []): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: reason }],
    structuredContent: { answer: "", runs: described(runs) },
  }
}
