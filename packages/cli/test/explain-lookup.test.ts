import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import type { SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { EXIT, runExplain } from "../src"
import { type DocumentShape, documentWith, symbolFor, writeScannedWorkspace } from "./ir-documents"
import { writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("explain-lookup")

const KEPT = symbolFor("ts:src/kept.ts#kept")
const ROUTE_LOST: SkippedFile = { path: "src/route.ts", reason: "parse-failed" }
const LOST_ROUTE: DocumentShape = { symbols: [KEPT], skipped: [ROUTE_LOST] }
const NAMED_LOSS = { kind: "named-losses", files: [ROUTE_LOST] }
const COMPOSED = "src/café.ts"
const DECOMPOSED = "src/café.ts"

interface Lookup {
  document: DocumentShape
  argument: string
  onDisk?: readonly string[]
  answer: Record<string, unknown>
}

async function lookUp({ document, argument, onDisk = [] }: Lookup) {
  await writeScannedWorkspace(workspace.root, document)
  for (const file of onDisk) await writeFileAt(workspace.root, file, "export const x = 1\n")
  return runExplain({ cwd: workspace.root, argument, noRescan: true })
}

describe("runExplain — an argument holding `#` is looked up as a Symbol id", () => {
  it.each<[string, Lookup]>([
    [
      "answers a Symbol the document holds",
      {
        document: { symbols: [KEPT] },
        argument: "ts:src/kept.ts#kept",
        answer: { kind: "single", exitCode: EXIT.SUCCESS, symbol: KEPT },
      },
    ],
    [
      "answers unknown when the file the id names was never analysed",
      {
        document: LOST_ROUTE,
        argument: "ts:src/route.ts#handleRequest",
        answer: { kind: "unknown", exitCode: EXIT.GATE, skipped: ROUTE_LOST, namedBy: "id" },
      },
    ],
    [
      "answers a Symbol whose id names a lost file but whose source.file does not",
      {
        document: {
          symbols: [symbolFor("ts:src/route.ts#relocated", "src/actual.ts")],
          skipped: [ROUTE_LOST],
        },
        argument: "ts:src/route.ts#relocated",
        answer: { kind: "single", exitCode: EXIT.SUCCESS },
      },
    ],
    [
      "qualifies a miss on a file the skip list does not hold",
      {
        document: LOST_ROUTE,
        argument: "ts:src/elsewhere.ts#gone",
        answer: { kind: "not-found", exitCode: EXIT.RUNTIME, coverage: NAMED_LOSS },
      },
    ],
    [
      "claims no file for an argument that is not a well-formed Symbol id",
      {
        document: LOST_ROUTE,
        argument: "ts:src/route.ts#3bad",
        answer: { kind: "not-found", exitCode: EXIT.RUNTIME, coverage: NAMED_LOSS },
      },
    ],
    [
      "falls through to the file arm for a path holding `#`",
      {
        document: { symbols: [KEPT], skipped: [{ path: "src/od#d.ts", reason: "unroutable" }] },
        argument: "src/od#d.ts",
        answer: {
          kind: "unknown",
          skipped: { path: "src/od#d.ts", reason: "unroutable" },
          namedBy: "path",
        },
      },
    ],
    [
      "hands a pattern holding `#` on to the substring arm",
      {
        document: { symbols: [KEPT] },
        argument: "odd#name",
        answer: { kind: "not-found", exitCode: EXIT.RUNTIME, coverage: null },
      },
    ],
  ])("%s", async (_, lookup) => {
    expect(await lookUp(lookup)).toMatchObject(lookup.answer)
  })
})

describe("runExplain — an argument holding `/` is looked up as a file", () => {
  it.each<[string, Lookup]>([
    [
      "answers unknown for a file on disk the scan never analysed",
      {
        document: LOST_ROUTE,
        argument: "src/route.ts",
        onDisk: ["src/route.ts"],
        answer: { kind: "unknown", exitCode: EXIT.GATE, skipped: ROUTE_LOST, namedBy: "path" },
      },
    ],
    [
      "answers unknown for a skipped file the working tree does not hold",
      {
        document: LOST_ROUTE,
        argument: "src/route.ts",
        answer: { kind: "unknown", exitCode: EXIT.GATE, skipped: ROUTE_LOST },
      },
    ],
    [
      "makes no positive claim about a path the document cannot tie to a loss",
      {
        document: LOST_ROUTE,
        argument: "src/never.ts",
        answer: { kind: "not-found", exitCode: EXIT.RUNTIME, coverage: NAMED_LOSS },
      },
    ],
    [
      "qualifies a file present on disk but empty of Symbols",
      {
        document: LOST_ROUTE,
        argument: "src/empty.ts",
        onDisk: ["src/empty.ts"],
        answer: { kind: "not-found", exitCode: EXIT.RUNTIME, coverage: NAMED_LOSS },
      },
    ],
    [
      "counts what a document predating stats.skippedFiles cannot name",
      {
        document: { symbols: [KEPT], unnamedLosses: 1 },
        argument: "src/empty.ts",
        onDisk: ["src/empty.ts"],
        answer: { kind: "not-found", coverage: { kind: "unnamed-losses", fileCount: 1 } },
      },
    ],
    [
      "answers from the Symbols a skipped path still carries",
      {
        document: {
          symbols: [symbolFor("ts:src/dup.ts#dup")],
          skipped: [{ path: "src/dup.ts", reason: "over-size" }],
        },
        argument: "src/dup.ts",
        onDisk: ["src/dup.ts"],
        answer: { kind: "file", exitCode: EXIT.SUCCESS, symbols: [symbolFor("ts:src/dup.ts#dup")] },
      },
    ],
    [
      "matches a decomposed argument against the composed path of a skipped file",
      {
        document: { symbols: [KEPT], skipped: [{ path: COMPOSED, reason: "parse-failed" }] },
        argument: DECOMPOSED,
        answer: { kind: "unknown", skipped: { path: COMPOSED, reason: "parse-failed" } },
      },
    ],
    [
      "finds the Symbols of a decomposed argument the document composed",
      {
        document: { symbols: [symbolFor(`ts:${COMPOSED}#read`)] },
        argument: DECOMPOSED,
        onDisk: [DECOMPOSED],
        answer: { kind: "file", symbols: [symbolFor(`ts:${COMPOSED}#read`)] },
      },
    ],
    [
      "falls through to the substring arm for a path outside the workspace",
      {
        document: { symbols: [KEPT] },
        argument: "../elsewhere/kept.ts",
        answer: { kind: "not-found", exitCode: EXIT.RUNTIME },
      },
    ],
  ])("%s", async (_, lookup) => {
    expect(await lookUp(lookup)).toMatchObject(lookup.answer)
  })

  it("reads a path typed in a subdirectory as relative to it, and looks it up from the root", async () => {
    await writeScannedWorkspace(workspace.root, LOST_ROUTE)
    await mkdir(resolve(workspace.root, "src"))

    const outcome = await runExplain({
      cwd: resolve(workspace.root, "src"),
      argument: "./route.ts",
      noRescan: true,
    })

    expect(outcome).toMatchObject({ kind: "unknown", skipped: ROUTE_LOST })
  })

  it("answers out of an --ir document that is not the one scan writes", async () => {
    const pinned = resolve(workspace.root, "pinned.ir.json")
    await writeFileAt(workspace.root, "pinned.ir.json", JSON.stringify(documentWith(LOST_ROUTE)))

    const outcome = await runExplain({
      cwd: workspace.root,
      argument: "src/route.ts",
      irPath: pinned,
    })

    expect(outcome).toMatchObject({ kind: "unknown", exitCode: EXIT.GATE, skipped: ROUTE_LOST })
  })
})

describe("runExplain — any other argument is a substring of Symbol names", () => {
  const OTHER_LOST: SkippedFile = { path: "src/other.ts", reason: "parse-timeout" }

  it.each<[string, Lookup]>([
    [
      "counts the files a document lost, sorted, on a miss",
      {
        document: { symbols: [KEPT], skipped: [ROUTE_LOST, OTHER_LOST] },
        argument: "handleRequest",
        answer: {
          kind: "not-found",
          exitCode: EXIT.RUNTIME,
          coverage: { kind: "named-losses", files: [OTHER_LOST, ROUTE_LOST] },
        },
      },
    ],
    [
      "attaches nothing when the document covered every file",
      {
        document: { symbols: [KEPT] },
        argument: "handleRequest",
        answer: { kind: "not-found", exitCode: EXIT.RUNTIME, coverage: null },
      },
    ],
    [
      "attaches nothing to a document that spells its empty skip list out",
      {
        document: { symbols: [KEPT], skipped: [] },
        argument: "handleRequest",
        answer: { kind: "not-found", coverage: null },
      },
    ],
    [
      "counts what a document predating stats.skippedFiles cannot name",
      {
        document: { symbols: [KEPT], unnamedLosses: 2 },
        argument: "handleRequest",
        answer: { kind: "not-found", coverage: { kind: "unnamed-losses", fileCount: 2 } },
      },
    ],
    [
      "answers a unique match, in a document that lost a file all the same",
      {
        document: LOST_ROUTE,
        argument: "kept",
        answer: { kind: "single", exitCode: EXIT.SUCCESS, symbol: KEPT },
      },
    ],
    [
      "lists the candidates of an ambiguous match, in a document that lost a file all the same",
      {
        document: {
          symbols: [KEPT, symbolFor("ts:src/kept2.ts#keptTwice")],
          skipped: [ROUTE_LOST],
        },
        argument: "kept",
        answer: { kind: "ambiguous", exitCode: EXIT.INPUT_ERROR },
      },
    ],
  ])("%s", async (_, lookup) => {
    const outcome = await lookUp(lookup)
    expect(outcome).toMatchObject(lookup.answer)
    if (outcome.kind === "ambiguous") expect(outcome.candidates).toHaveLength(2)
  })
})

const onPosix = it.skipIf(process.platform === "win32")

describe("runExplain — a path no Document can name", () => {
  onPosix("does not answer for the file a separator conversion would have named", async () => {
    const outcome = await lookUp({
      document: { symbols: [symbolFor("ts:src/weird/name.stub#neighbour")] },
      argument: "src/weird\\name.stub",
      onDisk: ["src/weird/name.stub", "src/weird\\name.stub"],
      answer: {},
    })

    expect(outcome).toMatchObject({
      kind: "unnameable",
      unnameablePrefix: "src/weird\\name.stub",
      exitCode: EXIT.GATE,
    })
    expect(JSON.stringify(outcome)).not.toContain("neighbour")
  })

  onPosix("says so for a name that is not on disk either", async () => {
    const outcome = await lookUp({
      document: { symbols: [KEPT] },
      argument: "src/no\\such.stub",
      answer: {},
    })
    expect(outcome.kind).toBe("unnameable")
  })
})
