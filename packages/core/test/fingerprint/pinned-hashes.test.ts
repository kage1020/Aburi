import { effect, rule, sig } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  apiFingerprint,
  FP_HEX_LENGTH,
  hashCanonicalObject,
  hashRawString,
  logicFingerprint,
  syntaxFingerprint,
} from "../../src/index"
import { makeSymbol } from "../fixtures/ir"

describe("fingerprints are pinned across releases", () => {
  it("hashRawString is the first 12 lowercase hex digits of SHA-256", () => {
    expect(FP_HEX_LENGTH).toBe(12)
    expect(hashRawString("{}")).toBe("44136fa355b3")
  })

  it("hashCanonicalObject hashes the compact canonical form, so key order does not matter", () => {
    expect(hashCanonicalObject({ b: 2, a: 1 })).toBe(hashRawString('{"a":1,"b":2}'))
  })

  it("syntaxFingerprint hashes the normalized AST string as written", () => {
    // echo -n '(function_declaration (identifier "foo"))' | sha256sum | cut -c1-12
    expect(syntaxFingerprint('(function_declaration (identifier "foo"))')).toBe("5bae34d2c0a4")
  })

  it("apiFingerprint of a Symbol with no signature", () => {
    expect(apiFingerprint(makeSymbol("ts:src/a.ts#foo"))).toBe("abf3a0597098")
  })

  it("apiFingerprint of a parameter with neither marker, whether absent or written false", () => {
    const withInputs = (inputs: Array<{ name: string; type: string }>) =>
      makeSymbol("ts:src/a.ts#find", { signature: sig({ inputs, outputs: ["User[]"] }) })
    const plain = [
      { name: "query", type: "string" },
      { name: "ids", type: "string[]" },
    ]
    const writtenFalse = plain.map((input) => ({ ...input, optional: false, rest: false }))

    expect(apiFingerprint(withInputs(plain))).toBe("a1f625081136")
    expect(apiFingerprint(withInputs(writtenFalse))).toBe("a1f625081136")
  })

  it("logicFingerprint of a body with no rules and no effects", () => {
    expect(logicFingerprint(makeSymbol("ts:src/a.ts#foo"))).toBe("a0af04270155")
  })

  it("logicFingerprint of a body with rules, local effects and propagated ones", () => {
    const symbol = makeSymbol("ts:src/a.ts#foo", {
      rules: [
        rule({ type: "guard", line: 2, condition: "!id" }),
        rule({ type: "throw", line: 3, what: "NotFound" }),
      ],
      effects: [
        effect({ id: "db.write", target: "z.local", plugin: "p", line: 4 }),
        effect({ id: "db.read", target: "m.local", plugin: "p", line: 5 }),
        effect({
          id: "db.write",
          target: "a.propagated",
          plugin: "p",
          propagated: true,
          derivedFrom: ["ts:src/b.ts#g"],
        }),
        effect({
          id: "x-acme:create",
          target: "b.propagated",
          plugin: "p",
          propagated: true,
          derivedFrom: ["ts:src/b.ts#g"],
        }),
      ],
    })
    expect(logicFingerprint(symbol)).toBe("93062ccd3776")
  })
})
