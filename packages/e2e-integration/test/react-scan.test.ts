import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scan } from "@aburi/core"
import { reactFrameworkPlugin } from "@aburi/framework-react"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let workRoot: string

beforeEach(async () => {
  workRoot = join(tmpdir(), `aburi-scan-react-e2e-${Math.floor(performance.now() * 1000)}`)
  await mkdir(workRoot, { recursive: true })
})

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await rm(workRoot, { recursive: true, force: true })
})

async function writeSource(rel: string, content: string): Promise<void> {
  const abs = join(workRoot, rel)
  const dir = abs.slice(0, Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\")))
  await mkdir(dir, { recursive: true })
  await writeFile(abs, content, "utf8")
}

function buildRegistry() {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  registry.register(reactFrameworkPlugin.manifest)
  return registry
}

describe("scan — integration through @aburi/framework-react", () => {
  it("classifies a full slate of React source shapes across .tsx and .jsx files", async () => {
    await writeSource(
      "src/Button.tsx",
      "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>\n}\n",
    )
    await writeSource(
      "src/hooks.tsx",
      "export function useCounter() {\n  const [c, setC] = useState(0)\n  return { c, inc: () => setC(c + 1) }\n}\n",
    )
    await writeSource(
      "src/context.tsx",
      "import { createContext } from 'react'\nexport const ThemeCtx = createContext(null)\n",
    )
    await writeSource(
      "src/forward.tsx",
      "export const FancyBtn = React.forwardRef((p, ref) => <button ref={ref} />)\n",
    )
    await writeSource(
      "src/memo.tsx",
      "export const Cell = React.memo(function Cell(props) { return <td>{props.v}</td> })\n",
    )
    await writeSource(
      "src/provider.tsx",
      "export function ThemeProvider({ children }) { return <ThemeCtx.Provider value={'dark'}>{children}</ThemeCtx.Provider> }\n",
    )
    await writeSource(
      "src/withAuth.tsx",
      "export function withAuth(Component) { return function Wrapped(p) { return <Component {...p} /> } }\n",
    )
    await writeSource(
      "src/legacy.jsx",
      "export function OldButton() { return <button>legacy</button> }\n",
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
      effects: [],
      registry: buildRegistry(),
    })

    const byName = new Map(result.ir.symbols.map((s) => [s.name, s]))

    expect(byName.get("Button")?.extKind).toBe("framework:react:component")
    expect(byName.get("useCounter")?.extKind).toBe("framework:react:hook")
    expect(byName.get("ThemeCtx")?.extKind).toBe("framework:react:context")
    expect(byName.get("FancyBtn")?.extKind).toBe("framework:react:forward-ref")
    expect(byName.get("Cell")?.extKind).toBe("framework:react:memo")
    expect(byName.get("ThemeProvider")?.extKind).toBe("framework:react:provider")
    expect(byName.get("withAuth")?.extKind).toBe("framework:react:hoc")
    // .jsx routed through the tsx grammar produces a classifiable component too.
    expect(byName.get("OldButton")?.extKind).toBe("framework:react:component")
  })

  it("leaves non-React helpers unclassified (framework plugin returns null)", async () => {
    await writeSource(
      "src/mixed.tsx",
      "export function formatDate(d: Date) { return d.toISOString() }\nexport function Widget() { return <div /> }\n",
    )

    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
      effects: [],
      registry: buildRegistry(),
    })

    const helper = result.ir.symbols.find((s) => s.name === "formatDate")
    const widget = result.ir.symbols.find((s) => s.name === "Widget")
    expect(helper?.extKind).toBeNull()
    expect(widget?.extKind).toBe("framework:react:component")
  })
})
