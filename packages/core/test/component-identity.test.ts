import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Component } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { detectComponents } from "../src/index"

/**
 * A directory can be claimed by more than one detector, and then more than one manifest
 * describes it. Which of them answers which field is component-detect.md §4.1's priority
 * order; these tests are that order applied to the one pair the JS detectors produce today,
 * a `package.json` beside an nx `project.json`.
 */

let tmp = ""

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "aburi-core-identity-"))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeJson(relativePath: string, value: unknown): Promise<void> {
  const path = join(tmp, relativePath)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, JSON.stringify(value), "utf8")
}

/** A workspace where `apps/billing` is declared by pnpm and by nx at once. */
async function writeDualDetectedWorkspace(): Promise<void> {
  await writeFile(join(tmp, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n', "utf8")
  await writeJson("nx.json", {})
}

async function billing(): Promise<Component> {
  const components = await detectComponents({ workspaceRoot: tmp })
  const found = components.find((component) => component.roots[0] === "apps/billing")
  if (found === undefined)
    throw new Error(`no component at apps/billing: ${JSON.stringify(components)}`)
  return found
}

describe("a directory two detectors claim", () => {
  it("takes its id and name from the package manifest, not the nx project file", async () => {
    await writeDualDetectedWorkspace()
    await writeJson("apps/billing/package.json", { name: "@acme/billing-api" })
    await writeJson("apps/billing/project.json", { name: "billing-e2e" })

    const component = await billing()

    expect(component.id).toBe("billing-api")
    expect(component.name).toBe("@acme/billing-api")
  })

  it("keeps the frameworks and the public API the package manifest declares", async () => {
    await writeDualDetectedWorkspace()
    await writeJson("apps/billing/package.json", {
      name: "billing",
      dependencies: { "@nestjs/core": "^10.0.0" },
      exports: { ".": "./src/index.ts" },
    })
    await writeJson("apps/billing/project.json", { name: "billing", targets: {} })

    const component = await billing()

    expect(component.frameworks).toEqual(["nestjs"])
    expect(component.publicApi).toEqual(["src/index.ts"])
  })

  it("stays one component, under both tools", async () => {
    await writeDualDetectedWorkspace()
    await writeJson("apps/billing/package.json", { name: "billing" })
    await writeJson("apps/billing/project.json", { name: "billing" })

    const components = await detectComponents({ workspaceRoot: tmp })

    expect(components.filter((component) => component.id === "billing")).toHaveLength(1)
  })

  it("falls through to the project file for a name the package manifest does not carry", async () => {
    // §4.1 is a priority over sources, not a single source: an absent `name` in the first is
    // not an answer, and the directory name is the last resort rather than the second.
    await writeDualDetectedWorkspace()
    await writeJson("apps/billing/package.json", { private: true })
    await writeJson("apps/billing/project.json", { name: "billing-web" })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.name).toBe("billing-web")
  })
})

describe("a directory only nx claims", () => {
  it("still takes its id and name from the project file", async () => {
    await writeJson("nx.json", {})
    await writeJson("apps/billing/project.json", { name: "billing-web" })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.name).toBe("billing-web")
  })

  it("reports no frameworks and no public API from it", async () => {
    // An nx project file holds targets, and its options are arbitrary JSON. A key spelled
    // `dependencies` or `exports` in one is not the npm field of that name, and the two
    // Component fields defined over those npm fields have no source here.
    await writeJson("nx.json", {})
    await writeJson("apps/billing/project.json", {
      name: "billing-web",
      dependencies: { "@nestjs/core": "^10.0.0" },
      exports: { ".": "./src/index.ts" },
    })

    const component = await billing()

    expect(component.frameworks).toBeUndefined()
    expect(component.publicApi).toBeUndefined()
  })
})
