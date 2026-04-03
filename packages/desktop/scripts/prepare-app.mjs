import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "../..");
const distDir = path.join(desktopRoot, "dist");
const appDir = path.join(desktopRoot, "app");
const bundledBackendDir = path.join(desktopRoot, "bundled-backend");

/**
 * Replace the 'bindings' npm package with a shim that loads .node addons
 * from the same directory as the bundle. This avoids needing node_modules
 * in the packaged app — only the .node binary file is needed alongside index.cjs.
 */
const nativeAddonPlugin = {
  name: "native-addon",
  setup(build) {
    build.onResolve({ filter: /^bindings$/ }, () => ({
      path: "bindings",
      namespace: "native-shim",
    }));
    build.onLoad({ filter: /.*/, namespace: "native-shim" }, () => ({
      contents: `
        const path = require("path");
        module.exports = function(name) {
          return require(path.join(__dirname, name));
        };
      `,
      loader: "js",
    }));
  },
};

async function ensureBuildOutput() {
  for (const file of ["main.js", "preload.js"]) {
    await fs.access(path.join(distDir, file));
  }
}

async function recreateDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function copyDistFiles() {
  for (const file of ["main.js", "preload.js"]) {
    await fs.copyFile(path.join(distDir, file), path.join(appDir, file));
  }
}

async function bundleBackend() {
  await recreateDir(bundledBackendDir);

  await esbuild.build({
    entryPoints: [path.join(workspaceRoot, "packages/backend/src/index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: path.join(bundledBackendDir, "index.cjs"),
    plugins: [nativeAddonPlugin],
  });

  // Copy only the native addon binary (the only file that can't be bundled)
  await fs.copyFile(
    path.join(
      workspaceRoot,
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    ),
    path.join(bundledBackendDir, "better_sqlite3.node"),
  );

  console.log("✓ Backend bundled successfully");
}

async function writePackageJson() {
  const packageJson = {
    name: "file-agent-desktop",
    version: "0.1.0",
    private: true,
    main: "main.js",
    description: "Windows desktop shell for FileAgent",
    author: "FileAgent",
  };
  await fs.writeFile(
    path.join(appDir, "package.json"),
    JSON.stringify(packageJson, null, 2),
    "utf8",
  );
}

await ensureBuildOutput();
await recreateDir(appDir);
await copyDistFiles();
await bundleBackend();
await writePackageJson();

console.log("✓ Desktop app prepared successfully");
