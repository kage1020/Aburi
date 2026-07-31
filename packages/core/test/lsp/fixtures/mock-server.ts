import type { LanguageId, LspServerConfig } from "@aburi/types"
import type { InitializeResult } from "vscode-languageserver-protocol"
import type { LSP_TIMEOUT, LspClient, LspFailure, ServerFactory } from "../../../src/lsp"

export type MockHandler = (
  params: unknown,
) => unknown | LspFailure | typeof LSP_TIMEOUT | Promise<unknown | LspFailure | typeof LSP_TIMEOUT>

/**
 * Outcome of a `didOpen` / `didClose` notification, decided per file. Returning
 * a failure models a write that timed out or was rejected; the callback also
 * doubles as the place to spend an injected clock (`EnrichmentInput.now`) the
 * way a slow real notification would spend wall time, without sleeping.
 */
export type MockNotificationOutcome = (uri: string) => LspFailure | null

/**
 * In-memory `LspClient` mock. Tests register handlers per LSP method and the
 * mock records every request it received so callers can assert on request
 * counts, order, and per-call params. No child process is spawned — perfect
 * for deterministic tests that must run identically in CI.
 */
export class MockLspClient implements LspClient {
  readonly requests: Array<{ method: string; params: unknown }> = []
  readonly openFiles: string[] = []
  readonly closedFiles: string[] = []
  /** Timeout budgets the pass handed to `didOpen` / `didClose`, in call order. */
  readonly openTimeouts: number[] = []
  readonly closeTimeouts: number[] = []
  initializeCalled = false
  shutdownCalled = false
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

  async initialize(): Promise<InitializeResult | LspFailure> {
    this.initializeCalled = true
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

  async shutdown(): Promise<void> {
    this.shutdownCalled = true
  }
}

/**
 * Factory that returns a fresh `MockLspClient` per language. Tests may capture
 * the returned clients via the `onClient` callback to inspect / configure them
 * further after they are handed to `enrichWithLsp`.
 */
export function mockServerFactory(
  onClient: (language: LanguageId, client: MockLspClient) => void,
): ServerFactory {
  return (language: LanguageId, _config: LspServerConfig, _root: string): LspClient => {
    const client = new MockLspClient()
    onClient(language, client)
    return client
  }
}

/**
 * Factory that always returns null — simulates server-missing scenario.
 */
export function nullServerFactory(): ServerFactory {
  return () => null
}
