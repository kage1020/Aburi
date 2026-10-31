import { unwrapValue } from "@aburi/core"
import {
  CALL_ARGUMENT_FUNCTION_DERIVED_BY,
  type ExtractionContext,
  type SymbolCandidate,
} from "@aburi/types"
import type { Node } from "web-tree-sitter"
import {
  asClassValue,
  asFunctionValue,
  hasChildOfType,
  makeSourceRange,
  nameFieldText,
} from "./ast-helpers"
import { invokedFunction, layOutBodies, wrappedFunctions } from "./call-symbols"
import { classMemberCandidates } from "./class-candidates"
import { foldMemberGroup, groupMemberDeclaration, type MemberGroup } from "./declaration-merge"
import { refuseAnonymousId } from "./declared-name"
import { readDecorators } from "./decorators"
import { exportEvidence, topLevelVisibility } from "./export-evidence"
import { readLeadingJsDoc } from "./leading-jsdoc"
import { objectEntryOf, objectLiteralOf } from "./object-members"
import { collectPatternBindings } from "./pattern-bindings"
import { makeTsSymbolId, nestedQname } from "./qname"
import { buildSignature } from "./signature"

export function makeVariableCandidates(
  declarator: Node,
  statement: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node>[] {
  const nameNode = declarator.childForFieldName("name")
  if (nameNode !== null && isBindingPattern(nameNode)) {
    const refuse = (node: Node): never =>
      refuseAnonymousId(
        `Unmodelled node "${node.type}" inside a destructuring pattern at ${nameNode.startPosition.row + 1}; refusing to report bindings this walk may have missed`,
        node.type,
      )
    return collectPatternBindings(nameNode, refuse).map((binding) =>
      makeDestructuredCandidate(binding, statement, ctx, namespacePath),
    )
  }
  return makeVariableCandidate(declarator, statement, ctx, namespacePath)
}

function isBindingPattern(node: Node): boolean {
  return node.type === "object_pattern" || node.type === "array_pattern"
}

function makeVariableCandidate(
  declarator: Node,
  statement: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node>[] {
  const name = nameFieldText(declarator)
  if (name === null) return []
  const initializer = declarator.childForFieldName("value")
  const value = initializer === null ? null : asFunctionValue(initializer)
  const qname = nestedQname([...namespacePath, name])
  const id = makeTsSymbolId(ctx.file.path, qname)
  if (value !== null) {
    return [
      {
        id,
        kind: "function",
        extKind: null,
        name: qname,
        visibility: topLevelVisibility(statement),
        decorators: [],
        signature: buildSignature(value, readLeadingJsDoc(statement)),
        source: makeSourceRange(statement, ctx),
        derivedBy: ["variable-assigned-function", ...exportEvidence(statement)],
        bodyNode: value.childForFieldName("body"),
        fullNode: value,
      },
    ]
  }
  const classNode = initializer === null ? null : asClassValue(initializer)
  if (classNode !== null) {
    return [
      {
        id,
        kind: "class",
        extKind: null,
        name: qname,
        visibility: topLevelVisibility(statement),
        decorators: readDecorators(classNode),
        signature: null,
        source: makeSourceRange(statement, ctx),
        derivedBy: ["variable-assigned-class", ...exportEvidence(statement)],
        bodyNode: classNode.childForFieldName("body"),
        fullNode: classNode,
      },
      ...classMemberCandidates(classNode, ctx, [...namespacePath, name]),
    ]
  }
  const object = initializer === null ? null : objectLiteralOf(initializer)
  if (object !== null) {
    return [
      {
        id,
        kind: "const",
        extKind: null,
        name: qname,
        visibility: topLevelVisibility(statement),
        decorators: [],
        signature: null,
        source: makeSourceRange(statement, ctx),
        derivedBy: ["object-literal-initializer", ...exportEvidence(statement)],
        bodyNode: object,
        fullNode: statement,
      },
      ...objectMemberCandidates(object, ctx, [...namespacePath, name]),
    ]
  }
  const { bodies, evidence } = initializerFunctions(initializer)
  return [
    {
      id,
      kind: "const",
      extKind: null,
      name: qname,
      visibility: topLevelVisibility(statement),
      decorators: [],
      signature: null,
      source: makeSourceRange(statement, ctx),
      derivedBy: [...evidence, ...exportEvidence(statement)],
      ...layOutBodies(bodies, statement),
    },
  ]
}

interface InitializerFunctions {
  bodies: Node[]
  evidence: string[]
}

function initializerFunctions(initializer: Node | null): InitializerFunctions {
  const call = initializer === null ? null : unwrapValue(initializer)
  if (call === null || call.type !== "call_expression") return { bodies: [], evidence: [] }
  const handed = wrappedFunctions(call)
  const invoked = invokedFunction(call)?.childForFieldName("body") ?? null
  if (invoked === null || invoked.text.length === 0) {
    return {
      bodies: handed,
      evidence: handed.length > 0 ? [CALL_ARGUMENT_FUNCTION_DERIVED_BY] : [],
    }
  }
  return {
    bodies: [invoked, ...handed],
    evidence:
      handed.length > 0
        ? ["invoked-function", CALL_ARGUMENT_FUNCTION_DERIVED_BY]
        : ["invoked-function"],
  }
}

function objectMemberCandidates(
  object: Node,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node>[] {
  const byId = new Map<string, MemberGroup>()
  const collect = (current: Node, chain: readonly string[]): void => {
    for (const entry of current.namedChildren) {
      if (entry === null) continue
      const read = objectEntryOf(entry)
      if (read === null) continue
      if (read.object !== null) {
        collect(read.object, [...chain, read.segment])
        continue
      }
      const candidate = makeObjectMemberCandidate(entry, read.fn, read.segment, ctx, chain)
      groupMemberDeclaration(byId, candidate, hasChildOfType(entry, "get"))
    }
  }
  collect(object, ownerChain)
  return [...byId.values()]
    .map(foldMemberGroup)
    .filter((candidate): candidate is SymbolCandidate<Node> => candidate !== null)
}

function makeObjectMemberCandidate(
  entry: Node,
  fn: Node,
  segment: string,
  ctx: ExtractionContext,
  ownerChain: readonly string[],
): SymbolCandidate<Node> {
  const qname = nestedQname([...ownerChain, segment])
  const derivedBy = ["object-method"]
  if (entry.type === "pair") derivedBy.push("property-assigned-function")
  if (hasChildOfType(entry, "get") || hasChildOfType(entry, "set")) {
    derivedBy.push("accessor-declaration")
  }
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "method",
    extKind: null,
    name: qname,
    visibility: "public",
    decorators: [],
    signature: buildSignature(fn, readLeadingJsDoc(entry)),
    source: makeSourceRange(entry, ctx),
    derivedBy,
    bodyNode: fn.childForFieldName("body"),
    fullNode: fn,
  }
}

function makeDestructuredCandidate(
  binding: Node,
  statement: Node,
  ctx: ExtractionContext,
  namespacePath: readonly string[],
): SymbolCandidate<Node> {
  const qname = nestedQname([...namespacePath, binding.text])
  return {
    id: makeTsSymbolId(ctx.file.path, qname),
    kind: "const",
    extKind: null,
    name: qname,
    visibility: topLevelVisibility(statement),
    decorators: [],
    signature: null,
    source: makeSourceRange(statement, ctx),
    derivedBy: ["destructured-binding", ...exportEvidence(statement)],
    bodyNode: null,
    fullNode: statement,
  }
}
