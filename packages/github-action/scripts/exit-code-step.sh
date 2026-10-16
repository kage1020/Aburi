# The last step, which runs whatever failed before it. Each step of the action that can stop it
# records its code, so a run with none recorded stopped in a setup step, and that is not a pass.
set -euo pipefail

if [ -n "${DIFF_EXIT:-}" ]; then
  code=$DIFF_EXIT
  if [ "$code" != "0" ]; then
    echo "::error::aburi diff exited with status $code (see previous log). Failing the step so the PR check reflects it." >&2
  fi
elif [ -n "${REFSPEC_EXIT:-}" ] || [ -n "${INPUTS_EXIT:-}" ]; then
  code=${REFSPEC_EXIT:-$INPUTS_EXIT}
  echo "The action stopped with status $code before aburi diff ran; the step that failed says why." >&2
else
  echo "::error::The action stopped before aburi diff ran, in a step that records no exit code; that step's log says why." >&2
  code=1
fi
echo "cli-exit-code=$code" >> "$GITHUB_OUTPUT"
exit "$code"
