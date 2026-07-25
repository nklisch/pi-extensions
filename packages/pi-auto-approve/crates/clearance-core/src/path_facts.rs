//! Native lexical path-fact derivation.
//!
//! This module is deliberately filesystem-free. It mirrors the former
//! TypeScript path-facts classifier over the generated shape contracts: paths
//! are decoded and normalized lexically, then classified against the configured
//! scope lattice. No glob expansion, realpath, stat, or symlink resolution is
//! performed here.

use crate::analyzer::{
    classify_mutation_trust_boundary, classify_stage_effect, stage_file_input_indices,
};
use crate::contracts::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathContext {
    pub cwd: String,
    pub project_scope: PathFactProjectScope,
    #[serde(default)]
    pub home_directory: Option<String>,
    #[serde(default)]
    pub system_path_prefixes: Option<Vec<String>>,
}

impl PathContext {
    fn from_value(value: Value) -> Result<Self, String> {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    fn normalized_home(&self) -> Option<String> {
        self.home_directory
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(normalize_path)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPathFactInput {
    pub raw: String,
    pub usage: PathUsageKind,
    pub access: PathAccess,
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub stage_index: Option<u32>,
    pub source: SourceSpan,
    #[serde(default)]
    pub effective_cwd: Option<String>,
    #[serde(default)]
    pub unresolved_cwd_prefix: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IteratorReduction {
    pub source_kind: IteratorSourceKind,
    pub entries: Vec<BashPathFactProvenanceEntry>,
    pub scope: PathScope,
    pub matched_scopes: Vec<PathScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concrete_absolute_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub static_prefix_absolute_path: Option<String>,
    pub glob_approximation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unknown_reason: Option<LoopVariableUnknownReason>,
}

pub fn enrich_path_facts(shape: ToolShape, context_value: Value) -> ToolShape {
    if matches!(shape, ToolShape::Unknown(_)) {
        return shape;
    }
    let context = match PathContext::from_value(context_value) {
        Ok(context) => context,
        Err(error) => return append_context_error(shape, &error),
    };
    enrich_with_context(shape, &context)
}

pub fn classify_path_fact(
    input_value: Value,
    context_value: Value,
) -> Result<BashPathFact, String> {
    let input: RawPathFactInput =
        serde_json::from_value(input_value).map_err(|error| error.to_string())?;
    let context = PathContext::from_value(context_value)?;
    Ok(classify_bash_path_fact(&input, &context))
}

pub fn reduce_iterator_entry_json(
    entry_value: Value,
    effective_cwd: &str,
    context_value: Value,
    home: Option<String>,
) -> Result<BashPathFactProvenanceEntry, String> {
    let entry: BashIteratorEntry =
        serde_json::from_value(entry_value).map_err(|error| error.to_string())?;
    let context = PathContext::from_value(context_value)?;
    Ok(reduce_iterator_entry(
        &entry,
        effective_cwd,
        &context,
        home.as_deref(),
    ))
}

pub fn reduce_for_loop_iterator_json(
    stage_value: Value,
    effective_cwd: &str,
    context_value: Value,
    home: Option<String>,
) -> Result<IteratorReduction, String> {
    let stage: BashStage =
        serde_json::from_value(stage_value).map_err(|error| error.to_string())?;
    let BashStage::ForLoop { .. } = stage else {
        return Err("iterator reduction requires a for-loop stage".into());
    };
    let context = PathContext::from_value(context_value)?;
    Ok(reduce_for_loop_iterator(
        &stage,
        effective_cwd,
        &context,
        home.as_deref(),
    ))
}

fn append_context_error(shape: ToolShape, error: &str) -> ToolShape {
    let diagnostic = ShapeDiagnostic {
        code: match &shape {
            ToolShape::Bash(_) => "bash:path-facts-error",
            ToolShape::PiTool(_) => "pi-tool:path-facts-error",
            ToolShape::Unknown(_) => "unknown:path-facts-error",
        }
        .into(),
        severity: DiagnosticSeverity::Error,
        message: format!("path fact derivation failed closed: {error}"),
        source: None,
    };
    match shape {
        ToolShape::Bash(mut shape) => {
            shape.diagnostics.push(diagnostic);
            ToolShape::Bash(shape)
        }
        ToolShape::PiTool(mut shape) => {
            shape.diagnostics.push(diagnostic);
            ToolShape::PiTool(shape)
        }
        ToolShape::Unknown(mut shape) => {
            shape.diagnostics.push(diagnostic);
            ToolShape::Unknown(shape)
        }
    }
}

fn enrich_with_context(shape: ToolShape, context: &PathContext) -> ToolShape {
    match shape {
        ToolShape::Bash(mut shape) => {
            shape.path_facts = Some(derive_bash_path_facts(&shape, context));
            ToolShape::Bash(shape)
        }
        ToolShape::PiTool(mut shape) => {
            let path_facts = derive_pi_path_facts(&shape, context);
            if shape.mutation_facts.is_some() {
                let path = path_facts
                    .facts
                    .first()
                    .and_then(|fact| fact.absolute_path.as_deref());
                let context_value = serde_json::to_value(context).unwrap_or(Value::Null);
                shape.trust_boundary = Some(classify_mutation_trust_boundary(path, context_value));
            }
            shape.path_facts = Some(path_facts.clone());

            if let Some(mut embedded) = shape.embedded_shell.take() {
                let working_directory_fact =
                    embedded
                        .working_directory
                        .as_deref()
                        .and_then(|working_directory| {
                            path_facts
                                .facts
                                .iter()
                                .find(|fact| {
                                    fact.usage == ToolPathUsage::Argument
                                        && fact.raw == working_directory
                                })
                                .cloned()
                        });
                let embedded_cwd = working_directory_fact
                    .as_ref()
                    .and_then(|fact| fact.absolute_path.clone())
                    .unwrap_or_else(|| context.cwd.clone());
                if let Some(command) = embedded.command.take() {
                    let mut embedded_context = context.clone();
                    embedded_context.cwd = embedded_cwd;
                    let enriched =
                        enrich_with_context(ToolShape::Bash(*command), &embedded_context);
                    if let ToolShape::Bash(command) = enriched {
                        embedded.command = Some(Box::new(command));
                    }
                }
                embedded.working_directory_fact = working_directory_fact;
                shape.embedded_shell = Some(embedded);
            }
            ToolShape::PiTool(shape)
        }
        ToolShape::Unknown(shape) => ToolShape::Unknown(shape),
    }
}

fn derive_bash_path_facts(shape: &BashCommandShape, context: &PathContext) -> BashPathFacts {
    let base_cwd = normalize_path(&context.cwd);
    let mut facts = Vec::new();
    let mut effective_cwd = base_cwd.clone();
    let mut cwd_prefix_fact = None;
    let mut cwd_prefix_unknown = false;

    if let Some(cwd_prefix) = shape.cwd_prefix.as_deref() {
        let input = RawPathFactInput {
            raw: cwd_prefix.into(),
            usage: PathUsageKind::CwdPrefix,
            access: PathAccess::Cwd,
            program: Some("cd".into()),
            stage_index: None,
            source: cwd_prefix_span(&shape.raw_command, cwd_prefix),
            effective_cwd: None,
            unresolved_cwd_prefix: None,
        };
        let fact = classify_bash_path_fact(&input, context);
        if fact.unknown_reason.is_none() {
            if let Some(path) = fact.absolute_path.clone() {
                effective_cwd = path;
            }
        } else {
            cwd_prefix_unknown = true;
        }
        cwd_prefix_fact = Some(fact.clone());
        facts.push(fact);
    } else if shape
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "bash:cwd-prefix-unsupported")
    {
        cwd_prefix_unknown = true;
    }

    for (stage_index, stage) in shape.stages.iter().enumerate() {
        let BashStage::Command { program, .. } = stage else {
            continue;
        };
        let stage_index = stage_index as u32;
        let mut candidates = Vec::new();
        if let Some(extractor_candidates) =
            extract_stage_candidates(&shape.raw_command, stage, stage_index)
        {
            candidates.extend(extractor_candidates);
        }
        candidates.extend(extract_redirect_candidates(stage, stage_index));
        for candidate in candidates {
            let fact = if candidate.usage == PathUsageKind::ImplicitTemp {
                implicit_temp_fact(&candidate)
            } else {
                let input = RawPathFactInput {
                    raw: candidate.raw,
                    usage: candidate.usage,
                    access: candidate.access,
                    program: candidate.program,
                    stage_index: candidate.stage_index,
                    source: candidate.source,
                    effective_cwd: Some(effective_cwd.clone()),
                    unresolved_cwd_prefix: Some(cwd_prefix_unknown),
                };
                classify_bash_path_fact(&input, context)
            };
            facts.push(fact);
        }

        let stage_changes_cwd = program.program == "cd";
        if stage_changes_cwd {
            cwd_prefix_unknown = true;
        }

        if classify_stage_effect(stage).0 == "read-only" {
            let indices = stage_file_input_indices(stage);
            if !indices.is_empty() {
                let mut cursor = recover_cursor(stage);
                for argument_index in indices {
                    let Some(raw) = program.arguments.get(argument_index as usize) else {
                        continue;
                    };
                    let source = recover_operand_span(&shape.raw_command, stage, &mut cursor, raw);
                    let input = RawPathFactInput {
                        raw: raw.clone(),
                        usage: PathUsageKind::Argument,
                        access: PathAccess::Read,
                        program: Some(program.program.clone()),
                        stage_index: Some(stage_index),
                        source,
                        effective_cwd: Some(effective_cwd.clone()),
                        unresolved_cwd_prefix: Some(cwd_prefix_unknown),
                    };
                    facts.push(classify_bash_path_fact(&input, context));
                }
            }
        }
    }

    if !has_unsupported_compound_diagnostic(shape) {
        let mut reductions = HashMap::new();
        for (stage_index, stage) in shape.stages.iter().enumerate() {
            facts.extend(derive_compound_stage_facts(
                stage,
                CompoundInput {
                    owner_stage_index: stage_index as u32,
                    raw_command: &shape.raw_command,
                    effective_cwd: &effective_cwd,
                    context,
                    cwd_prefix_unknown,
                    reductions: &mut reductions,
                    loop_stage: None,
                },
            ));
        }
    }

    BashPathFacts {
        base_cwd,
        effective_cwd,
        cwd_prefix: cwd_prefix_fact,
        has_unknown: facts.iter().any(|fact| fact.scope == PathScope::Unknown),
        has_denied: facts.iter().any(|fact| fact.scope == PathScope::Denied),
        has_outside_project: facts.iter().any(|fact| fact.scope == PathScope::Outside),
        has_system_path: facts.iter().any(|fact| fact.scope == PathScope::System),
        facts,
    }
}

fn derive_pi_path_facts(shape: &PiBuiltinToolShape, context: &PathContext) -> ToolPathFacts {
    let base_cwd = normalize_path(&context.cwd);
    let access = match shape.mutation_facts.as_ref() {
        None => ToolPathAccess::Read,
        Some(PiToolMutationFacts::Write { .. }) => ToolPathAccess::Create,
        Some(PiToolMutationFacts::Edit { .. }) => ToolPathAccess::Write,
    };
    let inputs: Vec<(String, ToolPathUsage)> = if shape.path_inputs.is_empty() {
        if !shape.diagnostics.is_empty() || shape.mutation_facts.is_some() {
            Vec::new()
        } else {
            vec![(".".into(), ToolPathUsage::ImplicitCwd)]
        }
    } else {
        shape
            .path_inputs
            .iter()
            .map(|input| (input.raw.clone(), ToolPathUsage::Argument))
            .collect()
    };
    let facts = inputs
        .into_iter()
        .enumerate()
        .map(|(index, (raw, usage))| {
            classify_pi_path_fact(
                &raw,
                usage,
                access,
                &shape.tool_name,
                index,
                &base_cwd,
                context,
            )
        })
        .collect::<Vec<_>>();
    ToolPathFacts {
        base_cwd: base_cwd.clone(),
        effective_cwd: base_cwd,
        has_unknown: facts.iter().any(|fact| fact.scope == PathScope::Unknown),
        has_denied: facts.iter().any(|fact| fact.scope == PathScope::Denied),
        has_outside_project: facts.iter().any(|fact| fact.scope == PathScope::Outside),
        has_system_path: facts.iter().any(|fact| fact.scope == PathScope::System),
        facts,
    }
}

fn classify_pi_path_fact(
    raw: &str,
    usage: ToolPathUsage,
    access: ToolPathAccess,
    tool_name: &str,
    index: usize,
    base_cwd: &str,
    context: &PathContext,
) -> ToolPathFact {
    if raw.is_empty() {
        return unknown_pi_path_fact(
            raw,
            usage,
            access,
            tool_name,
            index,
            PathUnknownReason::MissingOperand,
            false,
        );
    }
    let home = context.normalized_home();
    let decoded = decode_structured_path_literal(raw, home.as_deref());
    if let Some(reason) = decoded.unknown_reason {
        return unknown_pi_path_fact(
            raw,
            usage,
            access,
            tool_name,
            index,
            reason,
            decoded.dynamic,
        );
    }
    let literal = decoded.literal.unwrap_or_default();
    if literal.is_empty() {
        return unknown_pi_path_fact(
            raw,
            usage,
            access,
            tool_name,
            index,
            PathUnknownReason::UnsupportedShellLiteral,
            false,
        );
    }
    let absolute = resolve_path(base_cwd, &literal);
    let (scope, matched_scopes) = classify_scope(&absolute, context, home.as_deref());
    ToolPathFact {
        id: format!("path:{tool_name}:{}:{index}", usage_string(usage)),
        tool_name: Some(tool_name.into()),
        usage,
        access,
        raw: raw.into(),
        literal: Some(literal.clone()),
        absolute_path: Some(absolute),
        scope,
        matched_scopes,
        normalization: PathNormalization::Lexical,
        is_absolute: is_absolute(&literal),
        is_relative: !is_absolute(&literal),
        has_parent_traversal: contains_parent_traversal(&literal),
        dynamic: false,
        unknown_reason: None,
    }
}

fn unknown_pi_path_fact(
    raw: &str,
    usage: ToolPathUsage,
    access: ToolPathAccess,
    tool_name: &str,
    index: usize,
    reason: PathUnknownReason,
    dynamic: bool,
) -> ToolPathFact {
    ToolPathFact {
        id: format!("path:{tool_name}:{}:{index}", usage_string(usage)),
        tool_name: Some(tool_name.into()),
        usage,
        access,
        raw: raw.into(),
        literal: None,
        absolute_path: None,
        scope: PathScope::Unknown,
        matched_scopes: vec![PathScope::Unknown],
        normalization: PathNormalization::Lexical,
        is_absolute: false,
        is_relative: false,
        has_parent_traversal: false,
        dynamic,
        unknown_reason: Some(reason),
    }
}

fn usage_string(usage: ToolPathUsage) -> &'static str {
    match usage {
        ToolPathUsage::Argument => "argument",
        ToolPathUsage::ImplicitCwd => "implicit-cwd",
    }
}

struct DecodedPath {
    literal: Option<String>,
    quote: QuoteKind,
    dynamic: bool,
    unknown_reason: Option<PathUnknownReason>,
    is_absolute: bool,
    is_relative: bool,
    has_parent_traversal: bool,
}

fn decode_structured_path_literal(raw: &str, home: Option<&str>) -> DecodedPath {
    if raw.contains('$') || raw.contains('`') || raw.contains("$(") || raw.contains("<(") {
        return unknown_decoded(PathUnknownReason::DynamicExpansion, true);
    }
    if raw.chars().any(|ch| matches!(ch, '*' | '?' | '[' | ']')) {
        return unknown_decoded(PathUnknownReason::GlobExpansion, true);
    }
    if raw
        .find('{')
        .is_some_and(|index| contains_brace_expansion(raw, index))
    {
        return unknown_decoded(PathUnknownReason::BraceExpansion, true);
    }
    if let Some(rest) = raw.strip_prefix('~') {
        if rest.is_empty() || rest.starts_with('/') {
            let Some(home) = home else {
                return unknown_decoded(PathUnknownReason::UnsupportedShellLiteral, false);
            };
            return DecodedPath {
                literal: Some(format!("{home}{rest}")),
                quote: QuoteKind::None,
                dynamic: false,
                unknown_reason: None,
                is_absolute: true,
                is_relative: false,
                has_parent_traversal: contains_parent_traversal(rest),
            };
        }
        return unknown_decoded(PathUnknownReason::UnsupportedShellLiteral, true);
    }
    if raw.contains('\0') {
        return unknown_decoded(PathUnknownReason::UnsupportedShellLiteral, false);
    }
    DecodedPath {
        literal: Some(raw.into()),
        quote: QuoteKind::None,
        dynamic: false,
        unknown_reason: None,
        is_absolute: is_absolute(raw),
        is_relative: !is_absolute(raw),
        has_parent_traversal: contains_parent_traversal(raw),
    }
}

fn unknown_decoded(reason: PathUnknownReason, dynamic: bool) -> DecodedPath {
    DecodedPath {
        literal: None,
        quote: QuoteKind::None,
        dynamic,
        unknown_reason: Some(reason),
        is_absolute: false,
        is_relative: false,
        has_parent_traversal: false,
    }
}

fn classify_bash_path_fact(input: &RawPathFactInput, context: &PathContext) -> BashPathFact {
    if input.raw.is_empty() {
        return unknown_path_fact(input, PathUnknownReason::MissingOperand, false);
    }
    let home = context.normalized_home();
    let mut raw_for_decode = input.raw.clone();
    if let Some(remainder) = leading_tmpdir_remainder(&input.raw) {
        let Some(temp_directory) = context.project_scope.temp_directories.first() else {
            return unknown_path_fact(input, PathUnknownReason::UnsupportedShellLiteral, false);
        };
        if contains_raw_parent_traversal(&remainder) {
            return unknown_path_fact(input, PathUnknownReason::UnsupportedShellLiteral, false);
        }
        raw_for_decode = join_path(&normalize_path(temp_directory), &remainder);
    }
    let decoded = decode_shell_literal(&raw_for_decode, home.as_deref());
    if let Some(reason) = decoded.unknown_reason {
        return unknown_path_fact(input, reason, decoded.dynamic);
    }
    let literal = decoded.literal.clone().unwrap_or_default();
    if literal.is_empty() {
        return unknown_path_fact(input, PathUnknownReason::UnsupportedShellLiteral, false);
    }
    if input.unresolved_cwd_prefix.unwrap_or(false) && decoded.is_relative {
        return BashPathFact {
            id: fact_id(input),
            stage_index: input.stage_index,
            program: input.program.clone(),
            usage: input.usage,
            access: input.access,
            raw: input.raw.clone(),
            literal: None,
            absolute_path: None,
            scope: PathScope::Unknown,
            matched_scopes: vec![PathScope::Unknown],
            normalization: PathNormalization::Lexical,
            is_absolute: false,
            is_relative: true,
            has_parent_traversal: decoded.has_parent_traversal,
            quote: decoded.quote,
            dynamic: false,
            unknown_reason: Some(PathUnknownReason::UnresolvedCwdPrefix),
            source: input.source,
            provenance: None,
            glob_approximation: None,
        };
    }
    let cwd = input.effective_cwd.as_deref().unwrap_or(&context.cwd);
    let absolute = resolve_path(cwd, &literal);
    let (scope, matched_scopes) = classify_scope(&absolute, context, home.as_deref());
    BashPathFact {
        id: fact_id(input),
        stage_index: input.stage_index,
        program: input.program.clone(),
        usage: input.usage,
        access: input.access,
        raw: input.raw.clone(),
        literal: Some(literal),
        absolute_path: Some(absolute),
        scope,
        matched_scopes,
        normalization: PathNormalization::Lexical,
        is_absolute: decoded.is_absolute,
        is_relative: decoded.is_relative,
        has_parent_traversal: decoded.has_parent_traversal,
        quote: decoded.quote,
        dynamic: false,
        unknown_reason: None,
        source: input.source,
        provenance: None,
        glob_approximation: None,
    }
}

fn unknown_path_fact(
    input: &RawPathFactInput,
    reason: PathUnknownReason,
    dynamic: bool,
) -> BashPathFact {
    BashPathFact {
        id: fact_id(input),
        stage_index: input.stage_index,
        program: input.program.clone(),
        usage: input.usage,
        access: input.access,
        raw: input.raw.clone(),
        literal: None,
        absolute_path: None,
        scope: PathScope::Unknown,
        matched_scopes: vec![PathScope::Unknown],
        normalization: PathNormalization::Lexical,
        is_absolute: false,
        is_relative: false,
        has_parent_traversal: false,
        quote: QuoteKind::None,
        dynamic,
        unknown_reason: Some(reason),
        source: input.source,
        provenance: None,
        glob_approximation: None,
    }
}

fn fact_id(input: &RawPathFactInput) -> String {
    let stage = input
        .stage_index
        .map(|value| value.to_string())
        .unwrap_or_else(|| "cwd".into());
    format!(
        "path:{}:{stage}:{}:{}",
        path_usage_string(input.usage),
        input.source.start,
        input.source.end
    )
}

fn path_usage_string(usage: PathUsageKind) -> &'static str {
    match usage {
        PathUsageKind::CwdPrefix => "cwd-prefix",
        PathUsageKind::Argument => "argument",
        PathUsageKind::FlagValue => "flag-value",
        PathUsageKind::RedirectTarget => "redirect-target",
        PathUsageKind::ImplicitTemp => "implicit-temp",
    }
}

fn leading_tmpdir_remainder(raw: &str) -> Option<String> {
    let candidate = if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        &raw[1..raw.len() - 1]
    } else {
        raw
    };
    candidate
        .strip_prefix("$TMPDIR/")
        .or_else(|| candidate.strip_prefix("${TMPDIR}/"))
        .map(str::to_owned)
}

fn classify_scope(
    absolute: &str,
    context: &PathContext,
    home: Option<&str>,
) -> (PathScope, Vec<PathScope>) {
    let project = &context.project_scope;
    let mut matched = Vec::new();
    if within_any(absolute, &project.denied_directories) {
        matched.push(PathScope::Denied);
    }
    if within_any(absolute, &project.writable_directories) {
        matched.push(PathScope::WritableProject);
    }
    if within_any(absolute, &project.roots) {
        matched.push(PathScope::Project);
    }
    if within_any(absolute, &project.temp_directories) {
        matched.push(PathScope::Temp);
    }

    let in_home = home.is_some_and(|home| within(absolute, home));
    let sensitive = in_home && is_sensitive_home_path(absolute, home);
    if sensitive {
        matched.push(PathScope::SensitiveHome);
    }
    if within_any(
        absolute,
        project.agent_support_directories.as_deref().unwrap_or(&[]),
    ) && !sensitive
    {
        matched.push(PathScope::AgentSupport);
    }
    if in_home && !sensitive {
        if within_any(absolute, &project.safe_home_directories) {
            matched.push(PathScope::SafeHome);
        } else {
            matched.push(PathScope::Home);
        }
    }
    let prefixes = context
        .system_path_prefixes
        .clone()
        .unwrap_or_else(|| default_system_path_prefixes().to_vec());
    if within_any(absolute, &prefixes) {
        matched.push(PathScope::System);
    }
    if matched.is_empty() {
        matched.push(PathScope::Outside);
    }
    (matched[0], matched)
}

fn default_system_path_prefixes() -> &'static [String] {
    // This is allocated once per process and intentionally excludes /tmp: the
    // resolved project scope owns temp precedence over ambient system roots.
    static PREFIXES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    PREFIXES.get_or_init(|| {
        [
            "/etc", "/usr", "/bin", "/sbin", "/var", "/dev", "/proc", "/sys", "/boot", "/lib",
            "/lib64", "/opt",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    })
}

fn is_sensitive_home_path(absolute: &str, home: Option<&str>) -> bool {
    let Some(home) = home else { return false };
    let normalized_absolute = normalize_mixed_path(absolute);
    let normalized_home = normalize_mixed_path(home);
    if !within(&normalized_absolute, &normalized_home) || normalized_absolute == normalized_home {
        return false;
    }
    let relative = normalized_absolute
        .strip_prefix(&normalized_home)
        .unwrap_or("")
        .trim_start_matches('/');
    let parts = path_segments(relative);
    let basename = parts.last().map(String::as_str).unwrap_or("");
    let sensitive_dirs: &[&[&str]] = &[
        &[".ssh"],
        &[".gnupg"],
        &[".config", "gnupg"],
        &[".aws"],
        &[".config", "systemd"],
        &[".config", "keyring"],
        &[".password-store"],
        &[".docker"],
        &[".kube"],
        &[".config", "gcloud"],
        &[".azure"],
    ];
    if sensitive_dirs
        .iter()
        .any(|prefix| starts_with_segments(&parts, prefix))
    {
        return true;
    }
    let exact_paths: &[&[&str]] = &[
        &[".pi", "agent", "auth.json"],
        &[".pi", "agent", "models.json"],
        &[".config", "gh", "hosts.yml"],
        &[".config", "gh", "hosts.yaml"],
        &[".config", "glab", "hosts.yml"],
        &[".config", "glab", "hosts.yaml"],
        &[".config", "glab-cli", "hosts.yml"],
        &[".config", "glab-cli", "hosts.yaml"],
        &[".cargo", "credentials.toml"],
    ];
    if exact_paths
        .iter()
        .any(|expected| parts.as_slice() == *expected)
    {
        return true;
    }
    let home_names = [".netrc", ".env", ".npmrc", ".pypirc"];
    if home_names.contains(&basename) || basename.starts_with(".env.") {
        return true;
    }
    let dot_file_names = [
        "access_token",
        "access_token.json",
        "access_tokens",
        "access_tokens.db",
        "access_tokens.json",
        "accessTokens.json",
        "api-key",
        "api-key.json",
        "api_key",
        "api_key.json",
        "apikey",
        "apikey.json",
        "auth",
        "auth.json",
        "auth.yml",
        "auth.yaml",
        "credential",
        "credential.yml",
        "credential.yaml",
        "credentials",
        "credentials.db",
        "credentials.json",
        "credentials.toml",
        "credentials.yml",
        "credentials.yaml",
        "oauth.json",
        "oauth_tokens.json",
        "refresh_token",
        "refresh_token.json",
        "refresh_tokens",
        "refresh_tokens.json",
        "secret",
        "secrets",
        "secrets.json",
        "token",
        "token.db",
        "token.json",
        "tokens",
        "tokens.db",
        "tokens.json",
    ];
    parts
        .first()
        .is_some_and(|segment| segment.starts_with('.'))
        && (is_key_material_name(basename) || dot_file_names.contains(&basename))
}

fn is_key_material_name(name: &str) -> bool {
    name.ends_with(".pem")
        || name.ends_with(".key")
        || name == "id_rsa"
        || name.starts_with("id_")
        || name.ends_with("_rsa")
        || name.ends_with("_ed25519")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
}

fn extract_stage_candidates(
    raw_command: &str,
    stage: &BashStage,
    stage_index: u32,
) -> Option<Vec<PathCandidate>> {
    let BashStage::Command { program, span, .. } = stage else {
        return None;
    };
    let p = program.program.as_str();
    let mut cursor = recover_cursor(stage);
    let result = match p {
        "mkdir" => extract_operands(OperandExtraction {
            program,
            args: &program.arguments,
            stage,
            stage_index,
            raw_command,
            cursor: &mut cursor,
            access: AccessDisposition::Create,
            name: "mkdir",
        }),
        "touch" => extract_operands(OperandExtraction {
            program,
            args: &program.arguments,
            stage,
            stage_index,
            raw_command,
            cursor: &mut cursor,
            access: AccessDisposition::Write,
            name: "touch",
        }),
        "mktemp" => {
            let (mut candidates, emitted_operand, emitted_temp_dir) =
                extract_operands_with_flags(OperandExtraction {
                    program,
                    args: &program.arguments,
                    stage,
                    stage_index,
                    raw_command,
                    cursor: &mut cursor,
                    access: AccessDisposition::Create,
                    name: "mktemp",
                });
            if !emitted_operand && !emitted_temp_dir {
                candidates.push(PathCandidate {
                    usage: PathUsageKind::ImplicitTemp,
                    access: PathAccess::Temp,
                    raw: String::new(),
                    program: Some(p.into()),
                    stage_index: Some(stage_index),
                    source: *span,
                });
            }
            candidates
        }
        "cargo" if program.arguments.first().is_some_and(|arg| arg == "fmt") => {
            extract_operands(OperandExtraction {
                program,
                args: &program.arguments[1..],
                stage,
                stage_index,
                raw_command,
                cursor: &mut cursor,
                access: AccessDisposition::Write,
                name: "cargo",
            })
        }
        "biome" if program.flags.iter().any(|flag| flag.name == "write") => {
            let args = skip_subcommand_args(
                &program.arguments,
                &["check", "format", "lint", "migrate", "rage", "ci"],
            );
            extract_operands(OperandExtraction {
                program,
                args,
                stage,
                stage_index,
                raw_command,
                cursor: &mut cursor,
                access: AccessDisposition::Write,
                name: "biome",
            })
        }
        "prettier" if program.flags.iter().any(|flag| flag.name == "write") => {
            extract_operands(OperandExtraction {
                program,
                args: &program.arguments,
                stage,
                stage_index,
                raw_command,
                cursor: &mut cursor,
                access: AccessDisposition::Write,
                name: "prettier",
            })
        }
        "eslint" if program.flags.iter().any(|flag| flag.name == "fix") => {
            extract_operands(OperandExtraction {
                program,
                args: &program.arguments,
                stage,
                stage_index,
                raw_command,
                cursor: &mut cursor,
                access: AccessDisposition::Write,
                name: "eslint",
            })
        }
        "ruff"
            if program.arguments.first().is_some_and(|arg| arg == "check")
                && program.flags.iter().any(|flag| flag.name == "fix") =>
        {
            extract_operands(OperandExtraction {
                program,
                args: &program.arguments[1..],
                stage,
                stage_index,
                raw_command,
                cursor: &mut cursor,
                access: AccessDisposition::Write,
                name: "ruff",
            })
        }
        _ => return None,
    };
    Some(result)
}

fn skip_subcommand_args<'a>(args: &'a [String], subcommands: &[&str]) -> &'a [String] {
    if args
        .first()
        .is_some_and(|arg| subcommands.contains(&arg.as_str()))
    {
        &args[1..]
    } else {
        args
    }
}

#[derive(Clone, Copy)]
enum AccessDisposition {
    Create,
    Write,
}

struct OperandExtraction<'a> {
    program: &'a BashStageProgram,
    args: &'a [String],
    stage: &'a BashStage,
    stage_index: u32,
    raw_command: &'a str,
    cursor: &'a mut usize,
    access: AccessDisposition,
    name: &'a str,
}

fn extract_operands(input: OperandExtraction<'_>) -> Vec<PathCandidate> {
    extract_operands_with_flags(input).0
}

fn extract_operands_with_flags(input: OperandExtraction<'_>) -> (Vec<PathCandidate>, bool, bool) {
    let mut operands = input
        .args
        .iter()
        .map(|raw| Operand {
            raw: raw.clone(),
            source: recover_operand_span(input.raw_command, input.stage, input.cursor, raw),
            claimed: false,
        })
        .collect::<Vec<_>>();
    let terminator = input.program.flags.iter().position(|flag| flag.raw == "--");
    let option_flags = terminator
        .map(|index| &input.program.flags[..index])
        .unwrap_or(&input.program.flags);
    let post_flags = terminator
        .map(|index| &input.program.flags[index + 1..])
        .unwrap_or(&[]);
    let mut candidates = Vec::new();
    let mut emitted_operand = false;
    let mut emitted_temp_dir = false;
    for flag in option_flags {
        let Some((disposition, inline_only)) = value_flag_spec(input.name, &flag.name) else {
            continue;
        };
        if let Some(value) = flag.value.as_deref() {
            if disposition == ValueDisposition::Skip {
                continue;
            }
            candidates.push(PathCandidate {
                usage: PathUsageKind::FlagValue,
                access: disposition_access(disposition),
                raw: value.into(),
                program: Some(input.program.program.clone()),
                stage_index: Some(input.stage_index),
                source: flag.span,
            });
            if disposition == ValueDisposition::Temp {
                emitted_temp_dir = true;
            }
            continue;
        }
        if inline_only {
            continue;
        }
        let Some(index) = operands
            .iter()
            .position(|operand| !operand.claimed && operand.source.start >= flag.span.end)
        else {
            continue;
        };
        operands[index].claimed = true;
        if disposition == ValueDisposition::Skip {
            continue;
        }
        let operand = &operands[index];
        candidates.push(PathCandidate {
            usage: PathUsageKind::FlagValue,
            access: disposition_access(disposition),
            raw: operand.raw.clone(),
            program: Some(input.program.program.clone()),
            stage_index: Some(input.stage_index),
            source: operand.source,
        });
        if disposition == ValueDisposition::Temp {
            emitted_temp_dir = true;
        }
    }
    let mut remaining = operands
        .into_iter()
        .filter(|operand| !operand.claimed && operand.raw != "--")
        .collect::<Vec<_>>();
    remaining.extend(
        post_flags
            .iter()
            .filter(|flag| flag.raw != "--")
            .map(|flag| Operand {
                raw: flag.raw.clone(),
                source: flag.span,
                claimed: false,
            }),
    );
    remaining.sort_by_key(|operand| operand.source.start);
    for operand in remaining {
        candidates.push(PathCandidate {
            usage: PathUsageKind::Argument,
            access: match input.access {
                AccessDisposition::Create => PathAccess::Create,
                AccessDisposition::Write => PathAccess::Write,
            },
            raw: operand.raw,
            program: Some(input.program.program.clone()),
            stage_index: Some(input.stage_index),
            source: operand.source,
        });
        emitted_operand = true;
    }
    (candidates, emitted_operand, emitted_temp_dir)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ValueDisposition {
    Read,
    Skip,
    Temp,
}

fn value_flag_spec(program: &str, name: &str) -> Option<(ValueDisposition, bool)> {
    let spec = match program {
        "mkdir" if matches!(name, "m" | "mode" | "Z" | "context") => {
            (ValueDisposition::Skip, false)
        }
        "touch" if matches!(name, "r" | "reference") => (ValueDisposition::Read, false),
        "touch" if matches!(name, "t" | "time" | "d" | "date") => (ValueDisposition::Skip, false),
        "mktemp" if name == "p" => (ValueDisposition::Temp, false),
        "mktemp" if name == "tmpdir" => (ValueDisposition::Temp, true),
        "cargo"
            if matches!(
                name,
                "manifest-path"
                    | "config-path"
                    | "config"
                    | "unstable-features"
                    | "print-config"
                    | "emit"
            ) =>
        {
            (ValueDisposition::Skip, false)
        }
        "biome" if matches!(name, "config-path" | "reporter" | "stdin-file-path") => {
            (ValueDisposition::Skip, false)
        }
        "prettier"
            if matches!(
                name,
                "config"
                    | "config-path"
                    | "plugin"
                    | "plugin-search-dir"
                    | "parser"
                    | "ignore-path"
            ) =>
        {
            (ValueDisposition::Skip, false)
        }
        "eslint"
            if matches!(
                name,
                "config" | "c" | "rulesdir" | "resolve-plugins-relative-to"
            ) =>
        {
            (ValueDisposition::Skip, false)
        }
        "ruff" if matches!(name, "config" | "target-version") => (ValueDisposition::Skip, false),
        _ => return None,
    };
    Some(spec)
}

fn disposition_access(disposition: ValueDisposition) -> PathAccess {
    match disposition {
        ValueDisposition::Read => PathAccess::Read,
        ValueDisposition::Temp => PathAccess::Temp,
        ValueDisposition::Skip => PathAccess::Read,
    }
}

#[derive(Clone)]
struct Operand {
    raw: String,
    source: SourceSpan,
    claimed: bool,
}

#[derive(Clone)]
struct PathCandidate {
    usage: PathUsageKind,
    access: PathAccess,
    raw: String,
    program: Option<String>,
    stage_index: Option<u32>,
    source: SourceSpan,
}

fn extract_redirect_candidates(stage: &BashStage, stage_index: u32) -> Vec<PathCandidate> {
    let BashStage::Command {
        program, redirects, ..
    } = stage
    else {
        return Vec::new();
    };
    redirects
        .iter()
        .filter(|redirect| redirect.target_kind == RedirectTargetKind::File)
        .map(|redirect| PathCandidate {
            usage: PathUsageKind::RedirectTarget,
            access: if redirect.stream == RedirectStream::Stdin {
                PathAccess::Read
            } else {
                PathAccess::Write
            },
            raw: redirect.target.clone(),
            program: Some(program.program.clone()),
            stage_index: Some(stage_index),
            source: redirect.span,
        })
        .collect()
}

fn implicit_temp_fact(candidate: &PathCandidate) -> BashPathFact {
    let stage = candidate
        .stage_index
        .map(|value| value.to_string())
        .unwrap_or_else(|| "cwd".into());
    BashPathFact {
        id: format!(
            "path:implicit-temp:{stage}:{}:{}",
            candidate.source.start, candidate.source.end
        ),
        stage_index: candidate.stage_index,
        program: candidate.program.clone(),
        usage: PathUsageKind::ImplicitTemp,
        access: PathAccess::Temp,
        raw: candidate.raw.clone(),
        literal: None,
        absolute_path: None,
        scope: PathScope::Temp,
        matched_scopes: vec![PathScope::Temp],
        normalization: PathNormalization::Lexical,
        is_absolute: false,
        is_relative: false,
        has_parent_traversal: false,
        quote: QuoteKind::None,
        dynamic: false,
        unknown_reason: None,
        source: candidate.source,
        provenance: None,
        glob_approximation: None,
    }
}

fn recover_cursor(stage: &BashStage) -> usize {
    match stage {
        BashStage::Command { program, span, .. } => program.span.end.max(span.start) as usize,
        _ => 0,
    }
}

fn recover_operand_span(
    raw_command: &str,
    stage: &BashStage,
    cursor: &mut usize,
    text: &str,
) -> SourceSpan {
    let region = match stage {
        BashStage::Command { span, .. } => *span,
        _ => SourceSpan { start: 0, end: 0 },
    };
    if text.is_empty() {
        return SourceSpan {
            start: region.start,
            end: region.start,
        };
    }
    let start = *cursor;
    let Some(relative) = raw_command.get(start..).and_then(|tail| tail.find(text)) else {
        return region;
    };
    let index = start + relative;
    if index + text.len() > region.end as usize {
        return region;
    }
    *cursor = index + text.len();
    SourceSpan {
        // The former TS recovery used String#indexOf, whose offsets are UTF-16
        // code units, while tree-sitter's stage bounds are byte offsets. Keep
        // the byte cursor for containment but emit the public span in the
        // established JS coordinate system.
        start: utf16_offset(raw_command, index),
        end: utf16_offset(raw_command, index + text.len()),
    }
}

fn cwd_prefix_span(raw: &str, prefix: &str) -> SourceSpan {
    raw.find(prefix)
        .map(|start| SourceSpan {
            start: utf16_offset(raw, start),
            end: utf16_offset(raw, start + prefix.len()),
        })
        .unwrap_or(SourceSpan { start: 0, end: 0 })
}

fn utf16_offset(value: &str, byte_offset: usize) -> u32 {
    value
        .get(..byte_offset)
        .unwrap_or(value)
        .encode_utf16()
        .count() as u32
}

fn has_unsupported_compound_diagnostic(shape: &BashCommandShape) -> bool {
    shape.diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic.code.as_str(),
            "bash:compound-feature-unsupported"
                | "bash:compound-iterator-unsupported"
                | "bash:compound-body-unsupported"
        )
    })
}

fn decode_shell_literal(raw: &str, home: Option<&str>) -> DecodedPath {
    let mut output = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut saw_single = false;
    let mut saw_double = false;
    let mut has_expansion = false;
    let mut has_glob = false;
    let mut has_brace = false;
    let mut has_tilde_user = false;
    let mut unsupported = false;
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        let char_len = raw[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                output.push_str(&raw[i..i + char_len]);
            }
            i += char_len;
            continue;
        }
        if in_double {
            if ch == '"' {
                in_double = false;
                i += 1;
                continue;
            }
            if ch == '\\' {
                let next = bytes.get(i + 1).copied().map(char::from);
                if matches!(next, Some('$' | '`' | '"' | '\\' | '\n')) {
                    if next != Some('\n') {
                        output.push(next.unwrap());
                    }
                    i += 2;
                } else {
                    output.push(ch);
                    i += 1;
                }
                continue;
            }
            if ch == '$' || ch == '`' {
                has_expansion = true;
            }
            output.push_str(&raw[i..i + char_len]);
            i += char_len;
            continue;
        }
        match ch {
            '\'' => {
                saw_single = true;
                in_single = true;
                i += 1;
            }
            '"' => {
                saw_double = true;
                in_double = true;
                i += 1;
            }
            '\\' => {
                if i + 1 < bytes.len() {
                    let next_len = raw[i + 1..].chars().next().map(char::len_utf8).unwrap_or(1);
                    output.push_str(&raw[i + 1..i + 1 + next_len]);
                    i += 1 + next_len;
                } else {
                    unsupported = true;
                    i += 1;
                }
            }
            '$' | '`' => {
                has_expansion = true;
                output.push(ch);
                i += 1;
            }
            '<' | '>' if bytes.get(i + 1).copied() == Some(b'(') => {
                has_expansion = true;
                output.push(ch);
                i += 1;
            }
            '~' if i == 0 => {
                let next = bytes.get(i + 1).copied().map(char::from);
                if next.is_none() || next == Some('/') {
                    if let Some(home) = home {
                        output.push_str(home);
                    } else {
                        unsupported = true;
                    }
                    i += 1;
                } else if next == Some('+') || next == Some('-') || next.is_some_and(is_word_char) {
                    has_tilde_user = true;
                    output.push(ch);
                    i += 1;
                } else {
                    output.push(ch);
                    i += 1;
                }
            }
            '*' | '?' => {
                has_glob = true;
                output.push(ch);
                i += 1;
            }
            '[' => {
                has_glob = true;
                output.push(ch);
                i += 1;
            }
            '{' => {
                if contains_brace_expansion(raw, i) {
                    has_brace = true;
                }
                output.push(ch);
                i += 1;
            }
            '\0' => {
                unsupported = true;
                i += 1;
            }
            _ => {
                output.push_str(&raw[i..i + char_len]);
                i += char_len;
            }
        }
    }
    if in_single || in_double {
        unsupported = true;
    }
    let quote = match (saw_single, saw_double) {
        (true, true) => QuoteKind::Mixed,
        (true, false) => QuoteKind::Single,
        (false, true) => QuoteKind::Double,
        _ => QuoteKind::None,
    };
    let unknown_reason = if has_expansion {
        Some(PathUnknownReason::DynamicExpansion)
    } else if has_brace {
        Some(PathUnknownReason::BraceExpansion)
    } else if has_glob {
        Some(PathUnknownReason::GlobExpansion)
    } else if has_tilde_user || unsupported {
        Some(PathUnknownReason::UnsupportedShellLiteral)
    } else {
        None
    };
    let dynamic = has_expansion || has_brace || has_glob || has_tilde_user;
    if unknown_reason.is_some() {
        return DecodedPath {
            literal: None,
            quote,
            dynamic,
            unknown_reason,
            is_absolute: false,
            is_relative: false,
            has_parent_traversal: false,
        };
    }
    let is_absolute = is_absolute(&output);
    DecodedPath {
        literal: Some(output.clone()),
        quote,
        dynamic: false,
        unknown_reason: None,
        is_absolute,
        is_relative: !is_absolute && !output.is_empty(),
        has_parent_traversal: contains_parent_traversal(&output),
    }
}

fn is_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-')
}

fn contains_brace_expansion(raw: &str, start: usize) -> bool {
    let bytes = raw.as_bytes();
    let mut depth = 1;
    let mut content = String::new();
    let mut index = start + 1;
    while index < bytes.len() {
        let ch = bytes[index] as char;
        if ch == '{' {
            depth += 1;
            content.push(ch);
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return content.contains(',') || content.contains("..");
            }
            content.push(ch);
        } else {
            content.push(ch);
        }
        index += 1;
    }
    false
}

fn contains_parent_traversal(value: &str) -> bool {
    value.split(['/', '\\']).any(|segment| segment == "..")
}
fn contains_raw_parent_traversal(value: &str) -> bool {
    value.split(['/', '\\']).any(|segment| segment == "..")
}

fn scan_glob_pattern(raw: &str) -> Result<Option<usize>, PathUnknownReason> {
    let bytes = raw.as_bytes();
    let mut single = false;
    let mut double = false;
    let mut first = None;
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if single {
            if ch == '\'' {
                single = false;
            }
            i += 1;
            continue;
        }
        if double {
            if ch == '"' {
                double = false;
                i += 1;
                continue;
            }
            if ch == '\\' {
                i += if i + 1 < bytes.len() { 2 } else { 1 };
                continue;
            }
            if ch == '$' || ch == '`' {
                return Err(PathUnknownReason::DynamicExpansion);
            }
            i += 1;
            continue;
        }
        match ch {
            '\'' => single = true,
            '"' => double = true,
            '\\' => {
                i += if i + 1 < bytes.len() { 2 } else { 1 };
                continue;
            }
            '$' | '`' => return Err(PathUnknownReason::DynamicExpansion),
            '<' | '>' if bytes.get(i + 1) == Some(&b'(') => {
                return Err(PathUnknownReason::DynamicExpansion)
            }
            '~' if i == 0
                && bytes
                    .get(i + 1)
                    .copied()
                    .map(char::from)
                    .is_some_and(|next| next == '+' || next == '-' || is_word_char(next)) =>
            {
                return Err(PathUnknownReason::UnsupportedShellLiteral)
            }
            '{' if contains_brace_expansion(raw, i) => {
                return Err(PathUnknownReason::BraceExpansion)
            }
            '@' | '!' | '+' | '*' | '?' if bytes.get(i + 1) == Some(&b'(') => {
                return Err(PathUnknownReason::UnsupportedShellLiteral)
            }
            '*' | '?' | '[' if first.is_none() => first = Some(i),
            '\0' => return Err(PathUnknownReason::UnsupportedShellLiteral),
            _ => {}
        }
        i += 1;
    }
    if single || double {
        return Err(PathUnknownReason::UnsupportedShellLiteral);
    }
    Ok(first)
}

fn static_prefix_raw(raw: &str, first: Option<usize>) -> String {
    let Some(index) = first else {
        return raw.into();
    };
    raw[..index]
        .rfind('/')
        .map(|slash| raw[..=slash].into())
        .unwrap_or_else(|| ".".into())
}

fn decode_glob_static_prefix(raw: &str, home: Option<&str>) -> Result<String, PathUnknownReason> {
    let first = scan_glob_pattern(raw)?;
    if contains_raw_parent_traversal(raw) {
        return Err(PathUnknownReason::UnsupportedShellLiteral);
    }
    let decoded = decode_shell_literal(&static_prefix_raw(raw, first), home);
    decoded.literal.ok_or(
        decoded
            .unknown_reason
            .unwrap_or(PathUnknownReason::UnsupportedShellLiteral),
    )
}

fn reduce_iterator_entry(
    entry: &BashIteratorEntry,
    effective_cwd: &str,
    context: &PathContext,
    home: Option<&str>,
) -> BashPathFactProvenanceEntry {
    if entry.kind == BashIteratorEntryKind::LiteralGlob {
        let prefix = decode_glob_static_prefix(&entry.raw, home);
        return match prefix {
            Ok(prefix) if !prefix.is_empty() && !contains_parent_traversal(&prefix) => {
                let absolute = resolve_path(effective_cwd, &prefix);
                let (scope, matched) = classify_scope(&absolute, context, home);
                BashPathFactProvenanceEntry {
                    raw: entry.raw.clone(),
                    literal: Some(prefix),
                    concrete_absolute_path: None,
                    static_prefix_absolute_path: Some(absolute),
                    scope,
                    matched_scopes: matched,
                    quote: entry.quote,
                    unknown_reason: None,
                }
            }
            Err(reason) => unknown_iterator_entry(entry, reason),
            Ok(_) => unknown_iterator_entry(entry, PathUnknownReason::UnsupportedShellLiteral),
        };
    }
    let decoded = decode_shell_literal(&entry.raw, home);
    let Some(literal) = decoded.literal else {
        return unknown_iterator_entry(
            entry,
            decoded
                .unknown_reason
                .unwrap_or(PathUnknownReason::UnsupportedShellLiteral),
        );
    };
    if literal.is_empty() {
        return unknown_iterator_entry(entry, PathUnknownReason::UnsupportedShellLiteral);
    }
    let absolute = resolve_path(effective_cwd, &literal);
    let (scope, matched) = classify_scope(&absolute, context, home);
    BashPathFactProvenanceEntry {
        raw: entry.raw.clone(),
        literal: Some(literal),
        concrete_absolute_path: Some(absolute),
        static_prefix_absolute_path: None,
        scope,
        matched_scopes: matched,
        quote: entry.quote,
        unknown_reason: None,
    }
}

fn unknown_iterator_entry(
    entry: &BashIteratorEntry,
    reason: PathUnknownReason,
) -> BashPathFactProvenanceEntry {
    BashPathFactProvenanceEntry {
        raw: entry.raw.clone(),
        literal: None,
        concrete_absolute_path: None,
        static_prefix_absolute_path: None,
        scope: PathScope::Unknown,
        matched_scopes: vec![PathScope::Unknown],
        quote: entry.quote,
        unknown_reason: Some(reason),
    }
}

pub fn reduce_for_loop_iterator(
    stage: &BashStage,
    effective_cwd: &str,
    context: &PathContext,
    home: Option<&str>,
) -> IteratorReduction {
    let BashStage::ForLoop { iterator, .. } = stage else {
        return IteratorReduction {
            source_kind: IteratorSourceKind::Opaque,
            entries: Vec::new(),
            scope: PathScope::Unknown,
            matched_scopes: vec![PathScope::Unknown],
            concrete_absolute_path: None,
            static_prefix_absolute_path: None,
            glob_approximation: false,
            unknown_reason: Some(LoopVariableUnknownReason::OpaqueIterator),
        };
    };
    let entries = iterator
        .iter()
        .map(|entry| reduce_iterator_entry(entry, effective_cwd, context, home))
        .collect::<Vec<_>>();
    let glob_approximation = iterator
        .iter()
        .any(|entry| entry.kind == BashIteratorEntryKind::LiteralGlob);
    if entries.is_empty()
        || entries
            .iter()
            .any(|entry| entry.scope == PathScope::Unknown)
    {
        return IteratorReduction {
            source_kind: IteratorSourceKind::Opaque,
            entries,
            scope: PathScope::Unknown,
            matched_scopes: vec![PathScope::Unknown],
            concrete_absolute_path: None,
            static_prefix_absolute_path: None,
            glob_approximation,
            unknown_reason: Some(LoopVariableUnknownReason::OpaqueIterator),
        };
    }
    let source_kind = if iterator
        .iter()
        .any(|entry| entry.kind == BashIteratorEntryKind::LiteralWord)
        && iterator
            .iter()
            .any(|entry| entry.kind == BashIteratorEntryKind::LiteralGlob)
    {
        IteratorSourceKind::Mixed
    } else if glob_approximation {
        IteratorSourceKind::LiteralGlob
    } else {
        IteratorSourceKind::LiteralWord
    };
    let scope = entries
        .iter()
        .map(|entry| entry.scope)
        .min_by_key(|scope| scope_rank(*scope))
        .unwrap_or(PathScope::Unknown);
    let mut matched = entries.iter().map(|entry| entry.scope).collect::<Vec<_>>();
    matched.sort_by_key(|scope| scope_rank(*scope));
    matched.dedup();
    let concrete = if iterator
        .iter()
        .all(|entry| entry.kind == BashIteratorEntryKind::LiteralWord)
    {
        entries
            .first()
            .and_then(|entry| entry.concrete_absolute_path.clone())
            .filter(|first| {
                entries
                    .iter()
                    .all(|entry| entry.concrete_absolute_path.as_deref() == Some(first))
            })
    } else {
        None
    };
    let static_prefix = if glob_approximation {
        let prefixes = entries
            .iter()
            .filter_map(|entry| entry.static_prefix_absolute_path.as_deref())
            .collect::<Vec<_>>();
        prefixes
            .first()
            .filter(|first| prefixes.iter().all(|candidate| candidate == *first))
            .map(|value| (*value).to_owned())
    } else {
        None
    };
    IteratorReduction {
        source_kind,
        entries,
        scope,
        matched_scopes: matched,
        concrete_absolute_path: concrete,
        static_prefix_absolute_path: static_prefix,
        glob_approximation,
        unknown_reason: None,
    }
}

fn scope_rank(scope: PathScope) -> u8 {
    match scope {
        PathScope::Unknown => 0,
        PathScope::Denied => 1,
        PathScope::Outside => 2,
        PathScope::System => 3,
        PathScope::Home | PathScope::SafeHome | PathScope::SensitiveHome => 4,
        PathScope::AgentSupport | PathScope::Temp => 5,
        PathScope::Project => 6,
        PathScope::WritableProject => 7,
    }
}

struct CompoundInput<'a> {
    owner_stage_index: u32,
    raw_command: &'a str,
    effective_cwd: &'a str,
    context: &'a PathContext,
    cwd_prefix_unknown: bool,
    reductions: &'a mut HashMap<u32, IteratorReduction>,
    loop_stage: Option<(&'a BashStage, u32)>,
}

fn derive_compound_stage_facts(stage: &BashStage, input: CompoundInput<'_>) -> Vec<BashPathFact> {
    match stage {
        BashStage::ForLoop { body, .. } => {
            let reduction = ensure_reduction(
                stage,
                input.owner_stage_index,
                input.effective_cwd,
                input.context,
                input.reductions,
            );
            let _ = reduction;
            derive_compound_body_facts(
                body,
                CompoundInput {
                    owner_stage_index: input.owner_stage_index,
                    raw_command: input.raw_command,
                    effective_cwd: input.effective_cwd,
                    context: input.context,
                    cwd_prefix_unknown: input.cwd_prefix_unknown,
                    reductions: input.reductions,
                    loop_stage: Some((stage, input.owner_stage_index)),
                },
            )
        }
        BashStage::BraceGroup { body, .. } => derive_compound_body_facts(body, input),
        BashStage::Conditional {
            arms, else_body, ..
        } => {
            let mut result = Vec::new();
            for arm in arms {
                let arm_input = CompoundInput {
                    owner_stage_index: input.owner_stage_index,
                    raw_command: input.raw_command,
                    effective_cwd: input.effective_cwd,
                    context: input.context,
                    cwd_prefix_unknown: input.cwd_prefix_unknown,
                    reductions: &mut *input.reductions,
                    loop_stage: input.loop_stage,
                };
                result.extend(derive_compound_body_facts(&arm.body, arm_input));
            }
            if let Some(body) = else_body {
                let else_input = CompoundInput {
                    owner_stage_index: input.owner_stage_index,
                    raw_command: input.raw_command,
                    effective_cwd: input.effective_cwd,
                    context: input.context,
                    cwd_prefix_unknown: input.cwd_prefix_unknown,
                    reductions: &mut *input.reductions,
                    loop_stage: input.loop_stage,
                };
                result.extend(derive_compound_body_facts(body, else_input));
            }
            result
        }
        _ => Vec::new(),
    }
}

fn ensure_reduction<'a>(
    stage: &BashStage,
    index: u32,
    effective_cwd: &str,
    context: &PathContext,
    reductions: &'a mut HashMap<u32, IteratorReduction>,
) -> &'a IteratorReduction {
    let home = context.normalized_home();
    reductions
        .entry(index)
        .or_insert_with(|| reduce_for_loop_iterator(stage, effective_cwd, context, home.as_deref()))
}

fn derive_compound_body_facts(body: &BashBlock, input: CompoundInput<'_>) -> Vec<BashPathFact> {
    let mut facts = Vec::new();
    for (body_index, stage) in body.pipeline.stages.iter().enumerate() {
        match stage {
            BashStage::BraceGroup { body: nested, .. } => {
                let nested_input = CompoundInput {
                    owner_stage_index: input.owner_stage_index,
                    raw_command: input.raw_command,
                    effective_cwd: input.effective_cwd,
                    context: input.context,
                    cwd_prefix_unknown: input.cwd_prefix_unknown,
                    reductions: &mut *input.reductions,
                    loop_stage: input.loop_stage,
                };
                facts.extend(derive_compound_body_facts(nested, nested_input));
            }
            BashStage::Conditional { .. } => {
                let conditional_input = CompoundInput {
                    owner_stage_index: input.owner_stage_index,
                    raw_command: input.raw_command,
                    effective_cwd: input.effective_cwd,
                    context: input.context,
                    cwd_prefix_unknown: input.cwd_prefix_unknown,
                    reductions: &mut *input.reductions,
                    loop_stage: input.loop_stage,
                };
                facts.extend(derive_compound_stage_facts(stage, conditional_input));
            }
            BashStage::Command { program, .. } => {
                for candidate in extract_redirect_candidates(stage, input.owner_stage_index) {
                    let raw = candidate.raw.clone();
                    let fact_input = RawPathFactInput {
                        raw,
                        usage: candidate.usage,
                        access: candidate.access,
                        program: candidate.program,
                        stage_index: candidate.stage_index,
                        source: candidate.source,
                        effective_cwd: Some(input.effective_cwd.into()),
                        unresolved_cwd_prefix: Some(input.cwd_prefix_unknown),
                    };
                    facts.push(classify_bash_path_fact(&fact_input, input.context));
                }
                if classify_stage_effect(stage).0 != "read-only" {
                    continue;
                }
                let mut cursor = recover_cursor(stage);
                for argument_index in stage_file_input_indices(stage) {
                    let Some(raw) = program.arguments.get(argument_index as usize) else {
                        continue;
                    };
                    let source = recover_operand_span(input.raw_command, stage, &mut cursor, raw);
                    if let Some((loop_stage, loop_index)) = input.loop_stage {
                        if let BashStage::ForLoop { variable, .. } = loop_stage {
                            if let Some(reference) =
                                program.variable_references.as_ref().and_then(|refs| {
                                    refs.iter().find(|reference| {
                                        reference.name == *variable
                                            && reference.raw == *raw
                                            && reference.span == source
                                    })
                                })
                            {
                                let reduction = ensure_reduction(
                                    loop_stage,
                                    loop_index,
                                    input.effective_cwd,
                                    input.context,
                                    &mut *input.reductions,
                                );
                                facts.push(make_loop_variable_fact(
                                    reference,
                                    program.program.as_str(),
                                    input.owner_stage_index,
                                    body_index as u32,
                                    reduction,
                                ));
                                continue;
                            }
                        }
                    }
                    let fact_input = RawPathFactInput {
                        raw: raw.clone(),
                        usage: PathUsageKind::Argument,
                        access: PathAccess::Read,
                        program: Some(program.program.clone()),
                        stage_index: Some(input.owner_stage_index),
                        source,
                        effective_cwd: Some(input.effective_cwd.into()),
                        unresolved_cwd_prefix: Some(input.cwd_prefix_unknown),
                    };
                    facts.push(classify_bash_path_fact(&fact_input, input.context));
                }
            }
            _ => {}
        }
    }
    facts
}

fn make_loop_variable_fact(
    reference: &BashLoopVariableReference,
    program: &str,
    owner: u32,
    body: u32,
    reduction: &IteratorReduction,
) -> BashPathFact {
    BashPathFact {
        id: format!(
            "path:compound:loop-var:{owner}:{body}:{}:{}",
            reference.span.start, reference.span.end
        ),
        stage_index: Some(owner),
        program: Some(program.into()),
        usage: PathUsageKind::Argument,
        access: PathAccess::Read,
        raw: reference.raw.clone(),
        literal: None,
        absolute_path: reduction.concrete_absolute_path.clone(),
        scope: reduction.scope,
        matched_scopes: reduction.matched_scopes.clone(),
        normalization: PathNormalization::Lexical,
        is_absolute: false,
        is_relative: false,
        has_parent_traversal: false,
        quote: match reference.quote {
            LoopQuoteKind::None => QuoteKind::None,
            LoopQuoteKind::Single => QuoteKind::Single,
            LoopQuoteKind::Double => QuoteKind::Double,
        },
        dynamic: reduction.scope == PathScope::Unknown,
        unknown_reason: None,
        source: reference.span,
        provenance: Some(BashPathFactProvenance::LoopVariable {
            variable_name: reference.name.clone(),
            iterator_source_kind: reduction.source_kind,
            iterator_entries: reduction.entries.clone(),
            loop_stage_index: owner,
            unknown_reason: reduction.unknown_reason,
        }),
        glob_approximation: reduction.glob_approximation.then_some(true),
    }
}

fn resolve_path(cwd: &str, literal: &str) -> String {
    if is_absolute(literal) {
        normalize_path(literal)
    } else {
        normalize_path(&join_path(cwd, literal))
    }
}
fn join_path(left: &str, right: &str) -> String {
    if left.ends_with('/') {
        format!("{left}{right}")
    } else {
        format!("{left}/{right}")
    }
}
fn is_absolute(value: &str) -> bool {
    value.starts_with('/')
}
fn normalize_path(value: &str) -> String {
    let mut output: Vec<&str> = Vec::new();
    for segment in value.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                output.pop();
            }
            value => output.push(value),
        }
    }
    format!("/{}", output.join("/"))
}
fn path_segments(value: &str) -> Vec<String> {
    value
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_owned)
        .collect()
}
fn normalize_mixed_path(value: &str) -> String {
    normalize_path(&value.replace('\\', "/"))
}
fn within(candidate: &str, root: &str) -> bool {
    let candidate = normalize_path(candidate);
    let root = normalize_path(root);
    candidate == root
        || candidate
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}
fn within_any(candidate: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| within(candidate, root))
}
fn starts_with_segments(parts: &[String], prefix: &[&str]) -> bool {
    parts.len() >= prefix.len()
        && prefix
            .iter()
            .enumerate()
            .all(|(index, value)| parts[index] == *value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lexical_containment_does_not_match_prefixes() {
        assert!(within("/repo/src/file", "/repo"));
        assert!(!within("/repository/file", "/repo"));
    }
}
