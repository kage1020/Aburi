# @aburi/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that answers an AI coding
agent's questions about a workspace: what a change did, what a component exposes and which
effects it reaches, what one Symbol is. Every answer is the output of a run of the `aburi` CLI,
byte for byte, so the agent reads the report a reviewer reads.

The server holds no model and calls none. It speaks MCP over stdio.

## Install

Install it beside the CLI and the plugins your `aburi.json` names:

```bash
pnpm add -D @aburi/mcp @aburi/cli @aburi/lang-typescript
```

Then point the agent at it. For Claude Code:

```bash
claude mcp add aburi -- pnpm exec aburi-mcp
```

For a client configured with JSON:

```json
{ "mcpServers": { "aburi": { "command": "npx", "args": ["-y", "@aburi/mcp"] } } }
```

Each run starts the `@aburi/cli` the workspace installed, resolved from the directory the server
serves, because a plugin `aburi.json` names by package (`lang-typescript`) is loaded from where the
CLI is installed. So `npx -y @aburi/mcp` in a workspace with `@aburi/cli` installed answers as
`aburi scan` there would. In a workspace with none, the server runs the CLI it was installed with,
which loads only the plugins `aburi.json` names by path.

```
aburi-mcp [--cwd <path>] [--config <path>]
```

`--cwd` names the workspace (default: the current directory); `--config` is passed to every run,
as `aburi --config` takes it.

## Tools

| Tool | Input | Answers with |
|---|---|---|
| `scan` | — | The census lines of `aburi scan`, the scan's id (`scan-1`, …) and its Components' ids |
| `workspace` | `scan`? | That scan's `workspace.md` |
| `component` | `id`, `scan`? | That scan's `components/<id>.md`: the Component's public API, its Symbols and the effects they reach |
| `explain` | `target`, `scan`? | `aburi explain <target>` over that scan: a Symbol, every Symbol of a file, or the candidates a name matches |
| `diff` | `refspec`, or `base` and `head`; `format`?, `failOn`?, `failOnScope`?, `maxBytes`?, `symbol`? | `diff.md`, `diff.json` under `format: "json"`, or the Slice holding `symbol` with its members' changes |

- `workspace`, `component` and `explain` scan the working tree first unless `scan` names an
  earlier scan, since the agent is the one editing the tree between calls.
- `refspec` is `<base>..<head>`. The head is read from the working tree, so `HEAD..HEAD` is what
  the uncommitted edits did.
- `base` and `head` each take a scan's id or the path of an `aburi.ir.json`, so
  `{ base: "scan-1", head: "scan-2" }` is what changed between two scans, committed or not.

Every answer also carries a structured result: the text, and each run's arguments, exit code and
stderr. What a run wrote on stderr is the answer's second text block, since a scan's warnings
qualify what it answered. A call fails (`isError`) when its run wrote no answer, with the run's
stderr as the reason, or when it names a scan, a Component or a Symbol that does not exist.

Calls run one at a time. A cancelled call ends its run, and the server writes only in a directory
of its own under the system's temporary directory, removed when the connection closes. Nothing is
written in the workspace.

## See also

- [`docs/design/mcp-server.md`](../../docs/design/mcp-server.md) — the contract.
- [`@aburi/cli`](../cli) — the commands each tool runs.
