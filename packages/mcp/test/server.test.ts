import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { git, gitTestEnv, useScratchWorkspace } from "@aburi/test-support"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"
import { type AburiServer, createAburiServer } from "../src"
import { aburi, SERVICE_EDITED, writeFileAt, writeRepository } from "./workspace"

const workspace = useScratchWorkspace("mcp-server")
const cli = useScratchWorkspace("mcp-cli")

let open: { client: Client; aburi: AburiServer } | null = null

afterEach(async () => {
  await open?.client.close()
  await open?.aburi.close()
  open = null
})

async function connected(): Promise<Client> {
  const server = createAburiServer({
    cwd: workspace.root,
    env: gitTestEnv(workspace.root),
    version: "0.0.0-test",
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.server.connect(serverSide)
  const client = new Client({ name: "test", version: "0.0.0" })
  await client.connect(clientSide)
  open = { client, aburi: server }
  return client
}

interface Answer {
  isError: boolean
  text: string
  stderr: string
  structured: {
    answer: string
    scan?: string
    components?: string[]
    runs: { argv: string[]; exitCode: number | null; stderr: string }[]
  }
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

const ID = "ts:pkgs/api/src/invoice.service.ts#InvoiceService.create"

// Loads forever and holds SIGTERM, as a plugin stuck in a native call can.
const HANGING_PLUGIN = `import { writeFileSync } from "node:fs"
process.on("SIGTERM", () => {})
writeFileSync(new URL("./hanging.pid", import.meta.url), String(process.pid))
setInterval(() => {}, 1_000)
await new Promise(() => {})
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
    await writeRepository(workspace.root)
    const alone = await aburi(workspace.root, ["scan", "--output-dir", cli.root])
    const client = await connected()

    const scanned = await call(client, "scan")
    expect(scanned.isError).toBe(false)
    expect(scanned.structured.scan).toBe("scan-1")
    expect(scanned.structured.components).toEqual(["api", "web"])
    expect(scanned.text.split("\n").slice(0, 2)).toEqual(alone.stdout.split("\n").slice(0, 2))

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
    await writeRepository(workspace.root)
    const client = await connected()
    const explained = await call(client, "explain", { target })
    const ir = join(open?.aburi.directory ?? "", "scan-1", "aburi.ir.json")
    const alone = await aburi(workspace.root, ["explain", target, "--ir", ir])

    expect(explained.isError).toBe(false)
    expect(explained.text).toBe(alone.stdout)
    expect(explained.structured.runs.map((run) => run.exitCode)).toEqual([0, exitCode])
  })

  it("fails an explain nothing matches, with what aburi explain says", async () => {
    await writeRepository(workspace.root)
    const client = await connected()
    const explained = await call(client, "explain", { target: "nothingNamedThis" })

    expect(explained.isError).toBe(true)
    expect(explained.text).toContain('No matches for "nothingNamedThis"')
  })

  it("scans afresh for each question that names no scan, and says which it read", async () => {
    await writeRepository(workspace.root)
    const client = await connected()

    expect((await call(client, "workspace")).structured.scan).toBe("scan-1")
    expect((await call(client, "explain", { target: ID })).structured.scan).toBe("scan-2")
  })

  it("answers diff of the working tree with the report aburi diff writes, writing nothing there", async () => {
    await writeRepository(workspace.root)
    await writeFileAt(workspace.root, "pkgs/api/src/invoice.service.ts", SERVICE_EDITED)
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
    await expect(access(join(workspace.root, "out"))).rejects.toThrow()
    expect(await git(["status", "--porcelain"], workspace.root)).toBe(
      " M pkgs/api/src/invoice.service.ts\n",
    )
  })

  it("answers diff of two scans with the report of the two IRs they wrote", async () => {
    await writeRepository(workspace.root)
    const client = await connected()
    await call(client, "scan")
    await writeFileAt(workspace.root, "pkgs/api/src/invoice.service.ts", SERVICE_EDITED)
    await call(client, "scan")
    const directory = open?.aburi.directory ?? ""
    const report = await call(client, "diff", { base: "scan-1", head: "scan-2" })
    await aburi(workspace.root, [
      "diff",
      "--base",
      join(directory, "scan-1", "aburi.ir.json"),
      "--head",
      join(directory, "scan-2", "aburi.ir.json"),
      "--output-dir",
      cli.root,
    ])

    expect(report.isError).toBe(false)
    expect(report.text).toBe(await readFile(join(cli.root, "diff.md"), "utf8"))
    expect(report.text).toContain("InvoiceService.create")
  })

  it("answers a diff whose failOn trips, with the gate on stderr and exit 3", async () => {
    await writeRepository(workspace.root)
    await writeFileAt(workspace.root, "pkgs/api/src/invoice.service.ts", SERVICE_EDITED)
    const client = await connected()
    const report = await call(client, "diff", { refspec: "HEAD..HEAD", failOn: ["changed"] })

    expect(report.isError).toBe(false)
    expect(report.structured.runs[0]?.exitCode).toBe(3)
    expect(report.stderr).toMatch(/^aburi diff wrote on stderr \(exit 3\):\n/)
    expect(report.stderr).toContain("--fail-on changed tripped")
  })

  it("answers diff with the Slice holding a symbol, and fails for one no Slice holds", async () => {
    await writeRepository(workspace.root)
    await writeFileAt(workspace.root, "pkgs/api/src/invoice.service.ts", SERVICE_EDITED)
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

  it.each<[string, Record<string, unknown>, string]>([
    [
      "component",
      { id: "billing", scan: "scan-1" },
      'scan-1 holds no component "billing"; it holds api, web.',
    ],
    ["workspace", { scan: "scan-9" }, 'No scan is named "scan-9": this server has made scan-1.'],
    [
      "diff",
      { base: "scan-1", head: "scan-2" },
      'No scan is named "scan-2": this server has made scan-1.',
    ],
  ])("fails %s naming what does not exist, listing what does", async (tool, args, reason) => {
    await writeRepository(workspace.root)
    const client = await connected()
    await call(client, "scan")
    const answer = await call(client, tool, args)

    expect(answer.isError).toBe(true)
    expect(answer.text).toBe(reason)
  })

  it("fails a scan whose plugin cannot be loaded, with what aburi scan says", async () => {
    await writeRepository(workspace.root, { languages: ["./absent-plugin.mjs"] })
    const client = await connected()
    const scanned = await call(client, "scan")

    expect(scanned.isError).toBe(true)
    expect(scanned.text).toMatch(/^aburi scan exited 3 without an answer:\n/)
    expect(scanned.text).toContain("absent-plugin.mjs")
  })

  it("runs the aburi the workspace installed, when it has one", async () => {
    await writeRepository(workspace.root)
    await writeFileAt(
      workspace.root,
      "node_modules/@aburi/cli/package.json",
      JSON.stringify({ name: "@aburi/cli", bin: { aburi: "./bin.mjs" } }),
    )
    await writeFileAt(
      workspace.root,
      "node_modules/@aburi/cli/bin.mjs",
      `process.stderr.write("the workspace's aburi " + process.argv[2] + "\\n")\nprocess.exitCode = 1\n`,
    )
    const client = await connected()
    const scanned = await call(client, "scan")

    expect(scanned.isError).toBe(true)
    expect(scanned.text).toBe(
      "aburi scan exited 1 without an answer:\nthe workspace's aburi scan\n",
    )
  })

  it("answers two diffs sent at once, one after the other", async () => {
    await writeRepository(workspace.root)
    await writeFileAt(workspace.root, "pkgs/api/src/invoice.service.ts", SERVICE_EDITED)
    const client = await connected()
    const [first, second] = await Promise.all([
      call(client, "diff", { refspec: "HEAD..HEAD" }),
      call(client, "diff", { refspec: "HEAD..HEAD" }),
    ])

    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(second.text).toBe(first.text)
  })

  it("ends the run of a call the client cancels before it answers the next", async () => {
    await writeRepository(workspace.root, { languages: ["./hanging-plugin.mjs"] })
    await writeFileAt(workspace.root, "hanging-plugin.mjs", HANGING_PLUGIN)
    const client = await connected()
    const cancel = new AbortController()
    const scanning = client.callTool({ name: "scan", arguments: {} }, { signal: cancel.signal })
    const pidFile = join(workspace.root, "hanging.pid")
    await expect
      .poll(() => readFile(pidFile, "utf8").catch(() => ""), { timeout: 20_000 })
      .not.toBe("")
    const pid = Number(await readFile(pidFile, "utf8"))
    cancel.abort()
    await expect(scanning).rejects.toThrow()
    const next = await call(client, "workspace", { scan: "scan-1" })

    expect(next.text).toMatch(/^No scan is named "scan-1": this server has made none\./)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it("removes every scan it made when it closes", async () => {
    await writeRepository(workspace.root)
    const client = await connected()
    await call(client, "scan")
    const directory = open?.aburi.directory ?? ""
    await access(join(directory, "scan-1", "aburi.ir.json"))
    await open?.aburi.close()

    await expect(access(directory)).rejects.toThrow()
    await client.close()
    open = null
  })
})
