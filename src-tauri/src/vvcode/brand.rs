//! Compile-time view of `src/vvcode/brand.config.json`.
//!
//! `build.rs` validates the shared brand document and exports these values to
//! Rust without making reusable CC Switch modules depend on `vvcode`.

pub(crate) const DISPLAY_NAME: &str = env!("PRODUCT_DISPLAY_NAME");
pub(crate) const USER_AGENT: &str = env!("PRODUCT_USER_AGENT");
pub(crate) const GITHUB_RELEASES_API_URL: &str = env!("PRODUCT_GITHUB_RELEASES_API_URL");
pub(crate) const MANAGED_PROVIDER_ID: &str = env!("PRODUCT_MANAGED_PROVIDER_ID");
