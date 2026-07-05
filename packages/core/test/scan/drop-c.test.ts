import type { CallCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDropCFilter } from "../../src"

function makeCall(target: string): CallCandidate {
  return { target, line: 1, argumentCount: 0, inAwait: false, inNew: false, literalArgs: [] }
}

describe("DropCFilter — Category C call drop", () => {
  it("drops every core console.* call", () => {
    const filter = buildDropCFilter()
    for (const t of [
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
    ]) {
      expect(filter.shouldDropCall(makeCall(t))).toBe(true)
    }
  })

  it("drops process.stdout.write and process.stderr.write", () => {
    const filter = buildDropCFilter()
    expect(filter.shouldDropCall(makeCall("process.stdout.write"))).toBe(true)
    expect(filter.shouldDropCall(makeCall("process.stderr.write"))).toBe(true)
  })

  it("keeps calls that are not core drop targets", () => {
    const filter = buildDropCFilter()
    expect(filter.shouldDropCall(makeCall("prisma.user.create"))).toBe(false)
    expect(filter.shouldDropCall(makeCall("this.service.method"))).toBe(false)
  })

  it("respects config.suppress[] prefixes", () => {
    const filter = buildDropCFilter({ suppress: ["myLogger", "metrics"] })
    expect(filter.shouldDropCall(makeCall("myLogger.debug"))).toBe(true)
    expect(filter.shouldDropCall(makeCall("metrics.counter"))).toBe(true)
    expect(filter.shouldDropCall(makeCall("otherLogger.debug"))).toBe(false)
  })

  it("respects plugin dropCallees[]", () => {
    const filter = buildDropCFilter({ pluginDropCallees: ["pino", "child"] })
    expect(filter.shouldDropCall(makeCall("pino.info"))).toBe(true)
    expect(filter.shouldDropCall(makeCall("child.info"))).toBe(true)
  })

  it("config.keep[] wins over both suppress and core drop", () => {
    const filter = buildDropCFilter({
      suppress: ["console"],
      keep: ["console.error"],
    })
    // `console.error` is explicitly kept even though `console` prefix is suppressed
    // and `console.error` is a core drop target.
    expect(filter.shouldDropCall(makeCall("console.error"))).toBe(false)
    // Non-kept prefixes still fall under the suppress / core drop.
    expect(filter.shouldDropCall(makeCall("console.log"))).toBe(true)
  })

  it("supports the `@Decorator` keep syntax by stripping the `@`", () => {
    // Even though decorators do not reach a call filter, the config schema allows the
    // `@Name` shape; the filter must ignore the sigil rather than fail to match.
    const filter = buildDropCFilter({ suppress: ["Transaction"], keep: ["@Transaction"] })
    expect(filter.shouldDropCall(makeCall("Transaction.begin"))).toBe(false)
  })

  it("respects identifier boundaries — `console` prefix does NOT match `consoleWrap.method`", () => {
    const filter = buildDropCFilter({ suppress: ["console"] })
    expect(filter.shouldDropCall(makeCall("consoleWrap.method"))).toBe(false)
    expect(filter.shouldDropCall(makeCall("console.log"))).toBe(true)
  })
})
