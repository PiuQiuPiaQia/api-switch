import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const platform = process.platform;
const forwardedArgs = process.argv.slice(2);
const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";

if (platform !== "darwin" && platform !== "win32") {
  console.error(
    "Internal desktop packages can only be built on macOS or Windows.",
  );
  process.exit(1);
}

const env = { ...process.env };
const bundles = platform === "darwin" ? "app,dmg" : "msi,nsis";
const cargoBin = join(homedir(), ".cargo", "bin");

if (existsSync(cargoBin)) {
  env.PATH = `${cargoBin}${delimiter}${env.PATH ?? ""}`;
}

if (platform === "darwin") {
  // Ad-hoc signing keeps Apple Silicon downloads structurally signed without
  // pretending that this internal build has a Developer ID or notarization.
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
  `Building VV Code internal package for ${
    platform === "darwin" ? "macOS (ad-hoc signed)" : "Windows (unsigned)"
  }...`,
);

const result = spawnSync(
  pnpm,
  ["tauri", "build", "--bundles", bundles, ...forwardedArgs],
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
