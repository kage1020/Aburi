import { checkDocumentShape, DOCUMENT_SUBJECT } from "@aburi/core"
import type { IR } from "@aburi/types"
import { DEPENDENCY_IDENTITY_FIELDS, dependencyIdentity } from "./components"
import { DiffError } from "./errors"

export function ensureSchemasAgree(base: IR, head: IR): void {
  if (base.$schema !== head.$schema) {
    throw new DiffError(
      `Base IR schema "${base.$schema}" does not match head IR schema "${head.$schema}"; a diff across schema versions is not supported.`,
      { code: "schema-mismatch", value: base.$schema },
    )
  }
}

type IRSide = "baseIR" | "headIR"

interface IdentifiedCollection {
  readonly field: "symbols" | "components" | "dependencies"
  readonly identities: (ir: IR) => readonly (readonly string[])[]
  /** Must join the identity fields the way the diff keys on them, or the check guards nothing. */
  readonly keyOf: (parts: readonly string[]) => string
  readonly noun: string
  readonly show: (parts: readonly string[]) => string
  readonly consequence: string
}

/** Identity is a single field, so joining the one-member tuple is joining nothing. */
const soleField = (parts: readonly string[]): string => parts.join("")

const IDENTIFIED_COLLECTIONS: readonly IdentifiedCollection[] = [
  {
    field: "symbols",
    identities: (ir) => ir.symbols.map((symbol) => [symbol.id]),
    keyOf: soleField,
    noun: "id",
    show: soleField,
    consequence:
      "stage 1 pairs Symbols by id and every later stage tracks the base Symbols it has " +
      "consumed by id, so a repeat leaves one entry out of the diff entirely or classifies " +
      "its counterpart twice",
  },
  {
    field: "components",
    identities: (ir) => ir.components.map((component) => [component.id]),
    keyOf: soleField,
    noun: "id",
    show: soleField,
    consequence:
      "Component identity is the id, so a repeat hides one entry and can report a change " +
      "the two revisions do not contain",
  },
  {
    field: "dependencies",
    identities: (ir) =>
      ir.dependencies.map((dependency) =>
        DEPENDENCY_IDENTITY_FIELDS.map((field) => dependency[field]),
      ),
    keyOf: dependencyIdentity,
    noun: "(from, to, via) triple",
    show: (parts) => `(${parts.join(", ")})`,
    consequence:
      "direction and effect are deliberately outside Dependency identity, so a " +
      "repeat surfaces as an added + removed pair no reader can tell from a real flip",
  },
]

export function assertDiffable(ir: IR, name: IRSide): void {
  const violations = checkDocumentShape(ir)
  const first = violations[0]
  if (first !== undefined) {
    const subject = sidedSubject(name, first.subject)
    const rest = violations.length - 1
    const more = rest > 0 ? ` (and ${rest} more)` : ""
    throw new DiffError(`${subject}: ${first.message}${more}.`, {
      code: "ir-shape-invalid",
      value: subject,
      violations: violations.map((v) => ({ ...v, subject: sidedSubject(name, v.subject) })),
    })
  }
  if (ir.$schema.length === 0) {
    throw new DiffError(`${name}: "$schema" is empty, not a schema URL.`, {
      code: "ir-shape-invalid",
      value: name,
    })
  }
  for (const collection of IDENTIFIED_COLLECTIONS) {
    assertUniqueIdentity(collection.identities(ir), `${name}.${collection.field}`, collection)
  }
}

function sidedSubject(name: IRSide, subject: string): string {
  return subject === DOCUMENT_SUBJECT ? name : `${name}.${subject}`
}

function assertUniqueIdentity(
  identities: readonly (readonly string[])[],
  subject: string,
  collection: IdentifiedCollection,
): void {
  const firstSeen = new Map<string, number>()
  for (const [index, parts] of identities.entries()) {
    const key = collection.keyOf(parts)
    const first = firstSeen.get(key)
    if (first === undefined) {
      firstSeen.set(key, index)
      continue
    }
    const shown = collection.show(parts)
    throw new DiffError(
      `${subject}[${index}] repeats the ${collection.noun} "${shown}" first seen at index ` +
        `${first}; ${collection.consequence}.`,
      { code: "ir-identity-collision", value: shown },
    )
  }
}
