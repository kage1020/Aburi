import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme"
import { h } from "vue"
import HomeExample from "./HomeExample"
import "./brand.css"
import "./home-example.css"

/**
 * The home hero sells the idea; the comparison under it shows the thing. The
 * slot puts it above the feature cards so both land in the first view, and it
 * renders on the home layout alone, so no other page pays for it.
 */
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-after": () => h(HomeExample) }),
} satisfies Theme
