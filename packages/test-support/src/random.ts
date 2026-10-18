/** Numbers in (0, 1) drawn from `seed`: the same sequence on every run, so a failing trial replays. */
export function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 48271) % 2147483647
    return state / 2147483647
  }
}
