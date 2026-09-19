/** The leftmost identifier of a callee string (`app.route('/x').get` → `app`): everything after the first `.` or `(` is dropped. */
export function calleeRoot(callee: string): string {
  const stop = firstBreakIndex(callee)
  return stop < 0 ? callee : callee.slice(0, stop)
}

function firstBreakIndex(callee: string): number {
  const dot = callee.indexOf(".")
  const paren = callee.indexOf("(")
  if (dot < 0) return paren
  if (paren < 0) return dot
  return Math.min(dot, paren)
}
