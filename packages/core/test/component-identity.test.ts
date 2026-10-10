import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Component } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CoreError, detectComponents } from "../src/index"

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

    expect(component.id).toBe("acme-billing-api")
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
    await writeDualDetectedWorkspace()
    await writeJson("apps/billing/package.json", { private: true })
    await writeJson("apps/billing/project.json", { name: "billing-web" })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.name).toBe("billing-web")
  })

  it("asks the next manifest for a name that answers `name` but yields no id", async () => {
    await writeDualDetectedWorkspace()
    await writeJson("apps/billing/package.json", { name: "@scope/" })
    await writeJson("apps/billing/project.json", { name: "billing-web" })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.name).toBe("@scope/")
  })

  it("passes over a name that is not a string rather than crashing on it", async () => {
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
    await writeJson("nx.json", {})
    await writeJson("apps/billing/project.json", { name: "billing-e2e" })
    await writeJson("apps/billing/package.json", {
      name: "@acme/billing-api",
      dependencies: { "@nestjs/core": "^10.0.0" },
      exports: { ".": "./src/index.ts" },
    })

    const component = await billing()

    expect(component.id).toBe("acme-billing-api")
    expect(component.name).toBe("@acme/billing-api")
    expect(component.frameworks).toEqual(["nestjs"])
    expect(component.publicApi).toEqual(["src/index.ts"])
  })

  it("reports no frameworks and no public API from the project file", async () => {
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
