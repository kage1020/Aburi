# The "resolve refspec" step. `$(...)` drops only the trailing newline and a step output ends at a
# newline, so only a one-line answer becomes `value`; a failure leaves its exit code instead.
set -euo pipefail

status=0
refspec=$(node "$GITHUB_ACTION_PATH/scripts/resolve-refspec.mjs") || status=$?
if [ "$status" = "0" ] && { [ -z "$refspec" ] || [[ "$refspec" == *[$'\r\n']* ]]; }; then
  echo "::error::resolve-refspec.mjs answered with no ref spec, or with more than one line." >&2
  status=1
fi
if [ "$status" != "0" ]; then
  echo "cli-exit-code=$status" >> "$GITHUB_OUTPUT"
  exit "$status"
fi
echo "value=$refspec" >> "$GITHUB_OUTPUT"
