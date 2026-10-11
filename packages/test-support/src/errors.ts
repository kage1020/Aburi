import { expect } from "vitest"

/**
 * The error `attempt` throws or rejects with, checked to be an `errorClass`, so a test can assert on
 * its fields. Fails when `attempt` completes.
 */
export async function errorFrom<E extends Error>(
  errorClass: abstract new (...args: never[]) => E,
  attempt: () => unknown,
): Promise<E> {
  try {
    await attempt()
  } catch (error) {
    expect(error).toBeInstanceOf(errorClass)
    return error as E
  }
  throw new Error(`expected ${errorClass.name} to be thrown, but the attempt completed`)
}
