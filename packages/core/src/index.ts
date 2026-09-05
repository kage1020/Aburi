export { makeCallSiteKey } from "./call-site"
export {
  type CallEdge,
  type ResolveCallGraphInput,
  type ResolveCallGraphResult,
  reconstructCallEdgesFromIR,
  resolveCallGraph,
} from "./callgraph"
export { type SerializeOptions, serializeCanonical } from "./canonical"
export { describeCodePoints } from "./codepoints"
export {
  __testing as __testing_component,
  type DetectComponentsOptions,
  detectComponents,
} from "./component"
export {
  CoreError,
  type CoreErrorCode,
  type CoreErrorDetail,
  type IntegrityViolation,
} from "./errors"
export {
  apiFingerprint,
  type ComputeFingerprintInput,
  computeSymbolFingerprint,
  FP_HEX_LENGTH,
  hashCanonicalObject,
  hashRawString,
  lastQnameSegment,
  logicFingerprint,
  normalizeFingerprintString,
  syntaxFingerprint,
  ZERO_FINGERPRINT,
} from "./fingerprint"
export {
  type BackslashSite,
  backslashSite,
  DEFAULT_EXPORT_QNAME,
  type GrammarViolation,
  isComponentId,
  isDefaultExportQname,
  isLanguageId,
  isQualifiedName,
  isSymbolId,
  makeComponentId,
  makeLanguageId,
  makeMemberQname,
  makeNestedQname,
  makeSymbolId,
  makeTopLevelQname,
  posixWorkspaceRelativeViolation,
  RESERVED_LANGUAGE_IDS,
  type SymbolIdParts,
  symbolIdFile,
  symbolIdSeparatorSite,
  toDocumentPath,
  toPosixRelative,
  trySymbolId,
} from "./id"
export { type ImportBinding, splitAliasedImportName } from "./import-edge"
export { assertIRIntegrity, checkIRIntegrity } from "./integrity"
export { checkDocumentShape, DOCUMENT_SUBJECT } from "./integrity-shape"
export {
  type EnrichmentInput,
  type EnrichmentResult,
  enrichWithLsp,
  isLspFailure,
  type LspClient,
  type LspError,
  type LspFailure,
  type LspTimeout,
  type ReceiverHint,
  type ServerFactory,
} from "./lsp"
export {
  type PropagateInput,
  type PropagateResult,
  type PropagationStats,
  propagateEffects,
} from "./propagate"
export {
  buildComponentAttribution,
  type ComponentAttribution,
} from "./scan/attribute"
export {
  type CollidingFile,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  type DiscoveredFile,
  type DiscoverOptions,
  type DiscoverResult,
  discoverFiles,
  type SkippedFile,
  type UnnameableFile,
  type UnrepresentableFile,
} from "./scan/discover"
export { decideSymbolDrop } from "./scan/drop-b"
export {
  buildDropCFilter,
  DropCFilter,
  type DropCFilterInput,
} from "./scan/drop-c"
export {
  type ExtractedFile,
  type FilePipelineInput,
  type FilePipelineResult,
  type ParseFailedFile,
  type ParseTimeoutFile,
  runFilePipeline,
  type TreeReleaseFailure,
} from "./scan/pipeline"
export {
  buildLanguageRouter,
  LanguageRouter,
} from "./scan/route"
export {
  languageFileDropPatterns,
  type ParseErrorRecord,
  type ScanInput,
  type ScanResult,
  scan,
  writeCanonicalIR,
} from "./scan/scan"
export {
  CLASSIFY_TIMEOUT_MAX_MS,
  CLASSIFY_TIMEOUT_MIN_MS,
  type ClassifyTimeoutEvent,
  type ClassifyWithTimeoutOptions,
  classifyWithTimeout,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  DEFAULT_PARSE_TIMEOUT_MS,
  PARSE_TIMEOUT_MIN_MS,
  type ParseDeadline,
  type ParseTimeoutEvent,
  startParseDeadline,
} from "./scan/timeout"
export { computeWeaklyConnectedComponents } from "./wcc"
export {
  type DetectManagersResult,
  type DetectWorkspaceRootOptions,
  detectManagers,
  detectWorkspaceRoot,
  type UnresolvedDeclaration,
  type WorkspaceCandidate,
} from "./workspace"
