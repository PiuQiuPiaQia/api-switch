import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const rawArgs = process.argv.slice(2);
const forwardedArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const tauriCli = join(
  process.cwd(),
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

if (!existsSync(tauriCli)) {
  console.error("Tauri CLI is missing. Run pnpm install before packaging.");
  process.exit(1);
}

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.error("TAURI_SIGNING_PRIVATE_KEY is required for a release build.");
  process.exit(1);
}

if (!process.env.VV_CODE_UPDATER_PUBKEY) {
  console.error("VV_CODE_UPDATER_PUBKEY is required for a release build.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    tauriCli,
    "build",
    "--config",
    JSON.stringify({ bundle: { createUpdaterArtifacts: true } }),
    ...forwardedArgs,
  ],
  { env: process.env, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
