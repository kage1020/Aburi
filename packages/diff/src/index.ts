export {
  diffComponents,
  diffDependencies,
} from "./components"
export {
  computeSymbolDelta,
  DEFAULT_LINE_FUZZ,
  type DeltaOptions,
  MAX_LINE_FUZZ,
  MIN_LINE_FUZZ,
} from "./delta"
export {
  buildDiff,
  type DiffInput,
  writeCanonicalDiff,
} from "./diff"
export {
  DiffError,
  type DiffErrorCode,
  type DiffErrorDetail,
} from "./errors"
export {
  type GitRenameMap,
  matchStageDroppedWeak,
  matchStageGitRename,
  matchStageId,
  matchStageLogicFingerprint,
  matchStageNameSignature,
  type SymbolPair,
} from "./match"
export { signatureSimilarity } from "./signature"
export {
  jaccard,
  jaccardTokens,
  lastSegment,
  nameSimilarity,
  ownerSimilarity,
  tokenizeName,
} from "./similarity"
export { computeSlices, type SliceInput } from "./slice"
export {
  classifyStatus,
  type DropDirection,
  dropDirection,
  type SymbolStatus,
} from "./status"
