import type { PluginManifest } from "@aburi/types"
import {
  deriveXPrefix,
  isReserved,
  isUnderPrefix,
  type PluginType,
  TYPE_NAMESPACE_RULES,
} from "./constants"
import { type RegistryErrorCode, raise } from "./errors"

/**
 * The rules a manifest meets or breaks on its own, whatever else is registered. `granted` is a
 * reserved namespace this registration may hold below, never at.
 */
export function validateManifestRules(m: PluginManifest, granted: string | null): void {
  validateReserved(m, granted)
  validateTypeNamespaces(m)
  validateXPrefix(m)
  validateOwnDuplicates(m)
}

function validateReserved(m: PluginManifest, granted: string | null): void {
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

function validateTypeNamespaces(m: PluginManifest): void {
  // Own keys only: a hand-built manifest's `type: "toString"` would find the prototype's.
  if (!Object.hasOwn(TYPE_NAMESPACE_RULES, m.type)) {
    raise(`Plugin "${m.name}" has unknown type "${m.type}"`, "manifest-invalid", [m.name])
  }
  const rules = TYPE_NAMESPACE_RULES[m.type as PluginType]
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
  if (!rules.canOwnFrameworks && m.provides.frameworks.length > 0) {
    raise(
      `Plugin "${m.name}" (type ${m.type}) declares frameworks but only framework-type ` +
        `plugins may own framework names.`,
      "namespace-type-mismatch",
      [m.name],
    )
  }
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
    if (!allowedRoots.some((r) => isUnderPrefix(value, r))) {
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

function validateXPrefix(m: PluginManifest): void {
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

function validateOwnDuplicates(m: PluginManifest): void {
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
        // An exact repeat gives no lookup two owners; the schema's `uniqueItems` refuses it.
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
