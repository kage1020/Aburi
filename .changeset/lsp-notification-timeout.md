---
"@aburi/core": minor
"@aburi/cli": patch
---

Bound every LSP write so a stalled pipe or a dead server cannot park the
enrichment pass.

`createLspClient` raced every request against a deadline but awaited its four
notifications — `didOpen`, `didClose`, `initialized`, `exit` — unguarded.
JSON-RPC treats a notification as fire-and-forget, but the write still awaits the
transport, so backpressure on a stdio pipe stalls it exactly the way it stalls a
request. `didOpen` was the load-bearing case: it precedes the file's first
request and therefore precedes every `fileBudgetMs` check the pass makes, so a
stalled open meant the per-file budget could never fire and the scan sat on that
one file indefinitely.

Notifications now reuse the budgets the caller already has rather than adding a
knob of their own — `schema/aburi.config.v1.json` and the generated config types
are unchanged, and no new threshold had to be guessed at:

- `didOpen` is bounded by `fileBudgetMs`. An open that spends the whole budget
  has left nothing for the enrichment it exists to enable, so the budget is
  already the right ceiling; exceeding it is an ordinary per-file fallback. The
  pass also re-checks the budget immediately after `didOpen` returns, so an open
  that came back healthy but slow no longer gets to issue a `documentSymbol`
  request the budget cannot pay for.
- `didClose` is bounded by `requestTimeoutMs` — a single small write with no
  enrichment riding on it, where giving up sooner starts the next file sooner.
  A failure is logged at debug level instead of being swallowed whole; it cannot
  change what the file produced, so it moves no counter and escalates nothing.
- `initialized` is bounded by `initializeTimeoutMs`, and a write that never
  lands now fails `initialize` rather than returning a handshake that never
  completed. It draws the full budget rather than the request's remainder, so a
  wholly unresponsive server can cost two `initializeTimeoutMs` before its
  language is disabled — 20 s at the default, where it was 10 s.
- `exit` is bounded by the 1 s shutdown grace period that `shutdown` already
  used for its request and its SIGKILL timer, now a single named constant.

Writes addressed to a server already known to have exited fail immediately with
`server-disconnected`, notifications included. Previously only `request` did
this: `didOpen` returned quietly, so after a server crash every remaining file
was opened against a dead pipe, failed its single `documentSymbol` request
(one short of the three needed to escalate), and was counted in `filesEnriched`
with nothing enriched in it. Because the per-file streak reset on each such
file, the language was never disabled and the CLI — which warns only on
`filesFellBack > 0` or a disabled language — printed nothing at all. A crash
mid-scan now falls back per file and disables the language after five, which is
what makes the degraded run visible.

`LspClient.didOpen` / `didClose` take a `timeoutMs` argument — matching
`request(method, params, timeoutMs)` — and return `LspFailure | null` instead of
`void`. `null` rather than `undefined` is what makes the contract enforceable:
an implementation cannot claim a write succeeded by falling off the end of a
function, which is precisely the bug fixed above. Timing counters are untouched:
a notification is not a request, so `requestsIssued` / `requestsTimedOut` /
`requestsFailed` keep their meaning and a failed `didOpen` surfaces as
`filesFellBack`.

Two unbounded waits one layer down are closed with the same reasoning.
`SpawnedServer.killAfter` awaited the child's exit with no deadline, so a
process wedged in uninterruptible I/O — which does not answer SIGKILL either —
pinned `shutdown` forever; it now returns after at most two grace periods
whether or not the child was reaped. And `EnrichmentInput.now`, declared as the
injectable clock but never actually read, is now what the per-file budget goes
through, defaulting to `performance.now`: the budget measures elapsed time, and
a wall clock stepped backwards by NTP would make it unable to fire, reopening
the hang from another door.

`@aburi/cli` reads `ABURI_LOG_LEVEL`. It was parsed into `AburiEnv.logLevel` and
then dropped, while the scan logger hard-coded `debug` and `info` to no-ops —
so a debug line was unreachable in the shipped binary no matter what the user
set. Default output is unchanged (`warn` and above); `ABURI_LOG_LEVEL=debug` now
reaches the passes that emit at that level, the degraded-`didClose` line among
them.

`docs/design/lsp-enrichment.md` gains the notification bounds in §4.4, states in
§6.1 that a `didOpen` which exceeds its bound or addresses a dead server is a
per-file fallback (and names `filesFellBack`, replacing a reference to an
`lsp-degraded` marker that never existed in the code), and adds test criteria
LE19–LE23.
