import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme"
import { h } from "vue"
import HomeExample from "./HomeExample"
import "./brand.css"
import "./home-example.css"

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-after": () => h(HomeExample) }),
} satisfies Theme
