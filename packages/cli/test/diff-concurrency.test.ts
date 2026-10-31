import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it, vi } from "vitest"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME, EXIT } from "../src"
import { FAKE_LANGUAGE_PLUGIN, LANG_MANIFEST, pluginModuleSource } from "./plugin-fakes"
import { runCliIn } from "./run-cli"
import { writeStubRepository } from "./stub-language"
import { writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("diff-concurrency")

/**
 * A language plugin for `.meet` files. Parsing `meet-base.meet` or `meet-head.meet` waits up to ten
 * seconds for the other one, and leaves `<side>-met` in a `meeting` directory beside the workspace
 * when it came.
 */
const MEET_PLUGIN = pluginModuleSource(
  { ...LANG_MANIFEST, name: "lang-meet" },
  `  languageId: "meet",
  fileExtensions: [".meet"],
  capabilities: ${JSON.stringify(FAKE_LANGUAGE_PLUGIN.capabilities)},
  init: async () => {},
  parseFile: async (file) => {
    const { existsSync } = await import("node:fs")
    const { mkdir, writeFile } = await import("node:fs/promises")
    const meeting = new URL("../meeting/", import.meta.url)
    const [side, other] = file.path.includes("base") ? ["base", "head"] : ["head", "base"]
    await mkdir(meeting, { recursive: true })
    await writeFile(new URL(side, meeting), "")
    for (let waited = 0; waited < 10000 && !existsSync(new URL(other, meeting)); waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (existsSync(new URL(other, meeting))) await writeFile(new URL(side + "-met", meeting), "")
    return { tree: { path: file.path }, errors: [], imports: [] }
  },
  extractSymbols: () => [],
  walkBody: () => ({ rules: [], calls: [] }),
  normalizeAst: () => "meet",`,
)

/** `aburi diff main..HEAD`: its exit code, its streams, its per-file log and the report it wrote. */
async function diffAt(concurrency: number) {
  const logged = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const run = await runCliIn(workspace.root, [
      "diff",
      "main..HEAD",
      "--concurrency",
      String(concurrency),
    ])
    const report = await Promise.all(
      [DIFF_JSON_FILENAME, DIFF_MD_FILENAME].map((name) =>
        readFile(resolve(workspace.root, "out", name), "utf8").catch(() => null),
      ),
    )
    return { ...run, log: logged.mock.calls.map(([chunk]) => String(chunk)), report }
  } finally {
    logged.mockRestore()
  }
}

describe("aburi diff — its two scans at once", () => {
  it("runs the base and the head scan at the same time", async () => {
    const repository = resolve(workspace.root, "repository")
    await writeStubRepository(
      repository,
      { base: ["meet-base.meet"], head: ["meet-head.meet"] },
      { languages: ["./lang-meet.mjs"] },
    )
    await writeFileAt(repository, "lang-meet.mjs", MEET_PLUGIN)

    const { code, stderr } = await runCliIn(repository, [
      "diff",
      "main..HEAD",
      "--concurrency",
      "2",
    ])

    expect(code, stderr).toBe(EXIT.SUCCESS)
    expect(
      ["base", "head"].filter((side) =>
        existsSync(resolve(workspace.root, "meeting", `${side}-met`)),
      ),
    ).toEqual(["base", "head"])
  })

  it.each([
    [
      "both scans finish",
      {
        base: ["bad.stub", "warn.stub", "ok.stub"],
        head: ["zz-bad.stub", "noisy.stub", "ok.stub"],
      },
      EXIT.SUCCESS,
      "warn: Skipped zz-bad.stub",
    ],
    [
      "the base scan stops",
      { base: ["odd-base.stub", "ok.stub"], head: ["zz-bad.stub", "ok.stub"] },
      EXIT.GATE,
      'emitted extKind "stub:odd:thing" at odd-base.stub',
    ],
    [
      "the head scan stops",
      { base: ["bad.stub", "ok.stub"], head: ["odd-head.stub", "ok.stub"] },
      EXIT.GATE,
      'emitted extKind "stub:odd:thing" at odd-head.stub',
    ],
    [
      "both scans stop",
      { base: ["odd-base.stub", "ok.stub"], head: ["odd-head.stub", "ok.stub"] },
      EXIT.GATE,
      'emitted extKind "stub:odd:thing" at odd-base.stub',
    ],
  ])("says, writes and exits what it does with one scan at a time when %s", async (_, files, code, says) => {
    await writeStubRepository(workspace.root, files, { pluginOptions: { "effects-prsima": {} } })

    const inTurn = await diffAt(1)

    expect(inTurn.code).toBe(code)
    expect([inTurn.stderr, ...inTurn.log].join("")).toContain(says)
    expect(await diffAt(2)).toEqual(inTurn)
  })
})

describe("aburi diff --concurrency", () => {
  it.each([
    "0",
    "-1",
    "1.5",
    "two",
    "",
  ])("refuses %j, which is not a count of scans", async (value) => {
    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "main..HEAD",
      "--concurrency",
      value,
    ])

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(`--concurrency must be a positive integer (got "${value}")`)
  })
})
