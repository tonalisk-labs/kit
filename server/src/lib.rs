//! What the backends share: configuration loading, a Stripe client with its webhook signature
//! check, rate limits, problem details, the stop signal, the `OpenAPI` export and, for their
//! tests, how work grows in processor time.

pub mod config;
#[cfg(feature = "growth")]
pub mod growth;
pub mod limit;
pub mod openapi;
pub mod problem;
pub mod shutdown;
pub mod stripe;
pub mod sync;
