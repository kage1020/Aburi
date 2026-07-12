import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scan, writeCanonicalIR } from "@aburi/core"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { nextFrameworkPlugin } from "@aburi/framework-next"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

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

function buildRegistry() {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  registry.register(nextFrameworkPlugin.manifest)
  registry.register(prismaEffectsPlugin.manifest)
  return registry
}

describe("scan — integration through real plugins", () => {
  it("produces an IR that survives the 14 integrity invariants", async () => {
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
    expect(result.ir.$schema).toBe("https://aburi.dev/schema/aburi.ir.v1.json")
    expect(result.ir.workspace.root).toBe(".")
    expect(result.ir.symbols.length).toBeGreaterThan(0)
    expect(result.ir.stats.totalFiles).toBe(3)
    expect(result.ir.stats.parsedFiles).toBe(3)
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

    const outPath = join(workRoot, "out", "aburi.ir.json")
    const serialized = await writeCanonicalIR(result.ir, outPath)
    expect(serialized.startsWith("{\n")).toBe(true)
    const parsed = JSON.parse(serialized)
    expect(parsed.$schema).toBe("https://aburi.dev/schema/aburi.ir.v1.json")
  })
})
