# MCP Server

The contract of `@aburi/mcp`: a [Model Context Protocol](https://modelcontextprotocol.io) server that
answers an AI coding agent's questions about a workspace — what a change did, what a component
exposes and which effects it reaches, what one Symbol is — from the runs of the `aburi` CLI it
makes.

See: [`cli-spec.md`](./cli-spec.md) §5 (`aburi scan`), §6 (`aburi diff`), §7 (`aburi explain`),
§9 (exit codes); [`slice-view.md`](./slice-view.md) (the clusters `diff` can narrow to)
Implementation: [`packages/mcp`](https://github.com/kage1020/Aburi/tree/main/packages/mcp)

---

## 1. Purpose

Without the server an agent that wants Aburi's facts runs the CLI, finds the output directory, and
parses the IR or the Markdown itself. The server puts those facts behind tools an agent can call by
name with typed arguments, so that the agent asks "what did this branch change" and gets the report
a reviewer would read.

It changes nothing about what Aburi is. The server holds no model and calls none: it returns what
the CLI computed, and the reading belongs to the agent. Nothing is added to the IR for it either —
no free-text field written for a model — since every byte of the IR is a fact the scan can
reproduce.

## 2. Running it

```
aburi-mcp [--cwd <path>] [--config <path>]
```

The server speaks MCP over stdio: requests on stdin, answers on stdout, one JSON-RPC message per
line. It serves the workspace of the directory it is started in, or of `--cwd`; `--config` is
passed to every run it makes, as `--config` is to the CLI ([`cli-spec.md`](./cli-spec.md) §13).
`--help` and `--version` print and exit `0`; any other argument exits `2` with the reason on
stderr. An agent is configured with the command, for instance:

```json
{ "mcpServers": { "aburi": { "command": "npx", "args": ["-y", "@aburi/mcp"] } } }
```

Rule MC-1: **each tool call is a run of the `aburi` CLI**, in a process of its own, started with
the server's working directory and environment. What the call answers is what that run wrote:
its stdout, its stderr, its exit code and the files it wrote. A plugin that writes to stdout, calls
`process.exit()` or leaks memory does so in that process, so it neither corrupts the protocol nor
outlives the call, and an answer is the CLI's own by construction, not a second rendering of the
same IR that could drift from it.

Rule MC-2: the CLI a run starts is **the workspace's own** `@aburi/cli`, the one that resolves from
the directory the server serves as `pnpm exec aburi` finds it, at the time of the run. Only where
none resolves does the server run the `@aburi/cli` it was installed with. A plugin `aburi.json`
names by package is imported from where the CLI is installed, so the workspace's CLI loads the
plugins the workspace installed, and a server fetched by `npx` answers about the workspace as
`aburi scan` there would. The CLI of its own loads only the plugins `aburi.json` names by path.

Rule MC-3: calls are run **one at a time**, in the order they arrive. Two `aburi diff` runs of one
repository at once would contend for its base worktree, and a scan already holds the machine's
processors ([`performance.md`](./performance.md)). A call the client cancels ends its run with
`SIGTERM`, which removes what it was building as an interrupted `aburi diff` does
([`cli-spec.md`](./cli-spec.md) §6.4 step 8), and with `SIGKILL` if it is still running five
seconds later, since a plugin can hold `SIGTERM`. The next call starts only once that run has
exited.

Rule MC-4: the server writes **only in a directory of its own** under the system's temporary
directory, never in the workspace: no `out/`, no `aburi.ir.json` an `aburi explain` would later
read. That directory is removed when the connection closes, and with it every scan the server
made; a scan that wrote no IR is removed at once.

## 3. Tools

| Tool | Input | Runs | Answers with |
|---|---|---|---|
| `scan` | — | `aburi scan --output-dir <a directory of its own>` | The run's stdout (the census lines, §5.5 of cli-spec), the id of the scan, and its Components' ids |
| `workspace` | `scan`? | A `scan`, when no `scan` is named | That scan's `workspace.md` |
| `component` | `id`, `scan`? | Likewise | That scan's `components/<id>.md`: the Component's public API, its Symbols and the effects they reach |
| `explain` | `target`, `scan`? | Likewise, then `aburi explain <target> --ir <that scan's IR>` | The run's stdout: the Symbol's, or the file's, Markdown, or the candidates an ambiguous `target` matches |
| `diff` | `refspec`, or `base` and `head`; `format`?, `failOn`?, `failOnScope`?, `maxBytes`?, `symbol`? | `aburi diff` with them and `--output-dir <a directory of its own> --format both` | `diff.md`, or `diff.json` under `format: "json"`, or the Slice holding `symbol` |

- `scan` names a scan an earlier call made, `scan-1` and so on in the order they were made, so
  that several questions are asked of one scan. Without it, `workspace`, `component` and `explain`
  scan first and answer from that scan, whose id their answer carries for the next call. A scan is
  never reused unasked: an agent edits the tree between calls, and a stale answer would read as a
  fresh one.
- `refspec` is `<base>..<head>` as `aburi diff` takes it. The head is scanned from the working
  tree, so `HEAD..HEAD` is what the uncommitted edits did.
- `base` and `head` are each a scan's id or the path of an IR file, so `diff` with `base: "scan-1"`
  and `head: "scan-2"` is what changed between two scans of the tree, committed or not.
- `failOn` is a list of `--fail-on` values ([`cli-spec.md`](./cli-spec.md) §6.7), `failOnScope` is
  `--fail-on-scope`, and `maxBytes` is `--max-bytes`, capping `diff.md`.
- `symbol` is a Symbol id. The answer is then JSON: the Slice whose members hold it
  ([`slice-view.md`](./slice-view.md)) and the change of each member, from `diff.json`.

Every answer carries, beside its text, a structured result with the run's exit code and its stderr,
and the `scan` it read when there is one. The stderr is the second text block of the answer when
it is not empty, headed `aburi <command> wrote on stderr (exit <code>):`, since what a scan warns about — a
file it withdrew, a value it could not classify — qualifies the answer.

Rule MC-5: a call **fails** (`isError`) when its run wrote no answer: `scan` wrote no IR, `diff`
wrote no `diff.json`, `explain` printed nothing. The text is then the run's stderr, which says why,
and the exit code is the CLI's (§9 of cli-spec). A run that answered and also exited non-zero
answers: a scan that withdrew a file (`3`), a `diff` whose `failOn` tripped (`3`), an `explain`
with several candidates (`2`). A `scan`, a `component` or a `symbol` the call names that does not
exist fails too, listing the ones that do.

## 4. Verifiable Properties

| ID | Input | Expected |
|---|---|---|
| MC1 | `tools/list` | The five tools of §3, each with an input and an output schema |
| MC2 | `scan` over a TypeScript workspace, then `workspace` and `component` naming that scan | The census lines of `aburi scan` over the same tree; `workspace.md` and every `components/<id>.md` that run writes, byte for byte |
| MC3 | `explain` of a full Symbol id, of a file, and of a pattern several Symbols match | The stdout of `aburi explain <target> --ir <the scan's IR>`, with exit `0`, `0` and `2`; a `target` nothing matches fails with `No matches` |
| MC4 | `workspace`, `component` or `explain` naming no scan, twice | Each scans afresh and says which scan it read, `scan-1` then `scan-2` |
| MC5 | `diff` with `refspec: "HEAD..HEAD"` over an uncommitted edit, as Markdown and as JSON | `diff.md` and `diff.json` of `aburi diff HEAD..HEAD`; nothing written in the workspace |
| MC6 | `diff` with `base` and `head` naming two scans, before and after an edit | The report of `aburi diff --base <first IR> --head <second IR>` |
| MC7 | `diff` with a `failOn` that trips | Not a failure: the report, exit `3`, and the tripped clause on stderr |
| MC8 | `diff` with `symbol` naming a changed Symbol, and one naming no changed Symbol | The Slice holding it and its members' changes; the second fails, naming the Symbol |
| MC9 | `component` or `scan` naming one that does not exist | Fails, listing the ids that do |
| MC10 | A workspace whose language plugin cannot be loaded | `scan` fails with the CLI's message and exit `3` |
| MC11 | Two `diff` calls sent at once | Both answered, with the same report |
| MC12 | `aburi-mcp` over stdio, then stdin closed | The tools listed and a `scan` answered; the process exits and its directory is gone |
| MC13 | `aburi-mcp --bogus` | exit 2, the argument named on stderr |
| MC14 | A `scan` the client cancels while a plugin that holds `SIGTERM` is loading, then another call | The run's process has exited before the next call is answered, and the cancelled scan is given no id |
| MC15 | A workspace whose `node_modules` holds an `@aburi/cli` | Every run starts that CLI |

## 5. Design Decisions

### 5.1 Why a package of its own, not `aburi mcp`

The protocol SDK and its schema library would ride along with every `@aburi/cli` install, the
GitHub Action's included, to serve a use most installs never have. A package that depends on the
CLI keeps the CLI's dependencies what they are, and its version is the CLI's it was released with.

### 5.2 Why a process per call, not the CLI's functions in the server

The CLI's functions would answer faster by the cost of starting Node, a fraction of a second against
the seconds of a scan. In exchange the server would share its process with every plugin the
workspace loads: a `console.log` in a plugin would write into the protocol stream, a
`process.exit()` would end the server, and module state a plugin keeps would carry from one call
to the next where the CLI starts clean. A process per call also makes every answer the CLI's own
output rather than a second rendering of it.

### 5.3 Why every question scans, unless it names a scan

An IR on disk says nothing of the edits made since it was written, and an agent is the one making
them. Answering from the newest scan the server made would be as stale. A scan the call names is
reused, because then the agent chose it; one it does not name is made, because then the agent
asked about the tree.

### 5.4 Why the workspace's CLI before the server's own

A bare plugin name in `aburi.json` is imported by the CLI from its own install location, so the
CLI decides which plugins a scan can load. The workspace's CLI was installed beside the workspace's
plugins and is the one its CI runs; the server's own, fetched by `npx` into a cache of its own,
reaches none of them. Running the workspace's also keeps an answer the same as the `aburi scan` a
reviewer runs there, at the version the workspace pinned.

### 5.5 Why stdio only

The server answers about the files of the machine it runs on, for the agent that started it.
A network transport would add a listener, and the authentication it then needs, to serve a client
that is already its parent process.
