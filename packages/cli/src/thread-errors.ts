import { CliError, type CliErrorCode } from "./errors"

export type ThreadThrown =
  | {
      kind: "cli"
      message: string
      code: CliErrorCode
      stack: string | undefined
      cause: unknown
    }
  | {
      kind: "error"
      name: string
      message: string
      stack: string | undefined
      code: unknown
      cause: unknown
    }
  | { kind: "value"; text: string }

/** What a thread sends of an error: a structured clone drops its class and the fields it adds, `code` among them. */
export function describedForThread(error: unknown): ThreadThrown {
  if (error instanceof CliError) {
    return {
      kind: "cli",
      message: error.message,
      code: error.code,
      stack: error.stack,
      cause: ifCloneable(error.cause),
    }
  }
  if (error instanceof Error) {
    return {
      kind: "error",
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: ifCloneable((error as { code?: unknown }).code),
      cause: ifCloneable(error.cause),
    }
  }
  return { kind: "value", text: String(error) }
}

export function ifCloneable(value: unknown): unknown {
  try {
    structuredClone(value)
    return value
  } catch {
    return undefined
  }
}

export function rebuiltFromThread(thrown: ThreadThrown): unknown {
  switch (thrown.kind) {
    case "cli":
      return withStack(
        new CliError(thrown.message, thrown.code, causeOf(thrown.cause)),
        thrown.stack,
      )
    case "error": {
      const error = withStack(new Error(thrown.message, causeOf(thrown.cause)), thrown.stack)
      error.name = thrown.name
      if (thrown.code !== undefined) Object.assign(error, { code: thrown.code })
      return error
    }
    case "value":
      return thrown.text
  }
}

function causeOf(cause: unknown): { cause: unknown } | undefined {
  return cause === undefined ? undefined : { cause }
}

function withStack<T extends Error>(error: T, stack: string | undefined): T {
  if (stack !== undefined) error.stack = stack
  return error
}
