import { errorFrom } from "@aburi/test-support"
import type { Component } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CoreError, detectComponents } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-identity")

/** A workspace where `apps/billing` is declared by pnpm and by nx at once. */
async function writeDualDetectedWorkspace(): Promise<void> {
  await tree.writePnpmWorkspace("apps/*")
  await tree.writeJson("nx.json", {})
}

async function billing(): Promise<Component> {
  const components = await detectComponents({ workspaceRoot: tree.root })
  const found = components.find((component) => component.roots[0] === "apps/billing")
  if (found === undefined) {
    throw new Error(`no component at apps/billing: ${JSON.stringify(components)}`)
  }
  return found
}

describe("a directory two detectors claim", () => {
  it("takes its id and name from the package manifest, not the nx project file", async () => {
    await writeDualDetectedWorkspace()
    await tree.writeJson("apps/billing/package.json", { name: "@acme/billing-api" })
    await tree.writeJson("apps/billing/project.json", { name: "billing-e2e" })

    const component = await billing()

    expect(component.id).toBe("acme-billing-api")
    expect(component.name).toBe("@acme/billing-api")
  })

  it("keeps the frameworks and the public API the package manifest declares", async () => {
    await writeDualDetectedWorkspace()
    await tree.writeJson("apps/billing/package.json", {
      name: "billing",
      dependencies: { "@nestjs/core": "^10.0.0" },
      exports: { ".": "./src/index.ts" },
    })
    await tree.writeJson("apps/billing/project.json", { name: "billing", targets: {} })

    const component = await billing()

    expect(component.frameworks).toEqual(["nestjs"])
    expect(component.publicApi).toEqual(["src/index.ts"])
  })

  it("keeps the npm fields out of reach of a package manifest that declares nothing", async () => {
    await writeDualDetectedWorkspace()
    await tree.writeSource("apps/billing/package.json", "[]")
    await tree.writeJson("apps/billing/project.json", {
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
    await tree.writeJson("apps/billing/package.json", { private: true })
    await tree.writeJson("apps/billing/project.json", { name: "billing-web" })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.name).toBe("billing-web")
  })

  it("asks the next manifest for a name that answers `name` but yields no id", async () => {
    await writeDualDetectedWorkspace()
    await tree.writeJson("apps/billing/package.json", { name: "@scope/" })
    await tree.writeJson("apps/billing/project.json", { name: "billing-web" })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.name).toBe("@scope/")
  })

  it("passes over a name that is not a string rather than crashing on it", async () => {
    await writeDualDetectedWorkspace()
    await tree.writeJson("apps/billing/package.json", { name: ["billing-api"] })
    await tree.writeJson("apps/billing/project.json", { name: "billing-web" })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.name).toBe("billing-web")
  })
})

describe("a directory only nx claims", () => {
  it("still takes its id and name from the project file", async () => {
    await tree.writeJson("nx.json", {})
    await tree.writeJson("apps/billing/project.json", { name: "billing-web" })

    const component = await billing()

    expect(component.id).toBe("billing-web")
    expect(component.name).toBe("billing-web")
  })

  it("reads the package manifest beside it that no detector reported", async () => {
    await tree.writeJson("nx.json", {})
    await tree.writeJson("apps/billing/project.json", { name: "billing-e2e" })
    await tree.writeJson("apps/billing/package.json", {
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
    await tree.writeJson("nx.json", {})
    await tree.writeJson("apps/billing/project.json", {
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
  it.each<[string, () => Promise<void>, string]>([
    [
      "is not JSON",
      () => tree.writeSource("apps/billing/package.json", "{ broken"),
      "package.json",
    ],
    ["the filesystem will not hand over", () => tree.mkdir("apps/billing/package.json"), "EISDIR"],
  ])("refuses a package manifest that %s", async (_case, write, detail) => {
    await writeDualDetectedWorkspace()
    await write()
    await tree.writeJson("apps/billing/project.json", { name: "billing-e2e" })

    const error = await errorFrom(CoreError, () => detectComponents({ workspaceRoot: tree.root }))

    expect(error.code).toBe("workspace-manifest-malformed")
    expect(error.message).toContain(detail)
  })

  it("says nothing about a directory that simply has none", async () => {
    await tree.writeJson("nx.json", {})
    await tree.writeJson("apps/billing/project.json", { name: "billing-web" })

    await expect(detectComponents({ workspaceRoot: tree.root })).resolves.toHaveLength(1)
  })
})
