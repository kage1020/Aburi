import type { VocabRegistry } from "@aburi/types"
import { CoreError } from "../errors"
import { isCoreEffectId } from "../integrity"

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

/**
 * The check each emitted effect id and extKind passes through. An effect id from the core
 * vocabulary is owned by no plugin, so it passes whoever emits it; anything else has to be
 * claimed by the emitting plugin itself, directly or through a prefix it owns.
 */
export class VocabCheck {
  readonly #registry: VocabRegistry
  readonly #strict: boolean
  readonly #sink: UndeclaredVocabOccurrence[]

  constructor(registry: VocabRegistry, strict: boolean, sink: UndeclaredVocabOccurrence[]) {
    this.#registry = registry
    this.#strict = strict
    this.#sink = sink
  }

  effect(occurrence: Omit<UndeclaredVocabOccurrence, "kind">): void {
    if (isCoreEffectId(occurrence.value)) return
    if (this.#registry.isEffectOwnedBy(occurrence.value, occurrence.plugin)) return
    this.#undeclared({ kind: "effect", ...occurrence })
  }

  extKind(occurrence: Omit<UndeclaredVocabOccurrence, "kind">): void {
    if (this.#registry.isExtKindOwnedBy(occurrence.value, occurrence.plugin)) return
    this.#undeclared({ kind: "extKind", ...occurrence })
  }

  #undeclared(occurrence: UndeclaredVocabOccurrence): void {
    if (!this.#strict) {
      this.#sink.push(occurrence)
      return
    }
    const where =
      occurrence.line === null ? occurrence.file : `${occurrence.file}:${occurrence.line}`
    throw new CoreError(
      `Plugin "${occurrence.plugin}" emitted ${occurrence.kind} "${occurrence.value}" at ${where}, ` +
        "which its manifest does not declare. Declare it in the manifest's provides, or run " +
        "with strict off (`aburi scan --discover`) to record it instead.",
      { code: "vocab-undeclared", value: occurrence.value },
    )
  }
}
