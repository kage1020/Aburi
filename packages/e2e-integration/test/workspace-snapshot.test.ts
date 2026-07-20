import { projectWorkspace } from "@aburi/markdown-projection"
import type { Component } from "@aburi/types"
import { afterEach, describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"
import { scanFixture } from "../src/scan-helper"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup()
    cleanup = null
  }
})

/**
 * Anchors the L0 workspace mermaid rendering (roadmap: workspace overview as
 * mermaid graph) against a real scanned IR. The nestjs-billing fixture has
 * exactly one Aburi component and no inter-component edges, so the mermaid
 * block must render the sole component as an isolated node — the case that
 * would silently drop under the pre-issue-#29 edge-only enumeration.
 */
const NESTJS_BILLING_COMPONENT: Component = {
  id: "nestjs-billing",
  name: "nestjs-billing",
  roots: ["."],
  publicApi: [],
  languages: ["ts"],
  frameworks: ["nestjs"],
  description: null,
}

describe("e2e: projectWorkspace on fixtures/nestjs-billing", () => {
  it("renders the single fixture component as an isolated mermaid node", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const result = await scanFixture(fixture.root, {}, {}, [NESTJS_BILLING_COMPONENT])
    const md = projectWorkspace(result.ir, { suppressTimestamp: true })

    expect(md).toContain("# Workspace")
    expect(md).toContain("## Component dependencies")
    expect(md).toContain("```mermaid")
    expect(md).toContain("graph LR")
    // The load-bearing new-behaviour assertion: the sole component appears as
    // a labeled mermaid node even though no dependency touches it. `nestjs-billing`
    // sanitizes to `nestjs_billing` (kebab → snake), name stays verbatim inside
    // the `["..."]` label.
    expect(md).toContain('nestjs_billing["nestjs-billing"]')
    // No component→component edges in this fixture, so no arrow and no fallback
    // list header should appear.
    expect(md).not.toContain("-->")
    expect(md).not.toContain("Fallback list:")
    // Would signal a regression to the empty-message path we replaced.
    expect(md).not.toContain("_No inter-component dependencies._")
  })
})
