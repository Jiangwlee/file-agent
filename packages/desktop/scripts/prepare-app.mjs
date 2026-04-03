import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const distDir = path.join(desktopRoot, "dist");
const appDir = path.join(desktopRoot, "app");

async function ensureBuildOutput() {
  for (const file of ["main.js", "preload.js"]) {
    const target = path.join(distDir, file);
    await fs.access(target);
  }
}

async function recreateAppDir() {
  await fs.rm(appDir, { recursive: true, force: true });
  await fs.mkdir(appDir, { recursive: true });
}

async function copyDistFiles() {
  for (const file of ["main.js", "preload.js"]) {
    await fs.copyFile(path.join(distDir, file), path.join(appDir, file));
  }
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
await recreateAppDir();
await copyDistFiles();
await writePackageJson();
