import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import type { Config } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CliError, loadPlugins } from "../src"
import { detectorIdRefusal, windowsDriveRefusal } from "../src/plugin-loader"
import { FAKE_LANGUAGE_PLUGIN } from "./plugin-fakes"
import { STUB_PLUGIN } from "./stub-language"
import { writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("plugin-refs")

const WORKSPACE_ROOT = resolve(tmpdir(), "workspace")
const PLUGIN_REF_ROOT = resolve(tmpdir(), "different-plugin-root")
const ABSOLUTE = resolve(tmpdir(), "aburi plugins", "local #100%.mjs")

async function importedFor(config: Config): Promise<string[]> {
  const imported: string[] = []
  await loadPlugins({
    config,
    workspaceRoot: WORKSPACE_ROOT,
    pluginRefRoot: PLUGIN_REF_ROOT,
    importModule: async (specifier) => {
      imported.push(specifier)
      return { plugin: FAKE_LANGUAGE_PLUGIN }
    },
  })
  return imported
}

describe("loadPlugins — what a plugin ref is imported as", () => {
  it.each([
    ["a bare manifest name, under @aburi", "lang-fake", "@aburi/lang-fake"],
    ["a scoped package id, verbatim", "@aburi/lang-typescript", "@aburi/lang-typescript"],
    [
      "a relative path, against the plugin ref root",
      "./plugins/local.mjs",
      pathToFileURL(resolve(PLUGIN_REF_ROOT, "plugins/local.mjs")).href,
    ],
    ["an absolute path, at its own location", ABSOLUTE, pathToFileURL(ABSOLUTE).href],
    ["a file: URL, verbatim", pathToFileURL(ABSOLUTE).href, pathToFileURL(ABSOLUTE).href],
    [
      "a backslash relative path, as a package name",
      ".\\plugins\\x.mjs",
      "@aburi/.\\plugins\\x.mjs",
    ],
  ])("imports %s", async (_, ref, specifier) => {
    expect(await importedFor({ languages: [ref] })).toEqual([specifier])
  })

  it.runIf(process.platform === "win32").each([
    [
      "a Windows absolute path written with forward slashes",
      ABSOLUTE.replaceAll("\\", "/"),
      pathToFileURL(ABSOLUTE).href,
    ],
    [
      "a UNC path written with forward slashes",
      "//server/share/x.mjs",
      "file://server/share/x.mjs",
    ],
    [
      "a UNC path written with backslashes",
      "\\\\server\\share\\x.mjs",
      "file://server/share/x.mjs",
    ],
  ])("imports %s on Windows", async (_, ref, specifier) => {
    expect(await importedFor({ languages: [ref] })).toEqual([specifier])
  })

  it("imports an absolute plugin path containing spaces and URL-special characters", async () => {
    const pluginPath = resolve(workspace.root, "local #100%.mjs")
    await writeFileAt(workspace.root, "local #100%.mjs", STUB_PLUGIN)
    const loaderUrl = new URL("../src/plugin-loader.ts", import.meta.url).href
    const result = "aburi-test-result:"

    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { loadPlugins } from ${JSON.stringify(loaderUrl)};
        const loaded = await loadPlugins(${JSON.stringify({
          config: { languages: [pluginPath] },
          workspaceRoot: resolve(workspace.root, "workspace"),
        })});
        console.log(${JSON.stringify(result)} + JSON.stringify(loaded.languages.map(plugin => plugin.manifest.name)));`,
      ],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 20_000 },
    )

    const line = stdout.split("\n").find((l) => l.startsWith(result))
    expect(line, `no result line.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBeDefined()
    expect(JSON.parse((line ?? "").slice(result.length))).toEqual(["lang-stub"])
  })
})

describe("loadPlugins — a ref it refuses before importing anything", () => {
  it.each([
    [
      "a path whose drive this platform reads differently",
      {
        languages: ["./plugins/ok.mjs"],
        effects: [process.platform === "win32" ? "/opt/plugins/x.mjs" : "C:/plugins/x.mjs"],
      },
      process.platform === "win32" ? 'Plugin "/opt/plugins/x.mjs"' : 'Plugin "C:/plugins/x.mjs"',
    ],
    [
      "a bare detector id",
      { languages: ["lang-fake"], effects: ["prisma"] },
      'Plugin "prisma" in "effects" is not a plugin name: a bare name resolves to "@aburi/prisma", and the plugins there are named "effects-<name>". Write "effects-prisma".',
    ],
  ])("refuses %s as a config error, even after a ref it accepted", async (_, config, says) => {
    const imported: string[] = []
    const error = await errorFrom(CliError, () =>
      loadPlugins({
        config,
        workspaceRoot: WORKSPACE_ROOT,
        importModule: async (specifier) => {
          imported.push(specifier)
          return { plugin: FAKE_LANGUAGE_PLUGIN }
        },
      }),
    )

    expect(error.code).toBe("config-error")
    expect(error.message).toContain(says)
    expect(imported).toEqual([])
  })
})

describe("detectorIdRefusal", () => {
  it.each([
    ["languages", "tsx", 'Write "lang-typescript".'],
    ["frameworks", "nextjs", 'Write "framework-next".'],
    ["frameworks", "vue", "Write the plugin's manifest name"],
    ["effects", "nestjs", 'Write "effects-nestjs".'],
    ["languages", "x", "Write the plugin's manifest name"],
  ] as const)("refuses %s: %s", (field, ref, fix) => {
    expect(detectorIdRefusal(ref, field)).toContain(fix)
  })

  it("suggests a plugin of the field's own kind", () => {
    expect(detectorIdRefusal("nestjs", "effects")).not.toContain("framework-nestjs")
  })

  it.each([
    "lang-typescript",
    "@aburi/lang-typescript",
    "./x.mjs",
    "x.mjs",
    "Ts",
  ])("leaves %s to the loader", (ref) => {
    expect(detectorIdRefusal(ref, "languages")).toBeNull()
  })
})

describe("windowsDriveRefusal", () => {
  const ROOT = "D:\\ws"

  it.each([
    [
      "/opt/plugins/x.mjs",
      'take the drive of the workspace root. Write the drive in: "D:/opt/plugins/x.mjs"',
    ],
    ["\\plugins\\x.mjs", 'Write the drive in: "D:/plugins/x.mjs"'],
    ["\\\\x.mjs", 'Write the drive in: "D:/x.mjs"'],
    ["C:plugins/x.mjs", 'current on that drive. Start it at the root: "C:/plugins/x.mjs"'],
    ["C:plugins\\x.mjs", 'Start it at the root: "C:/plugins/x.mjs"'],
  ])("refuses %s on Windows", (ref, message) => {
    expect(windowsDriveRefusal(ref, "win32", ROOT)).toContain(message)
  })

  it("suggests the UNC share of a workspace on one", () => {
    expect(windowsDriveRefusal("/x.mjs", "win32", "\\\\srv\\share\\ws")).toContain(
      '"//srv/share/x.mjs"',
    )
  })

  it.each([
    "C:/plugins/x.mjs",
    "C:\\plugins\\x.mjs",
    "//server/share/x.mjs",
    "\\\\server\\share\\x.mjs",
    "./plugins/x.mjs",
    ".\\plugins\\x.mjs",
    "@aburi/lang-typescript",
    "file:///C:/plugins/x.mjs",
  ])("accepts %s on Windows", (ref) => {
    expect(windowsDriveRefusal(ref, "win32", ROOT)).toBeNull()
  })

  it.each([
    "C:/plugins/x.mjs",
    "C:\\plugins\\x.mjs",
    "C:plugins/x.mjs",
  ])("refuses %s on POSIX, which has no drives", (ref) => {
    expect(windowsDriveRefusal(ref, "linux", "/ws")).toContain("names the Windows drive C:")
  })

  it.each([
    "/opt/plugins/x.mjs",
    "./plugins/x.mjs",
    "lang-typescript",
    "file:///opt/x.mjs",
  ])("accepts %s on POSIX", (ref) => {
    expect(windowsDriveRefusal(ref, "linux", "/ws")).toBeNull()
  })
})
