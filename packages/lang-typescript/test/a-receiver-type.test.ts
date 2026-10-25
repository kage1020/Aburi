import { describe, expect, it } from "vitest"
import { walkOf } from "./fixtures/ctx"

/** A class `C` declaring `members`, each on its own line. */
const classOf = (...members: string[]) => ["export class C {", ...members, "}"].join("\n")

async function receiverTypesOf(source: string, id: string) {
  return (await walkOf(source, `ts:src/a.ts#${id}`)).calls.map((c) => [c.target, c.receiverType])
}

describe("a call through a field of `this` carries the type the class declares the field with", () => {
  it.each([
    [
      "a constructor parameter property",
      classOf(
        "  constructor(private readonly events: EventEmitter2) {}",
        '  m() { this.events.emit("a") }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a parameter property marked only `readonly`",
      classOf(
        "  constructor(readonly events: EventEmitter2) {}",
        '  m() { this.events.emit("a") }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a typed field",
      classOf("  private events: EventEmitter2", '  m() { this.events.emit("a") }'),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a `#`-private field",
      classOf("  #events: EventEmitter2", '  m() { this.#events.emit("a") }'),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a static field, from a static method",
      classOf("  static events: EventEmitter2", '  static m() { this.events.emit("a") }'),
      "C::m",
      "EventEmitter2",
    ],
    [
      "a type written through a namespace",
      classOf("  events: ee.EventEmitter2", '  m() { this.events.emit("a") }'),
      "C.m",
      "ee.EventEmitter2",
    ],
    [
      "a generic type, without its arguments",
      classOf("  events: Emitter<Payload>", '  m() { this.events.emit("a") }'),
      "C.m",
      "Emitter",
    ],
    [
      "an arrow inside the method, which keeps its `this`",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m() { return () => this.events.emit("a") }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a field holding an arrow",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m = () => this.events.emit("a")',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a parameter default",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m(sent = this.events.emit("a")) { return sent }',
      ),
      "C.m",
      "EventEmitter2",
    ],
    [
      "a class nested in the method, whose own field it is",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m() { return class { events!: Bus; n() { this.events.emit("a") } } }',
      ),
      "C.m",
      "Bus",
    ],
  ])("reads %s", async (_label, source, id, type) => {
    expect((await receiverTypesOf(source, id)).map(([, receiverType]) => receiverType)).toEqual([
      type,
    ])
  })

  it("reads a static field from the class's static block, which the class walks", async () => {
    const source = classOf("  static events: EventEmitter2", '  static { this.events.emit("a") }')

    expect(await receiverTypesOf(source, "C")).toEqual([["this.events.emit", "EventEmitter2"]])
  })
})

describe("a call through `this` carries no type where the class does not declare one", () => {
  it.each([
    [
      "a constructor parameter that is not a property",
      classOf(
        "  private events",
        "  constructor(events: EventEmitter2) { this.events = events }",
        '  m() { this.events.emit("a") }',
      ),
      "C.m",
    ],
    [
      "a field with no annotation",
      classOf("  events = new EventEmitter2()", '  m() { this.events.emit("a") }'),
      "C.m",
    ],
    [
      "a type that is not a name",
      classOf("  events: EventEmitter2 | null = null", '  m() { this.events?.emit("a") }'),
      "C.m",
    ],
    [
      "an instance field, from a static method",
      classOf("  events: EventEmitter2", '  static m() { this.events.emit("a") }'),
      "C::m",
    ],
    [
      "a static field, from an instance method",
      classOf("  static events: EventEmitter2", '  m() { this.events.emit("a") }'),
      "C.m",
    ],
    [
      "a field a base class declares",
      'export class C extends Base {\n  m() { this.events.emit("a") }\n}',
      "C.m",
    ],
    [
      "a `function` inside the method, which has a `this` of its own",
      classOf(
        "  constructor(private events: EventEmitter2) {}",
        '  m() { return function () { this.events.emit("a") } }',
      ),
      "C.m",
    ],
  ])("reads nothing from %s", async (_label, source, id) => {
    expect(await receiverTypesOf(source, id)).toEqual([["this.events.emit", undefined]])
  })

  it.each([
    [
      "a member of a field",
      classOf("  events: Hub", "  m() { this.events.bus.emit() }"),
      "C.m",
      "this.events.bus.emit",
    ],
    [
      "an object literal's method",
      'export const o = {\n  events: hub,\n  m() { this.events.emit("a") },\n}',
      "o.m",
      "this.events.emit",
    ],
    [
      "a parameter",
      "export function f(events: EventEmitter2) { events.emit() }",
      "f",
      "events.emit",
    ],
  ])("reads nothing through %s", async (_label, source, id, target) => {
    expect(await receiverTypesOf(source, id)).toEqual([[target, undefined]])
  })
})
