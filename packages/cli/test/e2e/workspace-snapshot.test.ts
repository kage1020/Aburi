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
  it("renders the single fixture component as an isolated mermaid node, then a list saying there is no edge", async () => {
    const result = await scanFixture(fixture.root, {}, {}, [NESTJS_BILLING])
    const md = projectWorkspace(result.ir, { suppressTimestamp: true })

    expect(md).toContain("# Workspace")
    expect(md).toContain("## Component dependencies")
    expect(md).toContain(
      '```mermaid\ngraph LR\n  c_nestjs_billing["nestjs-billing"]\n```\n\nFallback list:\n\n_No inter-component dependencies._\n',
    )
    expect(md).not.toContain("-->")
  })
})
