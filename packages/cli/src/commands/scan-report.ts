import type {
  SkippedFile,
  TreeReleaseFailure,
  UnrepresentableFile,
  UnresolvedDeclaration,
} from "@aburi/core"
import type { LspEnrichmentStats, UnresolvedCallDiagnostic } from "@aburi/types"
import type { ExitCode } from "../exit-codes"
import type { DiscoveredVocabItem } from "../vocab-discovered"

export type CoverageFault =
  | { kind: "nothing-discovered" }
  | {
      kind: "nothing-parsed"
      totalFiles: number
      dominant: SkippedFile["reason"]
      dominantCount: number
    }
  | { kind: "below-floor"; parsedFiles: number; totalFiles: number; floor: number }

export interface PluginNamedFramework {
  component: string
  value: string
  frameworkIds: readonly string[]
}

export interface ScanReport {
  irPath: string | null
  workspaceMdPath: string | null
  componentMdPaths: string[]
  totalFiles: number
  parsedFiles: number
  keptSymbols: number
  droppedSymbols: number
  parseErrorFiles: readonly { path: string; detail: string }[]
  parseErrorCount: number
  parseFailureCount: number
  timeoutCount: number
  skipped: readonly { path: string; reason: SkippedFile["reason"]; detail?: string }[]
  extractionFailures: readonly { file: string; message: string; code?: string }[]
  treeReleaseFailures: readonly TreeReleaseFailure[]
  lspEnrichment: LspEnrichmentStats | undefined
  callResolutionLine: string
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
  configSource: string | null
  configPinnedByCaller: boolean
  workspaceRoot: string
  coverageFault: CoverageFault | null
  unrepresentableFiles: readonly UnrepresentableFile[]
  undeclaredVocab: readonly DiscoveredVocabItem[]
  vocabDiscoveredPath: string | null
  unresolvedDeclarations: readonly UnresolvedDeclaration[]
  fellBackToSingleComponent: boolean
  pluginNamedFrameworks: readonly PluginNamedFramework[]
  exitCode: ExitCode
}
