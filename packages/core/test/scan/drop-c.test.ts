import { makeCall } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { buildDropCFilter, type DropCFilterInput } from "../../src"

const decomposed = "café".normalize("NFD")
const composed = decomposed.normalize("NFC")

function drops(input: DropCFilterInput, target: string): boolean {
  return buildDropCFilter(input).shouldDropCall(makeCall({ target }))
}

describe("buildDropCFilter", () => {
  it.each([
    "console.log",
    "console.info",
    "console.warn",
    "console.error",
    "console.debug",
    "console.trace",
    "console.table",
    "console.dir",
    "console.group",
    "console.groupEnd",
    "process.stdout.write",
    "process.stderr.write",
  ])("drops the core callee %s with nothing configured", (target) => {
    expect(drops({}, target)).toBe(true)
  })

  it.each([
    "prisma.user.create",
    "this.service.method",
    "consoleWrap.method",
  ])("keeps %s with nothing configured", (target) => {
    expect(drops({}, target)).toBe(false)
  })

  it.each<[string, DropCFilterInput, string, boolean]>([
    [
      "a suppress prefix drops a member call",
      { suppress: ["myLogger", "metrics"] },
      "metrics.counter",
      true,
    ],
    ["a suppress prefix drops the bare name", { suppress: ["myLogger"] }, "myLogger", true],
    [
      "a suppress prefix leaves another name",
      { suppress: ["myLogger"] },
      "otherLogger.debug",
      false,
    ],
    [
      "a suppress prefix stops at a member break",
      { suppress: ["console"] },
      "consoleWrap.method",
      false,
    ],
    [
      "a plugin's dropCallees drop like suppress",
      { pluginDropCallees: ["pino"] },
      "pino.info",
      true,
    ],
    [
      "keep rescues from suppress",
      { suppress: ["console"], keep: ["console.error"] },
      "console.error",
      false,
    ],
    [
      "keep leaves the rest of suppress in force",
      { suppress: ["console"], keep: ["console.error"] },
      "console.log",
      true,
    ],
    [
      "keep rescues from the core list",
      { keep: ["process.stdout.write"] },
      "process.stdout.write",
      false,
    ],
    [
      "keep rescues from a plugin's dropCallees",
      { pluginDropCallees: ["pino"], keep: ["pino.audit"] },
      "pino.audit",
      false,
    ],
    [
      "keep reads `@Name` as Name",
      { suppress: ["Transaction"], keep: ["@Transaction"] },
      "Transaction.begin",
      false,
    ],
    [
      "a decomposed suppress entry drops the composed call",
      { suppress: [decomposed] },
      `${composed}.log`,
      true,
    ],
    [
      "a decomposed dropCallee drops the composed call",
      { pluginDropCallees: [decomposed] },
      `${composed}.log`,
      true,
    ],
    [
      "a decomposed keep entry rescues the composed call",
      { suppress: [composed], keep: [`${decomposed}.audit`] },
      `${composed}.audit`,
      false,
    ],
  ])("%s", (_label, input, target, dropped) => {
    expect(drops(input, target)).toBe(dropped)
  })
})
