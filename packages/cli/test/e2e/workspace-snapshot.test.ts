import { projectWorkspace } from "@aburi/markdown-projection"
import { component } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanFixture, useFixtureCheckout } from "./project"

const NESTJS_BILLING = component({
  id: "nestjs-billing",
  name: "nestjs-billing",
  roots: ["."],
  frameworks: ["nestjs"],
})

const fixture = useFixtureCheckout()

describe("e2e: projectWorkspace on fixtures/nestjs-billing", () => {
  it("renders the single fixture component as an isolated mermaid node", async () => {
    const result = await scanFixture(fixture.root, {}, {}, [NESTJS_BILLING])
    const md = projectWorkspace(result.ir, { suppressTimestamp: true })

    expect(md).toContain("# Workspace")
    expect(md).toContain("## Component dependencies")
    expect(md).toContain("```mermaid")
    expect(md).toContain("graph LR")
    expect(md).toContain('nestjs_billing["nestjs-billing"]')
    expect(md).not.toContain("-->")
    expect(md).not.toContain("Fallback list:")
    expect(md).not.toContain("_No inter-component dependencies._")
  })
})
