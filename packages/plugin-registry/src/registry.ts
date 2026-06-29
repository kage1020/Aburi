import type {
  EffectVocab,
  ExtKindVocab,
  FrameworkVocab,
  PluginManifest,
  VocabRegistry as VocabRegistryContract,
} from "@aburi/types"
import {
  deriveXPrefix,
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

/**
 * Stable JSON serialization for manifest equality (idempotent `register`). Keys are
 * sorted deeply so logically-identical manifests round-trip to identical strings.
 *
 * `register` accepts any object typed `PluginManifest` — TS cannot guarantee the
 * caller actually went through `parsePluginManifest`. A naive `JSON.stringify` would
 * silently coerce `Date` / class instances / `Map` / `undefined` / functions into
 * lossy forms, making two non-equal manifests look identical and short-circuiting
 * the `name-collision` guard. Reject those values explicitly so the failure mode
 * is loud rather than a silent no-op re-register.
 */
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
  // Reject non-plain objects (Date, Map, Set, RegExp, class instances, …). Their
  // structural shape would either crash the recursion or serialise as `{}`.
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

/**
 * Concrete VocabRegistry. Each `register` call validates the manifest in isolation
 * (type-namespace rules, reserved-namespace, xPrefix consistency), then validates
 * against the current registry state (id / prefix / framework conflicts, prefix
 * shadowing, prefix-prefix overlap). All checks pass before any mutation so a
 * failing register leaves the registry untouched.
 */
export class VocabRegistry implements VocabRegistryContract {
  readonly #pluginsByName = new Map<string, PluginManifest>()
  readonly #pluginsStable = new Map<string, string>()
  readonly #effects = new Map<string, OwnedEffect>()
  readonly #effectPrefixes = new Map<string, OwnedPrefix>()
  readonly #extKinds = new Map<string, OwnedExtKind>()
  readonly #extKindPrefixes = new Map<string, OwnedPrefix>()
  readonly #frameworks = new Map<string, FrameworkVocab>()
  readonly #derivedByPrefixes = new Map<string, OwnedPrefix>()

  /**
   * Validate and register a plugin manifest. Idempotent: re-registering the same
   * (name, content) is a no-op. Re-registering a name with different content
   * throws `name-collision`.
   */
  register(manifest: PluginManifest): void {
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

    // Reserved-namespace check runs first because it is the strongest invariant
    // (no plugin may ever own those names, regardless of type). Type-namespace and
    // xPrefix checks are plugin-class concerns that come second.
    this.#validateReserved(manifest)
    this.#validateTypeNamespaces(manifest)
    this.#validateXPrefix(manifest)
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

  // ---------- Validations ----------

  /**
   * Pre-flight: the schema requires every provides.* array, but `register` accepts
   * any value typed PluginManifest at runtime (e.g. a hand-built object skipping
   * `loadPluginManifest`). Without this check, a missing array would `TypeError`
   * inside the commit loop after validation has already mutated nothing yet —
   * still safe atomicity-wise, but the error message would be `Cannot read
   * properties of undefined (reading 'length')`. Surface a coded error instead.
   */
  #assertProvidesShape(m: PluginManifest): void {
    if (!m.provides || typeof m.provides !== "object") {
      raise(`Plugin "${m.name}" is missing the required \`provides\` object.`, "manifest-invalid", [
        m.name,
      ])
    }
    const required = [
      "effects",
      "effectPrefixes",
      "extKinds",
      "extKindPrefixes",
      "frameworks",
      "derivedByPrefixes",
    ] as const
    const provides = m.provides as unknown as Record<string, unknown>
    for (const key of required) {
      const value = provides[key]
      if (!Array.isArray(value)) {
        raise(
          `Plugin "${m.name}" provides.${key} must be an array (got ${typeof value}).`,
          "manifest-invalid",
          [m.name],
        )
      }
    }
  }

  #validateTypeNamespaces(m: PluginManifest): void {
    const rules = TYPE_NAMESPACE_RULES[m.type as PluginType]
    if (!rules) {
      raise(`Plugin "${m.name}" has unknown type "${m.type}"`, "manifest-invalid", [m.name])
    }
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

  #validateReserved(m: PluginManifest): void {
    const checkOne = (value: string, kind: string): void => {
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

  // ---------- Query API ----------

  /**
   * Returns the single prefix in `prefixes` that owns `id`, or `null` if none does.
   * Throws an invariant error if more than one prefix matches — that would mean
   * conflict detection let an overlap slip through and the registry's view of
   * ownership is no longer well-defined.
   */
  #uniquePrefixOwner(id: string, prefixes: Map<string, OwnedPrefix>): OwnedPrefix | null {
    let match: OwnedPrefix | null = null
    for (const info of prefixes.values()) {
      if (!isUnderPrefix(id, info.prefix)) continue
      if (match !== null) {
        raise(
          `Internal invariant violation: id "${id}" matches both prefix "${match.prefix}" ` +
            `(plugin "${match.owner.name}") and "${info.prefix}" (plugin "${info.owner.name}"). ` +
            `register() should have rejected the second prefix as prefix-prefix-overlap.`,
          "prefix-prefix-overlap",
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
    const prefixOwner = this.#uniquePrefixOwner(id, this.#effectPrefixes)
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
    const prefixOwner = this.#uniquePrefixOwner(id, this.#extKindPrefixes)
    if (prefixOwner) {
      return { id, baseKind: null, description: null, owner: prefixOwner.owner }
    }
    return null
  }

  findFramework(name: string): FrameworkVocab | null {
    return this.#frameworks.get(name) ?? null
  }

  findDerivedByOwner(value: string): PluginManifest | null {
    return this.#uniquePrefixOwner(value, this.#derivedByPrefixes)?.owner ?? null
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
