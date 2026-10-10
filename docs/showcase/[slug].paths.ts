import { readShowcase, readShowcasePage } from "./showcase.ts"

export default {
  paths() {
    return readShowcase().map(({ slug }) => ({
      params: { slug },
      content: readShowcasePage(slug),
    }))
  },
}
