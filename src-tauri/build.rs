use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn required_string<'a>(config: &'a Value, path: &[&str]) -> &'a str {
    let mut value = config;
    for segment in path {
        value = value.get(segment).unwrap_or_else(|| {
            panic!(
                "brand.config.json is missing required field: {}",
                path.join(".")
            )
        });
    }

    let value = value
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            panic!(
                "brand.config.json field must be a non-empty string: {}",
                path.join(".")
            )
        });
    if value != value.trim() || value.contains(['\r', '\n']) {
        panic!(
            "brand.config.json field must be trimmed and single-line: {}",
            path.join(".")
        );
    }
    value
}

fn load_brand_config(manifest_dir: &Path) -> (PathBuf, Value) {
    let path = manifest_dir.join("../src/vvcode/brand.config.json");
    let source = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    let config: Value = serde_json::from_str(&source)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()));
    if config.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        panic!("{} must use schemaVersion 1", path.display());
    }
    (path, config)
}

fn export_brand_config(manifest_dir: &Path) {
    let (path, config) = load_brand_config(manifest_dir);
    let exports = [
        ("PRODUCT_DISPLAY_NAME", &["brand", "name"][..]),
        (
            "PRODUCT_CONFIG_DIR_NAME",
            &["distribution", "configDirName"][..],
        ),
        (
            "PRODUCT_DATABASE_FILENAME",
            &["distribution", "databaseFileName"][..],
        ),
        ("PRODUCT_LOG_FILENAME", &["distribution", "logFileName"][..]),
        ("PRODUCT_SYNC_ROOT", &["distribution", "syncRoot"][..]),
        ("PRODUCT_USER_AGENT", &["distribution", "userAgent"][..]),
        (
            "PRODUCT_GITHUB_RELEASES_API_URL",
            &["repository", "githubReleasesApiUrl"][..],
        ),
        ("PRODUCT_RELEASES_URL", &["repository", "releasesUrl"][..]),
        (
            "PRODUCT_MANAGED_PROVIDER_ID",
            &["compatibility", "managedProviderId"][..],
        ),
    ];

    for (environment_name, field_path) in exports {
        println!(
            "cargo:rustc-env={environment_name}={}",
            required_string(&config, field_path)
        );
    }
    println!("cargo:rerun-if-changed={}", path.display());
}

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    export_brand_config(&manifest_dir);
    tauri_build::build();

    // Windows: Embed Common Controls v6 manifest for test binaries
    //
    // When running `cargo test`, the generated test executables don't include
    // the standard Tauri application manifest. Without Common Controls v6,
    // `tauri::test` calls fail with STATUS_ENTRYPOINT_NOT_FOUND.
    //
    // This workaround:
    // 1. Embeds the manifest into test binaries via /MANIFEST:EMBED
    // 2. Uses /MANIFEST:NO for the main binary to avoid duplicate resources
    //    (Tauri already handles manifest embedding for the app binary)
    #[cfg(target_os = "windows")]
    {
        let manifest_path = manifest_dir.join("common-controls.manifest");
        let manifest_arg = format!("/MANIFESTINPUT:{}", manifest_path.display());

        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg={}", manifest_arg);
        // Avoid duplicate manifest resources in binary builds.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
        println!("cargo:rerun-if-changed={}", manifest_path.display());
    }
}
