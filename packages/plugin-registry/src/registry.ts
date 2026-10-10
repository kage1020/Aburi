import type {
  EffectVocab,
  ExtKindVocab,
  FrameworkVocab,
  PluginManifest,
  Provides,
  VocabRegistry as VocabRegistryContract,
} from "@aburi/types"
import {
  deriveXPrefix,
  HINT_NAMESPACE,
  isReserved,
  isUnderPrefix,
  type PluginType,
  TYPE_NAMESPACE_RULES,
} from "./constants"
import { RegistryError, type RegistryErrorCode } from "./errors"

interface OwnedPrefix {
  prefix: string
  owner: PluginManifest
}

interface OwnedEffect {
  id: string
  description: string
  owner: PluginManifest
}

interface OwnedExtKind {
  id: string
  baseKind: import("@aburi/types").SymbolKind
  description: string
  owner: PluginManifest
}

function stableStringify(value: unknown, path = "$"): string {
  if (value === null) return "null"
  const t = typeof value
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(value)
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
    throw new RegistryError(
      `Plugin manifest contains a non-JSON value (${t}) at ${path}; only plain JSON ` +
        `(string/number/boolean/null, plain object, array) is supported.`,
      { code: "manifest-invalid", plugins: [] },
    )
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => stableStringify(v, `${path}[${i}]`)).join(",")}]`
  }
  const proto = Object.getPrototypeOf(value as object)
  if (proto !== Object.prototype && proto !== null) {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown"
    throw new RegistryError(
      `Plugin manifest contains a non-plain object (${ctor}) at ${path}; only plain JSON ` +
        `objects are supported.`,
      { code: "manifest-invalid", plugins: [] },
    )
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], `${path}.${k}`)}`)
  return `{${entries.join(",")}}`
}

const PROVIDES_ENTRIES = {
  effects: ["id", "description"],
  effectPrefixes: "string",
  extKinds: ["id", "baseKind", "description"],
  extKindPrefixes: "string",
  frameworks: "string",
  derivedByPrefixes: "string",
} as const satisfies Record<keyof Provides, readonly string[] | "string">

function describeType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function raise(
  message: string,
  code: RegistryErrorCode,
  plugins: readonly string[],
  value?: string,
): never {
  throw new RegistryError(
    message,
    value === undefined ? { code, plugins } : { code, plugins, value },
  )
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
    this.#assertProvidesShape(manifest)

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

    this.#validateReserved(manifest, granted)
    this.#validateTypeNamespaces(manifest)
    this.#validateXPrefix(manifest)
    this.#validateOwnDuplicates(manifest)
    this.#validateConflicts(manifest)

    // Commit.
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

  #assertProvidesShape(m: PluginManifest): void {
    if (typeof m.name !== "string") {
      raise(
        `Plugin manifest name must be a string (got ${describeType(m.name)}).`,
        "manifest-invalid",
        [],
      )
    }
    if (!m.provides || typeof m.provides !== "object") {
      raise(`Plugin "${m.name}" is missing the required \`provides\` object.`, "manifest-invalid", [
        m.name,
      ])
    }
    // Annotated rather than inferred, so a call narrows the way a call to `raise` does.
    const refuse: (at: string, expected: string, value: unknown) => never = (at, expected, value) =>
      raise(
        `Plugin "${m.name}" provides.${at} must be ${expected} (got ${describeType(value)}).`,
        "manifest-invalid",
        [m.name],
      )
    const provides = m.provides as unknown as Record<string, unknown>
    for (const [key, fields] of Object.entries(PROVIDES_ENTRIES)) {
      // Own keys only, as for `type`: an inherited array would walk past this gate.
      const value = Object.hasOwn(provides, key) ? provides[key] : undefined
      if (!Array.isArray(value)) refuse(key, "an array", value)
      for (const [i, entry] of (value as unknown[]).entries()) {
        if (fields === "string") {
          if (typeof entry !== "string") refuse(`${key}[${i}]`, "a string", entry)
          continue
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          refuse(`${key}[${i}]`, "an object", entry)
        }
        for (const field of fields) {
          const own = Object.hasOwn(entry, field)
            ? (entry as Record<string, unknown>)[field]
            : undefined
          if (typeof own !== "string") refuse(`${key}[${i}].${field}`, "a string", own)
        }
      }
    }
  }

  #validateTypeNamespaces(m: PluginManifest): void {
    // Own keys only: a hand-built manifest's `type: "toString"` would find the prototype's.
    if (!Object.hasOwn(TYPE_NAMESPACE_RULES, m.type)) {
      raise(`Plugin "${m.name}" has unknown type "${m.type}"`, "manifest-invalid", [m.name])
    }
    const rules = TYPE_NAMESPACE_RULES[m.type as PluginType]
    // Effects.
    if (
      !rules.canOwnEffects &&
      (m.provides.effects.length > 0 || m.provides.effectPrefixes.length > 0)
    ) {
      raise(
        `Plugin "${m.name}" (type ${m.type}) declares effects but only effects-type ` +
          `plugins may own x-* namespaces.`,
        "namespace-type-mismatch",
        [m.name],
      )
    }
    // Frameworks.
    if (!rules.canOwnFrameworks && m.provides.frameworks.length > 0) {
      raise(
        `Plugin "${m.name}" (type ${m.type}) declares frameworks but only framework-type ` +
          `plugins may own framework names.`,
        "namespace-type-mismatch",
        [m.name],
      )
    }
    // ExtKinds: each id / prefix must start with an allowed root.
    const allowedRoots = rules.allowedExtKindRoots
    const checkRoot = (value: string, kind: "extKind id" | "extKind prefix"): void => {
      if (allowedRoots.length === 0) {
        raise(
          `Plugin "${m.name}" (type ${m.type}) declares ${kind} "${value}" but cannot own any ` +
            `extKind namespace.`,
          "namespace-type-mismatch",
          [m.name],
          value,
        )
      }
      const ok = allowedRoots.some((r) => isUnderPrefix(value, r))
      if (!ok) {
        raise(
          `Plugin "${m.name}" (type ${m.type}) declares ${kind} "${value}" outside its allowed ` +
            `roots (${allowedRoots.join(", ")}).`,
          "namespace-type-mismatch",
          [m.name],
          value,
        )
      }
    }
    for (const ek of m.provides.extKinds) checkRoot(ek.id, "extKind id")
    for (const p of m.provides.extKindPrefixes) checkRoot(p, "extKind prefix")
  }

  #validateOwnDuplicates(m: PluginManifest): void {
    const checkOnce = (kind: string, entries: readonly { id: string }[]): void => {
      const seen = new Set<string>()
      for (const { id } of entries) {
        if (seen.has(id)) {
          raise(
            `${kind} "${id}" is declared twice by plugin "${m.name}".`,
            "duplicate-id",
            [m.name],
            id,
          )
        }
        seen.add(id)
      }
    }
    checkOnce("Effect id", m.provides.effects)
    checkOnce("extKind id", m.provides.extKinds)
    const checkNesting = (
      kind: string,
      prefixes: readonly string[],
      code: RegistryErrorCode,
    ): void => {
      for (const [i, later] of prefixes.entries()) {
        for (const earlier of prefixes.slice(0, i)) {
          if (earlier === later) continue
          if (isUnderPrefix(later, earlier) || isUnderPrefix(earlier, later)) {
            raise(
              `${kind} "${later}" overlaps with prefix "${earlier}", both declared by plugin ` +
                `"${m.name}".`,
              code,
              [m.name],
              later,
            )
          }
        }
      }
    }
    checkNesting("extKind prefix", m.provides.extKindPrefixes, "prefix-prefix-overlap")
    checkNesting("derivedBy prefix", m.provides.derivedByPrefixes, "derivedby-prefix-overlap")
  }

  #validateXPrefix(m: PluginManifest): void {
    if (m.type !== "effects") return
    const xPrefix = m.xPrefix ?? deriveXPrefix(m.name)
    const expectedRoot = `x-${xPrefix}`
    for (const eff of m.provides.effects) {
      if (!eff.id.startsWith(`${expectedRoot}:`)) {
        raise(
          `Plugin "${m.name}" declares effect id "${eff.id}" but xPrefix "${xPrefix}" requires ` +
            `the form "${expectedRoot}:<action>".`,
          "xprefix-mismatch",
          [m.name],
          eff.id,
        )
      }
    }
    for (const p of m.provides.effectPrefixes) {
      if (p !== expectedRoot) {
        raise(
          `Plugin "${m.name}" declares effectPrefix "${p}" but xPrefix "${xPrefix}" requires ` +
            `"${expectedRoot}" exactly.`,
          "xprefix-mismatch",
          [m.name],
          p,
        )
      }
    }
  }

  /** `granted` is a reserved namespace this registration may hold below, never at. */
  #validateReserved(m: PluginManifest, granted: string | null): void {
    const checkOne = (value: string, kind: string): void => {
      if (granted !== null && value !== granted && isUnderPrefix(value, granted)) return
      if (isReserved(value)) {
        raise(
          `Plugin "${m.name}" declares ${kind} "${value}" inside a reserved namespace ` +
            `(core / aburi / _ / framework:hint).`,
          "reserved-namespace",
          [m.name],
          value,
        )
      }
    }
    for (const eff of m.provides.effects) checkOne(eff.id, "effect id")
    for (const p of m.provides.effectPrefixes) checkOne(p, "effect prefix")
    for (const ek of m.provides.extKinds) checkOne(ek.id, "extKind id")
    for (const p of m.provides.extKindPrefixes) checkOne(p, "extKind prefix")
    for (const fw of m.provides.frameworks) checkOne(fw, "framework name")
    for (const p of m.provides.derivedByPrefixes) checkOne(p, "derivedBy prefix")
  }

  #validateConflicts(m: PluginManifest): void {
    // Effect ids: duplicate id + new prefix vs existing ids + existing prefix vs new ids.
    for (const eff of m.provides.effects) {
      const dup = this.#effects.get(eff.id)
      if (dup) {
        raise(
          `Effect id "${eff.id}" is already declared by plugin "${dup.owner.name}".`,
          "duplicate-id",
          [dup.owner.name, m.name],
          eff.id,
        )
      }
      for (const [prefix, info] of this.#effectPrefixes) {
        if (isUnderPrefix(eff.id, prefix)) {
          raise(
            `Effect id "${eff.id}" from plugin "${m.name}" is shadowed by existing prefix ` +
              `"${prefix}" owned by plugin "${info.owner.name}".`,
            "prefix-shadow-id",
            [info.owner.name, m.name],
            eff.id,
          )
        }
      }
    }
    for (const newPrefix of m.provides.effectPrefixes) {
      const dup = this.#effectPrefixes.get(newPrefix)
      if (dup) {
        raise(
          `Effect prefix "${newPrefix}" is already declared by plugin "${dup.owner.name}".`,
          "duplicate-prefix",
          [dup.owner.name, m.name],
          newPrefix,
        )
      }
      for (const [existing, info] of this.#effectPrefixes) {
        if (existing === newPrefix) continue
        if (isUnderPrefix(existing, newPrefix) || isUnderPrefix(newPrefix, existing)) {
          raise(
            `Effect prefix "${newPrefix}" (plugin "${m.name}") overlaps with existing prefix ` +
              `"${existing}" (plugin "${info.owner.name}").`,
            "prefix-prefix-overlap",
            [info.owner.name, m.name],
            newPrefix,
          )
        }
      }
      for (const [id, info] of this.#effects) {
        if (isUnderPrefix(id, newPrefix)) {
          raise(
            `New effect prefix "${newPrefix}" from plugin "${m.name}" would shadow existing ` +
              `effect id "${id}" owned by plugin "${info.owner.name}".`,
            "prefix-shadow-id",
            [info.owner.name, m.name],
            id,
          )
        }
      }
    }

    // ExtKinds: same pattern.
    for (const ek of m.provides.extKinds) {
      const dup = this.#extKinds.get(ek.id)
      if (dup) {
        raise(
          `extKind id "${ek.id}" is already declared by plugin "${dup.owner.name}".`,
          "duplicate-id",
          [dup.owner.name, m.name],
          ek.id,
        )
      }
      for (const [prefix, info] of this.#extKindPrefixes) {
        if (isUnderPrefix(ek.id, prefix)) {
          raise(
            `extKind id "${ek.id}" from plugin "${m.name}" is shadowed by existing prefix ` +
              `"${prefix}" owned by plugin "${info.owner.name}".`,
            "prefix-shadow-id",
            [info.owner.name, m.name],
            ek.id,
          )
        }
      }
    }
    for (const newPrefix of m.provides.extKindPrefixes) {
      const dup = this.#extKindPrefixes.get(newPrefix)
      if (dup) {
        raise(
          `extKind prefix "${newPrefix}" is already declared by plugin "${dup.owner.name}".`,
          "duplicate-prefix",
          [dup.owner.name, m.name],
          newPrefix,
        )
      }
      for (const [existing, info] of this.#extKindPrefixes) {
        if (existing === newPrefix) continue
        if (isUnderPrefix(existing, newPrefix) || isUnderPrefix(newPrefix, existing)) {
          raise(
            `extKind prefix "${newPrefix}" (plugin "${m.name}") overlaps with existing prefix ` +
              `"${existing}" (plugin "${info.owner.name}").`,
            "prefix-prefix-overlap",
            [info.owner.name, m.name],
            newPrefix,
          )
        }
      }
      for (const [id, info] of this.#extKinds) {
        if (isUnderPrefix(id, newPrefix)) {
          raise(
            `New extKind prefix "${newPrefix}" from plugin "${m.name}" would shadow existing ` +
              `extKind id "${id}" owned by plugin "${info.owner.name}".`,
            "prefix-shadow-id",
            [info.owner.name, m.name],
            id,
          )
        }
      }
    }

    // Frameworks: simple duplicate-name check.
    for (const fw of m.provides.frameworks) {
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

    // derivedByPrefixes: overlap detection.
    for (const newPrefix of m.provides.derivedByPrefixes) {
      const dup = this.#derivedByPrefixes.get(newPrefix)
      if (dup) {
        raise(
          `derivedBy prefix "${newPrefix}" is already declared by plugin "${dup.owner.name}".`,
          "duplicate-prefix",
          [dup.owner.name, m.name],
          newPrefix,
        )
      }
      for (const [existing, info] of this.#derivedByPrefixes) {
        if (existing === newPrefix) continue
        if (isUnderPrefix(existing, newPrefix) || isUnderPrefix(newPrefix, existing)) {
          raise(
            `derivedBy prefix "${newPrefix}" (plugin "${m.name}") overlaps with existing prefix ` +
              `"${existing}" (plugin "${info.owner.name}").`,
            "derivedby-prefix-overlap",
            [info.owner.name, m.name],
            newPrefix,
          )
        }
      }
    }
  }

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
    const owner = this.findEffect(id)
    if (!owner) {
      raise(
        `Effect id "${id}" is not declared by any registered plugin.`,
        "vocab-undeclared",
        [byPlugin],
        id,
      )
    }
    if (owner.owner.name !== byPlugin) {
      raise(
        `Effect id "${id}" is owned by plugin "${owner.owner.name}", not "${byPlugin}".`,
        "vocab-undeclared",
        [byPlugin, owner.owner.name],
        id,
      )
    }
  }

  assertExtKindDeclared(id: string, byPlugin: string): void {
    const owner = this.findExtKind(id)
    if (!owner) {
      raise(
        `extKind id "${id}" is not declared by any registered plugin.`,
        "vocab-undeclared",
        [byPlugin],
        id,
      )
    }
    if (owner.owner.name !== byPlugin) {
      raise(
        `extKind id "${id}" is owned by plugin "${owner.owner.name}", not "${byPlugin}".`,
        "vocab-undeclared",
        [byPlugin, owner.owner.name],
        id,
      )
    }
  }
}
