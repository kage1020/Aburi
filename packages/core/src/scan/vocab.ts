import type { Config, VocabRegistry } from "@aburi/types"
import { CoreError } from "../errors"
import { isCoreEffectId } from "../integrity"
import { describeThrown, errorCode } from "./faults"

/**
 * One value a plugin emitted that its manifest does not claim (`extension-vocab.md`). Recorded
 * only in a run that is not strict; a strict run ends at the first one instead.
 */
export interface UndeclaredVocabOccurrence {
  kind: "effect" | "extKind"
  value: string
  /** Manifest name of the plugin that emitted it. */
  plugin: string
  file: string
  /** The call's line for an effect; an extKind belongs to the Symbol, which has none here. */
  line: number | null
  symbol: string
}

/** Whether a run with this config refuses undeclared vocabulary: `strict` defaults to true (`config.md`). */
export function isStrict(config: Pick<Config, "strict">): boolean {
  return config.strict !== false
}

/**
 * The check each emitted effect id and extKind passes through. An effect id from the core
 * vocabulary is owned by no plugin, so it passes whoever emits it; anything else has to be
 * claimed by the emitting plugin itself, directly or through a prefix it owns, which is the
 * registry's `assert*Declared` to decide. A run that is not strict keeps what they refuse in
 * `occurrences` instead of ending.
 */
export class VocabCheck {
  readonly #registry: VocabRegistry
  readonly #strict: boolean
  readonly #occurrences: UndeclaredVocabOccurrence[] = []

  constructor(registry: VocabRegistry, strict: boolean) {
    this.#registry = registry
    this.#strict = strict
  }

  /** What a run that is not strict found, in emission order. Always empty in a strict one. */
  get occurrences(): readonly UndeclaredVocabOccurrence[] {
    return this.#occurrences
  }

  effect(occurrence: Omit<UndeclaredVocabOccurrence, "kind">): void {
    if (isCoreEffectId(occurrence.value)) return
    this.#check({ kind: "effect", ...occurrence }, () =>
      this.#registry.assertEffectDeclared(occurrence.value, occurrence.plugin),
    )
  }

  extKind(occurrence: Omit<UndeclaredVocabOccurrence, "kind">): void {
    this.#check({ kind: "extKind", ...occurrence }, () =>
      this.#registry.assertExtKindDeclared(occurrence.value, occurrence.plugin),
    )
  }

  #check(occurrence: UndeclaredVocabOccurrence, assertDeclared: () => void): void {
    try {
      assertDeclared()
    } catch (error) {
      if (errorCode(error) !== "vocab-undeclared") throw error
      if (!this.#strict) {
        this.#occurrences.push(occurrence)
        return
      }
      const where =
        occurrence.line === null ? occurrence.file : `${occurrence.file}:${occurrence.line}`
      throw new CoreError(
        `Plugin "${occurrence.plugin}" emitted ${occurrence.kind} "${occurrence.value}" at ${where}, ` +
          `which its manifest does not declare (${describeThrown(error)}). Declare it in the ` +
          "manifest's provides, or run with strict off (`aburi scan --discover`) to record it " +
          "instead.",
        { code: "vocab-undeclared", value: occurrence.value },
        { cause: error },
      )
    }
  }
}
