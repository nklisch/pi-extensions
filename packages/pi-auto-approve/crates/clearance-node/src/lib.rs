//! Thin Node-API binding for the pure `clearance-core` crate.
//!
//! The binding exposes JSON-shaped parsing, policy, composition, replay, and
//! adversarial seams plus opaque compiled-policy handles. No Pi objects or
//! filesystem I/O cross this boundary.

use clearance_core::{
    analyze_tool, classify_mutation_trust_boundary,
    classify_overlap_json as core_classify_overlap_json, classify_path_fact, classify_stage_effect,
    compile_match, compile_pack, compile_pack_metadata, compose_policy, decide_policy,
    decide_policy_batch, effect_registry, enrich_path_facts, free_policy, health as core_health,
    new_policy, parse_bash, reduce_for_loop_iterator_json as core_reduce_for_loop_iterator_json,
    reduce_iterator_entry_json as core_reduce_iterator_entry_json, stage_file_input_indices,
    validate_pack_against_floor, CompiledPolicyHandle,
};
use napi_derive::napi;

#[napi(object)]
pub struct HealthInfo {
    pub version: String,
    #[napi(js_name = "grammarVersion")]
    pub grammar_version: String,
    pub target: String,
}

#[napi]
pub fn health() -> HealthInfo {
    let info = core_health();

    HealthInfo {
        version: info.version,
        grammar_version: info.grammar_version,
        target: info.target,
    }
}

/// Parse a bash command and return the generated contract as JSON. Keeping the
/// binding JSON-shaped avoids exposing tree-sitter or napi-owned object types.
#[napi(js_name = "compilePack")]
pub fn compile_pack_json(pack: String) -> String {
    let value = serde_json::from_str(&pack).unwrap_or(serde_json::Value::Null);
    compile_pack(&value).to_string()
}

#[napi(js_name = "compileMatch")]
pub fn compile_match_json(matcher: String) -> String {
    let value = serde_json::from_str(&matcher).unwrap_or(serde_json::Value::Null);
    compile_match(&value).to_string()
}

#[napi(js_name = "compilePackMetadata")]
pub fn compile_pack_metadata_json(metadata: String) -> String {
    let value = serde_json::from_str(&metadata).unwrap_or(serde_json::Value::Null);
    compile_pack_metadata(&value).to_string()
}

#[napi(js_name = "createPolicy")]
pub fn create_policy_json(policy: String) -> String {
    let value = serde_json::from_str(&policy).unwrap_or(serde_json::Value::Null);
    match new_policy(&value) {
        Ok(handle) => serde_json::json!({"handle": handle.0.to_string(), "errors": []}).to_string(),
        Err(error) => serde_json::json!({"errors": [error]}).to_string(),
    }
}

#[napi(js_name = "compilePolicy")]
pub fn compile_policy_json(policy: String) -> String {
    create_policy_json(policy)
}

#[napi(js_name = "composePolicy")]
pub fn compose_policy_json(request: String) -> String {
    let value = serde_json::from_str(&request).unwrap_or(serde_json::Value::Null);
    compose_policy(&value).to_string()
}

#[napi(js_name = "validatePackAgainstFloor")]
pub fn validate_pack_against_floor_json(request: String) -> String {
    let value = serde_json::from_str(&request).unwrap_or(serde_json::Value::Null);
    validate_pack_against_floor(&value).to_string()
}

#[napi(js_name = "classifyOverlap")]
pub fn classify_overlap_json(left: String, right: String) -> String {
    let left = serde_json::from_str(&left).unwrap_or(serde_json::Value::Null);
    let right = serde_json::from_str(&right).unwrap_or(serde_json::Value::Null);
    core_classify_overlap_json(&left, &right).to_owned()
}

#[napi(js_name = "validateCompoundAllowCanonicality")]
pub fn validate_compound_allow_canonicality_json(expr: String) -> String {
    let expr = serde_json::from_str(&expr).unwrap_or(serde_json::Value::Null);
    clearance_core::validate_compound_allow_canonicality(&expr).to_string()
}

#[napi(js_name = "freePolicy")]
pub fn free_policy_json(handle: String) -> bool {
    handle
        .parse::<u64>()
        .map(|value| free_policy(CompiledPolicyHandle(value)))
        .unwrap_or(false)
}

#[napi(js_name = "buildCorpusModel")]
pub fn build_corpus_model_json(corpus: String, handle: String, options: Option<String>) -> String {
    let corpus = serde_json::from_str(&corpus).unwrap_or(serde_json::Value::Null);
    let options = options
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let handle = handle.parse::<u64>().unwrap_or(0);
    clearance_core::build_corpus_model(&corpus, CompiledPolicyHandle(handle), &options).to_string()
}

#[napi(js_name = "replayDelta")]
pub fn replay_delta_json(
    corpus: String,
    baseline_handle: String,
    candidate_handle: String,
    options: Option<String>,
) -> String {
    let corpus = serde_json::from_str(&corpus).unwrap_or(serde_json::Value::Null);
    let options = options
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let baseline = baseline_handle.parse::<u64>().unwrap_or(0);
    let candidate = candidate_handle.parse::<u64>().unwrap_or(0);
    clearance_core::replay_delta(
        &corpus,
        CompiledPolicyHandle(baseline),
        CompiledPolicyHandle(candidate),
        &options,
    )
    .to_string()
}

#[napi(js_name = "adversarialValidate")]
pub fn adversarial_validate_json(
    proposal: String,
    baseline_handle: String,
    candidate_handle: Option<String>,
    options: Option<String>,
) -> String {
    let proposal = serde_json::from_str(&proposal).unwrap_or(serde_json::Value::Null);
    let options = options
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let baseline = baseline_handle.parse::<u64>().unwrap_or(0);
    let candidate = candidate_handle.and_then(|value| value.parse::<u64>().ok());
    clearance_core::adversarial_validate(
        &proposal,
        CompiledPolicyHandle(baseline),
        candidate.map(CompiledPolicyHandle),
        &options,
    )
    .to_string()
}

#[napi(js_name = "decide")]
pub fn decide_json(handle: String, shape: String) -> String {
    let parsed_shape = serde_json::from_str(&shape).unwrap_or(serde_json::Value::Null);
    let decision = handle
        .parse::<u64>()
        .map(|value| decide_policy(CompiledPolicyHandle(value), &parsed_shape))
        .unwrap_or_else(|_| serde_json::json!({"effect":"review","reason":"unknown policy handle","provenance":{"source":"default"}}));
    decision.to_string()
}

#[napi(js_name = "match")]
pub fn match_json(matcher: String, shape: String) -> bool {
    let matcher = serde_json::from_str(&matcher).unwrap_or(serde_json::Value::Null);
    let shape = serde_json::from_str(&shape).unwrap_or(serde_json::Value::Null);
    clearance_core::evaluate_matcher(&matcher, &shape)
}

#[napi(js_name = "decideBatch")]
pub fn decide_batch_json(handle: String, shapes: String) -> String {
    let parsed_shapes = serde_json::from_str(&shapes).unwrap_or(serde_json::Value::Null);
    let decisions = handle
        .parse::<u64>()
        .map(|value| decide_policy_batch(CompiledPolicyHandle(value), &parsed_shapes))
        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    decisions.to_string()
}

#[napi(js_name = "parseBash")]
pub fn parse_bash_json(command: String) -> String {
    let mut value =
        serde_json::to_value(parse_bash(&command)).expect("shape contracts are serializable");
    prune_optional_nulls(&mut value);
    value.to_string()
}

/// Analyze a Pi tool input through the native registry.
#[napi(js_name = "analyzeTool")]
pub fn analyze_tool_json(tool_name: String, input: String) -> String {
    let value = serde_json::from_str(&input).unwrap_or(serde_json::Value::Null);
    let mut output = serde_json::to_value(analyze_tool(&tool_name, value))
        .expect("shape contracts are serializable");
    prune_optional_nulls(&mut output);
    output.to_string()
}

#[napi(js_name = "effectRegistry")]
pub fn effect_registry_json() -> String {
    let mut value = effect_registry();
    prune_optional_nulls(&mut value);
    value.to_string()
}

#[napi(js_name = "classifyMutationTrustBoundary")]
pub fn classify_mutation_trust_boundary_json(path: Option<String>, context: String) -> String {
    let value = serde_json::from_str(&context).unwrap_or(serde_json::Value::Null);
    let mut output = serde_json::to_value(classify_mutation_trust_boundary(path.as_deref(), value))
        .expect("trust-boundary classification is serializable");
    prune_optional_nulls(&mut output);
    output.to_string()
}

#[napi(js_name = "stageFileInputIndices")]
pub fn stage_file_input_indices_json(stage: String) -> String {
    let result = serde_json::from_str(&stage)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .map(|stage| stage_file_input_indices(&stage))
        .unwrap_or_default();
    serde_json::to_string(&result).expect("indices are serializable")
}

#[napi(js_name = "enrichPathFacts")]
pub fn enrich_path_facts_json(shape: String, context: String) -> String {
    let parsed_shape = serde_json::from_str(&shape);
    let parsed_context = serde_json::from_str(&context).unwrap_or(serde_json::Value::Null);
    let mut output = match parsed_shape {
        Ok(value) => match serde_json::from_value(value) {
            Ok(shape) => serde_json::to_value(enrich_path_facts(shape, parsed_context))
                .expect("enriched shape is serializable"),
            Err(_) => serde_json::json!({"error": "invalid-tool-shape"}),
        },
        Err(_) => serde_json::json!({"error": "invalid-tool-shape-json"}),
    };
    prune_optional_nulls(&mut output);
    output.to_string()
}

#[napi(js_name = "classifyPathFact")]
pub fn classify_path_fact_json(input: String, context: String) -> String {
    let input = serde_json::from_str(&input).unwrap_or(serde_json::Value::Null);
    let context = serde_json::from_str(&context).unwrap_or(serde_json::Value::Null);
    let mut output = match classify_path_fact(input, context) {
        Ok(fact) => serde_json::to_value(fact).expect("path fact is serializable"),
        Err(error) => serde_json::json!({"error": error}),
    };
    prune_optional_nulls(&mut output);
    output.to_string()
}

#[napi(js_name = "reduceIteratorEntry")]
pub fn reduce_iterator_entry_json(
    entry: String,
    effective_cwd: String,
    context: String,
    home: Option<String>,
) -> String {
    let entry = serde_json::from_str(&entry).unwrap_or(serde_json::Value::Null);
    let context = serde_json::from_str(&context).unwrap_or(serde_json::Value::Null);
    let mut output = match core_reduce_iterator_entry_json(entry, &effective_cwd, context, home) {
        Ok(value) => serde_json::to_value(value).expect("iterator entry is serializable"),
        Err(error) => serde_json::json!({"error": error}),
    };
    prune_optional_nulls(&mut output);
    output.to_string()
}

#[napi(js_name = "reduceForLoopIterator")]
pub fn reduce_for_loop_iterator_json(
    stage: String,
    effective_cwd: String,
    context: String,
    home: Option<String>,
) -> String {
    let stage = serde_json::from_str(&stage).unwrap_or(serde_json::Value::Null);
    let context = serde_json::from_str(&context).unwrap_or(serde_json::Value::Null);
    let mut output = match core_reduce_for_loop_iterator_json(stage, &effective_cwd, context, home)
    {
        Ok(value) => serde_json::to_value(value).expect("iterator reduction is serializable"),
        Err(error) => serde_json::json!({"error": error}),
    };
    prune_optional_nulls(&mut output);
    output.to_string()
}

#[napi(js_name = "classifyStageEffect")]
pub fn classify_stage_effect_json(stage: String) -> String {
    let parsed = serde_json::from_str(&stage);
    let result = match parsed {
        Ok(value) => match serde_json::from_value(value) {
            Ok(stage) => {
                let (class, reason) = classify_stage_effect(&stage);
                serde_json::json!({ "class": class, "reason": reason })
            }
            Err(_) => serde_json::json!({ "class": "unknown", "reason": "invalid-stage" }),
        },
        Err(_) => serde_json::json!({ "class": "unknown", "reason": "invalid-stage" }),
    };
    result.to_string()
}

fn prune_optional_nulls(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for child in map.values_mut() {
                prune_optional_nulls(child);
            }
            map.retain(|key, child| key == "rawInput" || !child.is_null());
        }
        serde_json::Value::Array(values) => {
            for child in values {
                prune_optional_nulls(child);
            }
        }
        _ => {}
    }
}
