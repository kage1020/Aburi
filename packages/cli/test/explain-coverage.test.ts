import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { makeLanguageId } from "@aburi/core"
import type { IR, Symbol as IRSymbol, SkippedFile } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runCli, runExplain } from "../src"
import { symbolId } from "./fixtures"

/**
 * `aburi explain` answering out of an IR that records what its scan never read.
 *
 * `No matches` is an assertion of absence, and a document carrying `stats.skippedFiles` can
 * contradict it: the file that would declare the Symbol was withdrawn, so the document does
 * not know. The split this file pins is between a doubt the document can attach to the
 * question — the file arm and the id arm name a file, and the skip list either holds it or
 * does not — and a doubt it can only state about the run, which is every other case.
 */

class MemStream extends Writable {
  chunks: string[] = []
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  text(): string {
    return this.chunks.join("")
  }
}

function makeSymbol(id: string, file: string): IRSymbol {
  return {
    id: symbolId(id),
    kind: "function",
    extKind: null,
    name: id.slice(id.indexOf("#") + 1),
    language: makeLanguageId("ts"),
    component: null,
    visibility: "public",
    decorators: [],
    signature: null,
    rules: [],
    effects: [],
    calls: [],
    source: { file, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
    fingerprint: { api: "aaa", logic: "bbb", syntax: "ccc" },
    confidence: "high",
    derivedBy: [],
    dropped: false,
    dropReason: null,
  }
}

interface IRShape {
  symbols: readonly IRSymbol[]
  /** `stats.skippedFiles`; omitted entirely when absent, as a Class B field is. */
  skipped?: readonly SkippedFile[]
  /** Losses a document written before `stats.skippedFiles` can count but not name. */
  unnamedLosses?: number
}

/**
 * Every document here goes through `readIR`, so invariant #21 applies: the skip list is
 * exactly as long as `totalFiles - parsedFiles`. One file per Symbol keeps that arithmetic
 * honest without the fixtures having to state it.
 */
function makeIR(shape: IRShape): IR {
  const skipped = shape.skipped ?? null
  const lost = skipped === null ? (shape.unnamedLosses ?? 0) : skipped.length
  const byPath = (a: { path: string }, b: { path: string }): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  return {
    $schema: "https://aburi.dev/schema/aburi.ir.v1.json",
    generator: { name: "aburi", version: "0.0.0", plugins: [] },
    workspace: { root: ".", managers: [], languages: [makeLanguageId("ts")] },
    components: [],
    symbols: [...shape.symbols].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    dependencies: [],
    stats: {
      totalFiles: shape.symbols.length + lost,
      parsedFiles: shape.symbols.length,
      keptSymbols: shape.symbols.length,
      droppedSymbols: 0,
      ...(skipped === null ? {} : { skippedFiles: [...skipped].sort(byPath) }),
      effectPropagation: {
        sccCount: 0,
        maxSccSize: 0,
        propagatedEffectCount: 0,
        symbolsWithPropagatedEffects: 0,
      },
    },
  }
}

let scratch = ""

async function writeIR(shape: IRShape): Promise<void> {
  await mkdir(resolve(scratch, "out"), { recursive: true })
  await writeFile(resolve(scratch, "out/aburi.ir.json"), JSON.stringify(makeIR(shape)), "utf8")
}

async function put(relPath: string, contents: string): Promise<void> {
  const absolute = resolve(scratch, relPath)
  await mkdir(resolve(absolute, ".."), { recursive: true })
  await writeFile(absolute, contents, "utf8")
}

const KEPT = makeSymbol("ts:src/kept.ts#kept", "src/kept.ts")
const ROUTE_LOST: SkippedFile = { path: "src/route.ts", reason: "parse-failed" }

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-explain-coverage-"))
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "explain-coverage-fixture", private: true }),
    "utf8",
  )
  // A real workspace marker, not just the `package.json`: a lone manifest with no `workspaces`
  // field is not one, and the root would then be wherever the command was invoked — which is
  // the difference the run-from-a-subdirectory case below is about.
  await writeFile(resolve(scratch, ".aburi-workspace"), "", "utf8")
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runExplain — the id arm", () => {
  it("reports unknown when the file the id names was never analysed", async () => {
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ts:src/route.ts#handleRequest",
      noRescan: true,
    })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind !== "unknown") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.GATE)
    expect(outcome.skipped).toEqual(ROUTE_LOST)
    expect(outcome.namedBy).toBe("id")
  })

  it("answers a Symbol whose id names a lost file but whose source.file does not", async () => {
    // The id records where the Symbol was declared to live when it was minted; `source.file`
    // is where the document says it is, and a re-export or a generated file pulls them apart.
    // The check therefore runs on a miss only — this Symbol is right here, and the head of
    // the arm must not consult the skip list before looking for it.
    await writeIR({
      symbols: [makeSymbol("ts:src/route.ts#relocated", "src/actual.ts")],
      skipped: [ROUTE_LOST],
    })
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ts:src/route.ts#relocated",
      noRescan: true,
    })
    expect(outcome.kind).toBe("single")
    if (outcome.kind !== "single") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
  })

  it("qualifies the run when the id names a file the skip list does not hold", async () => {
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ts:src/elsewhere.ts#gone",
      noRescan: true,
    })
    expect(outcome.kind).toBe("not-found")
    if (outcome.kind !== "not-found") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.RUNTIME)
    expect(outcome.coverage).toEqual({ kind: "named-losses", files: [ROUTE_LOST] })
  })

  it("claims no file for an argument that is not a well-formed Symbol id", async () => {
    // The arm dispatches on a `#` — a silhouette, not the grammar. `3bad` is not a legal
    // qualified name, so this string names no file, and attributing `src/route.ts` to it
    // would let a typo produce a positive statement about coverage.
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ts:src/route.ts#3bad",
      noRescan: true,
    })
    expect(outcome.kind).toBe("not-found")
    if (outcome.kind !== "not-found") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.RUNTIME)
    expect(outcome.coverage).toEqual({ kind: "named-losses", files: [ROUTE_LOST] })
  })
})

describe("runExplain — an argument that holds a `#` without being an id", () => {
  it("falls through to the file arm instead of claiming it as a missed id", async () => {
    // `#` is what makes the id arm worth trying, not proof that it applies. A file whose name
    // holds one is recorded in `stats.skippedFiles` — the Document's path rule admits both id
    // separators and only the id grammar refuses them — so answering "no such Symbol id" here
    // would make the file arm unreachable for exactly the files that most need it.
    const lost = { path: "src/od#d.ts", reason: "unroutable" as const }
    await writeIR({ symbols: [KEPT], skipped: [lost] })
    const outcome = await runExplain({
      cwd: scratch,
      argument: "src/od#d.ts",
      noRescan: true,
    })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind !== "unknown") throw new Error("unreachable")
    expect(outcome.skipped).toEqual(lost)
    expect(outcome.namedBy).toBe("path")
  })

  it("still answers as a missed id when the argument really is one", async () => {
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ts:src/route.ts#gone",
      noRescan: true,
    })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind !== "unknown") throw new Error("unreachable")
    expect(outcome.namedBy).toBe("id")
  })

  it("hands a pattern holding a `#` on rather than answering for it", async () => {
    // Nothing can match it — a qualified name cannot hold a `#` (invariant #17), so the
    // substring arm finds nothing and the answer is `not-found` either way. What changed is
    // that the two arms below now get to say so: before, the id arm returned first.
    await writeIR({ symbols: [KEPT] })
    const outcome = await runExplain({ cwd: scratch, argument: "odd#name", noRescan: true })
    expect(outcome.kind).toBe("not-found")
  })
})

describe("runExplain — the file arm", () => {
  it("reports unknown for a file on disk the scan never analysed", async () => {
    await put("src/route.ts", "export function handleRequest() {}\n")
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({ cwd: scratch, argument: "src/route.ts", noRescan: true })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind !== "unknown") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.GATE)
    expect(outcome.skipped).toEqual(ROUTE_LOST)
    expect(outcome.namedBy).toBe("path")
  })

  it("reaches the arm for a file the working tree does not hold", async () => {
    // The pinned-artifact case `--ir` and `--no-rescan` exist for: the document names the
    // file, and requiring it on disk too would drop the question into the substring arm and
    // answer it with the diffuse message.
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({ cwd: scratch, argument: "src/route.ts", noRescan: true })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind !== "unknown") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.GATE)
    expect(outcome.skipped).toEqual(ROUTE_LOST)
  })

  it("makes no positive claim about a path the document cannot tie to a loss", async () => {
    // Which arm answered is not observable and is not the subject: a path-shaped argument the
    // skip list does not hold gets the doubt about the run, never a statement about the file.
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({ cwd: scratch, argument: "src/never.ts", noRescan: true })
    expect(outcome.kind).toBe("not-found")
    if (outcome.kind !== "not-found") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.RUNTIME)
    expect(outcome.coverage).toEqual({ kind: "named-losses", files: [ROUTE_LOST] })
  })

  it("answers from the Symbols a listed path still carries", async () => {
    await put("src/dup.ts", "export function dup() {}\n")
    await writeIR({
      symbols: [makeSymbol("ts:src/dup.ts#dup", "src/dup.ts")],
      skipped: [{ path: "src/dup.ts", reason: "over-size" }],
    })
    const outcome = await runExplain({ cwd: scratch, argument: "src/dup.ts", noRescan: true })
    expect(outcome.kind).toBe("file")
    if (outcome.kind !== "file") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
    expect(outcome.symbols).toHaveLength(1)
  })

  it("resolves the argument against the workspace root, not the directory it was typed in", async () => {
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({
      cwd: resolve(scratch, "src"),
      argument: "./route.ts",
      noRescan: true,
    })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind !== "unknown") throw new Error("unreachable")
    expect(outcome.skipped).toEqual(ROUTE_LOST)
  })

  it("matches a decomposed argument against the composed path the document holds", async () => {
    // `SkippedFile.path` is NFC by schema and by invariant #19, while the argument is
    // whatever the shell handed over — a name carrying a combining mark survives an archive
    // or a rename in decomposed form. Spelled as escapes here because the difference is one
    // the editor is free to hide.
    const composed = "src/caf\u00e9.ts"
    const decomposed = "src/cafe\u0301.ts"
    await writeIR({ symbols: [KEPT], skipped: [{ path: composed, reason: "parse-failed" }] })
    const outcome = await runExplain({ cwd: scratch, argument: decomposed, noRescan: true })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind !== "unknown") throw new Error("unreachable")
    expect(outcome.skipped.path).toBe(composed)
  })

  it("finds the Symbols of a decomposed argument the document composed", async () => {
    // The file on disk carries the decomposed name, which is what an archive leaves behind,
    // while the scan recorded it composed as §1.2 requires. The disk probe finds it under
    // the name it was given; the comparison against `source.file` must not depend on that.
    const composed = "src/caf\u00e9.ts"
    const decomposed = "src/cafe\u0301.ts"
    await put(decomposed, "export function read() {}\n")
    await writeIR({ symbols: [makeSymbol(`ts:${composed}#read`, composed)] })
    const outcome = await runExplain({ cwd: scratch, argument: decomposed, noRescan: true })
    expect(outcome.kind).toBe("file")
    if (outcome.kind !== "file") throw new Error("unreachable")
    expect(outcome.symbols).toHaveLength(1)
  })

  it("leaves an --output file alone when it has no answer to write", async () => {
    // A previous good answer sits in the file. `unknown` must not open it: truncating it would
    // replace an answer with nothing at all, and the exit code is the only other signal.
    const output = resolve(scratch, "out/explain.md")
    await mkdir(resolve(scratch, "out"), { recursive: true })
    await writeFile(output, "# a previous answer\n", "utf8")
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({
      cwd: scratch,
      argument: "src/route.ts",
      outputPath: output,
      noRescan: true,
    })
    expect(outcome.kind).toBe("unknown")
    expect(await readFile(output, "utf8")).toBe("# a previous answer\n")
  })

  it("qualifies the run when the file is present but empty of Symbols", async () => {
    await put("src/empty.ts", "type Only = string\n")
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({ cwd: scratch, argument: "src/empty.ts", noRescan: true })
    expect(outcome.kind).toBe("not-found")
    if (outcome.kind !== "not-found") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.RUNTIME)
    expect(outcome.coverage).toEqual({ kind: "named-losses", files: [ROUTE_LOST] })
  })
})

describe("runExplain — a pinned artifact", () => {
  it("answers out of an --ir document that is not the one scan writes", async () => {
    // CL21 is written in terms of `--ir`, and `resolveIR` takes a different branch for it than
    // for the default path every other case here uses.
    const pinned = resolve(scratch, "pinned.ir.json")
    await writeFile(
      pinned,
      JSON.stringify(makeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })),
      "utf8",
    )
    const outcome = await runExplain({
      cwd: scratch,
      argument: "src/route.ts",
      irPath: pinned,
    })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind !== "unknown") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.GATE)
    expect(outcome.skipped).toEqual(ROUTE_LOST)
  })
})

describe("runExplain — the substring arm", () => {
  it("counts the files the document names but does not list them", async () => {
    await writeIR({
      symbols: [KEPT],
      skipped: [ROUTE_LOST, { path: "src/other.ts", reason: "parse-timeout" }],
    })
    const outcome = await runExplain({ cwd: scratch, argument: "handleRequest", noRescan: true })
    expect(outcome.kind).toBe("not-found")
    if (outcome.kind !== "not-found") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.RUNTIME)
    expect(outcome.coverage).toEqual({
      kind: "named-losses",
      files: [{ path: "src/other.ts", reason: "parse-timeout" }, ROUTE_LOST],
    })
  })

  it("attaches nothing when the document covered every file", async () => {
    await writeIR({ symbols: [KEPT] })
    const outcome = await runExplain({ cwd: scratch, argument: "handleRequest", noRescan: true })
    expect(outcome.kind).toBe("not-found")
    if (outcome.kind !== "not-found") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.RUNTIME)
    expect(outcome.coverage).toBeNull()
  })

  it("attaches nothing to a document that spells its empty skip list out", async () => {
    // Class B says a writer omits the key rather than emitting `[]`, but a document that
    // writes it is still saying the scan covered everything — which is not a doubt.
    await writeIR({ symbols: [KEPT], skipped: [] })
    const outcome = await runExplain({ cwd: scratch, argument: "handleRequest", noRescan: true })
    expect(outcome.kind).toBe("not-found")
    if (outcome.kind !== "not-found") throw new Error("unreachable")
    expect(outcome.coverage).toBeNull()
  })

  it("counts what a document predating stats.skippedFiles cannot name", async () => {
    await writeIR({ symbols: [KEPT], unnamedLosses: 2 })
    const outcome = await runExplain({ cwd: scratch, argument: "handleRequest", noRescan: true })
    expect(outcome.kind).toBe("not-found")
    if (outcome.kind !== "not-found") throw new Error("unreachable")
    expect(outcome.coverage).toEqual({ kind: "unnamed-losses", fileCount: 2 })
  })

  it("leaves a hit alone in a document that lost a file", async () => {
    // The non-goal, pinned: a hit is the document speaking about a Symbol it holds. An
    // `over-size` file is skipped on every run, so caveating hits would caveat this
    // workspace's every answer forever.
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const outcome = await runExplain({ cwd: scratch, argument: "kept", noRescan: true })
    expect(outcome.kind).toBe("single")
    if (outcome.kind !== "single") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
  })

  it("leaves an ambiguous answer alone in a document that lost a file", async () => {
    await writeIR({
      symbols: [KEPT, makeSymbol("ts:src/kept2.ts#keptTwice", "src/kept2.ts")],
      skipped: [ROUTE_LOST],
    })
    const outcome = await runExplain({ cwd: scratch, argument: "kept", noRescan: true })
    expect(outcome.kind).toBe("ambiguous")
    if (outcome.kind !== "ambiguous") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.INPUT_ERROR)
    expect(outcome.candidates).toHaveLength(2)
  })

  it("reports what a predating document cannot name from the file arm too", async () => {
    await put("src/empty.ts", "type Only = string\n")
    await writeIR({ symbols: [KEPT], unnamedLosses: 1 })
    const outcome = await runExplain({ cwd: scratch, argument: "src/empty.ts", noRescan: true })
    expect(outcome.kind).toBe("not-found")
    if (outcome.kind !== "not-found") throw new Error("unreachable")
    expect(outcome.coverage).toEqual({ kind: "unnamed-losses", fileCount: 1 })
  })
})

/**
 * A language plugin that withdraws `bad.stub` and nothing else. No in-tree plugin refuses a
 * file to order, and the refusal has to leave the scan **green** — an unparseable file is a
 * property of the source, so `aburi scan` stays at exit 0 and `withScanFault` sees nothing.
 * That is what makes the case below a test of the document rather than of the scan's exit code.
 */
const STUB_PLUGIN = `
const manifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "lang-stub",
  version: "0.0.0",
  type: "lang",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [],
    frameworks: [],
  },
}

export const plugin = {
  manifest,
  languageId: "stub",
  fileExtensions: [".stub"],
  capabilities: {
    hasDecorators: false,
    hasGenerics: false,
    hasAsync: false,
    hasMacros: false,
    hasPatternMatching: false,
    hasAbstractTypes: false,
    hasModules: false,
    hasNamespaces: false,
    hasTypeParameters: false,
    hasExplicitVisibility: false,
    hasJsDoc: false,
  },
  init: async () => {},
  parseFile: async (file) => {
    const tree = { path: file.path }
    if (file.path === "bad.stub") {
      return {
        tree,
        errors: [{ message: "unterminated string", line: 12, column: 4, recoverable: false }],
        imports: [],
      }
    }
    return { tree, errors: [], imports: [] }
  },
  extractSymbols: (tree, ctx) => {
    const name = ctx.file.path.replace(/[^A-Za-z0-9]/g, "_")
    return [
      {
        id: "stub:" + ctx.file.path + "#" + name,
        kind: "function",
        extKind: null,
        name,
        visibility: "public",
        decorators: [],
        signature: null,
        source: {
          file: ctx.file.path,
          startLine: 1,
          endLine: 2,
          startColumn: null,
          endColumn: null,
        },
        derivedBy: [],
        bodyNode: tree,
        fullNode: tree,
      },
    ]
  },
  walkBody: () => ({ rules: [], calls: [] }),
  normalizeAst: () => "stub-ast",
}
`

describe("runExplain — the scan this command runs", () => {
  beforeEach(async () => {
    await writeFile(
      resolve(scratch, "aburi.json"),
      JSON.stringify({
        $schema: "https://aburi.dev/schema/aburi.config.v1.json",
        languages: ["./lang-stub.mjs"],
      }),
      "utf8",
    )
    await writeFile(resolve(scratch, "lang-stub.mjs"), STUB_PLUGIN, "utf8")
    await put("bad.stub", "bad")
    await put("ok.stub", "ok")
  })

  it("reports unknown for a file its own green scan withdrew", async () => {
    const outcome = await runExplain({ cwd: scratch, argument: "stub:bad.stub#bad_stub" })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind !== "unknown") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.GATE)
    expect(outcome.skipped).toEqual({ path: "bad.stub", reason: "parse-failed" })
  })

  it("answers the file that scan did read, which is what makes the scan green", async () => {
    // The control for the case above: were the scan itself faulted, `withScanFault` would
    // have made this exit 3 as well, and the gate above would prove nothing about coverage.
    const outcome = await runExplain({ cwd: scratch, argument: "stub:ok.stub#ok_stub" })
    expect(outcome.kind).toBe("single")
    if (outcome.kind !== "single") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
  })
})

describe("aburi explain — what the user reads", () => {
  it("names the file and the reason, and keeps stdout empty", async () => {
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "src/route.ts", "--no-rescan"],
      cwd: scratch,
      stdout,
      stderr,
    })
    expect(code).toBe(EXIT.GATE)
    expect(stdout.text()).toBe("")
    expect(stderr.text()).toContain("src/route.ts")
    expect(stderr.text()).toContain("parse-failed")
    expect(stderr.text()).not.toContain("No matches")
  })

  it("says the id named the file, not the question", async () => {
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "ts:src/route.ts#handleRequest", "--no-rescan"],
      cwd: scratch,
      stdout: new MemStream(),
      stderr,
    })
    expect(code).toBe(EXIT.GATE)
    expect(stderr.text()).toContain("the file that id names")
  })

  it("keeps No matches and adds the count when the doubt is diffuse", async () => {
    await writeIR({ symbols: [KEPT], skipped: [ROUTE_LOST] })
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "handleRequest", "--no-rescan"],
      cwd: scratch,
      stdout: new MemStream(),
      stderr,
    })
    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr.text()).toContain('No matches for "handleRequest".')
    expect(stderr.text()).toContain("1 file(s)")
    expect(stderr.text()).toContain("stats.skippedFiles")
    // The discriminator between the two doubts, which is the contract; the sentence carrying
    // it is the wrapper's to reword.
    expect(stderr.text()).not.toContain("predates")
  })

  it("says it cannot name them when the document predates the list", async () => {
    await writeIR({ symbols: [KEPT], unnamedLosses: 1 })
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "handleRequest", "--no-rescan"],
      cwd: scratch,
      stdout: new MemStream(),
      stderr,
    })
    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr.text()).toContain('No matches for "handleRequest".')
    expect(stderr.text()).toContain("1 file(s)")
    expect(stderr.text()).toContain("predates")
  })

  it("says exactly what it said before when the document covered everything", async () => {
    await writeIR({ symbols: [KEPT] })
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "handleRequest", "--no-rescan"],
      cwd: scratch,
      stdout: new MemStream(),
      stderr,
    })
    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr.text()).toBe('No matches for "handleRequest".\n')
  })
})

// Windows has no filename that holds a backslash — the character is its path separator — so the
// fixture can only exist on POSIX.
const onPosix = it.skipIf(process.platform === "win32")

describe("runExplain — the path arm converts a native path the way the core does", () => {
  onPosix("does not answer for the file the old conversion turned the argument into", async () => {
    // The argument is a native path, and the conversion used to rewrite every backslash into a
    // separator whatever the platform. That turns `src/weird\name.stub` — a real file — into
    // `src/weird/name.stub`, which here is a *different* real file the document does hold a
    // Symbol for, so the answer was another file's API with nothing saying so.
    await put("src/weird/name.stub", "1")
    await put("src/weird\\name.stub", "1")
    await writeIR({
      symbols: [makeSymbol("ts:src/weird/name.stub#neighbour", "src/weird/name.stub")],
    })

    // The forward slash is what puts the argument in this arm at all; a bare basename goes to
    // the substring arm and never reaches the conversion.
    const outcome = await runExplain({
      cwd: scratch,
      argument: "src/weird\\name.stub",
      noRescan: true,
    })

    expect(outcome.kind).not.toBe("single")
    expect(JSON.stringify(outcome)).not.toContain("neighbour")
  })
})
