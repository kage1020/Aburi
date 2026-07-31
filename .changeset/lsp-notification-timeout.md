---
"@aburi/core": patch
---

Bound the LSP client's notification writes so a clogged pipe cannot park the
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
  A failure is now logged at debug level instead of being swallowed whole; it
  cannot change what the file produced, so it is never escalated. A pipe stuck
  for good takes the next file's `didOpen` with it, and the existing
  five-consecutive-files escalation disables the language from there.
- `initialized` is bounded by `initializeTimeoutMs`, and a write that never
  lands now fails `initialize` rather than returning a handshake that never
  completed.
- `exit` is bounded by the 1 s shutdown grace period that `shutdown` already
  used for its request and its SIGKILL timer, now a single named constant.

`LspClient.didOpen` / `didClose` take a `timeoutMs` argument — matching
`request(method, params, timeoutMs)` — and return `LspFailure | undefined`
instead of `void`, so a stalled or rejected write is reported through the same
sentinel every other client method already uses rather than by throwing. Timing
counters are untouched: a notification is not a request, so `requestsIssued` /
`requestsTimedOut` / `requestsFailed` keep their meaning and a timed-out
`didOpen` surfaces as `filesFellBack`.

`EnrichmentInput.now` is finally read. It has always been declared as the
injectable clock and the pass called `Date.now()` directly anyway; the per-file
budget now goes through it, which is what lets the new budget test spend the
budget exactly rather than sleeping for it.

`docs/design/lsp-enrichment.md` gains the notification bounds in §4.4, states in
§6.1 that a `didOpen` that exceeds its bound is a per-file fallback, and adds
test criteria LE19–LE21.
