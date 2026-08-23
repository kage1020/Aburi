export {
  COMPONENTS_DIRNAME,
  DEFAULT_OUTPUT_DIRNAME,
  DIFF_JSON_FILENAME,
  DIFF_MD_FILENAME,
  IR_JSON_FILENAME,
  resolveOutputDir,
  WORKSPACE_MD_FILENAME,
} from "./artifact-paths"
export {
  classifyDiffError,
  type DiffOptions,
  type DiffReport,
  type DiffSide,
  formatFailOnMessage,
  type GitRunner,
  runDiff,
  type WarnFn,
} from "./commands/diff"
export {
  type CoverageDoubt,
  type ExplainOptions,
  type ExplainOutcome,
  runExplain,
} from "./commands/explain"
export {
  type InitOptions,
  type InitReport,
  runInit,
} from "./commands/init"
export {
  type CoverageFault,
  reportScanIncidents,
  runScan,
  type ScanOptions,
  type ScanReport,
} from "./commands/scan"
export { resolveConfigPath } from "./config-path"
export { type AburiEnv, type LogLevel, readEnv } from "./env"
export { CliError, type CliErrorCode } from "./errors"
export { EXIT, type ExitCode } from "./exit-codes"
export {
  evaluateClause,
  evaluateFailOn,
  type FailOnClause,
  type FailOnDeltaAxis,
  FailOnParseError,
  type FailOnStatusToken,
  type FailOnToken,
  formatTriggered,
  parseFailOn,
} from "./fail-on"
export { readIR } from "./ir-io"
export { type LoadedPlugins, type LoadPluginsOptions, loadPlugins } from "./plugin-loader"
export { type RunCliOptions, runCli } from "./run"
