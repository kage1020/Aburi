import { access, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_OUTPUT_DIRNAME } from "@aburi/cli"
import { editFile, git, gitTestEnv, useScratchWorkspace } from "@aburi/test-support"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"
import { type AburiServer, type AburiServerOptions, createAburiServer } from "../src"
import {
  aburi,
  BUNDLED_BIN,
  editService,
  hangingPlugin,
  installWorkspaceCli,
  outputOf,
  SERVICE_PATH,
  writeRepository,
} from "./workspace"

const workspace = useScratchWorkspace("mcp-server")
const cli = useScratchWorkspace("mcp-cli")

let open: { client: Client; aburi: AburiServer; warned: string[] } | null = null

afterEach(async () => {
  await open?.client.close()
  await open?.aburi.close()
  open = null
})

async function connected(
  env: NodeJS.ProcessEnv = {},
  options: Partial<AburiServerOptions> = {},
): Promise<Client> {
  const warned: string[] = []
  const server = createAburiServer({
    cwd: workspace.root,
    env: { ...gitTestEnv(workspace.root), ...env },
    version: "0.0.0-test",
    warn: (line) => warned.push(line),
    ...options,
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.server().connect(serverSide)
  const client = new Client({ name: "test", version: "0.0.0" })
  await client.connect(clientSide)
  open = { client, aburi: server, warned }
  return client
}

interface Run {
  bin: string
  argv: string[]
  exitCode: number | null
  stderr: string
}

interface Answer {
  isError: boolean
  text: string
  stderr: string
  structured: { answer: string; scan?: string; components?: string[]; runs: Run[] }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Answer> {
  const result = await client.callTool({ name, arguments: args })
  const texts = (result.content as { type: string; text: string }[]).map((block) => block.text)
  return {
    isError: result.isError === true,
    text: texts[0] ?? "",
    stderr: texts.slice(1).join(""),
    structured: result.structuredContent as Answer["structured"],
  }
}

/** The IR the scan a call made wrote. */
function irOf(answer: Answer): string {
  const [scanned] = answer.structured.runs
  if (scanned === undefined) throw new Error("the call made no scan")
  return join(outputOf(scanned), "aburi.ir.json")
}

/** What the server's own directory holds besides the scans it keeps. */
async function leftInServer(): Promise<string[]> {
  return (await readdir(open?.aburi.directory ?? "")).filter((name) => !/^scan-\d+$/.test(name))
}

async function worktrees(): Promise<string[]> {
  const listed = await git(["worktree", "list", "--porcelain"], workspace.root)
  return listed.split("\n").filter((line) => line.startsWith("worktree "))
}

async function pidOnceLoaded(): Promise<number> {
  const pidFile = join(workspace.root, "hanging.pid")
  await expect
    .poll(() => readFile(pidFile, "utf8").catch(() => ""), { timeout: 20_000 })
    .not.toBe("")
  return Number(await readFile(pidFile, "utf8"))
}

const ID = "ts:pkgs/api/src/invoice.service.ts#InvoiceService.create"

// Answers every run with the arguments it was given, on stderr.
const ECHOING_CLI = `process.stderr.write(JSON.stringify(process.argv.slice(2)) + "\\n")
process.exitCode = 1
`

describe("the aburi MCP server", () => {
  it("lists its five tools, each with an input and an output schema", async () => {
    const client = await connected()
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "component",
      "diff",
      "explain",
      "scan",
      "workspace",
    ])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object")
      expect(tool.outputSchema?.type).toBe("object")
    }
  })

  it("answers scan, workspace and component with what aburi scan prints and writes", async () => {
    await writeRepository(workspace)
    const alone = await aburi(workspace.root, ["scan", "--output-dir", cli.root, "--quiet"])
    const client = await connected()

    const scanned = await call(client, "scan")
    expect(scanned.isError).toBe(false)
    expect(scanned.structured.scan).toBe("scan-1")
    expect(scanned.structured.components).toEqual(["api", "web"])
    expect(scanned.structured.runs.map((run) => run.bin)).toEqual([BUNDLED_BIN])
    expect(scanned.text).toBe(alone.stdout)

    const overview = await call(client, "workspace", { scan: "scan-1" })
    expect(overview.text).toBe(await readFile(join(cli.root, "workspace.md"), "utf8"))
    for (const id of ["api", "web"]) {
      const page = await call(client, "component", { id, scan: "scan-1" })
      expect(page.text).toBe(await readFile(join(cli.root, "components", `${id}.md`), "utf8"))
      expect(page.structured.runs).toEqual([])
    }
  })

  it.each([
    [ID, 0],
    ["pkgs/api/src/invoice.service.ts", 0],
    ["InvoiceService.create", 2],
  ])("answers explain %s with what aburi explain prints", async (target, exitCode) => {
    await writeRepository(workspace)
    const client = await connected()
    const explained = await call(client, "explain", { target })
    const alone = await aburi(workspace.root, ["explain", target, "--ir", irOf(explained)])

    expect(explained.isError).toBe(false)
    expect(explained.text).toBe(alone.stdout)
    expect(explained.structured.runs.map((run) => run.exitCode)).toEqual([0, exitCode])
  })

  it("answers explain naming a scan from that scan, whatever the tree says since", async () => {
    await writeRepository(workspace)
    const client = await connected()
    const scanned = await call(client, "scan")
    const before = await aburi(workspace.root, ["explain", ID, "--ir", irOf(scanned)])
    await editFile(
      join(workspace.root, SERVICE_PATH),
      "create(total: number)",
      "create(total: number, currency: string)",
    )
    const listed = await readdir(workspace.root)

    const named = await call(client, "explain", { target: ID, scan: "scan-1" })
    expect(named.text).toBe(before.stdout)
    expect(named.text).not.toContain("currency")
    expect(named.structured.runs).toHaveLength(1)
    expect(await readdir(workspace.root)).toEqual(listed)
    expect((await call(client, "explain", { target: ID })).text).toContain("currency")
  })

  it("fails an explain nothing matches, with what aburi explain says", async () => {
    await writeRepository(workspace)
    const client = await connected()
    const explained = await call(client, "explain", { target: "nothingNamedThis" })

    expect(explained.isError).toBe(true)
    expect(explained.text).toContain('No matches for "nothingNamedThis"')
    expect(explained.structured.scan).toBe("scan-1")
    expect(explained.structured.runs).toHaveLength(2)
  })

  it.each(["--output", "--config", "-x"])(
    "explains %s as a target, never as an option of aburi explain",
    async (target) => {
      await writeRepository(workspace)
      const client = await connected()
      await call(client, "scan")
      const listed = await readdir(workspace.root)
      const explained = await call(client, "explain", { target, scan: "scan-1" })

      expect(explained.isError).toBe(true)
      expect(explained.text).toContain(`No matches for "${target}"`)
      expect(await readdir(workspace.root)).toEqual(listed)
    },
  )

  it("diffs a refspec that reads as an option as a refspec, and refuses it", async () => {
    await writeRepository(workspace)
    const client = await connected()
    const report = await call(client, "diff", { refspec: "--config=/elsewhere/aburi.json" })

    expect(report.isError).toBe(true)
    expect(report.text).toContain(
      'diff argument "--config=/elsewhere/aburi.json" is not a valid ref spec',
    )
  })

  it("scans afresh for each question that names no scan, and says which it read", async () => {
    await writeRepository(workspace)
    const client = await connected()

    expect((await call(client, "workspace")).structured.scan).toBe("scan-1")
    expect((await call(client, "explain", { target: ID })).structured.scan).toBe("scan-2")
  })

  it("answers diff of the working tree with the report aburi diff writes, writing nothing there", async () => {
    await writeRepository(workspace)
    await editService(workspace.root)
    await aburi(workspace.root, [
      "diff",
      "HEAD..HEAD",
      "--output-dir",
      cli.root,
      "--format",
      "both",
    ])
    const client = await connected()

    const markdown = await call(client, "diff", { refspec: "HEAD..HEAD" })
    const json = await call(client, "diff", { refspec: "HEAD..HEAD", format: "json" })

    expect(markdown.isError).toBe(false)
    expect(markdown.text).toBe(await readFile(join(cli.root, "diff.md"), "utf8"))
    expect(json.text).toBe(await readFile(join(cli.root, "diff.json"), "utf8"))
    await expect(access(join(workspace.root, DEFAULT_OUTPUT_DIRNAME))).rejects.toThrow()
    expect(await git(["status", "--porcelain"], workspace.root)).toBe(` M ${SERVICE_PATH}\n`)
    expect(await worktrees()).toHaveLength(1)
    expect(await leftInServer()).toEqual([])
  })

  it("answers diff of two scans with the report of the two IRs they wrote", async () => {
    await writeRepository(workspace)
    const client = await connected()
    const first = await call(client, "scan")
    await editService(workspace.root)
    const second = await call(client, "scan")
    const report = await call(client, "diff", { base: "scan-1", head: "scan-2" })
    await aburi(workspace.root, [
      "diff",
      "--base",
      irOf(first),
      "--head",
      irOf(second),
      "--output-dir",
      cli.root,
    ])

    expect(report.isError).toBe(false)
    expect(report.text).toBe(await readFile(join(cli.root, "diff.md"), "utf8"))
    expect(report.text).toContain("InvoiceService.create")
  })

  it.each([{}, { FORCE_COLOR: "1" }])(
    "answers a diff whose failOn trips, with the gate on stderr uncoloured and exit 3, under %j",
    async (env) => {
      await writeRepository(workspace)
      await editService(workspace.root)
      const client = await connected(env)
      const report = await call(client, "diff", { refspec: "HEAD..HEAD", failOn: ["changed"] })

      expect(report.isError).toBe(false)
      expect(report.structured.runs[0]?.exitCode).toBe(3)
      expect(report.stderr).toMatch(/^aburi diff wrote on stderr \(exit 3\):\n/)
      expect(report.stderr).toContain("--fail-on changed tripped")
      expect(report.stderr).not.toContain("\u001b[")
    },
  )

  it("answers diff with the Slice holding a symbol, and fails for one no Slice holds", async () => {
    await writeRepository(workspace)
    await editService(workspace.root)
    const client = await connected()
    const held = await call(client, "diff", { refspec: "HEAD..HEAD", symbol: ID })
    const answer = JSON.parse(held.text) as {
      slice: { members: string[] }
      changes: { status: string }[]
    }
    const unheld = await call(client, "diff", {
      refspec: "HEAD..HEAD",
      symbol: "ts:pkgs/web/src/page.ts#renderInvoice",
    })

    expect(answer.slice.members).toContain(ID)
    expect(answer.changes.map((change) => change.status)).toContain("changed")
    expect(unheld.isError).toBe(true)
    expect(unheld.text).toBe('No Slice of this diff holds "ts:pkgs/web/src/page.ts#renderInvoice".')
  })

  it.each<[string, Record<string, unknown>, string, number, string | undefined]>([
    [
      "component",
      { id: "billing", scan: "scan-1" },
      'scan-1 holds no component "billing"; it holds api, web.',
      0,
      "scan-1",
    ],
    [
      "component",
      { id: "billing" },
      'scan-2 holds no component "billing"; it holds api, web.',
      1,
      "scan-2",
    ],
    [
      "workspace",
      { scan: "scan-9" },
      'No scan is named "scan-9": this server has made scan-1.',
      0,
      undefined,
    ],
    [
      "diff",
      { base: "scan-1", head: "scan-2" },
      'No scan is named "scan-2": this server has made scan-1.',
      0,
      undefined,
    ],
  ])(
    "fails %s naming what does not exist, listing what does, with the runs and the scan it read",
    async (tool, args, reason, runs, scan) => {
      await writeRepository(workspace)
      const client = await connected()
      await call(client, "scan")
      const answer = await call(client, tool, args)

      expect(answer.isError).toBe(true)
      expect(answer.text).toBe(reason)
      expect(answer.structured.runs).toHaveLength(runs)
      expect(answer.structured.scan).toBe(scan)
    },
  )

  it("fails a scan whose plugin cannot be loaded, with what aburi scan says", async () => {
    await writeRepository(workspace, { languages: ["./absent-plugin.mjs"] })
    const client = await connected()
    const scanned = await call(client, "scan")

    expect(scanned.isError).toBe(true)
    expect(scanned.text).toMatch(
      /^aburi scan exited 3 without an answer: it wrote no aburi\.ir\.json\.\n/,
    )
    expect(scanned.text).toContain("absent-plugin.mjs")
  })

  it.each<[string, string, string, RegExp]>([
    [
      "exits 1 once its IR is written",
      `writeFileSync(join(output, "aburi.ir.json"), '{"components":[]}')
process.stderr.write("the pages could not be written\\n")
process.exitCode = 1`,
      "scan",
      /^aburi scan exited 1 without an answer\.\nthe pages could not be written\n$/,
    ],
    [
      "writes an IR that is cut short",
      `writeFileSync(join(output, "aburi.ir.json"), '{"components":[')`,
      "scan",
      /^aburi scan exited 0 without an answer: aburi\.ir\.json is not an IR: .*\.\n$/,
    ],
    [
      "writes no workspace.md",
      `writeFileSync(join(output, "aburi.ir.json"), '{"components":[]}')`,
      "workspace",
      /^aburi scan exited 0 without an answer: it wrote no workspace\.md\.\n$/,
    ],
  ])("fails a call whose scan %s, and gives that scan no id", async (_, writes, tool, expected) => {
    await writeRepository(workspace)
    await installWorkspaceCli(
      workspace,
      `import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const output = process.argv[process.argv.indexOf("--output-dir") + 1]
mkdirSync(output, { recursive: true })
${writes}
`,
    )
    const client = await connected()
    const answer = await call(client, tool)

    expect(answer.isError).toBe(true)
    expect(answer.text).toMatch(expected)
    if (tool === "scan") {
      expect((await call(client, "workspace", { scan: "scan-1" })).text).toMatch(
        /^No scan is named "scan-1": this server has made none\./,
      )
      expect(await leftInServer()).toEqual([])
    }
  })

  it("runs the aburi the workspace installed, when it has one", async () => {
    await writeRepository(workspace)
    const bin = await installWorkspaceCli(
      workspace,
      `process.stderr.write("the workspace's aburi " + process.argv[2] + "\\n")\nprocess.exitCode = 1\n`,
    )
    const client = await connected()
    const scanned = await call(client, "scan")

    expect(scanned.isError).toBe(true)
    expect(scanned.text).toBe(
      "aburi scan exited 1 without an answer.\nthe workspace's aburi scan\n",
    )
    expect(scanned.structured.runs.map((run) => run.bin)).toEqual([bin])
  })

  it("fails a call when the workspace's aburi is there but cannot be loaded", async () => {
    await writeRepository(workspace)
    await workspace.writeSource("node_modules/@aburi/cli/package.json", '{ "name": "@aburi/cli",')
    const client = await connected()
    const scanned = await call(client, "scan")

    expect(scanned.isError).toBe(true)
    expect(scanned.text).toContain("Invalid package config")
    // Windows names the file behind its long-path prefix.
    expect(scanned.text).toContain(join(workspace.root, "node_modules/@aburi/cli/package.json"))
  })

  it.each<[string, Partial<AburiServerOptions>, string, Record<string, unknown>, string[]]>([
    [
      "--config",
      { configPath: "/elsewhere/aburi.json" },
      "scan",
      {},
      ["--config", "/elsewhere/aburi.json"],
    ],
    ["maxBytes", {}, "diff", { refspec: "HEAD..HEAD", maxBytes: 100 }, ["--max-bytes", "100"]],
    [
      "failOnScope",
      {},
      "diff",
      { refspec: "HEAD..HEAD", failOnScope: "non-test" },
      ["--fail-on-scope", "non-test"],
    ],
  ])("passes %s on to the run", async (_, options, tool, args, passed) => {
    await writeRepository(workspace)
    await installWorkspaceCli(workspace, ECHOING_CLI)
    const client = await connected({}, options)
    const answer = await call(client, tool, args)
    const received = JSON.parse(answer.text.split("\n")[1] ?? "") as string[]

    const at = received.indexOf(passed[0] ?? "")
    expect(received.slice(at, at + passed.length)).toEqual(passed)
  })

  it("runs the calls it is sent at once one after the other", async () => {
    await writeRepository(workspace)
    await installWorkspaceCli(
      workspace,
      `import { appendFileSync } from "node:fs"
appendFileSync("runs.log", "start\\n")
await new Promise((resolve) => setTimeout(resolve, 300))
appendFileSync("runs.log", "end\\n")
process.exitCode = 1
`,
    )
    const client = await connected()
    await Promise.all([
      call(client, "diff", { refspec: "HEAD..HEAD" }),
      call(client, "diff", { refspec: "HEAD..HEAD" }),
    ])

    expect(await readFile(join(workspace.root, "runs.log"), "utf8")).toBe(
      "start\nend\nstart\nend\n",
    )
  })

  it("ends the run of a call the client cancels before it answers the next", async () => {
    await writeRepository(workspace, { languages: ["./hanging-plugin.mjs"] })
    await workspace.writeSource("hanging-plugin.mjs", hangingPlugin())
    const client = await connected()
    const cancel = new AbortController()
    const scanning = client.callTool({ name: "scan", arguments: {} }, { signal: cancel.signal })
    const pid = await pidOnceLoaded()
    cancel.abort()
    await expect(scanning).rejects.toThrow()
    const next = await call(client, "workspace", { scan: "scan-1" })

    expect(next.text).toMatch(/^No scan is named "scan-1": this server has made none\./)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it("removes the base worktree of a diff that was killed before it could", async () => {
    await writeRepository(workspace, { languages: ["./hanging-plugin.mjs"] })
    await workspace.writeSource("hanging-plugin.mjs", hangingPlugin({ deaf: true }))
    const client = await connected()
    const cancel = new AbortController()
    const diffing = client.callTool(
      { name: "diff", arguments: { refspec: "HEAD..HEAD" } },
      { signal: cancel.signal },
    )
    await pidOnceLoaded()
    await expect.poll(worktrees, { timeout: 20_000 }).toHaveLength(2)
    cancel.abort()
    await expect(diffing).rejects.toThrow()
    await call(client, "workspace", { scan: "scan-1" })

    expect(await worktrees()).toHaveLength(1)
    expect(await leftInServer()).toEqual([])
    expect(open?.warned).toEqual([])
  })

  it("ends the runs still going when it closes, and removes every scan it made", async () => {
    await writeRepository(workspace)
    const client = await connected()
    await call(client, "scan")
    const directory = open?.aburi.directory ?? ""
    await access(join(directory, "scan-1", "aburi.ir.json"))
    await workspace.writeSource(
      "aburi.json",
      JSON.stringify({ languages: ["./hanging-plugin.mjs"] }),
    )
    await workspace.writeSource("hanging-plugin.mjs", hangingPlugin())
    const scanning = call(client, "scan")
    const pid = await pidOnceLoaded()
    await open?.aburi.close()

    expect(() => process.kill(pid, 0)).toThrow()
    await expect(access(directory)).rejects.toThrow()
    expect((await scanning).isError).toBe(true)
    await client.close()
    open = null
  })
})
