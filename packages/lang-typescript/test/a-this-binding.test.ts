import { describe, expect, it } from "vitest"
import { classOf, walkOf } from "./fixtures/ctx"

async function thisBindingOf(source: string, id: string, target: string) {
  const calls = (await walkOf(source, `ts:src/a.ts#${id}`)).calls.filter(
    (call) => call.target === target,
  )
  expect(calls).toHaveLength(1)
  return calls[0]?.thisBinding
}

const SUBCLASS = (member: string) => `export class C extends B {\n${member}\n}`

describe("a call through `this` or `super` records what `this` is where it is written", () => {
  it.each([
    ["a static block", classOf("  static { this.make() }"), "C", "this.make", "class"],
    ["a static field", classOf("  static seed = this.make()"), "C", "this.make", "class"],
    ["an instance field", classOf("  seed = this.make()"), "C", "this.make", "instance"],
    ["a static method", classOf("  static m() { this.make() }"), "C::m", "this.make", "class"],
    ["an instance method", classOf("  m() { this.make() }"), "C.m", "this.make", "instance"],
    [
      "an arrow function in a static method",
      classOf("  static m() { return () => this.make() }"),
      "C::m",
      "this.make",
      "class",
    ],
    [
      "a static method's call through super",
      SUBCLASS("  static m() { super.make() }"),
      "C::m",
      "super.make",
      "class",
    ],
    [
      "a read through a field of this",
      classOf("  m() { this.repo.save() }"),
      "C.m",
      "this.repo.save",
      "instance",
    ],
  ])("as the class or an instance in %s", async (_label, source, id, target, binding) => {
    expect(await thisBindingOf(source, id, target)).toBe(binding)
  })

  it.each([
    [
      "a function expression, which binds its own this",
      classOf("  m() { return function () { this.make() } }"),
      "C.m",
      "this.make",
    ],
    [
      "a computed member name, read with the this around the class",
      classOf("  [this.key()]() {}"),
      "C",
      "this.key",
    ],
    ["an object literal's method", "export const o = { m() { this.make() } }", "o.m", "this.make"],
    ["a call through a name", classOf("  m() { repo.save() }"), "C.m", "repo.save"],
    [
      "a non-null this, whose target keeps the `!`",
      classOf("  m() { this!.make() }"),
      "C.m",
      "this!.make",
    ],
  ])("as nothing in %s", async (_label, source, id, target) => {
    expect(await thisBindingOf(source, id, target)).toBeUndefined()
  })
})
