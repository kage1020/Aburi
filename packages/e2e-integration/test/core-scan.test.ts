import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_OUTPUT_DIRNAME, IR_JSON_FILENAME } from "@aburi/cli"
import {
  apiFingerprint,
  assertIRIntegrity,
  detectComponents,
  scan,
  serializeCanonical,
  writeCanonicalIR,
} from "@aburi/core"
import { buildDiff } from "@aburi/diff"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { nextFrameworkPlugin } from "@aburi/framework-next"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { IR, IRSymbol } from "@aburi/types"
import Ajv2020 from "ajv/dist/2020.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import irSchema from "../../../schema/aburi.ir.v1.json" with { type: "json" }

let workRoot: string

beforeEach(async () => {
  workRoot = join(tmpdir(), `aburi-scan-e2e-${Math.floor(performance.now() * 1000)}`)
  await mkdir(workRoot, { recursive: true })
})

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await rm(workRoot, { recursive: true, force: true })
})

async function writeSource(rel: string, content: string): Promise<void> {
  const abs = join(workRoot, rel)
  const dir = abs.slice(0, Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\")))
  await mkdir(dir, { recursive: true })
  await writeFile(abs, content, "utf8")
}

const ajv = new Ajv2020({ strict: false, allErrors: true })
const validateIR = ajv.compile(irSchema)

/**
 * Validates a generated IR against `schema/aburi.ir.v1.json`, which is what puts the
 * conditional `Effect` constraints and `inferredThrows`' `minItems` in front of a real
 * document rather than a hand-built fixture.
 *
 * No path is excluded, `workspace.languages` included: it is declared by
 * `LanguagePlugin.languageId` and enforced by integrity invariant #18, so a regression
 * there fails here like any other.
 */
function schemaViolations(document: unknown): string[] {
  if (validateIR(document)) return []
  return (validateIR.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`)
}

function buildRegistry() {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  registry.register(nextFrameworkPlugin.manifest)
  registry.register(prismaEffectsPlugin.manifest)
  return registry
}

describe("scan — integration through real plugins", () => {
  it("produces an IR that survives every integrity invariant", async () => {
    await writeSource(
      "app/dashboard/page.tsx",
      "export default function DashboardPage() {\n  return null\n}\n",
    )
    await writeSource(
      "app/api/users/route.ts",
      `import { PrismaClient } from "@prisma/client"\nexport async function GET(prisma: PrismaClient) {\n  const users = await prisma.user.findMany()\n  return users\n}\n`,
    )
    await writeSource(
      "src/lib/helpers.ts",
      "export function formatDate(d: Date) {\n  return d.toISOString()\n}\n",
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [nextFrameworkPlugin],
      effects: [prismaEffectsPlugin],
      registry: buildRegistry(),
    })

    // scan() throws on integrity violation — reaching here means every invariant is
    // green. Shape sanity assertions:
    expect(result.ir.$schema).toBe("https://aburi.kage1020.com/schema/aburi.ir.v1.json")
    expect(result.ir.workspace.root).toBe(".")
    expect(result.ir.symbols.length).toBeGreaterThan(0)
    expect(result.ir.stats.totalFiles).toBe(3)
    expect(result.ir.stats.parsedFiles).toBe(3)

    // call-resolution.md §8.1 — the counters are emitted unconditionally, and
    // integrity invariant #15 has already checked them against symbols[].
    const callResolution = result.ir.stats.callResolution
    expect(callResolution).toBeDefined()
    expect(callResolution?.unresolved).toEqual({
      localScope: expect.any(Number),
      external: expect.any(Number),
      dynamic: expect.any(Number),
      ambiguous: expect.any(Number),
      noMatch: expect.any(Number),
    })
    expect(result.unresolvedCalls.length).toBe(
      (callResolution?.totalCalls ?? 0) - (callResolution?.resolvedCalls ?? 0),
    )
  })

  it("buckets an expression-receiver call as `dynamic` (CR27, end to end)", async () => {
    await writeSource(
      "app/api/reports/route.ts",
      `export function GET() {\n  return getRepo().save({})\n}\n`,
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [nextFrameworkPlugin],
      effects: [],
      registry: buildRegistry(),
    })

    const dynamic = result.unresolvedCalls.filter((d) => d.bucket === "dynamic")
    expect(dynamic.map((d) => d.target)).toContain("getRepo.save")
    expect(result.ir.stats.callResolution?.unresolved.dynamic).toBeGreaterThan(0)
  })

  it("routes Next.js page.tsx defaults to framework:next:page extKind", async () => {
    await writeSource("app/page.tsx", "export default function Home() {\n  return null\n}\n")

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [nextFrameworkPlugin],
      effects: [],
      registry: buildRegistry(),
    })

    const home = result.ir.symbols.find((s) => s.name === "Home")
    expect(home?.extKind).toBe("framework:next:page")
  })

  it("classifies prisma.<model>.<verb> calls into db.read / db.write effects", async () => {
    await writeSource(
      "app/api/orders/route.ts",
      `import { PrismaClient } from "@prisma/client"\nexport async function POST(prisma: PrismaClient) {\n  const order = await prisma.order.create({ data: {} })\n  const orders = await prisma.order.findMany()\n  return { order, orders }\n}\n`,
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [nextFrameworkPlugin],
      effects: [prismaEffectsPlugin],
      registry: buildRegistry(),
    })

    const post = result.ir.symbols.find((s) => s.name === "POST")
    const effectIds = new Set(post?.effects.map((e) => e.id) ?? [])
    expect(effectIds.has("db.read")).toBe(true)
    expect(effectIds.has("db.write")).toBe(true)
  })

  it("drops console.* calls from effects and calls (Category C)", async () => {
    await writeSource(
      "src/service.ts",
      `export function work() {\n  console.log("hello")\n  console.error("bad")\n}\n`,
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [],
      effects: [],
      registry: buildRegistry(),
    })

    const symbol = result.ir.symbols.find((s) => s.name === "work")
    for (const call of symbol?.calls ?? []) {
      expect(call.target.startsWith("console.")).toBe(false)
    }
    for (const effect of symbol?.effects ?? []) {
      expect(effect.target.startsWith("console.")).toBe(false)
    }
  })

  it("respects config.suppress[] to drop app-specific loggers", async () => {
    await writeSource(
      "src/service.ts",
      `export function work() {\n  myLogger.debug("hi")\n  metrics.counter("x")\n}\n`,
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: { suppress: ["myLogger", "metrics"] },
      languages: [langTypescriptPlugin],
      frameworks: [],
      effects: [],
      registry: buildRegistry(),
    })

    const symbol = result.ir.symbols.find((s) => s.name === "work")
    for (const call of symbol?.calls ?? []) {
      expect(call.target.startsWith("myLogger.")).toBe(false)
      expect(call.target.startsWith("metrics.")).toBe(false)
    }
  })

  it("marks interface / type alias declarations as dropped with correct dropReason", async () => {
    await writeSource(
      "src/types.ts",
      "export interface Foo { x: number }\nexport type Bar = string\nexport function baz(): void {}\n",
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [],
      effects: [],
      registry: buildRegistry(),
    })

    const foo = result.ir.symbols.find((s) => s.name === "Foo")
    const bar = result.ir.symbols.find((s) => s.name === "Bar")
    expect(foo?.dropped).toBe(true)
    expect(bar?.dropped).toBe(true)
    expect([foo?.dropReason, bar?.dropReason]).toEqual(
      expect.arrayContaining(["interface (data model)", "type alias"]),
    )
  })

  it("resolves same-file top-level calls into via:call symbol edges", async () => {
    await writeSource(
      "src/service.ts",
      `export function helper(n: number): number {\n  return n + 1\n}\nexport function caller(): number {\n  return helper(3)\n}\n`,
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [],
      effects: [],
      registry: buildRegistry(),
    })

    const callEdge = result.ir.dependencies.find(
      (d) => d.via === "call" && d.from.endsWith("#caller") && d.to.endsWith("#helper"),
    )
    expect(callEdge).toBeDefined()
    expect(callEdge?.direction).toBe("outbound")
    expect(callEdge?.effect).toBeNull()
    // The Call entry on the caller Symbol carries the resolved id too — this
    // is the round-trip invariant #14 (`call-resolution.md` §7.1).
    const caller = result.ir.symbols.find((s) => s.name === "caller")
    const resolvedCall = caller?.calls.find((c) => c.target === "helper")
    expect(resolvedCall?.resolved).toBe(callEdge?.to)
  })

  it("dedupes multi-line calls to the same callee into a single via:call Dependency", async () => {
    await writeSource(
      "src/service.ts",
      `export function helper(n: number): number {\n  return n + 1\n}\nexport function caller(): number {\n  const a = helper(1)\n  const b = helper(2)\n  const c = helper(3)\n  return a + b + c\n}\n`,
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [],
      effects: [],
      registry: buildRegistry(),
    })

    const caller = result.ir.symbols.find((s) => s.name === "caller")
    // Three per-line Call entries survive on the Symbol side (integrity #11
    // requires monotonic line order).
    const resolvedCalls = (caller?.calls ?? []).filter((c) => c.resolved !== null)
    expect(resolvedCalls.length).toBe(3)
    // ...but the Dependency projection collapses them into ONE triple
    // (invariant #13). This is the projectSymbolEdges dedup contract.
    const edges = result.ir.dependencies.filter(
      (d) => d.via === "call" && d.from.endsWith("#caller") && d.to.endsWith("#helper"),
    )
    expect(edges.length).toBe(1)
  })

  it("resolves relative-import calls into via:call symbol edges (import scope)", async () => {
    await writeSource(
      "src/util.ts",
      `export function stringify(v: unknown): string {\n  return JSON.stringify(v)\n}\n`,
    )
    await writeSource(
      "src/main.ts",
      `import { stringify } from "./util"\nexport function main(): string {\n  return stringify({ hello: "world" })\n}\n`,
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [],
      effects: [],
      registry: buildRegistry(),
    })

    const callEdge = result.ir.dependencies.find(
      (d) =>
        d.via === "call" && d.from.endsWith("main.ts#main") && d.to.endsWith("util.ts#stringify"),
    )
    expect(callEdge).toBeDefined()
  })

  it("emits every Class A key in the serialized IR (ir-schema.md §1.1)", async () => {
    // The assertion has to run on parsed JSON rather than on `result.ir`: serializeCanonical
    // drops properties whose value is `undefined`, so a writer that left a Class A key off
    // its object literal produces an in-memory tree that satisfies every value-based check
    // and a document on disk that is missing the key. Reading the key back out of the JSON
    // is the only place the two can be told apart.
    await writeFile(join(workRoot, "package.json"), JSON.stringify({ name: "billing-app" }), "utf8")
    await writeSource("src/InvoiceService.ts", "export class InvoiceService {\n  create() {}\n}\n")
    await writeSource("src/types.ts", "export interface Invoice {\n  id: string\n}\n")

    const components = await detectComponents({ workspaceRoot: workRoot })
    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      components,
      languages: [langTypescriptPlugin],
      frameworks: [],
      effects: [],
      registry: buildRegistry(),
    })

    const parsed = JSON.parse(serializeCanonical(result.ir)) as {
      symbols: Array<Record<string, unknown> & { source: Record<string, unknown> }>
      components: Array<Record<string, unknown>>
    }

    expect(parsed.symbols.length).toBeGreaterThan(0)
    for (const symbol of parsed.symbols) {
      for (const key of ["component", "signature"]) {
        expect(Object.hasOwn(symbol, key), `symbols[].${key} on ${String(symbol.id)}`).toBe(true)
      }
      for (const key of ["startColumn", "endColumn"]) {
        expect(
          Object.hasOwn(symbol.source, key),
          `symbols[].source.${key} on ${String(symbol.id)}`,
        ).toBe(true)
      }
    }

    expect(parsed.components.length).toBeGreaterThan(0)
    for (const component of parsed.components) {
      expect(Object.hasOwn(component, "description"), `components[].description`).toBe(true)
      // Class B on the same record: the empty case is an absent key, not `[]`. Keeping both
      // directions in one test is what stops a future "normalize every optional field"
      // cleanup from collapsing the distinction. Phrased as "present implies non-empty"
      // rather than "always absent" so that a fixture gaining a detectable framework does
      // not fail a test about key presence.
      for (const key of ["publicApi", "frameworks"]) {
        if (!Object.hasOwn(component, key)) continue
        expect(
          (component[key] as unknown[]).length,
          `components[].${key} present but empty`,
        ).toBeGreaterThan(0)
      }
    }

    expect(schemaViolations(parsed)).toEqual([])
  })

  it("reads an IR whose Class A keys were never written (ir-schema.md §1.1 reader rule)", async () => {
    // §1.1 calls the reader rule the load-bearing half: a committed IR cannot be rewritten,
    // and `aburi diff` reads one as its base, so consumers must read an absent Class A key
    // as `null`. That makes the `?? null` normalizations in fingerprint/api.ts and
    // diff/delta.ts part of the contract rather than clutter -- and this is what fails if
    // someone "cleans them up": every repository that committed an IR before the writers
    // started emitting the keys would report phantom changes on an unchanged workspace.
    await writeSource("src/InvoiceService.ts", "export class InvoiceService {\n  create() {}\n}\n")
    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [],
      effects: [],
      registry: buildRegistry(),
    })

    // Reconstruct a pre-convention document. A legacy writer dropped the key exactly where
    // the current one writes `null` -- it never discarded a real value -- so the strip is
    // conditional on the value being `null`. Deleting unconditionally would test something
    // else: that a Symbol reads the same with and without its signature, which is false and
    // should be.
    const legacy = JSON.parse(serializeCanonical(result.ir)) as IR
    const dropIfNull = <T extends object>(record: T, key: keyof T): void => {
      if (record[key] === null) delete record[key]
    }
    for (const symbol of legacy.symbols) {
      dropIfNull(symbol, "component")
      dropIfNull(symbol, "signature")
      dropIfNull(symbol.source, "startColumn")
      dropIfNull(symbol.source, "endColumn")
    }
    const first = legacy.symbols[0] as IRSymbol
    expect(Object.hasOwn(first, "component")).toBe(false)
    expect(Object.hasOwn(first.source, "startColumn")).toBe(false)

    // Still a valid v1 document -- absence is exactly why the keys stay out of `required`.
    expect(schemaViolations(legacy)).toEqual([])
    // ...and still integral: no invariant may key off Class A presence, or reading a
    // committed IR at diff time would become a fatal error.
    expect(() => assertIRIntegrity(legacy)).not.toThrow()

    // The two readers that normalize. `apiFingerprint` folds a missing `signature` to null,
    // so the axis it computes is the same on both documents. Comparing recomputed against
    // recomputed rather than against the stored value keeps dropped Symbols in scope --
    // those carry the all-zero fingerprint of §5.6, which no recomputation reproduces.
    for (const [i, symbol] of legacy.symbols.entries()) {
      const emitted = result.ir.symbols[i] as IRSymbol
      expect(apiFingerprint(symbol), `api fingerprint drift on ${symbol.id}`).toBe(
        apiFingerprint(emitted),
      )
    }
    // ...and `computeSymbolDelta` folds a missing `component`, so diffing the stripped base
    // against the emitted head finds nothing changed. Every Symbol lands in `unchanged`.
    const ref = { ref: "aburi.ir.json", irSchema: result.ir.$schema }
    const diff = buildDiff({ baseIR: legacy, headIR: result.ir, base: ref, head: ref })
    expect(diff.summary.unchanged).toBe(result.ir.symbols.length)
    expect(diff.symbols, "a Class A key going missing must not read as a change").toEqual([])
  })

  it("writes a canonical JSON IR to disk via writeCanonicalIR", async () => {
    await writeSource("src/app.ts", "export function main() {}\n")

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [],
      effects: [],
      registry: buildRegistry(),
    })

    const outPath = join(workRoot, DEFAULT_OUTPUT_DIRNAME, IR_JSON_FILENAME)
    const serialized = await writeCanonicalIR(result.ir, outPath)
    expect(serialized.startsWith("{\n")).toBe(true)
    const parsed = JSON.parse(serialized)
    expect(parsed.$schema).toBe("https://aburi.kage1020.com/schema/aburi.ir.v1.json")
  })
})
