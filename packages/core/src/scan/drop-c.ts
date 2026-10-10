import type { CallCandidate } from "@aburi/types"
import { toNfc } from "../codepoints"

const CORE_DROP_PREFIXES: readonly string[] = [
  "console.log",
  "console.info",
  "console.warn",
  "console.error",
  "console.debug",
  "console.trace",
  "console.table",
  "console.dir",
  "console.group",
  "console.groupEnd",
  "process.stdout.write",
  "process.stderr.write",
]

export interface DropCFilterInput {
  suppress?: readonly string[]
  pluginDropCallees?: readonly string[]
  keep?: readonly string[]
}

export function buildDropCFilter(input: DropCFilterInput = {}): DropCFilter {
  return new DropCFilter(
    CORE_DROP_PREFIXES,
    input.pluginDropCallees ?? [],
    input.suppress ?? [],
    input.keep ?? [],
  )
}

export class DropCFilter {
  readonly #dropPrefixes: readonly string[]
  readonly #keepPrefixes: readonly string[]

  /** @internal — call `buildDropCFilter` instead so the `@Decorator` sigil strip is not bypassed. */
  constructor(
    core: readonly string[],
    pluginDropCallees: readonly string[],
    suppress: readonly string[],
    keep: readonly string[],
  ) {
    this.#dropPrefixes = [...core, ...pluginDropCallees, ...suppress].map(toNfc)
    this.#keepPrefixes = keep.map((k) => toNfc(k.startsWith("@") ? k.slice(1) : k))
  }

  shouldDropCall(call: CallCandidate): boolean {
    if (this.matchesAnyPrefix(call.target, this.#keepPrefixes)) return false
    return this.matchesAnyPrefix(call.target, this.#dropPrefixes)
  }

  private matchesAnyPrefix(target: string, prefixes: readonly string[]): boolean {
    for (const prefix of prefixes) {
      if (isPrefixMatch(target, prefix)) return true
    }
    return false
  }
}

function isPrefixMatch(target: string, prefix: string): boolean {
  return target === prefix || target.startsWith(`${prefix}.`)
}
