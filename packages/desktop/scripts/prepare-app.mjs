import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "../..");
const distDir = path.join(desktopRoot, "dist");
const appDir = path.join(desktopRoot, "app");
const bundledBackendDir = path.join(desktopRoot, "bundled-backend");

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

  const entrypoint = path.join(workspaceRoot, "packages/backend/src/index.ts");
  const outfile = path.join(bundledBackendDir, "index.cjs");

  // Bundle backend into single CJS file; better-sqlite3 is native → external
  execSync(
    [
      "npx esbuild",
      `"${entrypoint}"`,
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=cjs",
      `--outfile="${outfile}"`,
      "--external:better-sqlite3",
    ].join(" "),
    { cwd: workspaceRoot, stdio: "inherit" },
  );

  // Copy better-sqlite3 and its runtime dependencies
  const nativeModules = ["better-sqlite3", "bindings", "file-uri-to-path"];
  const nodeModulesDir = path.join(bundledBackendDir, "node_modules");
  for (const mod of nativeModules) {
    const src = path.join(workspaceRoot, "node_modules", mod);
    const dest = path.join(nodeModulesDir, mod);
    await fs.cp(src, dest, { recursive: true });
  }

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
