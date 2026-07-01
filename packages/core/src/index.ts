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
  type DetectManagersResult,
  type DetectWorkspaceRootOptions,
  detectManagers,
  detectWorkspaceRoot,
  type WorkspaceCandidate,
} from "./workspace"
