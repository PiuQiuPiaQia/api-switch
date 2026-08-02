//! VV Code distribution policy.

/// VV Code uses selected CC Switch configuration primitives but does not run
/// the upstream multi-provider import, synchronization, or background workers.
/// Keep this switch in the owned product directory so distribution policy does
/// not become a shared CC Switch concern.
pub(crate) const UPSTREAM_FEATURES_ENABLED: bool = false;
