import { EXIT, reportScanIncidents, type ScanReport } from "../src"

export function scanReportWith(overrides: Partial<ScanReport>): ScanReport {
  return {
    irPath: null,
    workspaceMdPath: null,
    componentMdPaths: [],
    totalFiles: 0,
    parsedFiles: 0,
    keptSymbols: 0,
    droppedSymbols: 0,
    parseErrorFiles: [],
    parseErrorCount: 0,
    parseFailureCount: 0,
    timeoutCount: 0,
    skipped: [],
    extractionFailures: [],
    lspEnrichment: undefined,
    callResolutionLine: "",
    unresolvedCalls: [],
    configSource: null,
    configPinnedByCaller: false,
    workspaceRoot: "/repo",
    coverageFault: null,
    unrepresentableFiles: [],
    undeclaredVocab: [],
    vocabDiscoveredPath: null,
    unresolvedDeclarations: [],
    treeReleaseFailures: [],
    fellBackToSingleComponent: false,
    pluginNamedFrameworks: [],
    exitCode: EXIT.SUCCESS,
    ...overrides,
  }
}

export function incidentLinesFrom(
  report: Partial<ScanReport>,
  label: string | null = null,
): string[] {
  const lines: string[] = []
  reportScanIncidents(scanReportWith(report), (line) => lines.push(line), label)
  return lines
}
