/**
 * What a failed filesystem call or a thrown plugin value means to the scan.
 *
 * Both stages of a scan read files — discovery `stat`s every candidate, the orchestrator
 * `readFile`s the ones that survived — and both have to answer the same two questions about
 * a failure: does it end the run, and what does the incident say. Answered separately they
 * drifted: a permission failure ended the run at the second stage and was recorded as a
 * skipped file at the first, so the same errno on the same machine produced either a fatal
 * error or a quietly smaller Document depending on which call happened to hit it.
 *
 * A module of its own rather than a section of `scan.ts`, because `scan.ts` imports
 * `discover.ts` and the answers are needed on both sides of that edge.
 */

/** The `code` a coded error carries, or `null` for a thrown value that has none. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

/**
 * True when a failed `stat` or `readFile` means the path is no longer a file.
 *
 * The only read failure a scan absorbs. A scan lists the workspace once and then works
 * through the listing, so anything editing the tree while it runs — a concurrent build, a
 * watch-mode clean, a branch switch — leaves a listed path pointing at nothing. That is a
 * property of the moment rather than of the workspace, and a re-run is the whole fix.
 *
 * Everything else — a permission the checkout got wrong, an exhausted descriptor table,
 * failing storage — is a property of the machine, and absorbing it would let one commit
 * produce a different Document on a different day and still exit `0`, which is the opposite
 * of what a byte-stable canonical document is for.
 *
 * Two codes, because the operating systems disagree about what to call one event. Replacing
 * a directory with a file mid-scan is answered `ENOTDIR` on POSIX and `ENOENT` on Windows;
 * holding only `ENOENT` would make the identical act fatal on one platform and benign on the
 * other.
 */
export function isVanishedFile(error: unknown): boolean {
  const code = errorCode(error)
  return code === "ENOENT" || code === "ENOTDIR"
}

/**
 * The message to record for a thrown value.
 *
 * A plugin is under no obligation to throw an `Error` — it is ordinary JavaScript loaded by
 * ref — so a thrown string, a plain object, or an `Error` nobody gave a message still has to
 * name itself in the incident list. An empty `detail` is the same silence the boundary
 * exists to replace, one step further in.
 *
 * So the guarantee is non-emptiness, and it is enforced on the result rather than inside the
 * chain: a value can reach the end of the chain and come back empty by more than one route —
 * `throw ""` most obviously, but also an object whose `toJSON` returns `undefined` and whose
 * `toString` returns `""` — and a reader who is told nothing cannot tell "the plugin said
 * nothing" from "nobody recorded anything". Naming the type is the least that distinguishes
 * them.
 */
export function describeThrown(error: unknown): string {
  const described = describeValue(error)
  return described.length > 0 ? described : `a thrown ${typeof error} described itself as empty`
}

/**
 * The description itself, which may be empty.
 *
 * Every fallback is guarded: `JSON.stringify` throws on a circular structure and on a BigInt,
 * and `String()` throws on a null-prototype object with no `toString`.
 */
function describeValue(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : safeString(error)
  if (typeof error !== "object" || error === null) return safeString(error)
  try {
    return JSON.stringify(error) ?? safeString(error)
  } catch {
    return safeString(error)
  }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    // A null-prototype object has no `toString`, and a Symbol refuses the conversion.
    // `Object.prototype.toString` works on both because it never consults the value.
    return Object.prototype.toString.call(value)
  }
}
