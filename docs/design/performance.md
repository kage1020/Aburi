# Parallel Parsing Architecture

This document specifies how `aburi scan` uses a worker pool to reach the roadmap performance target — parse a >1000-file TypeScript project in under 30 seconds on a 4-core CI runner — while producing byte-identical IR to a single-threaded reference run. It refines, but does not replace, the concurrency defaults already stated in [cli-spec.md](./cli-spec.md) §14 and the WASM lifecycle rules in [lang-plugin.md](./lang-plugin.md) §8.1. No IR schema change, no new CLI flag, no new config field.

## References:

- [cli-spec.md](./cli-spec.md) §10 — progress reporting.
- [cli-spec.md](./cli-spec.md) §12 — CI mode.
- [cli-spec.md](./cli-spec.md) §14 — the existing concurrency defaults and per-worker heap cap.
- [lang-plugin.md](./lang-plugin.md) §4.3 — the `Symbol` and `SymbolCandidate` shape returned from `parseFile`.
- [lang-plugin.md](./lang-plugin.md) §8 — parser implementation options table.
- [lang-plugin.md](./lang-plugin.md) §8.1 — WASM memory-management rules that this document refines.
- [overview.md](./overview.md) §2 — parser layer decision (tree-sitter core + optional LSP).
- [overview.md](./overview.md) §4 — the extraction pipeline this document parallelizes.
- [lsp-enrichment.md](./lsp-enrichment.md) §5 — LSP-level concurrency (a separate axis).
- [call-resolution.md](./call-resolution.md) CR24 — the byte-identical-output invariant style this document adopts.
- [ir-schema.md](./ir-schema.md) §3 — canonical sort order for `symbols[]` and `dependencies[]`.
- [roadmap.md](../roadmap.md) — Later: >1000 files in 30 s target.

---

## 1. Purpose

`aburi scan` today runs single-threaded. On a 4-core CI runner, a >1000-file TypeScript monorepo takes long enough that Aburi becomes uncomfortable to keep in the PR loop. The roadmap sets a concrete target: >1000 files in 30 seconds on 4 cores / 8 GiB. This document specifies the worker pool architecture that meets that target while preserving four invariants:

1. **Byte-identical output**: `aburi scan --concurrency 1` and `aburi scan --concurrency N` produce identical IR JSON bytes for the same input, for any `N` the runtime picks.
2. **Failure isolation**: a worker crash on one file does not lose results from the others.
3. **Memory safety**: the WASM heap budget is bounded per worker and pool size is clamped by available memory.
4. **The single-threaded path is the reference implementation**: correctness debugging always has a deterministic linear execution to fall back to.

## 2. Reference project shape

The roadmap target is measured against a specific benchmark corpus so CI can regress against it. Any change to the corpus is a documented event.

| Attribute | Value |
| --- | --- |
| File count | 1,200 TypeScript files (`.ts` + `.tsx`) |
| Avg tokens per file | 800 |
| Component count | 8 (avg 150 files/component, skew ratio ~3×) |
| Framework mix | NestJS controllers (30%), React components (30%), plain modules (40%) |
| LSP available | No (parse-only benchmark; LSP enrichment is a separate phase per §10) |
| Runner | 4 vCPU, 8 GiB RAM, cold disk cache |
| Wall time SLA | ≤ 30 s |
| Peak RSS SLA | ≤ 2 GiB |

The corpus itself is stored under `benchmarks/perf-1k/` (added in a follow-up PR that also adds the CI job). The corpus is generated deterministically from templates so its structure is reproducible without vendoring 1,200 files.

## 3. Worker model — decision

| Option | Adopted | Rejected, and why |
| --- | --- | --- |
| Node `worker_threads` pool | ✔︎ | — |
| `child_process` fork pool |  | IPC uses stdout/stderr streams; serializing 1,200 files' worth of `SymbolCandidate[]` back through pipes adds measurable overhead vs. `postMessage` structured clone. Also loses the ability to share `ArrayBuffer` transferable regions if a future optimization needs it. |
| Single-threaded `Promise.all` |  | Tree-sitter parsing is CPU-bound synchronous work inside a single WASM instance. `Promise.all` yields no parallelism — all promises resolve on the same event loop. |
| Native `libuv` thread-pool via a native binding |  | Requires a native binding per platform; conflicts with the "npm install works everywhere" property. Reserved for the future via `capabilities.preferNative` (lang-plugin §8.1). |

Rule PF-1: the pool is Node `worker_threads`, one WASM parser instance per worker, workers long-lived for the duration of the scan.

Rule PF-2: pool size = `min(--concurrency, floor(availableMemoryMB / maxWasmHeapPerWorkerMB))` where the numerator defaults to `max(1, CPU_count - 1)` from [cli-spec.md](./cli-spec.md) §14. When multiple language plugins are loaded, `maxWasmHeapPerWorkerMB` = max of each plugin's declared `capabilities.wasmHeapPerWorkerMB` (also cli-spec §14).

## 4. Work partitioning

Rule PF-3: shards are file-level, not component-level. Component-level shards were considered and rejected: components skew (in the reference corpus, the largest component is 3× the median), and a component-level shard would idle N-1 workers for the duration of the largest component.

Rule PF-4: shard assignment is deterministic. For each discovered file `f`, the assigned worker index is `stable_hash(f.posix_path) mod pool_size`. Determinism at assignment time is a defense-in-depth measure; §7 also guarantees determinism at merge time, so scheduling order does not affect output.

Rule PF-5: component detection ([component-detect.md](./component-detect.md)) runs **before** the pool starts. It is fast (single-threaded, small memory footprint) and its output determines which files each worker sees. The pool is never asked to detect components.

Rule PF-6: drop-list state ([drop-list.md](./drop-list.md)) is computed once on the main thread and passed by structured clone to each worker at spawn time. It is immutable across the scan.

## 5. Serialization boundary

The `postMessage` boundary determines which values may cross between workers and the main thread. Getting this wrong causes both correctness bugs (dangling WASM node handles) and performance regressions (serializing 100 KB per file × 1,200 files).

### 5.1 Main → worker

For each file the worker receives a message shaped:

```ts
interface ParseRequest {
  fileId: number;              // 0-based, dense, assigned at enumeration time
  path: string;                // workspace-relative POSIX
  language: string;            // <language> token — routes to the correct lang plugin inside the worker
}
```

No source text crosses the boundary. The worker reads the file from disk itself. Rationale: the main thread already enumerated the file list (needs the paths); reading the source there too would double the FS I/O.

### 5.2 Worker → main

For each parsed file the worker returns a message shaped:

```ts
interface ParseResponse {
  fileId: number;
  outcome: "ok" | "skipped";
  symbols?: Symbol[];          // fully-normalized per lang-plugin §4.3
  error?: string;              // present iff outcome === "skipped"
  parseMs: number;             // for progress and telemetry
}
```

Rule PF-7: `Symbol[]` returned from a worker MUST be the fully-normalized shape defined in [lang-plugin.md](./lang-plugin.md) §4.3. It MUST NOT contain a `bodyNode`, `fullNode`, or any other handle into WASM memory. Rationale: those handles are pointers into the parser's `Parser`-owned heap; they lose meaning the moment they cross the structured-clone boundary because structured clone deep-copies data but not pointer semantics. A test enforces this by asserting `JSON.stringify(response)` succeeds for every response.

Rule PF-8: `Symbol.calls[].resolved` is left as string-form callee references on the worker side. Call resolution ([call-resolution.md](./call-resolution.md)) runs on the main thread **after** all workers drain, because it needs the union of all symbols. Effect propagation and fingerprint computation follow, also main-thread.

## 6. Backpressure and memory

### 6.1 Concurrency default

Unchanged from [cli-spec.md](./cli-spec.md) §14: default `--concurrency = max(1, CPU_count - 1)`. Clamped by the memory rule (PF-2).

### 6.2 WASM heap cap per worker

Each worker is spawned with `resourceLimits: { maxOldGenerationSizeMb: <cap> }` where `<cap>` is the language plugin's declared `capabilities.wasmHeapPerWorkerMB` (default 256 MiB per [cli-spec.md](./cli-spec.md) §14). Exceeding the cap crashes the worker, which the failure-isolation rule (§8) handles.

### 6.3 Bounded queue

The main thread dispatches at most `2 × pool_size` pending files at any moment. When the queue is full, the enumerator awaits a completion before dispatching the next file. Rationale: an unbounded queue would let the enumerator race ahead and hold 1,200 `ParseRequest` objects in memory even though only 4 are actively being parsed. Bounded queues also give the pool a natural back-pressure signal that keeps peak RSS predictable.

### 6.4 Parser lifecycle

The plugin-side rule from [lang-plugin.md](./lang-plugin.md) §8.1 stands: `parseFile()` creates a fresh `Parser`, calls `parser.delete()` after obtaining the result, releases `tree` via `tree.delete()`, and confines node references to `parseFile()`'s scope. This document does NOT change that rule — the plugin API surface is unchanged by the worker pool.

Rule PF-9 (worker follows plugin lifecycle): each worker invokes the plugin's `parseFile()` per file, which owns the parser lifecycle end-to-end per [lang-plugin.md](./lang-plugin.md) §8.1. No parser handle is retained across `parseFile()` calls. Rationale: reusing a parser across files would require a new API surface between the worker runtime and the plugin (parser injection), which is a change to `lang-plugin.md` §4 out of scope for this document. Parser-construction cost is real (5–15 ms per file on the reference corpus) but sits within the 30 s budget with headroom given file count and per-file work.

Rule PF-10 (parser-reuse is a future optimization): a future refinement of `lang-plugin.md` MAY introduce a `capabilities.parserInjection: true` opt-in through which the worker runtime supplies a long-lived parser. When and if that lands, this document will be revised to specify the injection contract. Until then the per-file lifecycle above is the only supported shape.

## 7. Determinism / canonical merge

The byte-identical output invariant is the strongest correctness property this document specifies. It is what lets users trust the pool and what lets CI compare `aburi scan --concurrency 1` output to `--concurrency 4` output without a special diff mode.

### 7.1 Invariant

Rule PF-11 (byte-identical output): for any input, `aburi scan --concurrency 1` and `aburi scan --concurrency N` produce IR JSON with identical SHA-256 for every `N` ∈ [1, poolSizeMax]. This holds regardless of file arrival order, worker scheduling, disk cache warmth, or GC timing.

### 7.2 Merge algorithm

1. Each worker returns `Symbol[]` for each file, tagged with its `fileId`.
2. The main thread accumulates results into a dense array indexed by `fileId`. Order of arrival is irrelevant; the slot is fixed.
3. When all files complete (or are skipped), the main thread flattens the array in `fileId` order.
4. The flattened array is sorted by `Symbol.id` lexicographically (matches [ir-schema.md](./ir-schema.md) §3 canonical order).
5. Call resolution runs on the sorted array (order-independent by construction).
6. `dependencies[]` are sorted by `(from, to, via)` lexicographically.
7. JSON serialization uses stable key order (alphabetical within each object) — same as the current single-threaded implementation.

Rule PF-12: no step above depends on wall-clock time, PID, worker index, or random values. Any implementation that reads any of these is a bug.

### 7.3 Forbidden non-determinism sources

The following are banned inside worker code and inside main-thread merge code:

- `Date.now()`, `performance.now()` values in output. (`parseMs` in `ParseResponse` is telemetry, not IR; it is not part of the JSON.)
- `Math.random()`.
- Worker index in any output field. (Only in log lines under `[worker:i]`, which are stderr and not part of IR.)
- Iteration order over `Map` / `Set` objects populated by workers, unless subsequently sorted.

Rule PF-13: a lint rule and a test enforce these bans. The test computes SHA-256 of IR JSON at `N ∈ {1, 2, 4, 8}` on the reference corpus and asserts all four hashes are equal.

## 8. Failure isolation

Rule PF-14: if a worker throws or crashes while parsing file F, the following happens in order:

1. The worker's `error` event fires on the main thread.
2. The main thread logs `[worker:i] parse failed <F>: <error message>` to stderr.
3. The main thread marks F as `outcome: "skipped"` in the result buffer.
4. The main thread respawns the worker and resumes dispatching queued files to it. No previously-completed results are lost.

Rule PF-15: after 3 respawns of the same worker slot within one scan, the pool aborts with exit code 2 and an error message naming the last three failed files. Rationale: a repeated crash indicates a systemic issue (heap exhaustion under a specific file shape, a plugin bug) that will not resolve by continuing.

Rule PF-16: skipped files appear in the scan summary (see [cli-spec.md](./cli-spec.md) §10) and their `fileId` slots in the merge array are empty. The final IR simply does not contain Symbols for those files; downstream (call resolution, effect propagation) sees this as "the file has no exported symbols", which is already a valid input.

## 9. Progress reporting integration

Progress reporting rules from [cli-spec.md](./cli-spec.md) §10 and §12 are unchanged. This document specifies only how worker events feed the progress reporter:

- Each worker emits `{event: "parsed", fileId, parseMs}` on completion.
- The main thread aggregates counts and elapsed time, updates the progress line at the current cadence (spec §10).
- Skipped files count against the total but are called out in the summary.
- Under `CI=true` ([cli-spec.md](./cli-spec.md) §12), the progress animation is silenced; the summary still prints once at the end.

## 10. LSP enrichment interaction

LSP enrichment ([lsp-enrichment.md](./lsp-enrichment.md)) runs as a **separate phase** from parsing. The pipeline is:

```
enumerate → detect components → parse phase (worker pool)
                                     ↓
                               drain to main
                                     ↓
                              call resolution
                                     ↓
                              effect propagation
                                     ↓
                              LSP enrichment (if enabled)
                                     ↓
                                fingerprint
                                     ↓
                                serialize IR
```

Rule PF-17: no LSP call is made from inside a worker. LSP concurrency is bounded by `lsp.servers.<lang>.concurrency` ([lsp-enrichment.md](./lsp-enrichment.md) §5, default 8) — a separate axis from parse concurrency, so a project may parse at concurrency 4 while enriching at concurrency 8 without contention.

Rationale for the phase split:

- LSP servers are typically single-instance-per-workspace; multiplexing them across workers adds no throughput and increases queue contention on the LSP side.
- Parse output is a stable input for LSP enrichment; running them in the same phase would require a partial-parse state machine on the LSP side.
- Keeping enrichment on the main thread means enrichment can consult the union of all symbols (needed for `this`/`super` resolution across sibling files).

## 11. Fallback: single-thread mode

Rule PF-18: `--concurrency 1` bypasses the worker pool entirely. `parseFile` is called inline on the main thread, in `fileId` order. No worker spawn, no `postMessage`, no queue. This mode is the reference implementation for correctness debugging: any parity failure between `--concurrency 1` and `--concurrency N` output is a pool bug, not an extraction bug.

Rule PF-19: `--concurrency 1` output MUST be identical to a hypothetical `--concurrency 1` running inside a worker (same code path modulo the worker envelope). The lint rule from §7.3 forbids the pool from taking any code path that the single-thread mode cannot also take.

## 12. Native binding fallback

Reserved for the future via `capabilities.preferNative` in the language plugin manifest ([lang-plugin.md](./lang-plugin.md) §8.1). When a plugin declares native support and the runtime detects a compatible platform, that plugin's workers MAY use a native tree-sitter binding instead of the WASM one. The choice is per-plugin per-run; it does not change the worker pool's shape, serialization boundary, or determinism rules — only the parser instance behind each worker.

Rule PF-20: when a native binding is in use, `capabilities.wasmHeapPerWorkerMB` still bounds pool sizing (the memory rule PF-2), because pool sizing needs a conservative upper bound regardless of which parser variant is active.

## 13. Verifiable Properties

| ID | Input | Expected |
| --- | --- | --- |
| PF1 | Reference corpus (§2), `--concurrency 4`, cold cache, 4-core runner | Wall time ≤ 30 s; peak RSS ≤ 2 GiB. **Pending corpus PR** — verifiable once `benchmarks/perf-1k/` lands (§2). |
| PF2 | Reference corpus, `--concurrency N` for N ∈ {1, 2, 4, 8} | SHA-256 of IR JSON identical across all N |
| PF3 | Any input, worker returns a `ParseResponse` containing a `bodyNode` | Structured-clone throws (or a test lint fails); pool aborts with diagnostic |
| PF4 | Worker throws while parsing one file | That file marked skipped; other workers unaffected; main thread respawns worker |
| PF5 | 3 successive crashes on the same worker slot | Scan aborts with exit code 2; last 3 failed files listed in error |
| PF6 | `--concurrency 1` and `--concurrency 4` on same input | `parseFile` code path exercised is identical (single-thread mode does not diverge) |
| PF7 | Pool size clamped by available memory | On a runner reporting 4 GiB `availableMemoryMB` with 512 MiB `wasmHeapPerWorkerMB` declared, and `--concurrency 8` requested → pool size = `min(8, floor(4096 / 512)) = 8`. On 2 GiB available → `min(8, floor(2048 / 512)) = 4`. Note: `availableMemoryMB` is the free memory reported by the runtime (already net of OS overhead), not the runner's nominal RAM. |
| PF8 | Enumerator produces 1,200 files, pool size = 4 | Queue depth never exceeds 8 (2 × pool_size) at any moment |
| PF9 | `Date.now()` referenced inside worker parse loop or main-thread merge | Lint failure at CI |
| PF10 | `Math.random()` referenced inside pool code | Lint failure at CI |
| PF11 | LSP enabled | Parse phase completes fully before LSP phase starts; no worker calls LSP |
| PF12 | Two lang plugins declare `wasmHeapPerWorkerMB` = 256 and 512 | Pool sizing uses 512 as the denominator |
| PF13 | Plugin `parseFile()` implementation retains a node handle after `tree.delete()` (a plugin bug, not a runtime failure) | Plugin conformance tests SHOULD detect this via lang-plugin's own test harness (see [lang-plugin.md](./lang-plugin.md) §9); the pool itself makes no additional check. Listed here for completeness — this is a plugin-side invariant. |
| PF14 | Under `CI=true` | Progress animation silenced; final summary still prints |

## 14. Design Decisions

### 14.1 Why `worker_threads` over `child_process`

Structured-clone `postMessage` is faster than piped stdout for the ~50 KB `SymbolCandidate[]` payload per file, and it exposes `Transferable` if a future optimization needs zero-copy passing of `ArrayBuffer`. `child_process` also incurs a Node startup penalty per worker (~40 ms) that `worker_threads` avoids.

### 14.2 Why file-level shards instead of component-level

Component sizes skew heavily in real monorepos. A component-level shard leaves N-1 workers idle for the tail of the largest component. File-level shards give each worker a stream of similarly-sized work units, and the deterministic hash assignment (PF-4) plus the merge algorithm (§7.2) preserve byte-identical output.

### 14.3 Why parser reuse is deferred, not adopted here

An earlier draft of this document adopted parser reuse across files inside one worker (parser constructed once at worker startup, `parser.delete()` at shutdown) as an optimization. On review the trade-off was inverted: parser reuse requires a new API surface between the worker runtime and the plugin (parser injection), which would silently change [lang-plugin.md](./lang-plugin.md) §8.1's per-file lifecycle rule. Two design docs disagreeing about `Parser`'s lifetime is a worse outcome than 5–15 ms per file of construction cost. If the parse budget later proves tight, the fix is a `lang-plugin.md` refinement (`capabilities.parserInjection` opt-in), not a silent override in `performance.md`.

### 14.4 Why single-thread mode remains the reference implementation

Byte-identical determinism is only useful if the check has a definite ground truth. `--concurrency 1` is that ground truth. It also gives users a debugging escape hatch: any behavior only reproducible under the pool is by definition a pool bug, and it can be reproduced by rerunning under `--concurrency 1` and diffing.

### 14.5 Why LSP is a separate phase

LSP servers are typically single-instance-per-workspace and stateful. Multiplexing them from N parse workers would add queue-contention on the LSP side without adding throughput. Running enrichment after parse also means the enricher sees the complete symbol universe, which it needs for cross-file `this`/`super` resolution.

### 14.6 Why the queue is bounded

An unbounded queue defeats one of the point of workers: peak-memory predictability. With a bounded queue, at most `2 × pool_size` `ParseRequest` objects live in memory at once, regardless of input size. This is what lets §2's ≤ 2 GiB peak RSS SLA hold on a 1,200-file input.
