import { lastQnameSegment } from "@aburi/core"
import type {
  ExtractionContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { isPascalCase, matchesHocNaming, returnsContextProvider, returnsJsx } from "./components"
import type { ReactExtKind } from "./ext-kinds"
import { bodyCallsAnotherHook, matchesHookNaming } from "./hooks"
import { extractWrapperCall, isContextCall, isForwardRefCall, isMemoCall } from "./wrappers"

/**
 * Local alias for a classification carrying a `ReactExtKind` literal so a typo in any
 * `extKind` assignment below fails to compile against the shared union — the manifest's
 * `EXT_KIND_ENTRIES` is pinned to the same union, so the two cannot drift.
 */
type ReactClassification = { extKind: ReactExtKind; derivedBy: string }

/**
 * Classify a SymbolCandidate against React conventions in first-match-wins order:
 *
 *   1. hook         — `function` kind, leaf name matches /^use[A-Z]/
 *   2. hoc          — `function` kind, leaf name matches /^with[A-Z]/
 *   3. context      — `const` kind, initializer is `createContext(...)`
 *   4. forward-ref  — `const` kind, initializer is `forwardRef(...)`
 *   5. memo         — `const` kind, initializer is `memo(...)`
 *   6. provider     — `function` kind, PascalCase, returned JSX is `<X.Provider>`
 *   7. component    — `function` kind, PascalCase, body returns JSX
 *
 * Order rationale: hook / hoc are name-only signals with lowercase-first identifiers
 * (`use[A-Z]` and `with[A-Z]`) so they cannot overlap the PascalCase-gated provider /
 * component signals. Checking name-only signals first lets `useOverlay() { return <div/> }`
 * classify as hook (naming beats body-shape), and `withAuth(C) { return <C/> }` classify
 * as hoc even when its body returns JSX. Any Symbol whose kind is not `function` or
 * `const` returns `null` and flows through unclassified.
 */
export function classifyReactSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  _ctx: ExtractionContext,
): SymbolClassification | null {
  if (symbol.kind === "function") return classifyFunctionSymbol(symbol)
  if (symbol.kind === "const") return classifyConstSymbol(symbol)
  return null
}

function classifyFunctionSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
): ReactClassification | null {
  const leaf = lastQnameSegment(symbol.name)

  // 1. Hook — name-only signal wins over any body-shape check.
  if (matchesHookNaming(leaf)) {
    const signals: string[] = ["framework:react:hook:naming"]
    if (bodyCallsAnotherHook(symbol.bodyNode)) {
      signals.push("framework:react:hook:hook-call")
    }
    return {
      extKind: "framework:react:hook",
      derivedBy: signals.join(";"),
    }
  }

  // 2. HOC — also name-only. `with[A-Z]` is lowercase-first so it never overlaps with
  //    the PascalCase-gated provider / component branches below.
  if (matchesHocNaming(leaf)) {
    return {
      extKind: "framework:react:hoc",
      derivedBy: "framework:react:hoc:naming",
    }
  }

  // Everything below requires a PascalCase-named function. A lowercase function that is
  // not a hook and not an HOC is a plain utility — nothing React-specific to classify.
  if (!isPascalCase(leaf)) return null

  // 6. Provider — a PascalCase function whose returned JSX is `<X.Provider>`.
  if (returnsContextProvider(symbol.bodyNode)) {
    return {
      extKind: "framework:react:provider",
      derivedBy: "framework:react:provider",
    }
  }

  // 7. Component — the general fallback for PascalCase functions returning JSX.
  if (returnsJsx(symbol.bodyNode)) {
    return {
      extKind: "framework:react:component",
      derivedBy: "framework:react:component",
    }
  }

  return null
}

function classifyConstSymbol(symbol: SymbolCandidate<OpaqueAstNode>): ReactClassification | null {
  const call = extractWrapperCall(symbol.fullNode)
  if (call === null) return null
  if (isContextCall(call)) {
    return {
      extKind: "framework:react:context",
      derivedBy: `framework:react:context:${call.callee}`,
    }
  }
  if (isForwardRefCall(call)) {
    return {
      extKind: "framework:react:forward-ref",
      derivedBy: `framework:react:forward-ref:${call.callee}`,
    }
  }
  if (isMemoCall(call)) {
    return {
      extKind: "framework:react:memo",
      derivedBy: `framework:react:memo:${call.callee}`,
    }
  }
  return null
}
