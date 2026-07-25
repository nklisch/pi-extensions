//! Export the native contract graph for the TypeScript boundary.
//!
//! The output directory is passed explicitly so the drift checker can generate
//! into a temporary directory without mutating the working tree.

use std::env;
use std::path::PathBuf;

use clearance_core::contracts::{
    AdversarialValidationReport, BashCommandShape, BashPathFactContext, BashPathFactProvenance,
    BashPathFacts, BashStage, CompoundBodyReason, CompoundFeatureReason, CompoundIteratorReason,
    CorpusQueryModel, CorpusRecord, Decision, EffectivePolicy, MatcherExpr, PackCompileResult,
    PathFactsResolvedConfig, PathScopeMatcherExpr, PiBuiltinToolSpec, PolicyPack, ReplayCorpus,
    ReplayDelta, ToolPathFactContext, ToolShape,
};
use ts_rs::{Config, TS};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: export-contracts <output-directory>")?;
    std::fs::create_dir_all(&output)?;

    let config = Config::from_env()
        .with_out_dir(output)
        .with_import_extension(Some("ts"));

    BashCommandShape::export_all(&config)?;
    BashPathFactContext::export_all(&config)?;
    BashPathFacts::export_all(&config)?;
    BashPathFactProvenance::export_all(&config)?;
    CompoundIteratorReason::export_all(&config)?;
    CompoundBodyReason::export_all(&config)?;
    CompoundFeatureReason::export_all(&config)?;
    PathFactsResolvedConfig::export_all(&config)?;
    PiBuiltinToolSpec::export_all(&config)?;
    ToolPathFactContext::export_all(&config)?;
    ToolShape::export_all(&config)?;
    BashStage::export_all(&config)?;
    PathScopeMatcherExpr::export_all(&config)?;
    MatcherExpr::export_all(&config)?;
    Decision::export_all(&config)?;
    PolicyPack::export_all(&config)?;
    EffectivePolicy::export_all(&config)?;
    PackCompileResult::export_all(&config)?;
    ReplayCorpus::export_all(&config)?;
    CorpusRecord::export_all(&config)?;
    CorpusQueryModel::export_all(&config)?;
    ReplayDelta::export_all(&config)?;
    AdversarialValidationReport::export_all(&config)?;

    Ok(())
}
