import {
  assertNonEmptySegments,
  hasLiteralFirstArgument,
  type PluginInputOrigin,
} from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"
import { hasPrismaImport } from "./imports"
import { isPrismaReadMethod, isPrismaTransactionMethod, isPrismaWriteMethod } from "./methods"
import {
  classificationConfidence,
  PRISMA_DELEGATE_MAX_ARGUMENTS,
  PRISMA_TRANSACTION_MAX_ARGUMENTS,
} from "./receivers"

/**
 * Classify a CallCandidate against Prisma Client conventions.
 *
 * Recognition strategy:
 *   1. The owning file must import a Prisma Client module (see `hasPrismaImport`). No
 *      import → `null`, so callers can chain other effect plugins after this one.
 *   2. The target is split on `.`; the plugin looks at the trailing segments to match
 *      Prisma's fixed client surface. Two shapes are accepted:
 *        - `<...>.<model>.<verb>` (3+ segments) — a model delegate call. The client
 *          segment stops two-segment method collisions (Express `router.create(...)`)
 *          from false-classifying.
 *        - `<...>.$transaction` (2+ segments) — the top-level transaction API on the
 *          client itself.
 *   3. A literal first argument rules the call out — no Prisma method takes one — and the
 *      receiver and the argument count decide the tier (`classificationConfidence`).
 *   4. Malformed targets (empty string, adjacent / leading / trailing dots) throw — the
 *      language plugin's contract is a normalized non-empty callee, so a violation
 *      here is an upstream bug we surface loudly instead of silently miscategorizing.
 *
 * **The import gate is not a receiver check.** It answers "does this file use Prisma",
 * which a file is free to answer yes to while most of its calls belong to something else:
 * `this.cache.items.delete(key)` is a `Map`, `session.user.update(fields)` is an object,
 * and both have three segments and a delegate verb. Step 3 is what keeps those from being
 * recorded as `db.write` at the tier a hand-annotated effect gets — a claim that
 * would then propagate through the call graph and into the diff. Where the receiver names
 * the client, the classification still lands at `high`; where it does not, the effect is
 * still emitted but at `medium`, because a syntactic classifier cannot tell a client under
 * a house naming convention apart from an unrelated object of the same shape, and silently
 * dropping the first is as wrong as confidently claiming the second.
 *
 * The function is a pure lookup — no I/O, no state, no async — matching the per-call
 * timeout budget the core enforces (effect-plugin.md §5.1.1).
 */
export function classifyPrismaCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_PRISMA_PLUGIN_NAME, filePath: ctx.file.path }

  // Fail-fast runs BEFORE the import gate — see `assertNonEmptySegments` for why the
  // order is load-bearing.
  const { segments: parts, last: method } = assertNonEmptySegments(call.target, origin)

  if (!hasPrismaImport(ctx.file.imports, ctx.file.path)) return null

  if (isPrismaTransactionMethod(method)) {
    // Bare `$transaction()` (single segment) is not a Prisma call — the transaction
    // API only makes sense as a method on the client (`<client>.$transaction(...)`).
    if (parts.length < 2) return null
    // `$transaction` is a `$`-prefixed name Prisma owns outright, so the receiver is the
    // main thing left to weigh. Its own arity is wider than a delegate's: the callback
    // form takes a second options argument (`$transaction(fn, { timeout })`).
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.transaction",
      confidence: classificationConfidence(parts.at(-2), call, PRISMA_TRANSACTION_MAX_ARGUMENTS),
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:tx`,
    }
  }

  // Model delegate calls need `<client>.<model>.<verb>` to distinguish them from
  // unrelated two-segment method calls (Express `router.create(...)`, an Array's
  // hypothetical `.findMany` collision) that would otherwise false-positive in files
  // that colocate Prisma with another library.
  if (parts.length < 3) return null

  // A delegate method takes an options object or nothing, so a literal first argument
  // (`this.cache.items.delete("session")`, `map.delete("id")`) is some other API's call.
  if (hasLiteralFirstArgument(call)) return null

  // The client sits immediately before the model, whatever precedes it: `prisma.user.create`,
  // `this.prisma.user.create` and `container.services.prisma.user.create` all put it at -3.
  const confidence = classificationConfidence(parts.at(-3), call, PRISMA_DELEGATE_MAX_ARGUMENTS)

  if (isPrismaReadMethod(method)) {
    return {
      effectId: "db.read",
      confidence,
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:read`,
    }
  }

  if (isPrismaWriteMethod(method)) {
    return {
      effectId: "db.write",
      confidence,
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:write`,
    }
  }

  return null
}
