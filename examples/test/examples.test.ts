import { describe, expect, it } from "vitest"
import { listExamples } from "../src/examples"
import { renderExample } from "../src/render"

const examples = await listExamples()

describe("the showcase examples", () => {
  it("has examples to show", () => {
    expect(examples.length).toBeGreaterThan(0)
  })

  it.each(examples)("renders %s with a change aburi diff sees", async (dir) => {
    const { page } = await renderExample(dir)
    expect(page).toContain("## What `aburi diff` reports")
  })
})
