import { component, dependency, effect, languageId, makeIR, makeSymbol } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { EFFECT_SURFACE_TOP_N, projectWorkspace } from "../src"
import { sectionOf } from "./markdown"

function withHeader(overrides: Partial<IR>): IR {
  const base = makeIR({
    symbols: [
      makeSymbol({ id: "ts:src/a.ts#kept", name: "kept" }),
      makeSymbol({ id: "ts:src/a.ts#gone", name: "gone", dropped: true, dropReason: "DTO" }),
    ],
  })
  return {
    ...base,
    workspace: {
      root: ".",
      languages: [languageId("ts"), languageId("py")],
      managers: [
        { tool: "uv", roots: ["services/api"] },
        { tool: "pnpm", roots: [".", "tools"] },
      ],
    },
    generator: { name: "aburi", version: "1.2.3", plugins: [] },
    stats: { ...base.stats, totalFiles: 2, parsedFiles: 2 },
    ...overrides,
  }
}

describe("projectWorkspace — header", () => {
  it("names the languages, the managers by tool, the Symbol counts and the generator", () => {
    const md = projectWorkspace(withHeader({ generatedAt: "2026-01-02T03:04:05Z" }))
    expect(md.split("\n").slice(0, 7)).toEqual([
      "# Workspace",
      "",
      "**Languages**: py, ts",
      "**Managers**: pnpm (`.`, `tools`), uv (`services/api`)",
      "**Symbols**: 1 kept · 1 dropped (across 2 files)",
      "**Generated**: aburi 1.2.3 at 2026-01-02T03:04:05Z",
      "",
    ])
  })

  it("leaves the time out when asked to, or when the IR carries none", () => {
    const stamped = withHeader({ generatedAt: "2026-01-02T03:04:05Z" })
    const { generatedAt: _absent, ...unstamped } = stamped
    for (const md of [
      projectWorkspace(stamped, { suppressTimestamp: true }),
      projectWorkspace(unstamped),
    ]) {
      expect(md).toContain("**Generated**: aburi 1.2.3\n")
    }
  })

  it("writes a dash for a workspace with no manager", () => {
    expect(projectWorkspace(makeIR())).toContain("**Managers**: —\n")
  })
})

describe("projectWorkspace — Components", () => {
  it("tabulates components by id, counting each one's kept Symbols", () => {
    const md = projectWorkspace(
      makeIR({
        components: [
          component({ id: "web", name: "Web", frameworks: ["next", "react"] }),
          component({ id: "api", name: "API", roots: ["apps/api", "libs/api"] }),
        ],
        symbols: [
          makeSymbol({ id: "ts:apps/api/a.ts#a", name: "a", component: "api" }),
          makeSymbol({ id: "ts:apps/api/b.ts#b", name: "b", component: "api" }),
          makeSymbol({
            id: "ts:apps/api/c.ts#c",
            name: "c",
            component: "api",
            dropped: true,
            dropReason: "DTO",
          }),
          makeSymbol({ id: "ts:scripts/d.ts#d", name: "d" }),
        ],
      }),
    )
    expect(sectionOf(md, "## Components")).toEqual([
      "## Components",
      "",
      "| id | roots | languages | frameworks | symbols |",
      "|---|---|---|---|---|",
      "| api | `apps/api`, `libs/api` | ts | — | 2 |",
      "| web | `apps/web` | ts | next, react | 0 |",
      "",
    ])
  })

  it("says so when no components are defined", () => {
    expect(sectionOf(projectWorkspace(makeIR()), "## Components")).toEqual([
      "## Components",
      "",
      "_No components defined._",
      "",
    ])
  })
})

describe("projectWorkspace — Effect surface", () => {
  const heading = `## Effect surface (top ${EFFECT_SURFACE_TOP_N} by count)`
  const withEffects = (name: string, component: string | null, ...effectIds: string[]) =>
    makeSymbol({
      id: `ts:src/${name}.ts#${name}`,
      name,
      component,
      effects: effectIds.map((effectId) => effect({ id: effectId, target: "t", plugin: "p" })),
    })

  it("ranks effects by how often kept Symbols carry them, then by id, with their components", () => {
    const md = projectWorkspace(
      makeIR({
        symbols: [
          withEffects("a", "web", "db.write", "db.read"),
          withEffects("b", "api", "db.write", "cache.read"),
          withEffects("c", "web", "db.write"),
          withEffects("d", null, "fs.read"),
          { ...withEffects("e", "api", "fs.read", "fs.read"), dropped: true },
        ],
      }),
    )
    expect(sectionOf(md, heading)).toEqual([
      heading,
      "",
      "| effect | count | components |",
      "|---|---|---|",
      "| db.write | 3 | api, web |",
      "| cache.read | 1 | api |",
      "| db.read | 1 | web |",
      "| fs.read | 1 | — |",
      "",
    ])
  })

  it(`keeps the top ${EFFECT_SURFACE_TOP_N} rows`, () => {
    const symbols = Array.from({ length: EFFECT_SURFACE_TOP_N + 2 }, (_, i) =>
      withEffects(`s${i}`, null, `effect.e${String(i).padStart(2, "0")}`),
    )
    const rows = sectionOf(projectWorkspace(makeIR({ symbols })), heading).filter((line) =>
      line.startsWith("| effect.e"),
    )
    expect(rows).toHaveLength(EFFECT_SURFACE_TOP_N)
    expect(rows.at(-1)).toBe(
      `| effect.e${String(EFFECT_SURFACE_TOP_N - 1).padStart(2, "0")} | 1 | — |`,
    )
  })

  it("is left out when no kept Symbol carries an effect", () => {
    expect(projectWorkspace(makeIR({ symbols: [withEffects("a", null)] }))).not.toContain(
      "## Effect surface",
    )
  })
})

describe("projectWorkspace — input order", () => {
  it("renders the same bytes whatever order the IR lists components, edges and Symbols in", () => {
    const components = [
      component({ id: "web", name: "Web" }),
      component({ id: "api", name: "API" }),
    ]
    const dependencies = [
      dependency({ from: "web", to: "api" }),
      dependency({ from: "api", to: "db" }),
      dependency({ from: "api", to: "cache", via: "event" }),
    ]
    const symbols = [
      makeSymbol({
        id: "ts:src/a.ts#a",
        name: "a",
        component: "web",
        effects: [effect({ id: "db.read", target: "t", plugin: "p" })],
      }),
      makeSymbol({
        id: "ts:src/b.ts#b",
        name: "b",
        component: "api",
        effects: [effect({ id: "db.read", target: "t", plugin: "p" })],
      }),
    ]
    expect(projectWorkspace(makeIR({ components, dependencies, symbols }))).toBe(
      projectWorkspace(
        makeIR({
          components: [...components].reverse(),
          dependencies: [...dependencies].reverse(),
          symbols: [...symbols].reverse(),
        }),
      ),
    )
  })
})
