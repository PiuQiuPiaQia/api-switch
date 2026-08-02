import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const platform = process.platform;
const rawArgs = process.argv.slice(2);
const forwardedArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const tauriCli = join(
  process.cwd(),
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

if (platform !== "darwin" && platform !== "win32") {
  console.error("Beta packages can only be built on macOS or Windows.");
  process.exit(1);
}

if (!existsSync(tauriCli)) {
  console.error("Tauri CLI is missing. Run pnpm install before packaging.");
  process.exit(1);
}

const env = { ...process.env };
const bundles = platform === "darwin" ? "app,dmg" : "msi,nsis";
const packageVersion = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version;
const buildVersion =
  env.VV_CODE_BUILD_VERSION ||
  `${packageVersion}-beta.${env.GITHUB_RUN_NUMBER || "0"}`;
const createUpdaterArtifacts = Boolean(env.TAURI_SIGNING_PRIVATE_KEY);
const betaConfig = JSON.stringify({
  version: buildVersion,
  bundle: {
    createUpdaterArtifacts,
    ...(platform === "win32" ? { windows: { wix: { template: null } } } : {}),
  },
});
const cargoBin = join(homedir(), ".cargo", "bin");
const pathKey =
  Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";

if (existsSync(cargoBin)) {
  env[pathKey] = `${cargoBin}${delimiter}${env[pathKey] ?? ""}`;
}

if (platform === "darwin") {
  // Pre-release builds intentionally use an ad-hoc signature so contributors
  // can package VV Code without an Apple Developer account.
  env.APPLE_SIGNING_IDENTITY = "-";

  for (const key of [
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
  ]) {
    delete env[key];
  }
}

console.log(
  `Building VV Code ${buildVersion} beta package for ${
    platform === "darwin" ? "macOS (ad-hoc signed)" : "Windows (unsigned)"
  }${createUpdaterArtifacts ? " with signed updater artifacts" : ""}...`,
);

const result = spawnSync(
  process.execPath,
  [
    tauriCli,
    "build",
    "--bundles",
    bundles,
    "--config",
    betaConfig,
    ...forwardedArgs,
  ],
  {
    env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
