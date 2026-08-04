import { makeComponentId, makeLanguageId } from "@aburi/core"
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
 * Anchors the L0 workspace mermaid rendering against a real scanned IR. The
 * nestjs-billing fixture is a single Aburi component with no inter-component
 * edges — a workspace whose only component has no incident dependencies must
 * still render that component as a labeled mermaid node so the L0 overview
 * matches the "full monorepo view" contract of `overview.md` §3.1.
 *
 * Only the workspace scan + projection wiring is exercised end-to-end here;
 * the fixture ships no aburi.json, so we inject a hand-crafted Component
 * that mirrors what `runInit` would autodetect.
 */
const NESTJS_BILLING_COMPONENT: Component = {
  id: makeComponentId("nestjs-billing"),
  name: "nestjs-billing",
  roots: ["."],
  publicApi: [],
  languages: [makeLanguageId("ts")],
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
    // `nestjs-billing` sanitizes to `nestjs_billing` (kebab → snake); the name
    // stays verbatim inside the `["..."]` label.
    expect(md).toContain('nestjs_billing["nestjs-billing"]')
    expect(md).not.toContain("-->")
    expect(md).not.toContain("Fallback list:")
    expect(md).not.toContain("_No inter-component dependencies._")
  })
})
