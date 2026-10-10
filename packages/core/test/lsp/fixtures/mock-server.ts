import type { LanguageId, LspServerConfig } from "@aburi/types"
import type { DocumentSymbol, InitializeResult, Position } from "vscode-languageserver-protocol"
import type { LspClient, LspFailure, ServerFactory } from "../../../src/lsp"

export const HOVER_METHOD = "textDocument/hover"
export const DOC_SYMBOL_METHOD = "textDocument/documentSymbol"

export type MockHandler = (params: unknown) => unknown

export type MockNotificationOutcome = (uri: string) => LspFailure | null

/** An `LspClient` that answers every request without a handler with `null`. */
export class MockLspClient implements LspClient {
  readonly requests: Array<{ method: string; params: unknown }> = []
  readonly openFiles: string[] = []
  readonly openLanguageIds: string[] = []
  readonly closedFiles: string[] = []
  readonly openTimeouts: number[] = []
  readonly closeTimeouts: number[] = []
  initializeCalled = false
  shutdownCount = 0
  private initializeThrow: unknown = null
  private initializeFailure: LspFailure | null = null
  private shutdownThrow: unknown = null
  private shutdownHangs = false
  private readonly handlers = new Map<string, MockHandler>()
  private didOpenOutcome: MockNotificationOutcome | null = null
  private didCloseOutcome: MockNotificationOutcome | null = null

  installHandler(method: string, handler: MockHandler): this {
    this.handlers.set(method, handler)
    return this
  }

  installInitializeFailure(failure: LspFailure): this {
    this.initializeFailure = failure
    return this
  }

  installInitializeThrow(error: unknown): this {
    this.initializeThrow = error
    return this
  }

  installDidOpenOutcome(outcome: MockNotificationOutcome): this {
    this.didOpenOutcome = outcome
    return this
  }

  installDidCloseOutcome(outcome: MockNotificationOutcome): this {
    this.didCloseOutcome = outcome
    return this
  }

  installShutdownThrow(error: unknown): this {
    this.shutdownThrow = error
    return this
  }

  installShutdownHang(): this {
    this.shutdownHangs = true
    return this
  }

  async initialize(): Promise<InitializeResult | LspFailure> {
    this.initializeCalled = true
    if (this.initializeThrow !== null) throw this.initializeThrow
    return this.initializeFailure ?? { capabilities: {} }
  }

  async didOpen(
    uri: string,
    languageId: string,
    _text: string,
    timeoutMs: number,
  ): Promise<LspFailure | null> {
    this.openFiles.push(uri)
    this.openLanguageIds.push(languageId)
    this.openTimeouts.push(timeoutMs)
    return this.didOpenOutcome?.(uri) ?? null
  }

  async didClose(uri: string, timeoutMs: number): Promise<LspFailure | null> {
    this.closedFiles.push(uri)
    this.closeTimeouts.push(timeoutMs)
    return this.didCloseOutcome?.(uri) ?? null
  }

  async request<T>(method: string, params: unknown): Promise<T | LspFailure> {
    this.requests.push({ method, params })
    const handler = this.handlers.get(method)
    return (handler === undefined ? null : await handler(params)) as T | LspFailure
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1
    if (this.shutdownHangs) await new Promise<void>(() => {})
    if (this.shutdownThrow !== null) throw this.shutdownThrow
  }
}

export interface MockServerFactory extends ServerFactory {
  readonly clients: Map<string, MockLspClient>
}

export function mockServerFactory(
  setup: (client: MockLspClient, language: LanguageId) => void = () => {},
): MockServerFactory {
  const clients = new Map<string, MockLspClient>()
  const factory = (language: LanguageId, _config: LspServerConfig, _root: string): LspClient => {
    const client = new MockLspClient()
    clients.set(language, client)
    setup(client, language)
    return client
  }
  return Object.assign(factory, { clients })
}

export function hoverServer(hover: MockHandler): MockServerFactory {
  return mockServerFactory((client) => client.installHandler(HOVER_METHOD, hover))
}

export function documentSymbolServer(entries: () => unknown): MockServerFactory {
  return mockServerFactory((client) => client.installHandler(DOC_SYMBOL_METHOD, entries))
}

/** A documentSymbol entry for `name` on 1-based `line`, starting at 0-based `startCol` the way LSP sends it. */
export function docSymbol(
  name: string,
  line: number,
  startCol: number,
  children?: DocumentSymbol[],
): DocumentSymbol {
  const range = {
    start: { line: line - 1, character: startCol },
    end: { line: line - 1, character: startCol + name.length },
  }
  return {
    name,
    kind: 5,
    range,
    selectionRange: range,
    ...(children === undefined ? {} : { children }),
  }
}

export function hoverPosition(params: unknown): Position {
  return (params as { position: Position }).position
}
