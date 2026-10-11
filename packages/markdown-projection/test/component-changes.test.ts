import { component, languageId, makeDiff } from "@aburi/test-support"
import type { Component } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { sectionOf } from "./markdown"

const HEADING = "## 🧱 Component changes"
const NO_AXIS = { rootsChanged: false, publicApiChanged: false, frameworksChanged: false }

function changedSection(before: Component, after: Component): string[] {
  return sectionOf(
    projectDiff(
      makeDiff({
        components: { added: [], removed: [], changed: [{ before, after, delta: NO_AXIS }] },
      }),
    ),
    HEADING,
  )
}

const billing = (overrides: Partial<Component> = {}) =>
  component({ id: "billing", name: "Billing", ...overrides })

describe("projectDiff — Component changes", () => {
  it("lists added components with their roots and removed ones by id, each in id order", () => {
    const md = projectDiff(
      makeDiff({
        components: {
          added: [
            component({ id: "web", name: "Web" }),
            component({ id: "api", name: "API", roots: ["apps/api", "libs/api"] }),
          ],
          removed: [
            component({ id: "legacy", name: "Legacy" }),
            component({ id: "batch", name: "Batch" }),
          ],
          changed: [],
        },
      }),
    )
    expect(sectionOf(md, HEADING)).toEqual([
      HEADING,
      "",
      "### Added",
      "- `api` — roots: `apps/api`, `libs/api`",
      "- `web` — roots: `apps/web`",
      "",
      "### Removed",
      "- `batch`",
      "- `legacy`",
      "",
    ])
  })

  it.each<[string, Component, Component, string]>([
    [
      "a display-name change with its before → after",
      billing(),
      billing({ name: "Billing & Invoicing" }),
      "- `billing`: name (`Billing` → `Billing & Invoicing`)",
    ],
    [
      "an added language",
      billing({ languages: [languageId("ts")] }),
      billing({ languages: [languageId("ts"), languageId("py")] }),
      "- `billing`: languages",
    ],
    [
      "a description added, spelling the absent one `none`",
      billing({ description: null }),
      billing({ description: "Invoices" }),
      "- `billing`: description (none → `Invoices`)",
    ],
    [
      "a description removed",
      billing({ description: "Invoices" }),
      billing({ description: null }),
      "- `billing`: description (`Invoices` → none)",
    ],
    [
      "an empty description apart from an absent one",
      billing({ description: null }),
      billing({ description: "" }),
      "- `billing`: description (none → (empty))",
    ],
    [
      "the three delta axes in Component field order",
      billing({ roots: ["apps/billing"], frameworks: [] }),
      billing({
        roots: ["apps/billing", "packages/billing-domain"],
        publicApi: ["apps/billing/routes/**"],
        frameworks: ["nestjs"],
      }),
      "- `billing`: roots, publicApi, frameworks",
    ],
    [
      "scalars and list fields in one row, name first and description last",
      billing({ roots: ["apps/billing"], description: "Invoices" }),
      billing({
        name: "Billing, Invoicing & Dunning",
        roots: ["apps/billing", "packages/billing-domain"],
        languages: [languageId("ts"), languageId("py")],
        description: "Invoices and dunning",
      }),
      "- `billing`: name (`Billing` → `Billing, Invoicing & Dunning`), roots, languages, " +
        "description (`Invoices` → `Invoices and dunning`)",
    ],
    ["the component alone when no field shows the change", billing(), billing(), "- `billing`"],
    [
      "a field this version of the renderer has never heard of",
      billing(),
      { ...billing(), owners: ["platform"] } as Component,
      "- `billing`: owners",
    ],
    [
      "nothing for an unheard-of field that is absent on one side and empty on the other",
      { ...billing(), owners: null, reviewers: [] } as Component,
      billing(),
      "- `billing`",
    ],
    [
      "nothing for an omitted optional key, read as the value it stands for",
      billing({ publicApi: [], frameworks: [], description: null }),
      {
        id: billing().id,
        name: "Billing",
        roots: billing().roots,
        languages: billing().languages,
      },
      "- `billing`",
    ],
  ])("names %s", (_, before, after, row) => {
    expect(changedSection(before, after)).toContain(row)
  })
})

describe("projectDiff — Component changes cannot be broken by free-form text", () => {
  it.each<[string, string, string]>([
    [
      "widens the fence past a backtick run inside the value",
      "a ``b`` c",
      "- `billing`: name (`Billing` → ```a ``b`` c```)",
    ],
    [
      "pads a value whose edge is a backtick, so CommonMark's strip does not eat it",
      "`code`",
      "- `billing`: name (`Billing` → `` `code` ``)",
    ],
  ])("%s", (_, name, row) => {
    expect(changedSection(billing(), billing({ name }))).toContain(row)
  })

  it("collapses a newline rather than ending the list item", () => {
    const section = changedSection(
      billing({ description: null }),
      billing({ description: "one\n\n## two\n- three" }),
    )
    expect(section.filter((line) => line.startsWith("-"))).toEqual([
      "- `billing`: description (none → `one ## two - three`)",
    ])
  })
})
