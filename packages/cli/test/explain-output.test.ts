import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import type { Symbol as IRSymbol, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CliError, EXIT, runExplain } from "../src"
import { symbolFor, writeScannedWorkspace } from "./ir-documents"
import { writeStubWorkspace } from "./stub-language"
import { writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("explain-output")

const GET_USER = symbolFor("ts:src/a.ts#getUser")
const GET_USERS = symbolFor("ts:src/b.ts#getUsers")

async function explainInto(argument: string, outputPath: string) {
  await writeScannedWorkspace(workspace.root, { symbols: [GET_USER, GET_USERS] })
  await writeFileAt(workspace.root, "src/a.ts", "export function getUser() {}\n")
  return runExplain({ cwd: workspace.root, argument, noRescan: true, outputPath })
}

describe("aburi explain --output", () => {
  it.each([
    ["an id", "ts:src/a.ts#getUser", "getUser"],
    ["a file", "src/a.ts", "getUser"],
    ["a pattern", "getUsers", "getUsers"],
  ])("writes the answer to %s under directories it creates", async (_, argument, named) => {
    const outcome = await explainInto(argument, "generated/explain/answer.md")

    const written = resolve(workspace.root, "generated/explain/answer.md")
    expect(outcome).toMatchObject({ exitCode: EXIT.SUCCESS, writtenTo: written })
    expect(await readFile(written, "utf8")).toContain(named)
  })

  it("leaves an earlier file alone when it has no answer to write", async () => {
    const lost: SkippedFile = { path: "src/route.ts", reason: "parse-failed" }
    await writeScannedWorkspace(workspace.root, { symbols: [GET_USER], skipped: [lost] })
    const output = resolve(workspace.root, "out/explain.md")
    await writeFile(output, "# a previous answer\n", "utf8")

    const outcome = await runExplain({
      cwd: workspace.root,
      argument: "src/route.ts",
      outputPath: output,
      noRescan: true,
    })

    expect(outcome.kind).toBe("unknown")
    expect(await readFile(output, "utf8")).toBe("# a previous answer\n")
  })

  it("writes the answer even when the scan it ran faulted, and exits 3", async () => {
    await writeStubWorkspace(workspace.root, ["boom.stub", "ok.stub"])

    const outcome = await runExplain({
      cwd: workspace.root,
      argument: "ok_stub",
      outputPath: "answer.md",
      warn: () => {},
    })

    expect(outcome).toMatchObject({ kind: "single", exitCode: EXIT.GATE })
    expect(await readFile(resolve(workspace.root, "answer.md"), "utf8")).toContain("ok_stub")
  })
})

describe("aburi explain — the calls an effect plugin declined", () => {
  it("lists the declines the document records for the Symbol it answers", async () => {
    const calling = (symbol: IRSymbol, target: string, line: number): IRSymbol => ({
      ...symbol,
      calls: [{ target, line, resolved: null }],
    })
    await writeScannedWorkspace(workspace.root, {
      symbols: [
        calling(GET_USER, "client.user.byId.query", 3),
        calling(GET_USERS, "client.user.list.query", 4),
      ],
      declinedCalls: [
        {
          plugin: "effects-trpc",
          symbolId: GET_USER.id,
          target: "client.user.byId.query",
          line: 3,
          reason: "effects-plugin:trpc:server-file-query",
        },
        {
          plugin: "effects-trpc",
          symbolId: GET_USERS.id,
          target: "client.user.list.query",
          line: 4,
          reason: "effects-plugin:trpc:server-file-query",
        },
      ],
    })

    const outcome = await runExplain({
      cwd: workspace.root,
      argument: GET_USER.id,
      noRescan: true,
    })

    expect(outcome).toMatchObject({ kind: "single", exitCode: EXIT.SUCCESS })
    const markdown = outcome.kind === "single" ? outcome.markdown : ""
    expect(markdown).toContain(
      "- `client.user.byId.query` (L3) [effects-trpc]: `effects-plugin:trpc:server-file-query`",
    )
    expect(markdown).not.toContain("client.user.list.query")
  })
})

describe("aburi explain --output, at a path that cannot hold a file", () => {
  it("names the path and the remedy when a file stands where a directory would go", async () => {
    await writeFileAt(workspace.root, "generated", "not a directory\n")

    const thrown = await errorFrom(CliError, () =>
      explainInto("ts:src/a.ts#getUser", "generated/explain/get-user.md"),
    )

    expect(thrown.code).toBe("input-error")
    expect(thrown.message).toContain(
      `aburi explain could not write the explain Markdown to ${resolve(workspace.root, "generated/explain/get-user.md")}`,
    )
    expect(thrown.message).toContain("--output")
  })

  it("names a directory standing on the path itself", async () => {
    await mkdir(resolve(workspace.root, "generated"), { recursive: true })

    const thrown = await errorFrom(CliError, () => explainInto("ts:src/a.ts#getUser", "generated"))

    expect(thrown.code).toBe("input-error")
    expect(thrown.message).toContain(resolve(workspace.root, "generated"))
    expect(thrown.message).toContain("is a directory")
  })
})
