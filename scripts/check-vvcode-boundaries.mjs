import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const errors = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function report(path, message) {
  errors.push(`${repositoryPath(path)}: ${message}`);
}

const frontendRoot = resolve(repositoryRoot, "src");
const frontendBridgeFiles = new Set([
  "src/main.tsx",
  "src/components/settings/AboutSection.tsx",
]);
const vvcodeImportPattern = /(?:from\s+|import\s*)["'][^"']*vvcode(?:\/|["'])/;

for (const path of walk(frontendRoot)) {
  const file = repositoryPath(path);
  if (!/\.(?:ts|tsx|js|jsx)$/.test(file) || file.startsWith("src/vvcode/")) {
    continue;
  }

  const source = readFileSync(path, "utf8");
  if (vvcodeImportPattern.test(source) && !frontendBridgeFiles.has(file)) {
    report(path, "CC Switch 共享前端不得反向导入 src/vvcode");
  }
}

const rustRoot = resolve(repositoryRoot, "src-tauri/src");
for (const path of walk(rustRoot)) {
  const file = repositoryPath(path);
  if (!file.endsWith(".rs") || file.startsWith("src-tauri/src/vvcode/")) {
    continue;
  }

  const source = readFileSync(path, "utf8");
  if (
    /\b(?:crate::)?vvcode::/.test(source) &&
    file !== "src-tauri/src/lib.rs"
  ) {
    report(path, "CC Switch 共享 Rust 模块不得反向依赖 vvcode");
  }
}

const retiredProductDirectory = resolve(repositoryRoot, "src/product");
try {
  if (statSync(retiredProductDirectory).isDirectory()) {
    report(
      retiredProductDirectory,
      "二开前端请使用 src/vvcode，不要恢复 src/product",
    );
  }
} catch {
  // Expected: the ambiguous legacy directory should not exist.
}

const upstreamCommandModule = resolve(
  repositoryRoot,
  "src-tauri/src/commands/mod.rs",
);
const upstreamProviderCommands = resolve(
  repositoryRoot,
  "src-tauri/src/commands/provider.rs",
);

if (/\bnewapi\b/i.test(readFileSync(upstreamCommandModule, "utf8"))) {
  report(upstreamCommandModule, "NewAPI 命令必须由 src-tauri/src/vvcode 管理");
}
if (/vv-code-managed/i.test(readFileSync(upstreamProviderCommands, "utf8"))) {
  report(
    upstreamProviderCommands,
    "VV Code 托管供应商逻辑不得放在上游 provider 命令",
  );
}

if (errors.length > 0) {
  console.error("VV Code architecture boundary check failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("VV Code architecture boundaries are valid.");
}
