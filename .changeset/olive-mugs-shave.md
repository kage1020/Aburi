---
"@aburi/github-action": patch
---

Stop documenting an expression the runner tries to evaluate

The `refspec` input's description quoted the fallback it documents —
`${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}` — as prose.
The runner parses a manifest's descriptions as templates, with a context set that has no `github`
in it, so loading the action failed before its first step ran:

```
action.yml (Line: 19, Col: 18): Unrecognized named-value: 'github'.
Located at position 1 within expression: github.event.pull_request.base.sha
```

Every consumer of the action got that, whatever their inputs: the manifest never loaded. The
description now names those context paths as plain text, and a test asserts that no description
holds a `${{ … }}` and that no input `default` does either, apart from the `${{ github.token }}`
every action uses — defaults are template-evaluated in the same way, so the next instance of this
outage would otherwise be one `default:` away. Nothing else catches it: the manifest is parsed by
the runner rather than by anything that runs in CI.

While there: the description also said the fallback applies on `pull_request`, where the step has
always accepted `pull_request_target` too.
