import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./generate-updater-manifest.mjs", import.meta.url),
);

test("generates beta updater entries for universal macOS and Windows x64", () => {
  const directory = mkdtempSync(join(tmpdir(), "vv-code-updater-test-"));
  const tag = "v0.0.1-beta.12";
  const mac = `VV-Code-${tag}-macOS.tar.gz`;
  const windows = `VV-Code-${tag}-Windows-x64.msi`;
  const output = join(directory, "latest.json");

  try {
    writeFileSync(join(directory, mac), "mac updater");
    writeFileSync(join(directory, `${mac}.sig`), "mac-signature");
    writeFileSync(join(directory, windows), "windows updater");
    writeFileSync(join(directory, `${windows}.sig`), "windows-signature");

    execFileSync(
      process.execPath,
      [script, directory, tag, "owner/repository", output],
      { stdio: "pipe" },
    );

    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(manifest.version, "0.0.1-beta.12");
    assert.equal(
      manifest.platforms["darwin-aarch64"].signature,
      "mac-signature",
    );
    assert.deepEqual(
      manifest.platforms["darwin-aarch64"],
      manifest.platforms["darwin-x86_64"],
    );
    assert.equal(
      manifest.platforms["windows-x86_64"].url,
      `https://github.com/owner/repository/releases/download/${tag}/${windows}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
