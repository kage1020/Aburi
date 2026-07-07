---
"@aburi/github-action": minor
---

Add `@aburi/github-action` — a composite GitHub Action that runs `aburi diff` on a
pull request and upserts the resulting Markdown as a hidden-marker PR comment.

### Runtime shape

- **Composite action** (`action.yml`). Consumers reference it via
  `uses: kage1020/Aburi/packages/github-action@<tag>`. The `@aburi/cli` binary is
  resolved through `pnpm dlx @aburi/cli@<version>`, so the CLI version is pinned by the
  workflow author rather than the action tag — a policy that lets us ship CLI patches
  without cutting a new action release.
- **Steps**: input validation (`comment: true` requires markdown output) →
  refspec resolution (input `refspec` overrides; otherwise fall back to
  `pull_request.base.sha..pull_request.head.sha`) → `pnpm/action-setup` +
  `actions/setup-node` → `pnpm dlx @aburi/cli@<version> diff …` → comment upsert via
  `actions/github-script@v7` → CLI exit-code propagation.
- **Exit-code propagation**: the diff step captures the CLI's status without failing
  the step so the comment upsert still runs; a trailing step then re-exits with the
  captured code, so a triggered `--fail-on` gate fails the PR check *and* leaves the
  Markdown comment on the PR for the reviewer.

### Comment upsert (`src/comment.ts`)

- Marker: `<!-- aburi:diff-comment -->` prepended to the body when absent. The marker
  is the sole coordination point; the action pages through PR comments and updates the
  first match rather than posting a fresh comment on every push.
- Idempotency: when the existing comment body already matches byte-for-byte, the
  action returns `unchanged` and skips the PATCH request, keeping notification traffic
  quiet on no-op re-runs.
- Error surfacing: every non-2xx response from the GitHub REST API throws with the
  operation label, status code, and a 400-char response snippet — a token scope typo
  is loud rather than silent-drop-then-green.
- Injectable `fetch` and `apiBase` so the same helper works against GitHub Enterprise
  Server (`https://ghe.example.com/api/v3`) and is fully unit-testable without touching
  the real network. `buildApiUrl` normalises the base so an ES mount path is preserved
  (a naïve `new URL(absolute, base)` would silently drop it).

### Public API

`upsertPullRequestComment`, `ensureMarker`, `ABURI_COMMENT_MARKER`, and the option /
outcome types are re-exported from `@aburi/github-action` for callers who want to post
Aburi-style diff comments programmatically without invoking the composite action.

### Inputs / outputs

Inputs: `version` (default `latest`), `refspec`, `fail-on`, `config`, `output-dir`
(default `out`), `format` (default `both`), `working-directory`, `comment`
(default `true`), `token` (default `${{ github.token }}`), `node-version`
(default `24`), `pnpm-version` (default `10`). Outputs: `diff-json-path`,
`diff-md-path`, `cli-exit-code`, `comment-id`, `comment-action` (`created` /
`updated` / `unchanged`).

### Tests

20 tests across `test/{comment,action-yml}.test.ts` cover the upsert primitive
(create / update / unchanged / pagination / GitHub error surfacing / bearer token
delivery / GHES base URL / non-array response rejection) and the composite manifest
(required inputs and defaults, `pnpm dlx` command shape, comment step guarded by
`inputs.comment == 'true'`, marker string parity between YAML and TypeScript, exit-code
propagation, output declarations, refspec fallback rejecting non-PR events, and
`comment=true + format=json` input validation).
