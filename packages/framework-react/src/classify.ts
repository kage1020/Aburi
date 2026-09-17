import { lastQnameSegment } from "@aburi/core"
import type {
  ExtractionContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { isPascalCase, matchesHocNaming, returnsContextProvider } from "./components"
import { REACT_DERIVED_BY_PREFIX, type ReactExtKind } from "./ext-kinds"
import { bodyCallsAnotherHook, matchesHookNaming } from "./hooks"
import { hasJsxReturn } from "./jsx"
import { extractWrapperCall, isContextCall, isForwardRefCall, isMemoCall } from "./wrappers"

/** `extKind` narrowed to the plugin's own union so a typo fails to compile. */
type ReactClassification = { extKind: ReactExtKind; derivedBy: string }

/**
 * First-match-wins over React conventions:
 *
 *   1. hook         — `function` kind, leaf name matches /^use[A-Z]/
 *   2. hoc          — `function` kind, leaf name matches /^with[A-Z]/
 *   3. context      — `const` kind, initializer is `createContext(...)`
 *   4. forward-ref  — `const` kind, initializer is `forwardRef(...)`
 *   5. memo         — `const` kind, initializer is `memo(...)`
 *   6. provider     — `function` kind, PascalCase, returned JSX is `<X.Provider>`
 *   7. component    — `function` kind, PascalCase, body returns JSX
 *
 * Hook / hoc are name-only signals on lowercase-first identifiers, so they cannot overlap
 * the PascalCase-gated branches and are checked first: `useOverlay() { return <div/> }` is a
 * hook, not a component. Other symbol kinds return `null`.
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

  if (matchesHookNaming(leaf)) {
    const signals = [`${REACT_DERIVED_BY_PREFIX}:hook:naming`]
    if (bodyCallsAnotherHook(symbol.bodyNode)) {
      signals.push(`${REACT_DERIVED_BY_PREFIX}:hook:hook-call`)
    }
    return { extKind: "framework:react:hook", derivedBy: signals.join(";") }
  }

  if (matchesHocNaming(leaf)) {
    return { extKind: "framework:react:hoc", derivedBy: `${REACT_DERIVED_BY_PREFIX}:hoc:naming` }
  }

  // A lowercase function that is neither hook nor HOC is a plain utility.
  if (!isPascalCase(leaf)) return null

  if (returnsContextProvider(symbol.bodyNode)) {
    return { extKind: "framework:react:provider", derivedBy: `${REACT_DERIVED_BY_PREFIX}:provider` }
  }

  if (hasJsxReturn(symbol.bodyNode)) {
    return {
      extKind: "framework:react:component",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:component`,
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
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:context:${call.callee}`,
    }
  }
  if (isForwardRefCall(call)) {
    return {
      extKind: "framework:react:forward-ref",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:forward-ref:${call.callee}`,
    }
  }
  if (isMemoCall(call)) {
    return {
      extKind: "framework:react:memo",
      derivedBy: `${REACT_DERIVED_BY_PREFIX}:memo:${call.callee}`,
    }
  }
  return null
}
