import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Component } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CoreError, detectComponents } from "../src/index"

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
  await writeRaw(relativePath, JSON.stringify(value))
}

async function writeRaw(relativePath: string, body: string): Promise<void> {
  const path = join(tmp, relativePath)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, body, "utf8")
}

/** A workspace where `apps/billing` is declared by pnpm and by nx at once. */
async function writeDualDetectedWorkspace(): Promise<void> {
  await writeRaw("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n')
  await writeJson("nx.json", {})
}

async function billing(): Promise<Component> {
  const components = await detectComponents({ workspaceRoot: tmp })
  const found = components.find((component) => component.roots[0] === "apps/billing")
  if (found === undefined) {
    throw new Error(`no component at apps/billing: ${JSON.stringify(components)}`)
  }
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

  it("keeps the npm fields out of reach of a package manifest that declares nothing", async () => {
    // Valid JSON that is not an object declares nothing, and the project file behind it must
    // not be promoted into its place: those two fields are npm's, and an nx target option
    // spelled `dependencies` is not one.
    await writeDualDetectedWorkspace()
    await writeRaw("apps/billing/package.json", "[]")
    await writeJson("apps/billing/project.json", {
      name: "billing-web",
      dependencies: { "@nestjs/core": "^10.0.0" },
      exports: { ".": "./src/index.ts" },
    })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.frameworks).toBeUndefined()
    expect(component.publicApi).toBeUndefined()
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

  it("asks the next manifest for a name that answers §4.2 but yields no id", async () => {
    // `@scope/` is a name, so §4.2 has its answer — and nothing can be built from it, so
    // §4.1 does not. Stopping there would take the id from the directory while a project
    // file beside it names the same directory usably.
    await writeDualDetectedWorkspace()
    await writeJson("apps/billing/package.json", { name: "@scope/" })
    await writeJson("apps/billing/project.json", { name: "billing-web" })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.name).toBe("@scope/")
  })

  it("passes over a name that is not a string rather than crashing on it", async () => {
    // A manifest is JSON another tool wrote. An array has a `length`, which is as far as a
    // truthiness check gets before the id derivation reads it as a string.
    await writeDualDetectedWorkspace()
    await writeJson("apps/billing/package.json", { name: ["billing-api"] })
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

  it("reads the package manifest beside it that no detector reported", async () => {
    // `detectNx` reports the project file alone. Leaving it at that would make a Component's
    // identity depend on whether an unrelated manifest exists elsewhere in the workspace.
    await writeJson("nx.json", {})
    await writeJson("apps/billing/project.json", { name: "billing-e2e" })
    await writeJson("apps/billing/package.json", {
      name: "@acme/billing-api",
      dependencies: { "@nestjs/core": "^10.0.0" },
      exports: { ".": "./src/index.ts" },
    })

    const component = await billing()

    expect(component.id).toBe("billing-api")
    expect(component.name).toBe("@acme/billing-api")
    expect(component.frameworks).toEqual(["nestjs"])
    expect(component.publicApi).toEqual(["src/index.ts"])
  })

  it("reports no frameworks and no public API from the project file", async () => {
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

describe("a manifest that cannot be read", () => {
  /**
   * Absent is the ordinary case and says nothing. Present and unreadable is a Component whose
   * identity this run cannot see: answering with the next manifest's name would put the
   * pre-detection answer back, with nothing anywhere saying the published one was ever there.
   */
  it("refuses a package manifest that is not JSON", async () => {
    await writeDualDetectedWorkspace()
    await writeRaw("apps/billing/package.json", "{ broken")
    await writeJson("apps/billing/project.json", { name: "billing-e2e" })

    const thrown = await detectComponents({ workspaceRoot: tmp }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CoreError)
    expect((thrown as CoreError).code).toBe("workspace-manifest-malformed")
    expect((thrown as Error).message).toContain("package.json")
  })

  it("refuses a package manifest the filesystem will not hand over", async () => {
    // Not every failure is a syntax error: the read itself can fail, and only "there is
    // nothing there" is the ordinary case. A directory of that name is the one such failure
    // a test can make on every platform — EACCES needs permissions Windows does not have.
    await writeDualDetectedWorkspace()
    await mkdir(join(tmp, "apps/billing/package.json"), { recursive: true })
    await writeJson("apps/billing/project.json", { name: "billing-e2e" })

    const thrown = await detectComponents({ workspaceRoot: tmp }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CoreError)
    expect((thrown as CoreError).code).toBe("workspace-manifest-malformed")
    expect((thrown as Error).message).toContain("EISDIR")
  })

  it("says nothing about a directory that simply has none", async () => {
    await writeJson("nx.json", {})
    await writeJson("apps/billing/project.json", { name: "billing-web" })

    await expect(detectComponents({ workspaceRoot: tmp })).resolves.toHaveLength(1)
  })
})
