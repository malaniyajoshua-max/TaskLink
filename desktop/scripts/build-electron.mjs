import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist-electron", { recursive: true });
await build({
  entryPoints: [
    "electron/main.ts",
    "electron/preload.ts",
    "electron/worker.ts",
  ],
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron", "electron-updater"],
  sourcemap: true,
});
await copyFile("public/tray.png", "dist-electron/tray.png");
