import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const brandConfigPath = resolve(repositoryRoot, "src/vvcode/brand.config.json");
const checkOnly = process.argv.includes("--check");
const mismatches = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`品牌配置 ${field} 必须是非空字符串`);
  }
  if (/\r|\n/.test(value)) {
    throw new Error(`品牌配置 ${field} 不得包含换行`);
  }
  return value.trim();
}

function httpUrl(value, field) {
  const text = nonEmptyString(value, field);
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`品牌配置 ${field} 必须是 HTTP(S) URL`);
  }
  if (url.username || url.password) {
    throw new Error(`品牌配置 ${field} 不得包含 URL 凭据`);
  }
  return text;
}

function matches(value, field, pattern, message) {
  const text = nonEmptyString(value, field);
  if (!pattern.test(text)) throw new Error(message);
  return text;
}

function validate(config) {
  if (config.schemaVersion !== 1) {
    throw new Error("仅支持 schemaVersion = 1 的品牌配置");
  }

  nonEmptyString(config.brand?.name, "brand.name");
  nonEmptyString(config.brand?.tagline, "brand.tagline");
  nonEmptyString(config.brand?.description, "brand.description");
  httpUrl(config.brand?.websiteUrl, "brand.websiteUrl");
  nonEmptyString(
    config.distribution?.publisherName,
    "distribution.publisherName",
  );

  const packageName = nonEmptyString(
    config.distribution?.packageName,
    "distribution.packageName",
  );
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packageName)) {
    throw new Error("distribution.packageName 只能包含小写字母、数字和连字符");
  }

  const bundleIdentifier = nonEmptyString(
    config.distribution?.bundleIdentifier,
    "distribution.bundleIdentifier",
  );
  if (!/^[A-Za-z0-9.-]+$/.test(bundleIdentifier)) {
    throw new Error("distribution.bundleIdentifier 格式无效");
  }

  const configDirName = nonEmptyString(
    config.distribution?.configDirName,
    "distribution.configDirName",
  );
  if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(configDirName)) {
    throw new Error("distribution.configDirName 必须是安全的隐藏目录名");
  }

  matches(
    config.distribution?.databaseFileName,
    "distribution.databaseFileName",
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/,
    "distribution.databaseFileName 必须是安全的 .db 文件名",
  );
  matches(
    config.distribution?.logFileName,
    "distribution.logFileName",
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/,
    "distribution.logFileName 必须是安全的 .log 文件名",
  );
  matches(
    config.distribution?.syncRoot,
    "distribution.syncRoot",
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "distribution.syncRoot 格式无效",
  );
  nonEmptyString(
    config.distribution?.themeStorageKey,
    "distribution.themeStorageKey",
  );
  matches(
    config.distribution?.userAgent,
    "distribution.userAgent",
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    "distribution.userAgent 格式无效",
  );

  httpUrl(config.service?.defaultBaseUrl, "service.defaultBaseUrl");
  for (const field of [
    "url",
    "issuesUrl",
    "releasesUrl",
    "githubReleasesApiUrl",
  ]) {
    httpUrl(config.repository?.[field], `repository.${field}`);
  }
  nonEmptyString(config.upstream?.name, "upstream.name");
  httpUrl(config.upstream?.url, "upstream.url");
  matches(
    config.compatibility?.managedProviderId,
    "compatibility.managedProviderId",
    /^[a-z0-9][a-z0-9-]*$/,
    "compatibility.managedProviderId 只能包含小写字母、数字和连字符",
  );
}

function updateFile(path, nextSource) {
  const currentSource = readFileSync(path, "utf8");
  if (currentSource === nextSource) return;

  const relativePath = path.slice(repositoryRoot.length + 1);
  if (checkOnly) {
    mismatches.push(relativePath);
  } else {
    writeFileSync(path, nextSource);
    console.log(`已同步 ${relativePath}`);
  }
}

function updateJson(relativePath, transform) {
  const path = resolve(repositoryRoot, relativePath);
  const document = readJson(path);
  transform(document);
  updateFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

function replacePackageField(source, field, tomlLiteral) {
  const pattern = new RegExp(`^${field} = .*$`, "m");
  if (!pattern.test(source)) {
    throw new Error(`src-tauri/Cargo.toml 缺少 [package].${field}`);
  }
  return source.replace(pattern, `${field} = ${tomlLiteral}`);
}

function tomlString(value) {
  return JSON.stringify(value);
}

const config = readJson(brandConfigPath);
validate(config);
const packageDocument = readJson(resolve(repositoryRoot, "package.json"));
const packageVersion = packageDocument.version;

updateJson("package.json", (document) => {
  document.name = config.distribution.packageName;
  document.description = config.brand.description;
  document.author = config.distribution.publisherName;
  document.homepage = config.brand.websiteUrl;
  document.repository = {
    type: "git",
    url: config.repository.url.endsWith(".git")
      ? config.repository.url
      : `${config.repository.url.replace(/\/+$/, "")}.git`,
  };
  document.bugs = { url: config.repository.issuesUrl };
});

updateJson("src-tauri/tauri.conf.json", (document) => {
  document.productName = config.brand.name;
  document.identifier = config.distribution.bundleIdentifier;
  document.app.windows[0].title = config.brand.name;
  document.bundle.shortDescription = config.brand.description;
});

updateJson("src-tauri/tauri.windows.conf.json", (document) => {
  document.app.windows[0].title = config.brand.name;
});

const cargoPath = resolve(repositoryRoot, "src-tauri/Cargo.toml");
let cargoSource = readFileSync(cargoPath, "utf8");
const currentCargoPackageName = cargoSource.match(/^name = "([^"]+)"$/m)?.[1];
if (!currentCargoPackageName) {
  throw new Error("src-tauri/Cargo.toml 缺少 [package].name");
}
cargoSource = replacePackageField(
  cargoSource,
  "name",
  tomlString(config.distribution.packageName),
);
cargoSource = replacePackageField(
  cargoSource,
  "description",
  tomlString(config.brand.description),
);
cargoSource = replacePackageField(
  cargoSource,
  "authors",
  `[${tomlString(config.distribution.publisherName)}]`,
);
cargoSource = replacePackageField(
  cargoSource,
  "homepage",
  tomlString(config.brand.websiteUrl),
);
cargoSource = replacePackageField(
  cargoSource,
  "repository",
  tomlString(config.repository.url),
);
updateFile(cargoPath, cargoSource);

if (currentCargoPackageName !== config.distribution.packageName) {
  const cargoLockPath = resolve(repositoryRoot, "src-tauri/Cargo.lock");
  const currentLockSource = readFileSync(cargoLockPath, "utf8");
  const currentHeader = `[[package]]\nname = ${tomlString(currentCargoPackageName)}\nversion = ${tomlString(packageVersion)}\n`;
  if (!currentLockSource.includes(currentHeader)) {
    throw new Error("无法在 src-tauri/Cargo.lock 中定位当前应用包");
  }
  updateFile(
    cargoLockPath,
    currentLockSource.replace(
      currentHeader,
      `[[package]]\nname = ${tomlString(config.distribution.packageName)}\nversion = ${tomlString(packageVersion)}\n`,
    ),
  );
}

for (const relativePath of [
  "src/vvcode/assets/logo.png",
  "src/vvcode/assets/app-icon.png",
]) {
  if (!existsSync(resolve(repositoryRoot, relativePath))) {
    throw new Error(`缺少标准品牌资源：${relativePath}`);
  }
}

if (checkOnly && mismatches.length > 0) {
  console.error("品牌派生元数据未同步：");
  for (const path of mismatches) console.error(`- ${path}`);
  console.error("请运行 pnpm brand:sync 后重新校验。");
  process.exit(1);
}

if (checkOnly)
  console.log("Brand configuration and derived metadata are in sync.");
else console.log("品牌配置同步完成。");
