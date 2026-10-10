import type {
  EffectVocab,
  ExtKindVocab,
  FrameworkVocab,
  PluginManifest,
  SymbolKind,
  VocabRegistry as VocabRegistryContract,
} from "@aburi/types"
import { HINT_NAMESPACE, isUnderPrefix } from "./constants"
import { type RegistryErrorCode, raise } from "./errors"
import { validateManifestRules } from "./manifest-rules"
import { assertProvidesShape } from "./provides-shape"
import { stableStringify } from "./stable-stringify"

interface Owned {
  owner: PluginManifest
}

interface OwnedPrefix extends Owned {
  prefix: string
}

interface OwnedEffect extends Owned {
  id: string
  description: string
}

interface OwnedExtKind extends Owned {
  id: string
  baseKind: SymbolKind
  description: string
}

/** How a conflict message names one vocabulary, at the start of a sentence and inside one. */
interface VocabLabel {
  readonly title: string
  readonly inline: string
}

const EFFECT: VocabLabel = { title: "Effect", inline: "effect" }
const EXT_KIND: VocabLabel = { title: "extKind", inline: "extKind" }
const DERIVED_BY: VocabLabel = { title: "derivedBy", inline: "derivedBy" }

function refuseTakenIds(
  label: VocabLabel,
  m: PluginManifest,
  ids: readonly string[],
  owned: ReadonlyMap<string, Owned>,
  prefixes: ReadonlyMap<string, OwnedPrefix>,
): void {
  for (const id of ids) {
    const dup = owned.get(id)
    if (dup) {
      raise(
        `${label.title} id "${id}" is already declared by plugin "${dup.owner.name}".`,
        "duplicate-id",
        [dup.owner.name, m.name],
        id,
      )
    }
    for (const [prefix, info] of prefixes) {
      if (isUnderPrefix(id, prefix)) {
        raise(
          `${label.title} id "${id}" from plugin "${m.name}" is shadowed by existing prefix ` +
            `"${prefix}" owned by plugin "${info.owner.name}".`,
          "prefix-shadow-id",
          [info.owner.name, m.name],
          id,
        )
      }
    }
  }
}

function refuseTakenPrefixes(
  label: VocabLabel,
  m: PluginManifest,
  newPrefixes: readonly string[],
  prefixes: ReadonlyMap<string, OwnedPrefix>,
  overlap: RegistryErrorCode,
  ids: ReadonlyMap<string, Owned> = new Map(),
): void {
  for (const newPrefix of newPrefixes) {
    const dup = prefixes.get(newPrefix)
    if (dup) {
      raise(
        `${label.title} prefix "${newPrefix}" is already declared by plugin "${dup.owner.name}".`,
        "duplicate-prefix",
        [dup.owner.name, m.name],
        newPrefix,
      )
    }
    for (const [existing, info] of prefixes) {
      if (isUnderPrefix(existing, newPrefix) || isUnderPrefix(newPrefix, existing)) {
        raise(
          `${label.title} prefix "${newPrefix}" (plugin "${m.name}") overlaps with existing ` +
            `prefix "${existing}" (plugin "${info.owner.name}").`,
          overlap,
          [info.owner.name, m.name],
          newPrefix,
        )
      }
    }
    for (const [id, info] of ids) {
      if (isUnderPrefix(id, newPrefix)) {
        raise(
          `New ${label.inline} prefix "${newPrefix}" from plugin "${m.name}" would shadow ` +
            `existing ${label.inline} id "${id}" owned by plugin "${info.owner.name}".`,
          "prefix-shadow-id",
          [info.owner.name, m.name],
          id,
        )
      }
    }
  }
}

export class VocabRegistry implements VocabRegistryContract {
  readonly #pluginsByName = new Map<string, PluginManifest>()
  readonly #pluginsStable = new Map<string, string>()
  readonly #effects = new Map<string, OwnedEffect>()
  readonly #effectPrefixes = new Map<string, OwnedPrefix>()
  readonly #extKinds = new Map<string, OwnedExtKind>()
  readonly #extKindPrefixes = new Map<string, OwnedPrefix>()
  readonly #frameworks = new Map<string, FrameworkVocab>()
  readonly #derivedByPrefixes = new Map<string, OwnedPrefix>()

  register(manifest: PluginManifest): void {
    this.#register(manifest, null)
  }

  registerHint(manifest: PluginManifest): void {
    this.#register(manifest, HINT_NAMESPACE)
  }

  #register(manifest: PluginManifest, granted: string | null): void {
    assertProvidesShape(manifest)

    const serialized = stableStringify(manifest)
    const existingStable = this.#pluginsStable.get(manifest.name)
    if (existingStable !== undefined) {
      if (existingStable === serialized) return
      raise(
        `Plugin "${manifest.name}" is already registered with a different manifest. ` +
          `Idempotent re-register requires identical contents.`,
        "name-collision",
        [manifest.name],
      )
    }

    validateManifestRules(manifest, granted)
    this.#validateConflicts(manifest)

    this.#pluginsByName.set(manifest.name, manifest)
    this.#pluginsStable.set(manifest.name, serialized)
    for (const eff of manifest.provides.effects) {
      this.#effects.set(eff.id, { id: eff.id, description: eff.description, owner: manifest })
    }
    for (const p of manifest.provides.effectPrefixes) {
      this.#effectPrefixes.set(p, { prefix: p, owner: manifest })
    }
    for (const ek of manifest.provides.extKinds) {
      this.#extKinds.set(ek.id, {
        id: ek.id,
        baseKind: ek.baseKind,
        description: ek.description,
        owner: manifest,
      })
    }
    for (const p of manifest.provides.extKindPrefixes) {
      this.#extKindPrefixes.set(p, { prefix: p, owner: manifest })
    }
    for (const fw of manifest.provides.frameworks) {
      this.#frameworks.set(fw, { name: fw, owner: manifest })
    }
    for (const p of manifest.provides.derivedByPrefixes) {
      this.#derivedByPrefixes.set(p, { prefix: p, owner: manifest })
    }
  }

  #validateConflicts(m: PluginManifest): void {
    const { provides } = m
    refuseTakenIds(
      EFFECT,
      m,
      provides.effects.map((e) => e.id),
      this.#effects,
      this.#effectPrefixes,
    )
    refuseTakenPrefixes(
      EFFECT,
      m,
      provides.effectPrefixes,
      this.#effectPrefixes,
      "prefix-prefix-overlap",
      this.#effects,
    )
    refuseTakenIds(
      EXT_KIND,
      m,
      provides.extKinds.map((e) => e.id),
      this.#extKinds,
      this.#extKindPrefixes,
    )
    refuseTakenPrefixes(
      EXT_KIND,
      m,
      provides.extKindPrefixes,
      this.#extKindPrefixes,
      "prefix-prefix-overlap",
      this.#extKinds,
    )
    for (const fw of provides.frameworks) {
      const dup = this.#frameworks.get(fw)
      if (dup) {
        raise(
          `Framework "${fw}" is already declared by plugin "${dup.owner.name}".`,
          "duplicate-id",
          [dup.owner.name, m.name],
          fw,
        )
      }
    }
    refuseTakenPrefixes(
      DERIVED_BY,
      m,
      provides.derivedByPrefixes,
      this.#derivedByPrefixes,
      "derivedby-prefix-overlap",
    )
  }

  /** `code` names the `register` check that should have kept a second match out. */
  #uniquePrefixOwner(
    id: string,
    prefixes: Map<string, OwnedPrefix>,
    code: RegistryErrorCode,
  ): OwnedPrefix | null {
    let match: OwnedPrefix | null = null
    for (const info of prefixes.values()) {
      if (!isUnderPrefix(id, info.prefix)) continue
      if (match !== null) {
        raise(
          `Internal invariant violation: id "${id}" matches both prefix "${match.prefix}" ` +
            `(plugin "${match.owner.name}") and "${info.prefix}" (plugin "${info.owner.name}"). ` +
            `register() should have rejected the second prefix as ${code}.`,
          code,
          [match.owner.name, info.owner.name],
          id,
        )
      }
      match = info
    }
    return match
  }

  findEffect(id: string): EffectVocab | null {
    const direct = this.#effects.get(id)
    if (direct) {
      return { id: direct.id, description: direct.description, owner: direct.owner }
    }
    const prefixOwner = this.#uniquePrefixOwner(id, this.#effectPrefixes, "prefix-prefix-overlap")
    if (prefixOwner) {
      return { id, description: null, owner: prefixOwner.owner }
    }
    return null
  }

  findExtKind(id: string): ExtKindVocab | null {
    const direct = this.#extKinds.get(id)
    if (direct) {
      return {
        id: direct.id,
        baseKind: direct.baseKind,
        description: direct.description,
        owner: direct.owner,
      }
    }
    const prefixOwner = this.#uniquePrefixOwner(id, this.#extKindPrefixes, "prefix-prefix-overlap")
    if (prefixOwner) {
      return { id, baseKind: null, description: null, owner: prefixOwner.owner }
    }
    return null
  }

  findFramework(name: string): FrameworkVocab | null {
    return this.#frameworks.get(name) ?? null
  }

  findDerivedByOwner(value: string): PluginManifest | null {
    return (
      this.#uniquePrefixOwner(value, this.#derivedByPrefixes, "derivedby-prefix-overlap")?.owner ??
      null
    )
  }

  isEffectOwnedBy(id: string, pluginName: string): boolean {
    return this.findEffect(id)?.owner.name === pluginName
  }

  isExtKindOwnedBy(id: string, pluginName: string): boolean {
    return this.findExtKind(id)?.owner.name === pluginName
  }

  listEffects(): EffectVocab[] {
    return [...this.#effects.values()].map((e) => ({
      id: e.id,
      description: e.description,
      owner: e.owner,
    }))
  }

  listExtKinds(): ExtKindVocab[] {
    return [...this.#extKinds.values()].map((e) => ({
      id: e.id,
      baseKind: e.baseKind,
      description: e.description,
      owner: e.owner,
    }))
  }

  listFrameworks(): FrameworkVocab[] {
    return [...this.#frameworks.values()]
  }

  listPlugins(): PluginManifest[] {
    return [...this.#pluginsByName.values()]
  }

  assertEffectDeclared(id: string, byPlugin: string): void {
    this.#assertDeclared(EFFECT, id, byPlugin, this.findEffect(id))
  }

  assertExtKindDeclared(id: string, byPlugin: string): void {
    this.#assertDeclared(EXT_KIND, id, byPlugin, this.findExtKind(id))
  }

  #assertDeclared(label: VocabLabel, id: string, byPlugin: string, found: Owned | null): void {
    if (!found) {
      raise(
        `${label.title} id "${id}" is not declared by any registered plugin.`,
        "vocab-undeclared",
        [byPlugin],
        id,
      )
    }
    if (found.owner.name !== byPlugin) {
      raise(
        `${label.title} id "${id}" is owned by plugin "${found.owner.name}", not "${byPlugin}".`,
        "vocab-undeclared",
        [byPlugin, found.owner.name],
        id,
      )
    }
  }
}
