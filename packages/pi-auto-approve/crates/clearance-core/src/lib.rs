//! Pure native clearance engine.
//!
//! The crate remains free of Node and filesystem APIs. Parser projection,
//! lexical path-fact derivation, typed matcher/policy evaluation, sealed
//! composition, replay, and adversarial kernels are native capabilities.

mod analyzer;
pub mod composition;
pub mod contracts;
mod parser;
pub mod path_facts;
mod policy;
pub mod replay;

pub use analyzer::{
    analyze_tool, classify_mutation_trust_boundary, classify_stage_effect, effect_registry,
    stage_file_input_indices,
};
pub use composition::{
    classify_overlap_json, compose_policy, validate_compound_allow_canonicality,
    validate_pack_against_floor,
};
pub use parser::parse_bash;
pub use path_facts::{
    classify_path_fact, enrich_path_facts, reduce_for_loop_iterator_json,
    reduce_iterator_entry_json,
};
pub use policy::{
    compile_match, compile_pack, compile_pack_metadata, decide_policy, decide_policy_batch,
    evaluate_matcher, free_policy, new_policy, CompiledPolicyHandle,
};
pub use replay::{adversarial_validate, build_corpus_model, replay_delta};

/// Version of the native engine contract.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Crates.io grammar revision reserved for the native parser slice.
pub const GRAMMAR_VERSION: &str = "tree-sitter-bash@0.25.1";

/// Build metadata returned by the binding's health endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthInfo {
    pub version: String,
    pub grammar_version: String,
    pub target: String,
}

/// Return static engine/build information without performing I/O.
pub fn health() -> HealthInfo {
    HealthInfo {
        version: ENGINE_VERSION.to_owned(),
        grammar_version: GRAMMAR_VERSION.to_owned(),
        target: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
    }
}

#[cfg(test)]
mod tests {
    use super::{health, ENGINE_VERSION, GRAMMAR_VERSION};

    #[test]
    fn health_reports_the_pinned_engine_and_grammar() {
        let info = health();

        assert_eq!(info.version, ENGINE_VERSION);
        assert_eq!(info.grammar_version, GRAMMAR_VERSION);
        assert!(!info.target.is_empty());
    }
}
