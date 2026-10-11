import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { extractFile } from "@aburi/test-harness"
import { describe, expect, it } from "vitest"
import { hasRouteArguments } from "../src/routes"

async function callNode(line: string): Promise<unknown> {
  const { candidates } = await extractFile(langTypescriptPlugin, "src/a.ts", `${line}\n`)
  const call = candidates.find((candidate) => candidate.kind === "call")
  if (call === undefined) throw new Error(`no call Symbol in ${line}`)
  return call.fullNode
}

describe("hasRouteArguments", () => {
  it("answers for a call node", async () => {
    expect(hasRouteArguments(await callNode(`app.get("/users", listUsers)`))).toBe(true)
    expect(hasRouteArguments(await callNode(`app.get("env")`))).toBe(false)
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a plain object", {}],
    ["the source text of a route", `app.get("/users", listUsers)`],
  ])("answers false for %s, which is not a syntax node", (_label, value) => {
    expect(hasRouteArguments(value)).toBe(false)
  })
})
