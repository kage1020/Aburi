import { readShowcase, type ShowcaseEntry } from "./showcase.ts"

export type { ShowcaseEntry }

declare const data: ShowcaseEntry[]

export { data }

export default {
  load: readShowcase,
}
