import { makeComponentId, makeLanguageId } from "@aburi/core"
import { projectWorkspace } from "@aburi/markdown-projection"
import type { Component } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"
import { scanFixture } from "../src/scan-helper"

/**
 * Anchors the L0 workspace mermaid rendering against a real scanned IR. The nestjs-billing
 * fixture is a single Aburi component with no inter-component edges — a workspace whose only
 * component has no incident dependencies must still render that component as a labeled
 * mermaid node, per the "full monorepo view" contract of `overview.md`.
 *
 * The fixture ships no aburi.json, so a hand-crafted Component mirroring what `runInit`
 * would autodetect is injected.
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

const fixture = useFixtureCheckout()

describe("e2e: projectWorkspace on fixtures/nestjs-billing", () => {
  it("renders the single fixture component as an isolated mermaid node", async () => {
    const result = await scanFixture(fixture.root, {}, {}, [NESTJS_BILLING_COMPONENT])
    const md = projectWorkspace(result.ir, { suppressTimestamp: true })

    expect(md).toContain("# Workspace")
    expect(md).toContain("## Component dependencies")
    expect(md).toContain("```mermaid")
    expect(md).toContain("graph LR")
    // `nestjs-billing` sanitizes to `nestjs_billing` (kebab → snake); the name stays
    // verbatim inside the `["..."]` label.
    expect(md).toContain('nestjs_billing["nestjs-billing"]')
    expect(md).not.toContain("-->")
    expect(md).not.toContain("Fallback list:")
    expect(md).not.toContain("_No inter-component dependencies._")
  })
})
