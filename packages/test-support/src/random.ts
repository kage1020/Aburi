const MODULUS = 2147483647

/** Numbers in (0, 1) drawn from `seed`: the same sequence on every run, so a failing trial replays. */
export function seeded(seed: number): () => number {
  if (!Number.isInteger(seed) || seed < 1 || seed >= MODULUS) {
    throw new Error(`seed ${seed} is not an integer from 1 to ${MODULUS - 1}`)
  }
  let state = seed
  return () => {
    state = (state * 48271) % MODULUS
    return state / MODULUS
  }
}
