import { reactFrameworkPlugin } from "@aburi/framework-react"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

const workspace = useScratchWorkspace("scan-react-e2e")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [reactFrameworkPlugin],
  })

describe("scan — integration through @aburi/framework-react", () => {
  it("classifies a full slate of React source shapes across .tsx and .jsx files", async () => {
    await workspace.writeSource(
      "src/Button.tsx",
      "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>\n}\n",
    )
    await workspace.writeSource(
      "src/hooks.tsx",
      "export function useCounter() {\n  const [c, setC] = useState(0)\n  return { c, inc: () => setC(c + 1) }\n}\n",
    )
    await workspace.writeSource(
      "src/context.tsx",
      "import { createContext } from 'react'\nexport const ThemeCtx = createContext(null)\n",
    )
    await workspace.writeSource(
      "src/forward.tsx",
      "export const FancyBtn = React.forwardRef((p, ref) => <button ref={ref} />)\n",
    )
    await workspace.writeSource(
      "src/memo.tsx",
      "export const Cell = React.memo(function Cell(props) { return <td>{props.v}</td> })\n",
    )
    await workspace.writeSource(
      "src/provider.tsx",
      "export function ThemeProvider({ children }) { return <ThemeCtx.Provider value={'dark'}>{children}</ThemeCtx.Provider> }\n",
    )
    await workspace.writeSource(
      "src/withAuth.tsx",
      "export function withAuth(Component) { return function Wrapped(p) { return <Component {...p} /> } }\n",
    )
    await workspace.writeSource(
      "src/legacy.jsx",
      "export function OldButton() { return <button>legacy</button> }\n",
    )

    const result = await scanWorkspace()

    const byName = new Map(result.ir.symbols.map((symbol) => [symbol.name, symbol]))

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
    await workspace.writeSource(
      "src/mixed.tsx",
      "export function formatDate(d: Date) { return d.toISOString() }\nexport function Widget() { return <div /> }\n",
    )

    const result = await scanWorkspace()

    const helper = result.ir.symbols.find((s) => s.name === "formatDate")
    const widget = result.ir.symbols.find((s) => s.name === "Widget")
    expect(helper?.extKind).toBeNull()
    expect(widget?.extKind).toBe("framework:react:component")
  })
})
