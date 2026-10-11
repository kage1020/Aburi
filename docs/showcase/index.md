# Showcase

Each example is a small project written twice, before and after one change. When this site is built, both
versions are committed to a scratch repository and `aburi diff HEAD~1..HEAD` runs over them, so every page
shows the change as git sees it next to the report Aburi actually prints for it — not a mock-up.

<script setup>
import { data as examples } from "./showcase.data"
</script>

<div v-for="example in examples" :key="example.slug" class="showcase-entry">
  <h2 :id="example.slug"><a :href="`./${example.slug}`">{{ example.title }}</a></h2>
  <p>{{ example.summary.replaceAll("`", "") }}</p>
</div>
