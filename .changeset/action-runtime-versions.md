---
"@aburi/github-action": patch
---

The composite action installs pnpm and Node with `pnpm/action-setup@v6` and `actions/setup-node@v7`, the versions this repository's own workflows use, and the README's workflow examples use the same action versions. The `fail-on` and `max-bytes` input descriptions point at the published CLI reference instead of repository paths.
