import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { reactFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("react-scan")

describe("scan — React source shapes across .tsx and .jsx files", () => {
  it("classifies each React shape, and leaves a helper beside them alone", async () => {
    const files: Record<string, string> = {
      "src/Button.tsx":
        "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>\n}\n",
      "src/hooks.tsx":
        "export function useCounter() {\n  const [c, setC] = useState(0)\n  return { c, inc: () => setC(c + 1) }\n}\n",
      "src/context.tsx":
        "import { createContext } from 'react'\nexport const ThemeCtx = createContext(null)\n",
      "src/forward.tsx":
        "export const FancyBtn = React.forwardRef((p, ref) => <button ref={ref} />)\n",
      "src/memo.tsx":
        "export const Cell = React.memo(function Cell(props) { return <td>{props.v}</td> })\n",
      "src/provider.tsx":
        "export function ThemeProvider({ children }) { return <ThemeCtx.Provider value={'dark'}>{children}</ThemeCtx.Provider> }\n",
      "src/withAuth.tsx":
        "export function withAuth(Component) { return function Wrapped(p) { return <Component {...p} /> } }\n",
      "src/legacy.jsx": "export function OldButton() { return <button>legacy</button> }\n",
      "src/format.tsx": "export function formatDate(d: Date) { return d.toISOString() }\n",
    }
    for (const [path, source] of Object.entries(files)) await workspace.writeSource(path, source)

    const { ir } = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [reactFrameworkPlugin],
    })
    const extKinds = Object.fromEntries(ir.symbols.map((symbol) => [symbol.name, symbol.extKind]))

    expect(extKinds).toMatchObject({
      Button: "framework:react:component",
      useCounter: "framework:react:hook",
      ThemeCtx: "framework:react:context",
      FancyBtn: "framework:react:forward-ref",
      Cell: "framework:react:memo",
      ThemeProvider: "framework:react:provider",
      withAuth: "framework:react:hoc",
      OldButton: "framework:react:component",
      formatDate: null,
    })
  })
})
