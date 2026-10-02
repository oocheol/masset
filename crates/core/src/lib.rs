//! Local project persistence and verified, portable asset bundles.
//!
//! SQLite is the authoritative project snapshot. `project.json` is an atomic,
//! readable mirror that is repaired from SQLite when a project is reopened.
//! Imported and generated artifacts use new UUID directories; originals are
//! never overwritten. Bundle export verifies every file before and after copy.

pub mod models;
mod repository;

pub use repository::{sha256_file, Repository};
