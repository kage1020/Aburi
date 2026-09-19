import { expect } from "vitest"
import { ConfigError } from "../../src/index"

/** Run `attempt` and return the `ConfigError` it throws; fails the test if it does not. */
export async function configErrorFrom(attempt: () => unknown): Promise<ConfigError> {
  try {
    await attempt()
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError)
    return err as ConfigError
  }
  throw new Error("expected a ConfigError to be thrown")
}
