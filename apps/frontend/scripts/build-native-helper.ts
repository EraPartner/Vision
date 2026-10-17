import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const productionOutput = path.resolve(frontend, "../../dist");

export interface NativeHelperBuildOptions {
  outDir?: string;
  /** Explicit isolated output for artifact tests, never the production dist. */
  scratch?: boolean;
}

/** Add the optional helper only after the ordinary build. This separate config
 * intentionally has no normal HTML preload plugin, public files or CSS entry. */
export async function buildNativeHelper(
  options: NativeHelperBuildOptions = {},
) {
  const outDir = path.resolve(options.outDir ?? productionOutput);
  if (options.scratch) {
    if (!options.outDir || outDir === productionOutput)
      throw new Error("Helper scratch build requires isolated output");
  } else {
    await access(path.join(outDir, "index.html"));
    if (!(await stat(path.join(outDir, "assets"))).isDirectory())
      throw new Error(
        "Ordinary frontend assets must exist before helper build",
      );
  }
  const rootPackage = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return build({
    configFile: false,
    root: frontend,
    envDir: false,
    publicDir: false,
    base: "/",
    define: { __APP_VERSION__: JSON.stringify(rootPackage.version) },
    resolve: {
      alias: { "@": path.join(frontend, "src") },
      dedupe: ["decimal.js"],
    },
    build: {
      outDir,
      emptyOutDir: false,
      assetsDir: "native-helper-assets",
      rollupOptions: {
        input: path.join(frontend, "native-helper.html"),
        output: {
          entryFileNames: "native-helper-assets/[name]-[hash].js",
          chunkFileNames: "native-helper-assets/[name]-[hash].js",
          assetFileNames: "native-helper-assets/[name]-[hash][extname]",
        },
      },
    },
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const flag = process.argv.indexOf("--out-dir");
  const outDir = flag === -1 ? undefined : process.argv[flag + 1];
  if (flag !== -1 && !outDir) throw new Error("--out-dir requires a directory");
  // The native runtime build passes its staged ordinary build directory.
  await buildNativeHelper(outDir ? { outDir } : {});
}
