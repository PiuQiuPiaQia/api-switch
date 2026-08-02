import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
const betaConfig =
  platform === "win32"
    ? JSON.stringify({ bundle: { windows: { wix: { template: null } } } })
    : null;
const cargoBin = join(homedir(), ".cargo", "bin");
const pathKey =
  Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";

function hasEnv(name) {
  return Boolean(env[name]?.trim());
}

if (existsSync(cargoBin)) {
  env[pathKey] = `${cargoBin}${delimiter}${env[pathKey] ?? ""}`;
}

if (platform === "darwin") {
  const notarizationKeys = [
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
  ];
  const appleIdKeys = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  const apiKeyKeys = [
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
  ];
  const hasDeveloperId =
    hasEnv("APPLE_SIGNING_IDENTITY") &&
    env.APPLE_SIGNING_IDENTITY.trim() !== "-";
  const hasAppleIdCredentials = appleIdKeys.every(hasEnv);
  const hasApiKeyCredentials = apiKeyKeys.every(hasEnv);
  const hasPartialCredentials =
    notarizationKeys.some(hasEnv) &&
    !hasAppleIdCredentials &&
    !hasApiKeyCredentials;

  if (hasDeveloperId && hasPartialCredentials) {
    console.error(
      "Incomplete Apple notarization credentials. Provide APPLE_ID, " +
        "APPLE_PASSWORD and APPLE_TEAM_ID, or the complete App Store " +
        "Connect API credential set.",
    );
    process.exit(1);
  }

  if (hasDeveloperId && !hasAppleIdCredentials && !hasApiKeyCredentials) {
    console.error(
      "Developer ID beta builds must also provide Apple notarization credentials.",
    );
    process.exit(1);
  }

  if (!hasDeveloperId) {
    // Local builds without a Developer ID remain structurally signed for Apple
    // Silicon, but CI release artifacts must use the signed path below.
    env.APPLE_SIGNING_IDENTITY = "-";
    for (const key of notarizationKeys) delete env[key];
  }
}

const macDistributionLabel =
  env.APPLE_SIGNING_IDENTITY === "-"
    ? "macOS (ad-hoc signed local build)"
    : "macOS (Developer ID signed and notarized)";

console.log(
  `Building VV Code beta package for ${
    platform === "darwin" ? macDistributionLabel : "Windows (unsigned)"
  }...`,
);

const result = spawnSync(
  process.execPath,
  [
    tauriCli,
    "build",
    "--bundles",
    bundles,
    ...(betaConfig ? ["--config", betaConfig] : []),
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
