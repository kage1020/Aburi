export {
  type CallEdge,
  type ResolveCallGraphInput,
  type ResolveCallGraphResult,
  reconstructCallEdgesFromIR,
  resolveCallGraph,
} from "./callgraph"
export { type SerializeOptions, serializeCanonical } from "./canonical"
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
  DEFAULT_EXPORT_QNAME,
  isDefaultExportQname,
  makeMemberQname,
  makeNestedQname,
  makeSymbolId,
  makeTopLevelQname,
  toPosixRelative,
} from "./id"
export { assertIRIntegrity, checkIRIntegrity } from "./integrity"
export {
  createFallbackState,
  createLspCache,
  createLspClient,
  createStatsBuilder,
  DEFAULT_FALLBACK_CONFIG,
  type EnrichmentInput,
  type EnrichmentResult,
  enrichWithLsp,
  finalizeStats,
  isLspFailure,
  LSP_TIMEOUT,
  type LspCache,
  type LspClient,
  type LspError,
  type LspFailure,
  type LspTimeout,
  makeReceiverHintKey,
  type ReceiverHint,
  type ReceiverHintKey,
  requestDocumentSymbols,
  requestHover,
  requestImplementation,
  requestTypeDefinition,
  type ServerFactory,
  type SpawnedServer,
  spawnStdioServer,
} from "./lsp"
export {
  type PropagateInput,
  type PropagateResult,
  type PropagationStats,
  propagateEffects,
} from "./propagate"
export {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  type DiscoveredFile,
  type DiscoverOptions,
  type DiscoverResult,
  discoverFiles,
  type SkippedFile,
} from "./scan/discover"
export { decideSymbolDrop } from "./scan/drop-b"
export {
  buildDropCFilter,
  DropCFilter,
  type DropCFilterInput,
} from "./scan/drop-c"
export {
  type FilePipelineInput,
  type FilePipelineResult,
  runFilePipeline,
} from "./scan/pipeline"
export {
  buildLanguageRouter,
  LanguageRouter,
} from "./scan/route"
export {
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
} from "./scan/timeout"
export { computeWeaklyConnectedComponents } from "./wcc"
export {
  type DetectManagersResult,
  type DetectWorkspaceRootOptions,
  detectManagers,
  detectWorkspaceRoot,
  type WorkspaceCandidate,
} from "./workspace"
