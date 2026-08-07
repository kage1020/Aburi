import type { CallCandidate } from "@aburi/types"

/**
 * Core standard callee prefixes that are dropped from Category C per drop-list.md
 * §5.1. Every entry is a dot-terminated identifier prefix — `console.log`,
 * `console.info`, etc. all match `console.` and never reach `Symbol.calls[]` or
 * `Symbol.effects[]`.
 */
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
  /** `config.suppress[]` — user-added identifier prefixes to drop. */
  suppress?: readonly string[]
  /** `EffectPlugin.dropCallees[]` — logger plugins can add themselves here. */
  pluginDropCallees?: readonly string[]
  /** `config.keep[]` — identifier prefixes that escape drop. Wins over everything. */
  keep?: readonly string[]
}

/**
 * Compile a reusable predicate that answers "should this callee be dropped from
 * effects / calls per Category C?". The compiled form is a set of prefix strings — no
 * regex — because drop rules are all exact identifier chains and the identifier chain
 * has already been normalized by the language plugin.
 *
 * Precedence follows drop-list.md §6.2: `keep` wins over `suppress` and both wins
 * over the core / plugin drop sets. Consumers only need one probe per call.
 */
export function buildDropCFilter(input: DropCFilterInput = {}): DropCFilter {
  return new DropCFilter(
    CORE_DROP_PREFIXES,
    input.pluginDropCallees ?? [],
    input.suppress ?? [],
    input.keep ?? [],
  )
}

function toNfc(value: string): string {
  return value.normalize("NFC")
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
    // Decorator names in `keep[]` use `@Name` syntax per drop-list.md §6.2. Strip the
    // `@` for prefix comparison — a decorator can't reach here anyway (this is
    // call-level) so the strip is defensive against consumers mixing the two syntaxes.
    //
    // Both lists are put into Unicode NFC because the `target` they are matched against is
    // (ir-schema.md §1.2). These arrive from a JSON config and a plugin manifest, neither of
    // which normalizes, so without this a `suppress` entry could fail to match the call it
    // names — and a dropped call leaves nothing in the Document to trace the miss back from.
    this.#dropPrefixes = [...core, ...pluginDropCallees, ...suppress].map(toNfc)
    this.#keepPrefixes = keep.map((k) => toNfc(k.startsWith("@") ? k.slice(1) : k))
  }

  /** True when the call's `target` should be dropped from effects / calls. */
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

/**
 * A prefix matches when the target either equals the prefix, ends at a member break
 * (`prefix + "."`), or the prefix itself ended at a break. Bare `console` matches
 * `console.log` but not `consoleWrap.method` — the identifier boundary is honored.
 */
function isPrefixMatch(target: string, prefix: string): boolean {
  if (target === prefix) return true
  if (target.startsWith(`${prefix}.`)) return true
  return false
}
