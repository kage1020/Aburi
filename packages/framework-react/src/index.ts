export {
  asSyntaxNode,
  calleeLeaf,
  calleeText,
  findFirstDescendantOfType,
  type SyntaxNode,
} from "./ast"
export { classifyReactSymbol } from "./classify"
export {
  isPascalCase,
  matchesHocNaming,
  returnsContextProvider,
  returnsJsx,
} from "./components"
export {
  isReactExtKind,
  REACT_EXT_KIND_SET,
  REACT_EXT_KINDS,
  type ReactExtKind,
} from "./ext-kinds"
export { bodyCallsAnotherHook, matchesHookNaming } from "./hooks"
export { findReturnedJsxElementName, hasJsxReturn, isProviderElementName } from "./jsx"
export { frameworkReactManifest } from "./manifest"
export { ReactFrameworkPlugin, reactFrameworkPlugin } from "./plugin"
export {
  extractWrapperCall,
  isContextCall,
  isForwardRefCall,
  isMemoCall,
  REACT_CONTEXT_FACTORIES,
  REACT_FORWARD_REF_FACTORIES,
  REACT_MEMO_FACTORIES,
  type WrapperCall,
} from "./wrappers"
