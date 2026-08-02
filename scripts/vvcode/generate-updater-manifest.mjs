import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [assetsDir, tag, repository, output = "latest.json"] =
  process.argv.slice(2);

if (!assetsDir || !tag || !repository) {
  console.error(
    "Usage: node scripts/vvcode/generate-updater-manifest.mjs <assets-dir> <tag> <owner/repo> [output]",
  );
  process.exit(1);
}

const version = tag.replace(/^v/, "");
const files = readdirSync(assetsDir).filter((name) =>
  statSync(join(assetsDir, name)).isFile(),
);
const platforms = {};
const baseUrl = `https://github.com/${repository}/releases/download/${tag}`;

function addPlatform(keys, artifactName) {
  if (!artifactName) return;
  const signatureName = `${artifactName}.sig`;
  if (!files.includes(signatureName)) {
    throw new Error(`Missing updater signature: ${signatureName}`);
  }

  const signature = readFileSync(join(assetsDir, signatureName), "utf8").trim();
  if (!signature)
    throw new Error(`Updater signature is empty: ${signatureName}`);

  for (const key of keys) {
    platforms[key] = {
      signature,
      url: `${baseUrl}/${encodeURIComponent(basename(artifactName))}`,
    };
  }
}

const macArtifact = files.find(
  (name) => name.endsWith("-macOS.tar.gz") && !name.endsWith(".sig"),
);
const windowsArtifact = files.find(
  (name) =>
    name.endsWith("-Windows-x64-setup.exe") && !name.endsWith(".sig"),
);

addPlatform(["darwin-aarch64", "darwin-x86_64"], macArtifact);
addPlatform(["windows-x86_64"], windowsArtifact);

if (Object.keys(platforms).length === 0) {
  throw new Error(`No updater artifacts found in ${assetsDir}`);
}

const manifest = {
  version,
  notes: `VV Code ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Wrote ${output} for ${version}: ${Object.keys(platforms).join(", ")}`,
);
