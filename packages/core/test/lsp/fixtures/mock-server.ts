import type { LanguageId, LspServerConfig } from "@aburi/types"
import type { InitializeResult } from "vscode-languageserver-protocol"
import type { LSP_TIMEOUT, LspClient, LspFailure, ServerFactory } from "../../../src/lsp"

export type MockHandler = (
  params: unknown,
) => unknown | LspFailure | typeof LSP_TIMEOUT | Promise<unknown | LspFailure | typeof LSP_TIMEOUT>

export type MockNotificationOutcome = (uri: string) => LspFailure | null

export class MockLspClient implements LspClient {
  readonly requests: Array<{ method: string; params: unknown }> = []
  readonly openFiles: string[] = []
  readonly closedFiles: string[] = []
  /** Timeout budgets the pass handed to `didOpen` / `didClose`, in call order. */
  readonly openTimeouts: number[] = []
  readonly closeTimeouts: number[] = []
  initializeCalled = false
  shutdownCalled = false
  /** Shutdowns received, so a caller can tell one from two. */
  shutdownCount = 0
  private initializeThrow: unknown = null
  private shutdownThrow: unknown = null
  private shutdownHangs = false
  private handlers = new Map<string, MockHandler>()
  private initializeResult: InitializeResult = {
    capabilities: {},
  }
  private initializeFailure: LspFailure | null = null
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

  installInitializeResult(result: InitializeResult): this {
    this.initializeResult = result
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

  /** Reject `initialize`, the way an injected client is free to. */
  installInitializeThrow(error: unknown): this {
    this.initializeThrow = error
    return this
  }

  async initialize(): Promise<InitializeResult | LspFailure> {
    this.initializeCalled = true
    if (this.initializeThrow !== null) throw this.initializeThrow
    if (this.initializeFailure !== null) return this.initializeFailure
    return this.initializeResult
  }

  async didOpen(
    uri: string,
    _languageId: string,
    _text: string,
    timeoutMs: number,
  ): Promise<LspFailure | null> {
    this.openFiles.push(uri)
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
    if (handler === undefined) return null as T
    const result = await handler(params)
    return result as T | LspFailure
  }

  /** Reject `shutdown`, the way an injected client is free to. */
  installShutdownThrow(error: unknown): this {
    this.shutdownThrow = error
    return this
  }

  /** Never settle `shutdown`, the way a client talking to a wedged process would. */
  installShutdownHang(): this {
    this.shutdownHangs = true
    return this
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true
    this.shutdownCount += 1
    if (this.shutdownHangs) await new Promise<void>(() => {})
    if (this.shutdownThrow !== null) throw this.shutdownThrow
  }
}

export function mockServerFactory(
  onClient: (language: LanguageId, client: MockLspClient) => void,
): ServerFactory {
  return (language: LanguageId, _config: LspServerConfig, _root: string): LspClient => {
    const client = new MockLspClient()
    onClient(language, client)
    return client
  }
}

export function nullServerFactory(): ServerFactory {
  return () => null
}
