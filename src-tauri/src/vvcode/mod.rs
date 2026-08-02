//! VV Code-only backend modules.
//!
//! This directory may depend on reusable CC Switch modules. Shared upstream
//! modules must not depend back on this directory; `lib.rs` is the composition
//! root that registers the product commands and runtime policy.

pub(crate) mod edition;
mod newapi;
mod restore;
mod tool_environment;
pub(crate) mod tray;

pub use newapi::*;
pub use restore::*;
pub use tool_environment::*;
