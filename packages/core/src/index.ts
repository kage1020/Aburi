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
