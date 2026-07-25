//! Native policy compiler and interpreter.
//!
//! Policy values cross the public seam as JSON, while compiled policy handles
//! own a typed matcher IR for the hot path. The generated contract types describe
//! the boundary; this module remains independent of napi and filesystem concerns.
//! Decisions never deserialize policy or compile regular expressions per call.

use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const MAX_MATCHER_DEPTH: usize = 64;
const COMBINATORS: &[&str] = &[
    "tool",
    "program",
    "arg0In",
    "argAt",
    "argCount",
    "envAssignmentCount",
    "argMatches",
    "flagPresent",
    "flagMatches",
    "flagAllowlist",
    "flagValueIn",
    "flagCount",
    "anyArgMatches",
    "envAssignmentNameIn",
    "noSubstitution",
    "noStdoutRedirect",
    "redirect",
    "pipeline",
    "operator",
    "stageEvery",
    "stageSome",
    "compoundForm",
    "bodyStagesAllReadOnly",
    "bodyStagesAllScopeIn",
    "iteratorScopesAllIn",
    "noBodySubstitution",
    "noBodyShellWrap",
    "noBodyRedirectTo",
    "diagnosticCode",
    "composition",
    "all",
    "any",
    "not",
    "always",
    "pathScopesAllIn",
    "pathScopesNoneIn",
    "pathScopesSomeIn",
    "mutationTool",
    "mutationShape",
    "mutationTrustBoundary",
];
const UNSUPPORTED_COMPOUND_DIAGNOSTICS: &[&str] = &[
    "bash:compound-feature-unsupported",
    "bash:compound-iterator-unsupported",
    "bash:compound-body-unsupported",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompiledPolicyHandle(pub u64);

#[derive(Debug, Clone)]
struct CompiledPolicy {
    floor: Vec<CompiledRule>,
    active: Vec<CompiledRule>,
}

#[derive(Debug, Clone)]
struct CompiledRule {
    raw: Value,
    matcher: MatcherIr,
}

/// Matcher IR used by the decision hot path. The wire contract remains JSON, but
/// policy handles compile matcher fields once so every decision does not walk the
/// matcher object, allocate temporary arrays, or compile regular expressions.
/// Complex predicates retain their validated JSON only until their specialized
/// evaluator is migrated; this keeps the optimization targeted rather than
/// changing matcher semantics in the final migration slice.
#[derive(Debug, Clone)]
enum MatcherIr {
    Always,
    Tool(String),
    Program(String),
    Arg0In(HashSet<String>),
    ArgAt {
        index: usize,
        value: String,
    },
    ArgCount {
        min: Option<u64>,
        max: Option<u64>,
    },
    EnvAssignmentCount {
        min: Option<u64>,
        max: Option<u64>,
    },
    ArgMatches {
        index: usize,
        regex: Regex,
    },
    FlagPresent(String),
    FlagMatches {
        names: HashSet<String>,
        prefixes: Vec<String>,
        short_chars: HashSet<char>,
    },
    FlagAllowlist {
        names: HashSet<String>,
        short_chars: HashSet<char>,
    },
    FlagValueIn {
        names: HashSet<String>,
        values: HashSet<String>,
        allow_undefined_value: bool,
    },
    FlagCount {
        names: HashSet<String>,
        short_chars: HashSet<char>,
        min: Option<u64>,
        max: Option<u64>,
    },
    AnyArgMatches {
        regex: Regex,
    },
    EnvAssignmentNameIn {
        names: HashSet<String>,
        prefixes: Vec<String>,
        case_insensitive_prefixes: Vec<String>,
    },
    NoSubstitution,
    NoStdoutRedirect,
    Redirect {
        stream: Option<String>,
        target: Option<String>,
        target_kind: Option<String>,
    },
    Pipeline(String),
    Operator(String),
    StageEvery(Box<MatcherIr>),
    StageSome(Box<MatcherIr>),
    DiagnosticCode(String),
    All(Vec<MatcherIr>),
    Any(Vec<MatcherIr>),
    Not(Box<MatcherIr>),
    /// Compound, path, mutation, and composition predicates use the mature
    /// evaluator until their shape-specific helpers are moved to typed inputs.
    Raw(Value),
}

impl MatcherIr {
    fn compile(expr: &Value) -> Self {
        let Some(kind) = expr.get("kind").and_then(Value::as_str) else {
            return Self::Raw(expr.clone());
        };
        let strings = |field: &str| -> Option<Vec<String>> {
            expr.get(field)?
                .as_array()?
                .iter()
                .map(|value| value.as_str().map(str::to_owned))
                .collect()
        };
        let optional_range = || {
            (
                expr.get("min").and_then(Value::as_u64),
                expr.get("max").and_then(Value::as_u64),
            )
        };
        match kind {
            "always" => Self::Always,
            "tool" => expr
                .get("tool")
                .and_then(Value::as_str)
                .map(|value| Self::Tool(value.to_owned()))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "program" => expr
                .get("name")
                .and_then(Value::as_str)
                .map(|value| Self::Program(value.to_owned()))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "arg0In" => strings("values")
                .map(|values| Self::Arg0In(values.into_iter().collect()))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "argAt" => match (
                expr.get("index").and_then(Value::as_u64),
                expr.get("value").and_then(Value::as_str),
            ) {
                (Some(index), Some(value)) => Self::ArgAt {
                    index: index as usize,
                    value: value.to_owned(),
                },
                _ => Self::Raw(expr.clone()),
            },
            "argCount" => {
                let (min, max) = optional_range();
                Self::ArgCount { min, max }
            }
            "envAssignmentCount" => {
                let (min, max) = optional_range();
                Self::EnvAssignmentCount { min, max }
            }
            "argMatches" => match (
                expr.get("index").and_then(Value::as_u64),
                expr.get("pattern").and_then(Value::as_str),
            ) {
                (Some(index), Some(pattern)) => anchored_regex(pattern)
                    .map(|regex| Self::ArgMatches {
                        index: index as usize,
                        regex,
                    })
                    .unwrap_or_else(|| Self::Raw(expr.clone())),
                _ => Self::Raw(expr.clone()),
            },
            "flagPresent" => expr
                .get("name")
                .and_then(Value::as_str)
                .map(|value| Self::FlagPresent(normalize_flag(value)))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "flagMatches" => compile_flag_matches(expr, false),
            "flagAllowlist" => compile_flag_matches(expr, true),
            "flagValueIn" => match (strings("names"), strings("values")) {
                (Some(names), Some(values)) => Self::FlagValueIn {
                    names: names
                        .into_iter()
                        .map(|value| normalize_flag(&value))
                        .collect(),
                    values: values.into_iter().collect(),
                    allow_undefined_value: expr.get("allowUndefinedValue").and_then(Value::as_bool)
                        == Some(true),
                },
                _ => Self::Raw(expr.clone()),
            },
            "flagCount" => Self::FlagCount {
                names: strings("names")
                    .unwrap_or_default()
                    .into_iter()
                    .map(|value| normalize_flag(&value))
                    .collect(),
                short_chars: strings("shortChars")
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.chars().next())
                    .collect(),
                min: expr.get("min").and_then(Value::as_u64),
                max: expr.get("max").and_then(Value::as_u64),
            },
            "anyArgMatches" => expr
                .get("pattern")
                .and_then(Value::as_str)
                .and_then(anchored_regex)
                .map(|regex| Self::AnyArgMatches { regex })
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "envAssignmentNameIn" => Self::EnvAssignmentNameIn {
                names: strings("names").unwrap_or_default().into_iter().collect(),
                prefixes: strings("prefixes").unwrap_or_default(),
                case_insensitive_prefixes: strings("caseInsensitivePrefixes")
                    .unwrap_or_default()
                    .into_iter()
                    .map(|value| value.to_lowercase())
                    .collect(),
            },
            "noSubstitution" => Self::NoSubstitution,
            "noStdoutRedirect" => Self::NoStdoutRedirect,
            "redirect" => Self::Redirect {
                stream: expr
                    .get("stream")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                target: expr
                    .get("target")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                target_kind: expr
                    .get("targetKind")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            },
            "pipeline" => expr
                .get("target")
                .and_then(Value::as_str)
                .map(|value| Self::Pipeline(value.to_owned()))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "operator" => expr
                .get("op")
                .and_then(Value::as_str)
                .map(|value| Self::Operator(value.to_owned()))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "stageEvery" => expr
                .get("inner")
                .map(|inner| Self::StageEvery(Box::new(Self::compile(inner))))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "stageSome" => expr
                .get("inner")
                .map(|inner| Self::StageSome(Box::new(Self::compile(inner))))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "diagnosticCode" => expr
                .get("code")
                .and_then(Value::as_str)
                .map(|value| Self::DiagnosticCode(value.to_owned()))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            "all" | "any" => {
                let Some(values) = expr.get("of").and_then(Value::as_array) else {
                    return Self::Raw(expr.clone());
                };
                if values.is_empty() {
                    return Self::Raw(expr.clone());
                }
                let compiled = values.iter().map(Self::compile).collect();
                if kind == "all" {
                    Self::All(compiled)
                } else {
                    Self::Any(compiled)
                }
            }
            "not" => expr
                .get("of")
                .or_else(|| expr.get("inner"))
                .map(|inner| Self::Not(Box::new(Self::compile(inner))))
                .unwrap_or_else(|| Self::Raw(expr.clone())),
            _ => Self::Raw(expr.clone()),
        }
    }
}

fn compile_flag_matches(expr: &Value, allowlist: bool) -> MatcherIr {
    let strings = |field: &str| -> Vec<String> {
        expr.get(field)
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let names = strings("names")
        .into_iter()
        .map(|value| normalize_flag(&value))
        .collect();
    let prefixes = strings("prefixes")
        .into_iter()
        .map(|value| normalize_flag(&value))
        .collect();
    let short_chars = strings("shortChars")
        .into_iter()
        .filter_map(|value| value.chars().next())
        .collect();
    if allowlist {
        MatcherIr::FlagAllowlist { names, short_chars }
    } else {
        MatcherIr::FlagMatches {
            names,
            prefixes,
            short_chars,
        }
    }
}

fn anchored_regex(pattern: &str) -> Option<Regex> {
    Regex::new(&format!("^(?:{pattern})$")).ok()
}

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static POLICIES: OnceLock<Mutex<std::collections::HashMap<u64, std::sync::Arc<CompiledPolicy>>>> =
    OnceLock::new();

fn policies() -> &'static Mutex<std::collections::HashMap<u64, std::sync::Arc<CompiledPolicy>>> {
    POLICIES.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Compile one JSON policy pack. The result is `{ pack, errors }` so pack
/// authoring and runtime composition can share one strict compiler.
pub fn compile_pack(raw: &Value) -> Value {
    let mut errors = Vec::new();
    let object = match raw.as_object() {
        Some(value) => value,
        None => {
            return json!({"pack": null, "errors": [error(None, None, "$", "expected policy pack object")]})
        }
    };

    let pack_id = object.get("id").and_then(Value::as_str).map(str::to_owned);
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        errors.push(error(
            pack_id.as_deref(),
            None,
            "version",
            "expected version 1",
        ));
    }
    if !non_empty_string(object.get("id")) {
        errors.push(error(
            pack_id.as_deref(),
            None,
            "id",
            "expected non-empty pack id",
        ));
    }

    let mut rules = Vec::new();
    match object.get("rules").and_then(Value::as_array) {
        Some(raw_rules) => {
            for (index, raw_rule) in raw_rules.iter().enumerate() {
                let (compiled, rule_errors) =
                    compile_rule(raw_rule, pack_id.as_deref(), &format!("rules[{index}]"));
                errors.extend(rule_errors);
                if let Some(rule) = compiled {
                    rules.push(rule);
                }
            }
        }
        None => errors.push(error(
            pack_id.as_deref(),
            None,
            "rules",
            "expected rules array",
        )),
    }

    let (metadata, metadata_errors) =
        compile_metadata(object.get("metadata"), pack_id.as_deref(), "metadata");
    errors.extend(metadata_errors);

    if !errors.is_empty() || pack_id.is_none() {
        return json!({"pack": null, "errors": errors});
    }

    let mut pack = Map::new();
    pack.insert("version".into(), json!(1));
    pack.insert("id".into(), json!(pack_id.unwrap_or_default()));
    if let Some(metadata) = metadata {
        pack.insert("metadata".into(), metadata);
    }
    pack.insert("rules".into(), Value::Array(rules));
    json!({"pack": Value::Object(pack), "errors": []})
}

pub fn compile_pack_metadata(raw: &Value) -> Value {
    let (metadata, errors) = compile_metadata(Some(raw), None, "metadata");
    json!({"metadata": metadata, "errors": errors})
}

pub fn compile_match(raw: &Value) -> Value {
    match compile_match_inner(raw, "$", None, None, 0) {
        Ok(expr) => json!({"expr": expr}),
        Err(errors) => json!({"errors": errors}),
    }
}

fn compile_rule(raw: &Value, pack_id: Option<&str>, path: &str) -> (Option<Value>, Vec<Value>) {
    let object = match raw.as_object() {
        Some(value) => value,
        None => {
            return (
                None,
                vec![error(pack_id, None, path, "expected rule object")],
            )
        }
    };
    let rule_id = object.get("id").and_then(Value::as_str);
    let mut errors = Vec::new();
    for field in object.keys() {
        if !matches!(
            field.as_str(),
            "id" | "effect" | "match" | "reason" | "provenance"
        ) {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                "unknown rule field",
            ));
        }
    }
    if !non_empty_string(object.get("id")) {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.id"),
            "expected non-empty rule id",
        ));
    }
    let effect = object.get("effect").and_then(Value::as_str);
    if !matches!(effect, Some("allow") | Some("deny") | Some("review")) {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.effect"),
            "invalid effect",
        ));
    }
    if !non_empty_string(object.get("reason")) {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.reason"),
            "expected non-empty reason",
        ));
    }
    let (source, provenance_errors) = compile_provenance(
        object.get("provenance"),
        pack_id,
        rule_id,
        &format!("{path}.provenance"),
    );
    errors.extend(provenance_errors);
    let matcher = compile_match_inner(
        object.get("match").unwrap_or(&Value::Null),
        &format!("{path}.match"),
        pack_id,
        rule_id,
        0,
    );
    let matcher = match matcher {
        Ok(value) => Some(value),
        Err(matcher_errors) => {
            errors.extend(matcher_errors);
            None
        }
    };
    if !errors.is_empty()
        || rule_id.is_none()
        || effect.is_none()
        || matcher.is_none()
        || source.is_none()
    {
        return (None, errors);
    }
    let mut result = Map::new();
    result.insert("id".into(), json!(rule_id.unwrap_or_default()));
    result.insert("effect".into(), json!(effect.unwrap_or_default()));
    result.insert("match".into(), matcher.unwrap_or(Value::Null));
    result.insert(
        "reason".into(),
        json!(object
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default()),
    );
    let mut provenance = Map::new();
    provenance.insert("source".into(), json!(source.unwrap_or("generated")));
    if let Some(pack_id) = pack_id {
        provenance.insert("packId".into(), json!(pack_id));
    }
    if let Some(rule_id) = rule_id {
        provenance.insert("ruleId".into(), json!(rule_id));
    }
    result.insert("provenance".into(), Value::Object(provenance));
    (Some(Value::Object(result)), errors)
}

fn compile_provenance(
    raw: Option<&Value>,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
    path: &str,
) -> (Option<&'static str>, Vec<Value>) {
    let Some(raw) = raw else {
        return (Some("generated"), Vec::new());
    };
    let Some(object) = raw.as_object() else {
        return (
            None,
            vec![error(pack_id, rule_id, path, "expected provenance object")],
        );
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if field != "source" {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                "unknown provenance field",
            ));
        }
    }
    let source = object.get("source").and_then(Value::as_str);
    if object.contains_key("source") && !valid_source(source) {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.source"),
            "invalid provenance.source",
        ));
    }
    if !errors.is_empty() {
        return (None, errors);
    }
    match source {
        Some(value) if valid_source(Some(value)) => (
            Some(match value {
                "allow" => "generated", // unreachable; kept exhaustive below
                "shipped" => "shipped",
                "user-global" => "user-global",
                "user-project" => "user-project",
                "trusted-repo" => "trusted-repo",
                "package" => "package",
                "generated" => "generated",
                "default" => "default",
                _ => "generated",
            }),
            errors,
        ),
        _ => (Some("generated"), errors),
    }
}

fn compile_metadata(
    raw: Option<&Value>,
    pack_id: Option<&str>,
    path: &str,
) -> (Option<Value>, Vec<Value>) {
    let Some(raw) = raw else {
        return (None, Vec::new());
    };
    let Some(object) = raw.as_object() else {
        return (
            None,
            vec![error(pack_id, None, path, "expected metadata object")],
        );
    };
    let allowed = [
        "title",
        "description",
        "docs",
        "tags",
        "warnings",
        "examples",
    ];
    let mut errors = Vec::new();
    for field in object.keys() {
        if !allowed.contains(&field.as_str()) {
            errors.push(error(
                pack_id,
                None,
                &format!("{path}.{field}"),
                "unknown metadata field",
            ));
        }
    }
    let mut result = Map::new();
    for field in ["title", "description"] {
        if let Some(value) = object.get(field) {
            if !non_empty_string(Some(value)) {
                errors.push(error(
                    pack_id,
                    None,
                    &format!("{path}.{field}"),
                    "expected non-empty string",
                ));
            } else {
                result.insert(field.into(), value.clone());
            }
        }
    }
    if let Some(value) = object.get("docs") {
        match value.as_array() {
            Some(entries) => {
                let mut docs = Vec::new();
                for (index, entry) in entries.iter().enumerate() {
                    let entry_path = format!("{path}.docs[{index}]");
                    let Some(entry) = entry.as_object() else {
                        errors.push(error(
                            pack_id,
                            None,
                            &entry_path,
                            "expected docs link object",
                        ));
                        continue;
                    };
                    for field in entry.keys() {
                        if !matches!(field.as_str(), "label" | "href") {
                            errors.push(error(
                                pack_id,
                                None,
                                &format!("{entry_path}.{field}"),
                                "unknown docs field",
                            ));
                        }
                    }
                    if !non_empty_string(entry.get("label")) {
                        errors.push(error(
                            pack_id,
                            None,
                            &format!("{entry_path}.label"),
                            "expected non-empty string",
                        ));
                    }
                    if !non_empty_string(entry.get("href")) {
                        errors.push(error(
                            pack_id,
                            None,
                            &format!("{entry_path}.href"),
                            "expected non-empty string",
                        ));
                    }
                    if non_empty_string(entry.get("label")) && non_empty_string(entry.get("href")) {
                        docs.push(json!({"label": entry["label"], "href": entry["href"]}));
                    }
                }
                result.insert("docs".into(), Value::Array(docs));
            }
            None => errors.push(error(
                pack_id,
                None,
                &format!("{path}.docs"),
                "expected docs array",
            )),
        }
    }
    if let Some(value) = object.get("tags") {
        match value.as_array() {
            Some(values) => {
                let mut tags = Vec::new();
                for (index, value) in values.iter().enumerate() {
                    if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
                        tags.push(Value::String(value.to_owned()));
                    } else {
                        errors.push(error(
                            pack_id,
                            None,
                            &format!("{path}.tags[{index}]"),
                            "expected non-empty string",
                        ));
                    }
                }
                result.insert("tags".into(), Value::Array(tags));
            }
            None => errors.push(error(
                pack_id,
                None,
                &format!("{path}.tags"),
                "expected string array",
            )),
        }
    }
    if let Some(value) = object.get("warnings") {
        match value.as_array() {
            Some(entries) => {
                let mut warnings = Vec::new();
                for (index, entry) in entries.iter().enumerate() {
                    let entry_path = format!("{path}.warnings[{index}]");
                    let Some(entry) = entry.as_object() else {
                        errors.push(error(pack_id, None, &entry_path, "expected warning object"));
                        continue;
                    };
                    for field in entry.keys() {
                        if !matches!(field.as_str(), "level" | "message") {
                            errors.push(error(
                                pack_id,
                                None,
                                &format!("{entry_path}.{field}"),
                                "unknown warning field",
                            ));
                        }
                    }
                    let level = entry.get("level").and_then(Value::as_str);
                    if !matches!(level, Some("info") | Some("warning") | Some("danger")) {
                        errors.push(error(
                            pack_id,
                            None,
                            &format!("{entry_path}.level"),
                            "invalid warning level",
                        ));
                    }
                    if !non_empty_string(entry.get("message")) {
                        errors.push(error(
                            pack_id,
                            None,
                            &format!("{entry_path}.message"),
                            "expected non-empty string",
                        ));
                    }
                    if matches!(level, Some("info") | Some("warning") | Some("danger"))
                        && non_empty_string(entry.get("message"))
                    {
                        warnings.push(json!({"level": level, "message": entry["message"]}));
                    }
                }
                result.insert("warnings".into(), Value::Array(warnings));
            }
            None => errors.push(error(
                pack_id,
                None,
                &format!("{path}.warnings"),
                "expected warnings array",
            )),
        }
    }
    if let Some(value) = object.get("examples") {
        match value.as_array() {
            Some(entries) => {
                let mut examples = Vec::new();
                for (index, entry) in entries.iter().enumerate() {
                    let entry_path = format!("{path}.examples[{index}]");
                    let Some(entry) = entry.as_object() else {
                        errors.push(error(pack_id, None, &entry_path, "expected example object"));
                        continue;
                    };
                    for field in entry.keys() {
                        if !matches!(field.as_str(), "outcome" | "shape" | "note") {
                            errors.push(error(
                                pack_id,
                                None,
                                &format!("{entry_path}.{field}"),
                                "unknown example field",
                            ));
                        }
                    }
                    let outcome = entry.get("outcome").and_then(Value::as_str);
                    if !matches!(outcome, Some("allow") | Some("deny") | Some("review")) {
                        errors.push(error(
                            pack_id,
                            None,
                            &format!("{entry_path}.outcome"),
                            "invalid example outcome",
                        ));
                    }
                    if !non_empty_string(entry.get("shape")) {
                        errors.push(error(
                            pack_id,
                            None,
                            &format!("{entry_path}.shape"),
                            "expected non-empty string",
                        ));
                    }
                    if let Some(note) = entry.get("note") {
                        if !note.is_string() {
                            errors.push(error(
                                pack_id,
                                None,
                                &format!("{entry_path}.note"),
                                "expected string",
                            ));
                        }
                    }
                    if matches!(outcome, Some("allow") | Some("deny") | Some("review"))
                        && non_empty_string(entry.get("shape"))
                    {
                        let mut example = Map::new();
                        example.insert("outcome".into(), json!(outcome));
                        example.insert("shape".into(), entry["shape"].clone());
                        if let Some(note) = entry.get("note") {
                            example.insert("note".into(), note.clone());
                        }
                        examples.push(Value::Object(example));
                    }
                }
                result.insert("examples".into(), Value::Array(examples));
            }
            None => errors.push(error(
                pack_id,
                None,
                &format!("{path}.examples"),
                "expected examples array",
            )),
        }
    }
    if errors.is_empty() {
        (Some(Value::Object(result)), errors)
    } else {
        (None, errors)
    }
}

fn compile_match_inner(
    raw: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
    depth: usize,
) -> Result<Value, Vec<Value>> {
    if depth > MAX_MATCHER_DEPTH {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "matcher nesting exceeds depth limit",
        )]);
    }
    let Some(object) = raw.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "expected matcher object",
        )]);
    };
    let known: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| COMBINATORS.contains(key))
        .collect();
    let unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !COMBINATORS.contains(key))
        .collect();
    if known.len() > 1 {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "ambiguous matcher object",
        )]);
    }
    if !unknown.is_empty() {
        return Err(unknown
            .into_iter()
            .map(|key| {
                error(
                    pack_id,
                    rule_id,
                    &format!("{path}.{key}"),
                    "unknown combinator",
                )
            })
            .collect());
    }
    let Some(kind) = known.first().copied() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "expected matcher combinator",
        )]);
    };
    let value = object.get(kind).unwrap_or(&Value::Null);
    let child_path = format!("{path}.{kind}");
    compile_combinator(kind, value, &child_path, pack_id, rule_id, depth)
}

fn compile_combinator(
    kind: &str,
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
    depth: usize,
) -> Result<Value, Vec<Value>> {
    match kind {
        "always" | "noSubstitution" | "noStdoutRedirect" | "bodyStagesAllReadOnly" | "noBodySubstitution" | "noBodyShellWrap" | "noBodyRedirectTo" => {
            if value == &Value::Bool(true) { Ok(json!({"kind": kind})) } else { Err(vec![error(pack_id, rule_id, path, "matcher sentinel must be true")]) }
        }
        "tool" | "program" | "pipeline" | "diagnosticCode" => {
            if non_empty_string(Some(value)) { Ok(json!({"kind": kind, field_for_simple(kind): value})) } else { Err(vec![error(pack_id, rule_id, path, &format!("{kind} must be a non-empty string"))]) }
        }
        "arg0In" => string_array(kind, value, path, pack_id, rule_id, true).map(|values| json!({"kind": kind, "values": values.into_iter().map(Value::String).collect::<Vec<_>>() })),
        "argAt" => compile_arg_at(value, path, pack_id, rule_id),
        "argCount" | "envAssignmentCount" => compile_count(kind, value, path, pack_id, rule_id),
        "argMatches" => compile_arg_matches(value, path, pack_id, rule_id),
        "flagPresent" => if non_empty_string(Some(value)) { Ok(json!({"kind": kind, "name": value})) } else { Err(vec![error(pack_id, rule_id, path, "flagPresent must be a non-empty string")]) },
        "flagMatches" => compile_name_pattern(kind, value, path, pack_id, rule_id, false),
        "flagAllowlist" => compile_name_pattern(kind, value, path, pack_id, rule_id, true),
        "flagValueIn" => compile_flag_value_in(value, path, pack_id, rule_id),
        "flagCount" => compile_flag_count(value, path, pack_id, rule_id),
        "anyArgMatches" => compile_pattern(kind, value, path, pack_id, rule_id),
        "envAssignmentNameIn" => compile_name_pattern(kind, value, path, pack_id, rule_id, false),
        "redirect" => compile_redirect(value, path, pack_id, rule_id),
        "operator" => if matches!(value.as_str(), Some("and") | Some("or") | Some("seq") | Some("background")) { Ok(json!({"kind": kind, "op": value})) } else { Err(vec![error(pack_id, rule_id, path, "invalid operator")]) },
        "stageEvery" | "stageSome" | "not" => {
            let inner = compile_match_inner(value, path, pack_id, rule_id, depth + 1)?;
            if kind == "not" { Ok(json!({"kind": kind, "of": inner})) } else { Ok(json!({"kind": kind, "inner": inner})) }
        }
        "compoundForm" => if matches!(value.as_str(), Some("for") | Some("brace-group") | Some("if")) { Ok(json!({"kind": kind, "form": value})) } else { Err(vec![error(pack_id, rule_id, path, "invalid compound form")]) },
        "bodyStagesAllScopeIn" | "iteratorScopesAllIn" => compile_compound_scope(kind, value, path, pack_id, rule_id),
        "composition" => compile_composition(value, path, pack_id, rule_id, depth),
        "all" | "any" => compile_match_array(kind, value, path, pack_id, rule_id, depth),
        "pathScopesAllIn" | "pathScopesNoneIn" | "pathScopesSomeIn" => compile_path_scope(kind, value, path, pack_id, rule_id),
        "mutationTool" => compile_mutation_tool(value, path, pack_id, rule_id),
        "mutationShape" => compile_mutation_shape(value, path, pack_id, rule_id),
        "mutationTrustBoundary" => compile_mutation_boundary(value, path, pack_id, rule_id),
        _ => Err(vec![error(pack_id, rule_id, path, "unknown combinator")]),
    }
}

fn field_for_simple(kind: &str) -> &'static str {
    match kind {
        "tool" => "tool",
        "program" => "name",
        "pipeline" => "target",
        "diagnosticCode" => "code",
        _ => "value",
    }
}

fn compile_arg_at(
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "argAt must be an object",
        )]);
    };
    let mut errors = Vec::new();
    let index = object.get("index").and_then(safe_integer);
    if index.is_none() {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.index"),
            "argAt.index must be a non-negative integer",
        ));
    }
    if !object.get("value").map(Value::is_string).unwrap_or(false) {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.value"),
            "argAt.value must be a string",
        ));
    }
    if errors.is_empty() {
        Ok(json!({"kind":"argAt", "index":index.unwrap_or(0), "value":object["value"]}))
    } else {
        Err(errors)
    }
}

fn compile_count(
    kind: &str,
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            &format!("{kind} must be an object"),
        )]);
    };
    let mut errors = Vec::new();
    let mut min = None;
    let mut max = None;
    for field in object.keys() {
        if field != "min" && field != "max" {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                &format!("unknown {kind} field"),
            ));
        }
    }
    for field in ["min", "max"] {
        if let Some(value) = object.get(field) {
            let parsed = safe_integer(value);
            if parsed.is_none() {
                errors.push(error(
                    pack_id,
                    rule_id,
                    &format!("{path}.{field}"),
                    &format!("{kind}.{field} must be a non-negative safe integer"),
                ));
            } else if field == "min" {
                min = parsed;
            } else {
                max = parsed;
            }
        }
    }
    if min.zip(max).is_some_and(|(min, max)| min > max) {
        errors.push(error(
            pack_id,
            rule_id,
            path,
            &format!("{kind}.min must not exceed {kind}.max"),
        ));
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut result = Map::new();
    result.insert("kind".into(), json!(kind));
    if let Some(value) = min {
        result.insert("min".into(), json!(value));
    }
    if let Some(value) = max {
        result.insert("max".into(), json!(value));
    }
    Ok(Value::Object(result))
}

fn compile_arg_matches(
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "argMatches must be an object",
        )]);
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if field != "index" && field != "pattern" {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                "unknown argMatches field",
            ));
        }
    }
    let index = object.get("index").and_then(safe_integer);
    if index.is_none() {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.index"),
            "argMatches.index must be a non-negative integer",
        ));
    }
    let pattern = object.get("pattern").and_then(Value::as_str);
    if pattern.is_none() || pattern == Some("") {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.pattern"),
            "argMatches.pattern must be a non-empty string",
        ));
    } else if Regex::new(&format!("^(?:{})$", pattern.unwrap_or_default())).is_err() {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.pattern"),
            "argMatches.pattern must be a valid regular expression",
        ));
    }
    if errors.is_empty() {
        Ok(
            json!({"kind":"argMatches", "index": index.unwrap_or(0), "pattern": pattern.unwrap_or_default()}),
        )
    } else {
        Err(errors)
    }
}

fn compile_pattern(
    kind: &str,
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(pattern) = value.as_str() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            &format!("{kind} must be a non-empty pattern string"),
        )]);
    };
    if pattern.is_empty() || Regex::new(&format!("^(?:{})$", pattern)).is_err() {
        let message = if pattern.is_empty() {
            format!("{kind} must be a non-empty pattern string")
        } else {
            format!("{kind} pattern does not compile")
        };
        return Err(vec![error(pack_id, rule_id, path, &message)]);
    }
    Ok(json!({"kind": kind, "pattern": pattern}))
}

fn compile_name_pattern(
    kind: &str,
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
    allow_empty: bool,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            &format!("{kind} must be an object"),
        )]);
    };
    let allowed: &[&str] = match kind {
        "flagAllowlist" => &["names", "shortChars"],
        "envAssignmentNameIn" => &["names", "prefixes", "caseInsensitivePrefixes"],
        _ => &["names", "prefixes", "shortChars"],
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if !allowed.contains(&field.as_str()) {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                &format!("unknown {kind} field"),
            ));
        }
    }
    let mut result = Map::new();
    result.insert("kind".into(), json!(kind));
    let mut present = false;
    for field in allowed {
        if let Some(value) = object.get(*field) {
            present = true;
            match string_array(
                field,
                value,
                &format!("{path}.{field}"),
                pack_id,
                rule_id,
                true,
            ) {
                Ok(values) => {
                    result.insert(
                        (*field).into(),
                        Value::Array(values.into_iter().map(Value::String).collect()),
                    );
                }
                Err(mut field_errors) => errors.append(&mut field_errors),
            }
        }
    }
    if !present && !allow_empty {
        errors.push(error(
            pack_id,
            rule_id,
            path,
            &format!("{kind} requires at least one criterion"),
        ));
    }
    if errors.is_empty() {
        Ok(Value::Object(result))
    } else {
        Err(errors)
    }
}

fn compile_flag_value_in(
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "flagValueIn must be an object",
        )]);
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if !matches!(field.as_str(), "names" | "values" | "allowUndefinedValue") {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                "unknown flagValueIn field",
            ));
        }
    }
    let names = match required_string_array(
        object.get("names"),
        &format!("{path}.names"),
        "flagValueIn.names",
        pack_id,
        rule_id,
    ) {
        Ok(v) => v,
        Err(e) => {
            errors.extend(e);
            Vec::new()
        }
    };
    let values = match required_string_array(
        object.get("values"),
        &format!("{path}.values"),
        "flagValueIn.values",
        pack_id,
        rule_id,
    ) {
        Ok(v) => v,
        Err(e) => {
            errors.extend(e);
            Vec::new()
        }
    };
    if let Some(value) = object.get("allowUndefinedValue") {
        if !value.is_boolean() {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.allowUndefinedValue"),
                "allowUndefinedValue must be a boolean",
            ));
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut result = Map::new();
    result.insert("kind".into(), json!("flagValueIn"));
    result.insert(
        "names".into(),
        Value::Array(names.into_iter().map(Value::String).collect()),
    );
    result.insert(
        "values".into(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
    if let Some(value) = object.get("allowUndefinedValue") {
        result.insert("allowUndefinedValue".into(), value.clone());
    }
    Ok(Value::Object(result))
}

fn compile_flag_count(
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "flagCount must be an object",
        )]);
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if !matches!(field.as_str(), "names" | "shortChars" | "min" | "max") {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                "unknown flagCount field",
            ));
        }
    }
    let mut result = Map::new();
    result.insert("kind".into(), json!("flagCount"));
    for field in ["names", "shortChars"] {
        if let Some(value) = object.get(field) {
            match string_array(
                field,
                value,
                &format!("{path}.{field}"),
                pack_id,
                rule_id,
                true,
            ) {
                Ok(values) => {
                    result.insert(
                        field.into(),
                        Value::Array(values.into_iter().map(Value::String).collect()),
                    );
                }
                Err(mut e) => errors.append(&mut e),
            }
        }
    }
    for field in ["min", "max"] {
        if let Some(value) = object.get(field) {
            if let Some(number) = safe_integer(value) {
                result.insert(field.into(), json!(number));
            } else {
                errors.push(error(
                    pack_id,
                    rule_id,
                    &format!("{path}.{field}"),
                    &format!("flagCount.{field} must be a non-negative integer"),
                ));
            }
        }
    }
    if errors.is_empty() {
        Ok(Value::Object(result))
    } else {
        Err(errors)
    }
}

fn compile_redirect(
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    if value == &Value::Bool(true) {
        return Ok(json!({"kind":"redirect"}));
    }
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "redirect must be true or an object",
        )]);
    };
    let mut errors = Vec::new();
    let mut result = Map::new();
    result.insert("kind".into(), json!("redirect"));
    for field in object.keys() {
        if !matches!(field.as_str(), "stream" | "target" | "targetKind") {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                "unknown redirect field",
            ));
        }
    }
    if let Some(value) = object.get("stream") {
        if !matches!(
            value.as_str(),
            Some("stdout") | Some("stderr") | Some("stdin") | Some("fd") | Some("both")
        ) {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.stream"),
                "invalid redirect.stream",
            ));
        } else {
            result.insert("stream".into(), value.clone());
        }
    }
    if let Some(value) = object.get("target") {
        if !value.is_string() {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.target"),
                "redirect.target must be a string",
            ));
        } else {
            result.insert("target".into(), value.clone());
        }
    }
    if let Some(value) = object.get("targetKind") {
        if !matches!(
            value.as_str(),
            Some("file") | Some("fd") | Some("heredoc") | Some("herestring")
        ) {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.targetKind"),
                "invalid redirect.targetKind",
            ));
        } else {
            result.insert("targetKind".into(), value.clone());
        }
    }
    if errors.is_empty() {
        Ok(Value::Object(result))
    } else {
        Err(errors)
    }
}

fn compile_composition(
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
    depth: usize,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "composition must be an object",
        )]);
    };
    let mut errors = Vec::new();
    let stage = match compile_match_inner(
        object.get("stage").unwrap_or(&Value::Null),
        &format!("{path}.stage"),
        pack_id,
        rule_id,
        depth + 1,
    ) {
        Ok(v) => Some(v),
        Err(e) => {
            errors.extend(e);
            None
        }
    };
    let operators = match object.get("operators").and_then(Value::as_array) {
        Some(values) if !values.is_empty() => {
            let mut result = Vec::new();
            for value in values {
                if matches!(value.as_str(), Some("and") | Some("seq")) {
                    result.push(value.clone());
                } else {
                    errors.push(error(
                        pack_id,
                        rule_id,
                        &format!("{path}.operators"),
                        "invalid composition operator",
                    ));
                }
            }
            result
        }
        _ => {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.operators"),
                "composition.operators must be a non-empty array",
            ));
            Vec::new()
        }
    };
    if let Some(value) = object.get("allowBackground") {
        if !value.is_boolean() {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.allowBackground"),
                "composition.allowBackground must be boolean",
            ));
        }
    }
    if let Some(value) = object.get("minStages") {
        if safe_integer(value) != Some(value.as_u64().unwrap_or(0)) || value.as_u64() == Some(0) {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.minStages"),
                "composition.minStages must be a positive safe integer",
            ));
        }
    }
    if let Some(value) = object.get("orFallback") {
        match value.as_array() {
            Some(values)
                if !values.is_empty()
                    && values
                        .iter()
                        .all(|v| matches!(v.as_str(), Some("true") | Some(":"))) => {}
            Some(values) if values.is_empty() => errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.orFallback"),
                "composition.orFallback must be a non-empty array",
            )),
            Some(_) => errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.orFallback"),
                "composition.orFallback entries must be \"true\" or \":\"",
            )),
            None => errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.orFallback"),
                "composition.orFallback must be a non-empty array",
            )),
        }
    }
    if !errors.is_empty() || stage.is_none() {
        return Err(errors);
    }
    let mut result = Map::new();
    result.insert("kind".into(), json!("composition"));
    result.insert("stage".into(), json!(stage.unwrap_or(Value::Null)));
    result.insert("operators".into(), Value::Array(operators));
    for field in ["allowBackground", "minStages", "orFallback"] {
        if let Some(value) = object.get(field) {
            result.insert(field.into(), value.clone());
        }
    }
    Ok(Value::Object(result))
}

fn compile_match_array(
    kind: &str,
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
    depth: usize,
) -> Result<Value, Vec<Value>> {
    let Some(values) = value.as_array() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "expected matcher array",
        )]);
    };
    if values.is_empty() {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "matcher array must be non-empty",
        )]);
    }
    let mut errors = Vec::new();
    let mut compiled = Vec::new();
    for (index, value) in values.iter().enumerate() {
        match compile_match_inner(
            value,
            &format!("{path}[{index}]"),
            pack_id,
            rule_id,
            depth + 1,
        ) {
            Ok(v) => compiled.push(v),
            Err(e) => errors.extend(e),
        }
    }
    if !errors.is_empty() {
        Err(errors)
    } else {
        Ok(json!({"kind":kind, "of":compiled}))
    }
}

fn compile_compound_scope(
    kind: &str,
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            &format!("{kind} must be an object"),
        )]);
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if field != "scopes" {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                &format!("unknown {kind} field"),
            ));
        }
    }
    let scopes = match path_scopes(
        object.get("scopes"),
        &format!("{path}.scopes"),
        kind,
        pack_id,
        rule_id,
    ) {
        Ok(v) => v,
        Err(e) => {
            errors.extend(e);
            Vec::new()
        }
    };
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut result = Map::new();
    result.insert("kind".into(), json!(kind));
    result.insert(
        "scopes".into(),
        Value::Array(scopes.into_iter().map(Value::String).collect()),
    );
    Ok(Value::Object(result))
}

fn compile_path_scope(
    kind: &str,
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            &format!("{kind} must be an object"),
        )]);
    };
    let mut errors = Vec::new();
    let scopes = match path_scopes(
        object.get("scopes"),
        &format!("{path}.scopes"),
        kind,
        pack_id,
        rule_id,
    ) {
        Ok(v) => v,
        Err(e) => {
            errors.extend(e);
            Vec::new()
        }
    };
    let allowed = [
        "scopes",
        "programs",
        "usages",
        "allowExactPaths",
        "forbidPathSegments",
        "requireFacts",
    ];
    for field in object.keys() {
        if !allowed.contains(&field.as_str()) {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                &format!("unknown {kind} field"),
            ));
        }
    }
    let mut result = Map::new();
    result.insert("kind".into(), json!("pathScope"));
    result.insert(
        "mode".into(),
        json!(match kind {
            "pathScopesAllIn" => "all-in",
            "pathScopesNoneIn" => "none-in",
            _ => "some-in",
        }),
    );
    result.insert(
        "scopes".into(),
        Value::Array(scopes.into_iter().map(Value::String).collect()),
    );
    for field in [
        "programs",
        "usages",
        "allowExactPaths",
        "forbidPathSegments",
    ] {
        if let Some(value) = object.get(field) {
            let Some(values) = value.as_array() else {
                errors.push(error(
                    pack_id,
                    rule_id,
                    &format!("{path}.{field}"),
                    &format!("{kind}.{field} must be a non-empty array"),
                ));
                continue;
            };
            if values.is_empty() {
                errors.push(error(
                    pack_id,
                    rule_id,
                    &format!("{path}.{field}"),
                    &format!("{kind}.{field} must be a non-empty array"),
                ));
                continue;
            }
            let mut normalized = Vec::new();
            for (index, value) in values.iter().enumerate() {
                let valid = match field {
                    "programs" => value.as_str().is_some_and(|value| !value.is_empty()),
                    "usages" => matches!(
                        value.as_str(),
                        Some("cwd-prefix")
                            | Some("argument")
                            | Some("flag-value")
                            | Some("redirect-target")
                            | Some("implicit-temp")
                    ),
                    "allowExactPaths" => value.as_str().is_some_and(|value| {
                        !value.is_empty()
                            && (value.starts_with('/') || value.chars().nth(1) == Some(':'))
                    }),
                    "forbidPathSegments" => value.as_str().is_some_and(|value| {
                        !value.is_empty() && !value.contains('/') && !value.contains('\\')
                    }),
                    _ => false,
                };
                if !valid {
                    errors.push(error(
                        pack_id,
                        rule_id,
                        &format!("{path}.{field}[{index}]"),
                        if field == "programs" {
                            "expected non-empty string"
                        } else if field == "usages" {
                            "invalid path usage"
                        } else if field == "allowExactPaths" {
                            "allowExactPaths entries must be absolute paths"
                        } else {
                            "forbidPathSegments entries must be non-empty bare segments"
                        },
                    ));
                    continue;
                }
                if !normalized.iter().any(|existing: &Value| existing == value) {
                    normalized.push(value.clone());
                }
            }
            result.insert(field.into(), Value::Array(normalized));
        }
    }
    if let Some(value) = object.get("requireFacts") {
        if !matches!(
            value.as_str(),
            Some("one-or-more") | Some("zero-or-more") | Some("per-command-stage")
        ) {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.requireFacts"),
                "invalid requireFacts",
            ));
        } else {
            result.insert("requireFacts".into(), value.clone());
        }
    }
    if object.get("programs").is_some()
        && result.get("requireFacts").and_then(Value::as_str) != Some("per-command-stage")
    {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.programs"),
            &format!("{kind}.programs requires requireFacts \"per-command-stage\""),
        ));
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    if matches!(kind, "pathScopesAllIn" | "pathScopesSomeIn")
        && result.get("requireFacts").is_none()
    {
        result.insert("requireFacts".into(), json!("one-or-more"));
    }
    Ok(Value::Object(result))
}

fn path_scopes(
    value: Option<&Value>,
    path: &str,
    kind: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Vec<String>, Vec<Value>> {
    let Some(value) = value else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            &format!("{kind}.scopes is required"),
        )]);
    };
    let Some(values) = value.as_array() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            &format!("{kind}.scopes must be a non-empty array"),
        )]);
    };
    if values.is_empty() {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            &format!("{kind}.scopes must be a non-empty array"),
        )]);
    }
    let allowed = [
        "writable-project",
        "project",
        "temp",
        "home",
        "safe-home",
        "sensitive-home",
        "agent-support",
        "system",
        "outside",
        "denied",
        "unknown",
    ];
    let mut result = Vec::new();
    let mut errors = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if let Some(value) = value.as_str().filter(|value| allowed.contains(value)) {
            result.push(value.to_owned());
        } else {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}[{index}]"),
                "invalid scope",
            ));
        }
    }
    if errors.is_empty() {
        Ok(result)
    } else {
        Err(errors)
    }
}

fn compile_mutation_tool(
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "mutationTool must be an object",
        )]);
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if field != "tools" {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                "unknown mutationTool field",
            ));
        }
    }
    let Some(tools_value) = object.get("tools") else {
        return Err(vec![error(
            pack_id,
            rule_id,
            &format!("{path}.tools"),
            "mutationTool.tools is required",
        )]);
    };
    let Some(values) = tools_value.as_array() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            &format!("{path}.tools"),
            "mutationTool.tools must be an array",
        )]);
    };
    let allowed = ["edit", "write"];
    let mut tools = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if let Some(value) = value.as_str().filter(|value| allowed.contains(value)) {
            tools.push(value.to_owned());
        } else {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.tools[{index}]"),
                "invalid mutation tool",
            ));
        }
    }
    if errors.is_empty() {
        Ok(json!({"kind":"mutationTool", "tools":tools}))
    } else {
        Err(errors)
    }
}

fn compile_mutation_shape(
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "mutationShape must be an object",
        )]);
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if field != "shape" {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                "unknown mutationShape field",
            ));
        }
    }
    if !matches!(
        object.get("shape").and_then(Value::as_str),
        Some("well-formed") | Some("create") | Some("replace")
    ) {
        errors.push(error(
            pack_id,
            rule_id,
            &format!("{path}.shape"),
            "invalid mutation shape",
        ));
    }
    if errors.is_empty() {
        Ok(json!({"kind":"mutationShape", "shape":object["shape"]}))
    } else {
        Err(errors)
    }
}

fn compile_mutation_boundary(
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Value, Vec<Value>> {
    let Some(object) = value.as_object() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "mutationTrustBoundary must be an object",
        )]);
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if field != "in" {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.{field}"),
                "unknown mutationTrustBoundary field",
            ));
        }
    }
    let Some(in_value) = object.get("in") else {
        return Err(vec![error(
            pack_id,
            rule_id,
            &format!("{path}.in"),
            "mutationTrustBoundary.in is required",
        )]);
    };
    let Some(values) = in_value.as_array() else {
        return Err(vec![error(
            pack_id,
            rule_id,
            &format!("{path}.in"),
            "mutationTrustBoundary.in must be a non-empty array",
        )]);
    };
    if values.is_empty() {
        return Err(vec![error(
            pack_id,
            rule_id,
            &format!("{path}.in"),
            "mutationTrustBoundary.in must be a non-empty array",
        )]);
    }
    let allowed = [
        "none",
        "project-overlay",
        "policy-pack",
        "reviewer-config",
        "executable-hook",
        "package-script",
        "user-owned-config",
        "sensitive-home",
        "unknown",
    ];
    let mut kinds = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if let Some(value) = value.as_str().filter(|value| allowed.contains(value)) {
            kinds.push(value.to_owned());
        } else {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}.in[{index}]"),
                "invalid mutation trust boundary",
            ));
        }
    }
    if errors.is_empty() {
        Ok(json!({"kind":"mutationTrustBoundary", "in":kinds}))
    } else {
        Err(errors)
    }
}

fn string_array(
    _field: &str,
    value: &Value,
    path: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
    non_empty: bool,
) -> Result<Vec<String>, Vec<Value>> {
    let Some(values) = value.as_array() else {
        return Err(vec![error(pack_id, rule_id, path, "expected string array")]);
    };
    if non_empty && values.is_empty() {
        return Err(vec![error(
            pack_id,
            rule_id,
            path,
            "expected non-empty string array",
        )]);
    }
    let mut result = Vec::new();
    let mut errors = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if let Some(value) = value.as_str() {
            if !non_empty || !value.is_empty() {
                result.push(value.to_owned());
            } else {
                errors.push(error(
                    pack_id,
                    rule_id,
                    &format!("{path}[{index}]"),
                    "expected non-empty string",
                ));
            }
        } else {
            errors.push(error(
                pack_id,
                rule_id,
                &format!("{path}[{index}]"),
                "expected string",
            ));
        }
    }
    if errors.is_empty() {
        Ok(result)
    } else {
        Err(errors)
    }
}
fn required_string_array(
    value: Option<&Value>,
    path: &str,
    label: &str,
    pack_id: Option<&str>,
    rule_id: Option<&str>,
) -> Result<Vec<String>, Vec<Value>> {
    let value = value.unwrap_or(&Value::Null);
    match string_array(label, value, path, pack_id, rule_id, true) {
        Ok(v) => Ok(v),
        Err(_) => Err(vec![error(
            pack_id,
            rule_id,
            path,
            &format!("{label} must be a non-empty string array"),
        )]),
    }
}
fn non_empty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}
fn safe_integer(value: &Value) -> Option<u64> {
    let number = value.as_u64()?;
    (number <= 9_007_199_254_740_991).then_some(number)
}
fn valid_source(value: Option<&str>) -> bool {
    matches!(
        value,
        Some("shipped")
            | Some("user-global")
            | Some("user-project")
            | Some("trusted-repo")
            | Some("package")
            | Some("generated")
            | Some("default")
    )
}
fn error(pack_id: Option<&str>, rule_id: Option<&str>, path: &str, message: &str) -> Value {
    json!({"packId": pack_id, "ruleId": rule_id, "path": path, "message": message})
}

/// Allocate a native policy handle from an effective-policy JSON object.
pub fn new_policy(policy: &Value) -> Result<CompiledPolicyHandle, String> {
    let Some(object) = policy.as_object() else {
        return Err("expected effective policy object".into());
    };
    let compile_lane = |field: &str| {
        object
            .get(field)
            .and_then(Value::as_array)
            .map(|rules| {
                rules
                    .iter()
                    .map(|raw| CompiledRule {
                        matcher: MatcherIr::compile(raw.get("match").unwrap_or(&Value::Null)),
                        raw: raw.clone(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let floor = compile_lane("floor");
    let active = if object.contains_key("active") {
        compile_lane("active")
    } else {
        compile_lane("rules")
    };
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    policies()
        .lock()
        .map_err(|_| "policy handle lock poisoned".to_owned())?
        .insert(
            handle,
            std::sync::Arc::new(CompiledPolicy { floor, active }),
        );
    Ok(CompiledPolicyHandle(handle))
}

pub fn free_policy(handle: CompiledPolicyHandle) -> bool {
    policies()
        .lock()
        .ok()
        .and_then(|mut values| values.remove(&handle.0))
        .is_some()
}

pub fn evaluate_matcher(expr: &Value, shape: &Value) -> bool {
    eval_expr(expr, shape)
}

pub fn decide_policy(handle: CompiledPolicyHandle, shape: &Value) -> Value {
    // Clone the Arc (cheap refcount bump) rather than deep-cloning the whole
    // rule set on every decision; the lock is held only for the lookup.
    let policy = match policies()
        .lock()
        .ok()
        .and_then(|values| values.get(&handle.0).cloned())
    {
        Some(policy) => policy,
        None => return default_review("unknown policy handle"),
    };
    decide_shape(shape, &policy)
}

/// Evaluate a batch while crossing the Node-API JSON boundary once. Replay
/// already runs inside Rust, but this seam also gives future tune/runtime callers
/// a way to amortize shape and decision serialization over a group of calls.
pub fn decide_policy_batch(handle: CompiledPolicyHandle, shapes: &Value) -> Value {
    let policy = match policies()
        .lock()
        .ok()
        .and_then(|values| values.get(&handle.0).cloned())
    {
        Some(policy) => policy,
        None => return Value::Array(Vec::new()),
    };
    let Some(shapes) = shapes.as_array() else {
        return Value::Array(Vec::new());
    };
    Value::Array(
        shapes
            .iter()
            .map(|shape| decide_shape(shape, &policy))
            .collect(),
    )
}

fn decide_shape(shape: &Value, policy: &CompiledPolicy) -> Value {
    if shape.get("kind").and_then(Value::as_str) == Some("pi-tool")
        && shape.get("operation").and_then(Value::as_str) == Some("embedded-shell")
    {
        if let Some(projection) = shape.get("embeddedShell") {
            if let Some(inner) = projection.get("command") {
                let inner_decision = decide_plain_shape(inner, policy);
                if inner_decision.get("effect").and_then(Value::as_str) == Some("deny") {
                    return inner_decision;
                }
                let wrapper_uncertain = diagnostics(shape).iter().any(|diagnostic| {
                    diagnostic.get("severity").and_then(Value::as_str) != Some("info")
                }) || projection
                    .get("diagnostics")
                    .and_then(Value::as_array)
                    .is_some_and(|diagnostics| {
                        diagnostics.iter().any(|diagnostic| {
                            diagnostic.get("severity").and_then(Value::as_str) != Some("info")
                        })
                    });
                let safe_cwd = projection.get("workingDirectory").is_none()
                    || projection
                        .get("workingDirectoryFact")
                        .and_then(|fact| fact.get("scope"))
                        .and_then(Value::as_str)
                        .is_some_and(|scope| scope == "project" || scope == "writable-project");
                if !wrapper_uncertain
                    && safe_cwd
                    && inner_decision.get("effect").and_then(Value::as_str) == Some("allow")
                {
                    return inner_decision;
                }
                if !wrapper_uncertain && safe_cwd {
                    let fallback = decide_plain_shape(shape, policy);
                    if fallback.get("effect").and_then(Value::as_str) == Some("allow") {
                        return inner_decision;
                    }
                    return fallback;
                }
            }
        }
    }
    decide_plain_shape(shape, policy)
}

fn decide_plain_shape(shape: &Value, policy: &CompiledPolicy) -> Value {
    for rule in &policy.floor {
        if rule.raw.get("effect").and_then(Value::as_str) == Some("deny") && eval_rule(rule, shape)
        {
            return decision_from_rule(&rule.raw);
        }
    }
    let blocking = diagnostics_blocking(shape);
    let rules: Vec<&CompiledRule> = if blocking {
        policy
            .active
            .iter()
            .filter(|rule| {
                rule.raw.get("effect").and_then(Value::as_str) != Some("allow")
                    && eval_rule(rule, shape)
            })
            .collect()
    } else {
        policy
            .active
            .iter()
            .filter(|rule| eval_rule(rule, shape))
            .collect()
    };
    if rules.is_empty() {
        return default_review(if blocking {
            "parse diagnostics present"
        } else {
            "no matching rule"
        });
    }
    let rank = |effect: Option<&str>| match effect {
        Some("allow") => 1,
        Some("review") => 2,
        Some("deny") => 3,
        _ => 0,
    };
    let winning_rank = rules
        .iter()
        .map(|rule| rank(rule.raw.get("effect").and_then(Value::as_str)))
        .max()
        .unwrap_or(0);
    let winners: Vec<&CompiledRule> = rules
        .into_iter()
        .filter(|rule| rank(rule.raw.get("effect").and_then(Value::as_str)) == winning_rank)
        .collect();
    let mut chosen = winners.first().copied();
    for candidate in winners.into_iter().skip(1) {
        if chosen.is_some_and(|current| {
            compare_rules(&candidate.raw, &current.raw) == std::cmp::Ordering::Greater
        }) {
            chosen = Some(candidate);
        }
    }
    chosen
        .map(|rule| decision_from_rule(&rule.raw))
        .unwrap_or_else(|| default_review("interpreter error"))
}

fn eval_rule(rule: &CompiledRule, shape: &Value) -> bool {
    eval_compiled_expr(&rule.matcher, shape)
}
fn decision_from_rule(rule: &Value) -> Value {
    let id = rule.get("id").and_then(Value::as_str).unwrap_or("");
    let reason = rule.get("reason").and_then(Value::as_str).unwrap_or("");
    let reason = if reason.starts_with(&format!("{id}:")) {
        reason.to_owned()
    } else {
        format!("{id}: {reason}")
    };
    json!({"effect":rule.get("effect").cloned().unwrap_or(json!("review")),"reason":reason,"provenance":rule.get("provenance").cloned().unwrap_or(json!({"source":"default"}))})
}
fn default_review(reason: &str) -> Value {
    json!({"effect":"review","reason":reason,"provenance":{"source":"default"}})
}
fn diagnostics_blocking(shape: &Value) -> bool {
    shape
        .get("diagnostics")
        .and_then(Value::as_array)
        .is_some_and(|diagnostics| {
            diagnostics.iter().any(|diagnostic| {
                diagnostic.get("severity").and_then(Value::as_str) != Some("info")
            })
        })
}

fn compare_rules(a: &Value, b: &Value) -> std::cmp::Ordering {
    let a_score = specificity(a.get("match").unwrap_or(&Value::Null));
    let b_score = specificity(b.get("match").unwrap_or(&Value::Null));
    a_score
        .partial_cmp(&b_score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| source_priority(a).cmp(&source_priority(b)))
}
fn source_priority(rule: &Value) -> i32 {
    match rule
        .get("provenance")
        .and_then(|p| p.get("source"))
        .and_then(Value::as_str)
    {
        Some("user-project") => 4,
        Some("user-global") => 3,
        Some("trusted-repo") | Some("package") => 2,
        Some("shipped") => 1,
        _ => 0,
    }
}
fn specificity(expr: &Value) -> f64 {
    let kind = expr.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "always" => 0.0,
        "tool" => 1.0,
        "program" => 3.0,
        "arg0In" => {
            2.0 + inverse_width(
                expr.get("values")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len),
            )
        }
        "argAt" => 3.0,
        "argMatches" | "argCount" | "envAssignmentCount" | "flagPresent" | "noSubstitution"
        | "noStdoutRedirect" | "redirect" | "pipeline" | "operator" | "flagAllowlist" => 2.0,
        "flagMatches"
        | "flagValueIn"
        | "flagCount"
        | "anyArgMatches"
        | "envAssignmentNameIn"
        | "compoundForm"
        | "bodyStagesAllReadOnly"
        | "bodyStagesAllScopeIn"
        | "iteratorScopesAllIn"
        | "noBodySubstitution"
        | "noBodyShellWrap"
        | "noBodyRedirectTo"
        | "diagnosticCode"
        | "mutationShape"
        | "mutationTrustBoundary" => 3.0,
        "mutationTool" => {
            2.0 + inverse_width(
                expr.get("tools")
                    .and_then(Value::as_array)
                    .map_or(2, Vec::len),
            )
        }
        "stageEvery" => specificity(expr.get("inner").unwrap_or(&Value::Null)) + 1.0,
        "stageSome" => specificity(expr.get("inner").unwrap_or(&Value::Null)),
        "composition" => {
            specificity(expr.get("stage").unwrap_or(&Value::Null))
                + expr
                    .get("operators")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len) as f64
                + if expr.get("allowBackground").and_then(Value::as_bool) == Some(true) {
                    0.0
                } else {
                    1.0
                }
        }
        "all" => expr
            .get("of")
            .and_then(Value::as_array)
            .map_or(0.0, |values| values.iter().map(specificity).sum()),
        "any" => expr
            .get("of")
            .and_then(Value::as_array)
            .map_or(0.0, |values| {
                values.iter().map(specificity).fold(0.0, f64::max)
            }),
        "pathScope" => {
            3.0 + if expr.get("requireFacts").and_then(Value::as_str) == Some("per-command-stage") {
                1.0 + if expr.get("programs").is_some() {
                    1.0
                } else {
                    0.0
                }
            } else {
                0.0
            }
        }
        "not" => 0.0,
        _ => 0.0,
    }
}
fn inverse_width(width: usize) -> f64 {
    if width == 0 {
        0.0
    } else {
        1.0 / width as f64
    }
}

fn eval_compiled_expr(expr: &MatcherIr, shape: &Value) -> bool {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match expr {
        MatcherIr::Always => true,
        MatcherIr::Tool(tool) => matches_tool(tool, shape),
        MatcherIr::Program(program) => every_command_stage(shape, |stage| {
            command_program(stage) == Some(program.as_str())
                && stage
                    .get("program")
                    .and_then(|value| value.get("resolvable"))
                    .and_then(Value::as_bool)
                    == Some(true)
        }),
        MatcherIr::Arg0In(values) => every_command_stage(shape, |stage| {
            command_arg(stage, 0).is_some_and(|value| values.contains(value))
        }),
        MatcherIr::ArgAt { index, value } => every_command_stage(shape, |stage| {
            command_arg(stage, *index) == Some(value.as_str())
        }),
        MatcherIr::ArgCount { min, max } => {
            every_command_stage(shape, |stage| range_values(args(stage).len(), *min, *max))
        }
        MatcherIr::EnvAssignmentCount { min, max } => every_command_stage(shape, |stage| {
            range_values(environment(stage).len(), *min, *max)
        }),
        MatcherIr::ArgMatches { index, regex } => every_command_stage(shape, |stage| {
            command_arg(stage, *index).is_some_and(|value| regex.is_match(value))
        }),
        MatcherIr::FlagPresent(name) => every_command_stage(shape, |stage| {
            flags(stage)
                .iter()
                .any(|flag| normalize_flag(flag_name(flag)) == *name)
        }),
        MatcherIr::FlagMatches {
            names,
            prefixes,
            short_chars,
        } => any_modeled_stage(shape, |stage| {
            flags(stage).iter().any(|flag| {
                let name = normalize_flag(flag_name(flag));
                names.contains(&name)
                    || prefixes.iter().any(|prefix| name.starts_with(prefix))
                    || (flag.get("short").and_then(Value::as_bool) == Some(true)
                        && flag_name(flag)
                            .chars()
                            .any(|character| short_chars.contains(&character)))
            })
        }),
        MatcherIr::FlagAllowlist { names, short_chars } => {
            is_bash(shape)
                && every_command_stage(shape, |stage| {
                    (names.is_empty() && short_chars.is_empty() || !flags(stage).is_empty())
                        && flags(stage).iter().all(|flag| {
                            names.contains(&normalize_flag(flag_name(flag)))
                                || (flag.get("short").and_then(Value::as_bool) == Some(true)
                                    && flag_name(flag)
                                        .chars()
                                        .all(|character| short_chars.contains(&character)))
                        })
                })
        }
        MatcherIr::FlagValueIn {
            names,
            values,
            allow_undefined_value,
        } => {
            is_bash(shape)
                && every_command_stage(shape, |stage| {
                    flags(stage).iter().all(|flag| {
                        let name = normalize_flag(flag_name(flag));
                        if !names.contains(&name) {
                            return true;
                        }
                        flag.get("value")
                            .and_then(Value::as_str)
                            .map(|value| values.contains(value))
                            .unwrap_or(*allow_undefined_value)
                    })
                })
        }
        MatcherIr::FlagCount {
            names,
            short_chars,
            min,
            max,
        } => {
            is_bash(shape)
                && every_command_stage(shape, |stage| {
                    let active = !names.is_empty() || !short_chars.is_empty();
                    let count = flags(stage)
                        .iter()
                        .filter(|flag| {
                            !active
                                || names.contains(&normalize_flag(flag_name(flag)))
                                || (flag.get("short").and_then(Value::as_bool) == Some(true)
                                    && flag_name(flag)
                                        .chars()
                                        .any(|character| short_chars.contains(&character)))
                        })
                        .count();
                    range_values(count, *min, *max)
                })
        }
        MatcherIr::AnyArgMatches { regex } => {
            is_bash(shape)
                && any_modeled_stage(shape, |stage| {
                    args(stage).iter().any(|argument| {
                        argument.as_str().is_some_and(|argument| {
                            regex.is_match(argument) || regex.is_match(&unquote(argument))
                        })
                    })
                })
        }
        MatcherIr::EnvAssignmentNameIn {
            names,
            prefixes,
            case_insensitive_prefixes,
        } => {
            is_bash(shape)
                && any_modeled_stage(shape, |stage| {
                    environment(stage).iter().any(|assignment| {
                        let name = assignment.get("name").and_then(Value::as_str).unwrap_or("");
                        names.contains(name)
                            || prefixes.iter().any(|prefix| name.starts_with(prefix))
                            || case_insensitive_prefixes
                                .iter()
                                .any(|prefix| name.to_lowercase().starts_with(prefix))
                    })
                })
        }
        MatcherIr::NoSubstitution => {
            every_command_stage(shape, |stage| substitutions(stage).is_empty())
        }
        MatcherIr::NoStdoutRedirect => every_command_stage(shape, |stage| {
            !redirects(stage).iter().any(|redirect| {
                matches!(
                    redirect.get("stream").and_then(Value::as_str),
                    Some("stdout") | Some("both")
                )
            })
        }),
        MatcherIr::Redirect {
            stream,
            target,
            target_kind,
        } => every_command_stage(shape, |stage| {
            redirects(stage).iter().any(|redirect| {
                stream.as_deref().is_none_or(|value| {
                    redirect.get("stream").and_then(Value::as_str) == Some(value)
                }) && target.as_deref().is_none_or(|value| {
                    redirect.get("target").and_then(Value::as_str) == Some(value)
                }) && target_kind.as_deref().is_none_or(|value| {
                    redirect.get("targetKind").and_then(Value::as_str) == Some(value)
                })
            })
        }),
        MatcherIr::Pipeline(target) => {
            is_bash(shape)
                && blocks(shape).iter().any(|block| {
                    block
                        .get("pipeline")
                        .and_then(|pipeline| pipeline.get("pipeTargets"))
                        .and_then(Value::as_array)
                        .is_some_and(|targets| {
                            targets.iter().any(|value| value.as_str() == Some(target))
                        })
                })
        }
        MatcherIr::Operator(op) => {
            is_bash(shape) && blocks(shape).iter().any(|block| block_operator(block, op))
        }
        MatcherIr::StageEvery(inner) => {
            is_bash(shape)
                && !stages(shape).is_empty()
                && stages(shape).iter().enumerate().all(|(index, stage)| {
                    eval_compiled_expr(inner, &single_stage_shape(shape, stage, index))
                })
        }
        MatcherIr::StageSome(inner) => {
            is_bash(shape)
                && any_modeled_stage_refs(shape).iter().any(|(stage, index)| {
                    eval_compiled_expr(inner, &single_stage_shape(shape, stage, *index))
                })
        }
        MatcherIr::DiagnosticCode(code) => diagnostics(shape)
            .iter()
            .any(|diagnostic| diagnostic.get("code").and_then(Value::as_str) == Some(code)),
        MatcherIr::All(children) => children
            .iter()
            .all(|child| eval_compiled_expr(child, shape)),
        MatcherIr::Any(children) => children
            .iter()
            .any(|child| eval_compiled_expr(child, shape)),
        MatcherIr::Not(child) => !eval_compiled_expr(child, shape),
        MatcherIr::Raw(raw) => eval_expr(raw, shape),
    }));
    result.unwrap_or(false)
}

fn range_values(count: usize, min: Option<u64>, max: Option<u64>) -> bool {
    min.is_none_or(|value| count as u64 >= value) && max.is_none_or(|value| count as u64 <= value)
}

fn eval_expr(expr: &Value, shape: &Value) -> bool {
    let kind = expr.get("kind").and_then(Value::as_str).unwrap_or("");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match kind {
        "always" => true,
        "tool" => matches_tool(
            expr.get("tool").and_then(Value::as_str).unwrap_or(""),
            shape,
        ),
        "program" => every_command_stage(shape, |stage| {
            command_program(stage) == expr.get("name").and_then(Value::as_str)
                && stage
                    .get("program")
                    .and_then(|p| p.get("resolvable"))
                    .and_then(Value::as_bool)
                    == Some(true)
        }),
        "arg0In" => every_command_stage(shape, |stage| {
            expr.get("values")
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().any(|v| v.as_str() == command_arg(stage, 0)))
        }),
        "argAt" => every_command_stage(shape, |stage| {
            command_arg(
                stage,
                expr.get("index").and_then(Value::as_u64).unwrap_or(0) as usize,
            ) == expr.get("value").and_then(Value::as_str)
        }),
        "argCount" | "envAssignmentCount" => every_command_stage(shape, |stage| {
            let count = if kind == "argCount" {
                args(stage).len()
            } else {
                environment(stage).len()
            };
            range(count, expr)
        }),
        "argMatches" => every_command_stage(shape, |stage| {
            regex_match(
                expr.get("pattern").and_then(Value::as_str),
                command_arg(
                    stage,
                    expr.get("index").and_then(Value::as_u64).unwrap_or(0) as usize,
                ),
            )
        }),
        "flagPresent" => every_command_stage(shape, |stage| {
            flags(stage).iter().any(|flag| {
                flag_name(flag)
                    == normalize_flag(expr.get("name").and_then(Value::as_str).unwrap_or(""))
            })
        }),
        "flagMatches" => any_modeled_stage(shape, |stage| {
            flags(stage)
                .iter()
                .any(|flag| flag_matches_expr(flag, expr))
        }),
        "flagAllowlist" => {
            is_bash(shape) && every_command_stage(shape, |stage| flag_allowlist(stage, expr))
        }
        "flagValueIn" => {
            is_bash(shape)
                && every_command_stage(shape, |stage| {
                    flags(stage).iter().all(|flag| flag_value_in(flag, expr))
                })
        }
        "flagCount" => {
            is_bash(shape)
                && every_command_stage(shape, |stage| {
                    let active = expr.get("names").is_some() || expr.get("shortChars").is_some();
                    let count = flags(stage)
                        .iter()
                        .filter(|flag| !active || flag_matches_expr(flag, expr))
                        .count();
                    range(count, expr)
                })
        }
        "anyArgMatches" => {
            is_bash(shape)
                && any_modeled_stage(shape, |stage| {
                    args(stage).iter().any(|argument| {
                        argument.as_str().is_some_and(|argument| {
                            regex_match(expr.get("pattern").and_then(Value::as_str), Some(argument))
                                || regex_match(
                                    expr.get("pattern").and_then(Value::as_str),
                                    Some(&unquote(argument)),
                                )
                        })
                    })
                })
        }
        "envAssignmentNameIn" => {
            is_bash(shape)
                && any_modeled_stage(shape, |stage| {
                    environment(stage)
                        .iter()
                        .any(|assignment| env_matches(assignment, expr))
                })
        }
        "noSubstitution" => every_command_stage(shape, |stage| substitutions(stage).is_empty()),
        "noStdoutRedirect" => every_command_stage(shape, |stage| {
            !redirects(stage).iter().any(|redirect| {
                matches!(
                    redirect.get("stream").and_then(Value::as_str),
                    Some("stdout") | Some("both")
                )
            })
        }),
        "redirect" => every_command_stage(shape, |stage| {
            redirects(stage)
                .iter()
                .any(|redirect| redirect_matches(redirect, expr))
        }),
        "pipeline" => {
            is_bash(shape)
                && blocks(shape).iter().any(|block| {
                    block
                        .get("pipeline")
                        .and_then(|p| p.get("pipeTargets"))
                        .and_then(Value::as_array)
                        .is_some_and(|targets| {
                            targets.iter().any(|target| {
                                target.as_str() == expr.get("target").and_then(Value::as_str)
                            })
                        })
                })
        }
        "operator" => {
            is_bash(shape)
                && blocks(shape).iter().any(|block| {
                    block_operator(block, expr.get("op").and_then(Value::as_str).unwrap_or(""))
                })
        }
        "stageEvery" => {
            is_bash(shape)
                && !stages(shape).is_empty()
                && stages(shape).iter().enumerate().all(|(index, stage)| {
                    eval_expr(
                        expr.get("inner").unwrap_or(&Value::Null),
                        &single_stage_shape(shape, stage, index),
                    )
                })
        }
        "stageSome" => {
            is_bash(shape)
                && any_modeled_stage_refs(shape).iter().any(|(stage, index)| {
                    eval_expr(
                        expr.get("inner").unwrap_or(&Value::Null),
                        &single_stage_shape(shape, stage, *index),
                    )
                })
        }
        "compoundForm" => compound_stages(shape).is_some_and(|stages| {
            !stages.is_empty()
                && stages
                    .iter()
                    .all(|stage| compound_form(stage) == expr.get("form").and_then(Value::as_str))
        }),
        "bodyStagesAllReadOnly" => body_command_stages(shape).is_some_and(|stages| {
            !stages.is_empty()
                && stages
                    .iter()
                    .all(|stage| stage_effect(stage) == "read-only")
        }),
        "bodyStagesAllScopeIn" => body_scope_match(shape, expr),
        "iteratorScopesAllIn" => iterator_scope_match(shape, expr),
        "noBodySubstitution" => body_command_stages(shape).is_some_and(|stages| {
            !stages.is_empty() && stages.iter().all(|stage| substitutions(stage).is_empty())
        }),
        "noBodyShellWrap" => body_command_stages(shape).is_some_and(|stages| {
            !stages.is_empty()
                && stages
                    .iter()
                    .all(|stage| stage_effect(stage) != "shell-wrap")
        }),
        "noBodyRedirectTo" => no_body_redirect(shape),
        "diagnosticCode" => diagnostics(shape).iter().any(|diagnostic| {
            diagnostic.get("code").and_then(Value::as_str)
                == expr.get("code").and_then(Value::as_str)
        }),
        "composition" => composition_match(shape, expr),
        "all" => expr
            .get("of")
            .and_then(Value::as_array)
            .is_some_and(|values| {
                !values.is_empty() && values.iter().all(|child| eval_expr(child, shape))
            }),
        "any" => expr
            .get("of")
            .and_then(Value::as_array)
            .is_some_and(|values| {
                !values.is_empty() && values.iter().any(|child| eval_expr(child, shape))
            }),
        "not" => !eval_expr(
            expr.get("of")
                .or_else(|| expr.get("inner"))
                .unwrap_or(&Value::Null),
            shape,
        ),
        "mutationTool" => mutation_tool_match(shape, expr),
        "mutationShape" => mutation_shape_match(shape, expr),
        "mutationTrustBoundary" => {
            shape.get("kind").and_then(Value::as_str) == Some("pi-tool")
                && shape.get("operation").and_then(Value::as_str) == Some("mutation")
                && expr
                    .get("in")
                    .and_then(Value::as_array)
                    .is_some_and(|values| {
                        values.iter().any(|value| {
                            value.as_str()
                                == shape
                                    .get("trustBoundary")
                                    .and_then(|b| b.get("kind"))
                                    .and_then(Value::as_str)
                        })
                    })
        }
        "pathScope" => path_scope_match(shape, expr),
        _ => false,
    }));
    result.unwrap_or(false)
}

fn is_bash(shape: &Value) -> bool {
    shape.get("kind").and_then(Value::as_str) == Some("bash")
}
fn matches_tool(tool: &str, shape: &Value) -> bool {
    if tool == "bash" {
        is_bash(shape)
    } else {
        matches!(
            shape.get("kind").and_then(Value::as_str),
            Some("pi-tool") | Some("unknown")
        ) && shape.get("toolName").and_then(Value::as_str) == Some(tool)
    }
}
fn stages(shape: &Value) -> &[Value] {
    shape
        .get("stages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn blocks(shape: &Value) -> &[Value] {
    shape
        .get("blocks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn diagnostics(shape: &Value) -> &[Value] {
    shape
        .get("diagnostics")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn args(stage: &Value) -> &[Value] {
    stage
        .get("program")
        .and_then(|p| p.get("arguments"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn flags(stage: &Value) -> &[Value] {
    stage
        .get("program")
        .and_then(|p| p.get("flags"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn environment(stage: &Value) -> &[Value] {
    stage
        .get("program")
        .and_then(|p| p.get("environment"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn substitutions(stage: &Value) -> &[Value] {
    stage
        .get("substitutions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn redirects(stage: &Value) -> &[Value] {
    stage
        .get("redirects")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn command_arg(stage: &Value, index: usize) -> Option<&str> {
    args(stage).get(index).and_then(Value::as_str)
}
fn command_program(stage: &Value) -> Option<&str> {
    stage
        .get("program")
        .and_then(|p| p.get("program"))
        .and_then(Value::as_str)
}
fn flag_name(flag: &Value) -> &str {
    flag.get("name").and_then(Value::as_str).unwrap_or("")
}
fn normalize_flag(value: &str) -> String {
    value.trim_start_matches('-').to_owned()
}
fn every_command_stage<F: Fn(&Value) -> bool>(shape: &Value, predicate: F) -> bool {
    is_bash(shape)
        && !stages(shape).is_empty()
        && stages(shape).iter().all(|stage| {
            stage.get("kind").and_then(Value::as_str) == Some("command") && predicate(stage)
        })
}
fn range(count: usize, expr: &Value) -> bool {
    expr.get("min")
        .and_then(Value::as_u64)
        .is_none_or(|min| count as u64 >= min)
        && expr
            .get("max")
            .and_then(Value::as_u64)
            .is_none_or(|max| count as u64 <= max)
}
fn regex_match(pattern: Option<&str>, value: Option<&str>) -> bool {
    let (Some(pattern), Some(value)) = (pattern, value) else {
        return false;
    };
    Regex::new(&format!("^(?:{})$", pattern))
        .map(|regex| regex.is_match(value))
        .unwrap_or(false)
}
fn unquote(value: &str) -> String {
    if value.len() >= 2
        && ((value.starts_with('\'') && value.ends_with('\''))
            || (value.starts_with('"') && value.ends_with('"')))
    {
        value[1..value.len() - 1].to_owned()
    } else {
        value.to_owned()
    }
}
fn flag_value_in(flag: &Value, expr: &Value) -> bool {
    let name = normalize_flag(flag_name(flag));
    let selected = expr
        .get("names")
        .and_then(Value::as_array)
        .is_some_and(|names| {
            names
                .iter()
                .any(|value| normalize_flag(value.as_str().unwrap_or("")) == name)
        });
    if !selected {
        return true;
    }
    if let Some(value) = flag.get("value").and_then(Value::as_str) {
        return expr
            .get("values")
            .and_then(Value::as_array)
            .is_some_and(|values| {
                values
                    .iter()
                    .any(|candidate| candidate.as_str() == Some(value))
            });
    }
    expr.get("allowUndefinedValue").and_then(Value::as_bool) == Some(true)
}
fn flag_matches_expr(flag: &Value, expr: &Value) -> bool {
    let name = normalize_flag(flag_name(flag));
    expr.get("names")
        .and_then(Value::as_array)
        .is_some_and(|values| {
            values
                .iter()
                .any(|v| normalize_flag(v.as_str().unwrap_or("")) == name)
        })
        || expr
            .get("prefixes")
            .and_then(Value::as_array)
            .is_some_and(|values| {
                values
                    .iter()
                    .any(|v| name.starts_with(&normalize_flag(v.as_str().unwrap_or(""))))
            })
        || (flag.get("short").and_then(Value::as_bool) == Some(true)
            && expr
                .get("shortChars")
                .and_then(Value::as_array)
                .is_some_and(|values| {
                    name.chars().any(|c| {
                        values
                            .iter()
                            .any(|v| v.as_str() == Some(c.to_string().as_str()))
                    })
                }))
}
fn flag_allowlist(stage: &Value, expr: &Value) -> bool {
    let names = expr
        .get("names")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(normalize_flag)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let chars = expr
        .get("shortChars")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let requires = !names.is_empty() || !chars.is_empty();
    (!requires || !flags(stage).is_empty())
        && flags(stage).iter().all(|flag| {
            names.contains(&normalize_flag(flag_name(flag)))
                || (flag.get("short").and_then(Value::as_bool) == Some(true)
                    && flag_name(flag)
                        .chars()
                        .all(|c| chars.contains(c.to_string().as_str())))
        })
}
fn env_matches(assignment: &Value, expr: &Value) -> bool {
    let name = assignment.get("name").and_then(Value::as_str).unwrap_or("");
    expr.get("names")
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(name)))
        || expr
            .get("prefixes")
            .and_then(Value::as_array)
            .is_some_and(|values| {
                values
                    .iter()
                    .any(|value| name.starts_with(value.as_str().unwrap_or("")))
            })
        || expr
            .get("caseInsensitivePrefixes")
            .and_then(Value::as_array)
            .is_some_and(|values| {
                values.iter().any(|value| {
                    name.to_lowercase()
                        .starts_with(&value.as_str().unwrap_or("").to_lowercase())
                })
            })
}
fn redirect_matches(redirect: &Value, expr: &Value) -> bool {
    expr.get("stream")
        .and_then(Value::as_str)
        .is_none_or(|v| redirect.get("stream").and_then(Value::as_str) == Some(v))
        && expr
            .get("target")
            .and_then(Value::as_str)
            .is_none_or(|v| redirect.get("target").and_then(Value::as_str) == Some(v))
        && expr
            .get("targetKind")
            .and_then(Value::as_str)
            .is_none_or(|v| redirect.get("targetKind").and_then(Value::as_str) == Some(v))
}
fn block_operator(block: &Value, op: &str) -> bool {
    if op == "background" {
        block.get("background").and_then(Value::as_bool) == Some(true)
    } else {
        block.get("operator").and_then(Value::as_str) == Some(op)
    }
}

fn compound_stage(stage: &Value) -> bool {
    matches!(
        stage.get("kind").and_then(Value::as_str),
        Some("for-loop") | Some("brace-group") | Some("conditional")
    )
}
fn compound_stages(shape: &Value) -> Option<Vec<&Value>> {
    if !is_bash(shape)
        || diagnostics(shape).iter().any(|diagnostic| {
            UNSUPPORTED_COMPOUND_DIAGNOSTICS
                .contains(&diagnostic.get("code").and_then(Value::as_str).unwrap_or(""))
        })
        || stages(shape).is_empty()
        || !stages(shape).iter().all(compound_stage)
    {
        return None;
    }
    Some(stages(shape).iter().collect())
}
fn compound_form(stage: &Value) -> Option<&str> {
    match stage.get("kind").and_then(Value::as_str) {
        Some("for-loop") => Some("for"),
        Some("brace-group") => Some("brace-group"),
        Some("conditional") => Some("if"),
        _ => None,
    }
}
fn body_blocks(stage: &Value) -> Vec<&Value> {
    match stage.get("kind").and_then(Value::as_str) {
        Some("for-loop") | Some("brace-group") => stage.get("body").into_iter().collect(),
        Some("conditional") => {
            let mut result = Vec::new();
            if let Some(arms) = stage.get("arms").and_then(Value::as_array) {
                result.extend(arms.iter().filter_map(|arm| arm.get("body")));
            }
            if let Some(body) = stage.get("elseBody") {
                result.push(body);
            }
            result
        }
        _ => Vec::new(),
    }
}
fn body_command_stages(shape: &Value) -> Option<Vec<&Value>> {
    let compounds = compound_stages(shape)?;
    let mut result = Vec::new();
    for compound in compounds {
        let bodies = body_blocks(compound);
        if bodies.is_empty() {
            return None;
        }
        for body in bodies {
            let pipeline = body.get("pipeline")?;
            let stages = pipeline.get("stages")?.as_array()?;
            if stages.is_empty()
                || !stages
                    .iter()
                    .all(|stage| stage.get("kind").and_then(Value::as_str) == Some("command"))
            {
                return None;
            }
            result.extend(stages);
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}
fn any_modeled_stage<F: Fn(&Value) -> bool>(shape: &Value, predicate: F) -> bool {
    any_modeled_stage_refs(shape)
        .iter()
        .any(|(stage, _)| predicate(stage))
}
fn any_modeled_stage_refs(shape: &Value) -> Vec<(&Value, usize)> {
    if !is_bash(shape) {
        return Vec::new();
    }
    let top = stages(shape);
    let mut result = Vec::new();
    let mut has_compound = false;
    for (index, stage) in top.iter().enumerate() {
        if stage.get("kind").and_then(Value::as_str) == Some("command") {
            result.push((stage, index));
        } else if compound_stage(stage) {
            has_compound = true;
            let Some(body) = modeled_body(stage) else {
                return top
                    .iter()
                    .enumerate()
                    .filter(|(_, stage)| {
                        stage.get("kind").and_then(Value::as_str) == Some("command")
                    })
                    .map(|(index, stage)| (stage, index))
                    .collect();
            };
            result.extend(body.into_iter().map(|stage| (stage, index)));
        }
    }
    if has_compound {
        result
    } else {
        top.iter()
            .enumerate()
            .filter(|(_, stage)| stage.get("kind").and_then(Value::as_str) == Some("command"))
            .map(|(index, stage)| (stage, index))
            .collect()
    }
}
fn modeled_body(stage: &Value) -> Option<Vec<&Value>> {
    let mut result = Vec::new();
    for body in body_blocks(stage) {
        let stages = body.get("pipeline")?.get("stages")?.as_array()?;
        if stages.is_empty()
            || !stages
                .iter()
                .all(|stage| stage.get("kind").and_then(Value::as_str) == Some("command"))
        {
            return None;
        }
        result.extend(stages);
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}
fn single_stage_shape(parent: &Value, stage: &Value, index: usize) -> Value {
    let mut shape = json!({"kind":"bash", "rawCommand":"", "blocks":[{"pipeline":{"stages":[stage],"pipeTargets":[],"span":stage.get("span").cloned().unwrap_or(json!({"start":0,"end":0}))},"span":stage.get("span").cloned().unwrap_or(json!({"start":0,"end":0}))}],"stages":[stage],"diagnostics":diagnostics(parent)});
    if let Some(path_facts) = parent.get("pathFacts").and_then(Value::as_object) {
        let facts = path_facts
            .get("facts")
            .and_then(Value::as_array)
            .map(|facts| {
                facts
                    .iter()
                    .filter(|fact| {
                        fact.get("stageIndex").and_then(Value::as_u64) == Some(index as u64)
                            || fact.get("usage").and_then(Value::as_str) == Some("cwd-prefix")
                    })
                    .map(|fact| {
                        let mut fact = fact.clone();
                        if fact.get("stageIndex").and_then(Value::as_u64) == Some(index as u64) {
                            fact["stageIndex"] = json!(0);
                        }
                        fact
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut envelope = path_facts.clone();
        envelope.insert("facts".into(), Value::Array(facts.clone()));
        envelope.insert(
            "hasUnknown".into(),
            json!(facts
                .iter()
                .any(|fact| fact.get("scope").and_then(Value::as_str) == Some("unknown"))),
        );
        envelope.insert(
            "hasDenied".into(),
            json!(facts
                .iter()
                .any(|fact| fact.get("scope").and_then(Value::as_str) == Some("denied"))),
        );
        envelope.insert(
            "hasOutsideProject".into(),
            json!(facts
                .iter()
                .any(|fact| fact.get("scope").and_then(Value::as_str) == Some("outside"))),
        );
        envelope.insert(
            "hasSystemPath".into(),
            json!(facts
                .iter()
                .any(|fact| fact.get("scope").and_then(Value::as_str) == Some("system"))),
        );
        shape["pathFacts"] = Value::Object(envelope);
    }
    if let Some(cwd) = parent.get("cwdPrefix") {
        shape["cwdPrefix"] = cwd.clone();
    }
    shape
}

fn body_scope_match(shape: &Value, expr: &Value) -> bool {
    if !is_bash(shape)
        || diagnostics(shape).iter().any(|d| {
            UNSUPPORTED_COMPOUND_DIAGNOSTICS
                .contains(&d.get("code").and_then(Value::as_str).unwrap_or(""))
        })
    {
        return false;
    }
    let Some(body) = body_command_stages(shape) else {
        return false;
    };
    let Some(facts) = shape
        .get("pathFacts")
        .and_then(|p| p.get("facts"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    let scopes = expr
        .get("scopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let owners: HashSet<usize> = (0..stages(shape).len()).collect();
    let selected: Vec<&Value> = facts
        .iter()
        .filter(|fact| {
            fact.get("stageIndex")
                .and_then(Value::as_u64)
                .is_some_and(|index| owners.contains(&(index as usize)))
                && fact.get("usage").and_then(Value::as_str) != Some("cwd-prefix")
        })
        .collect();
    if !selected.iter().all(|fact| {
        scopes
            .iter()
            .any(|scope| scope.as_str() == fact.get("scope").and_then(Value::as_str))
    }) {
        return false;
    }
    body.iter().all(|stage| {
        file_input_args(stage)
            .iter()
            .enumerate()
            .all(|(index, argument)| {
                let _ = index;
                let raw = argument.as_str().unwrap_or("");
                selected.iter().any(|fact| {
                    fact.get("access").and_then(Value::as_str) == Some("read")
                        && fact.get("program").and_then(Value::as_str) == command_program(stage)
                        && fact.get("raw").and_then(Value::as_str) == Some(raw)
                })
            })
    })
}
fn iterator_scope_match(shape: &Value, expr: &Value) -> bool {
    if !is_bash(shape)
        || diagnostics(shape).iter().any(|d| {
            UNSUPPORTED_COMPOUND_DIAGNOSTICS
                .contains(&d.get("code").and_then(Value::as_str).unwrap_or(""))
        })
    {
        return false;
    }
    let Some(compounds) = compound_stages(shape) else {
        return false;
    };
    let scopes = expr
        .get("scopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut loops = 0;
    for (index, stage) in compounds.iter().enumerate() {
        if stage.get("kind").and_then(Value::as_str) != Some("for-loop") {
            continue;
        }
        loops += 1;
        let facts = shape
            .get("pathFacts")
            .and_then(|p| p.get("facts"))
            .and_then(Value::as_array)
            .map(|facts| {
                facts
                    .iter()
                    .filter(|fact| {
                        fact.get("provenance")
                            .and_then(|p| p.get("loopStageIndex"))
                            .and_then(Value::as_u64)
                            == Some(index as u64)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if facts.is_empty()
            || facts.iter().any(|fact| {
                !scopes
                    .iter()
                    .any(|scope| scope.as_str() == fact.get("scope").and_then(Value::as_str))
                    || fact
                        .get("provenance")
                        .and_then(|p| p.get("kind"))
                        .and_then(Value::as_str)
                        != Some("loop-variable")
                    || fact
                        .get("provenance")
                        .and_then(|p| p.get("unknownReason"))
                        .is_some()
                    || !iterator_provenance_safe(fact, &scopes)
            })
        {
            return false;
        }
    }
    loops > 0
}
fn iterator_provenance_safe(fact: &Value, scopes: &[Value]) -> bool {
    let Some(entries) = fact
        .get("provenance")
        .and_then(|provenance| provenance.get("iteratorEntries"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    !entries.is_empty()
        && entries.iter().all(|entry| {
            entry.get("unknownReason").is_none()
                && scopes
                    .iter()
                    .any(|scope| scope.as_str() == entry.get("scope").and_then(Value::as_str))
        })
}
fn no_body_redirect(shape: &Value) -> bool {
    let Some(compounds) = compound_stages(shape) else {
        return false;
    };
    if compounds.iter().any(|stage| {
        stage.get("kind").and_then(Value::as_str) == Some("brace-group")
            && redirects(stage).iter().any(output_redirect)
    }) {
        return false;
    }
    body_command_stages(shape).is_some_and(|stages| {
        !stages.is_empty()
            && stages
                .iter()
                .all(|stage| !redirects(stage).iter().any(output_redirect))
    })
}
fn output_redirect(redirect: &Value) -> bool {
    redirect.get("targetKind").and_then(Value::as_str) == Some("file")
        && matches!(
            redirect.get("stream").and_then(Value::as_str),
            Some("stdout") | Some("stderr") | Some("both") | Some("fd")
        )
}
fn file_input_args(stage: &Value) -> Vec<&Value> {
    serde_json::from_value(stage.clone())
        .ok()
        .map(|stage| crate::stage_file_input_indices(&stage))
        .map(|indices| {
            indices
                .into_iter()
                .filter_map(|index| args(stage).get(index as usize))
                .collect()
        })
        .unwrap_or_default()
}
fn stage_effect(stage: &Value) -> &str {
    serde_json::from_value(stage.clone())
        .ok()
        .map(|stage| crate::classify_stage_effect(&stage).0)
        .unwrap_or("unknown")
}
fn mutation_tool_match(shape: &Value, expr: &Value) -> bool {
    shape.get("kind").and_then(Value::as_str) == Some("pi-tool")
        && shape.get("operation").and_then(Value::as_str) == Some("mutation")
        && shape.get("mutationFacts").is_some()
        && ["edit", "write"].contains(&shape.get("toolName").and_then(Value::as_str).unwrap_or(""))
        && expr
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| {
                tools.is_empty()
                    || tools
                        .iter()
                        .any(|tool| tool.as_str() == shape.get("toolName").and_then(Value::as_str))
            })
}
fn mutation_shape_match(shape: &Value, expr: &Value) -> bool {
    if !mutation_tool_match(shape, &json!({"tools":[]}))
        || diagnostics(shape)
            .iter()
            .any(|d| d.get("severity").and_then(Value::as_str) == Some("error"))
    {
        return false;
    }
    let requested = expr.get("shape").and_then(Value::as_str).unwrap_or("");
    if requested == "well-formed" {
        return true;
    }
    let Some(facts) = shape.get("mutationFacts") else {
        return false;
    };
    facts.get("kind").and_then(Value::as_str) == Some("edit")
        && ((requested == "create"
            && facts.get("createsContent").and_then(Value::as_bool) == Some(true))
            || (requested == "replace"
                && facts.get("createsContent").and_then(Value::as_bool) == Some(false)))
}
fn path_scope_match(shape: &Value, expr: &Value) -> bool {
    let Some(path_facts) = shape.get("pathFacts") else {
        return false;
    };
    let mut facts: Vec<&Value> = path_facts
        .get("facts")
        .and_then(Value::as_array)
        .map(|facts| facts.iter().collect())
        .unwrap_or_default();
    if let Some(usages) = expr.get("usages").and_then(Value::as_array) {
        facts.retain(|fact| {
            usages
                .iter()
                .any(|usage| usage.as_str() == fact.get("usage").and_then(Value::as_str))
        });
    }
    let requirement = expr.get("requireFacts").and_then(Value::as_str);
    if requirement == Some("one-or-more") && facts.is_empty() {
        return false;
    }
    if requirement == Some("per-command-stage") {
        if !is_bash(shape) || stages(shape).is_empty() {
            return false;
        }
        for (index, stage) in stages(shape).iter().enumerate() {
            if stage.get("kind").and_then(Value::as_str) != Some("command")
                || expr
                    .get("programs")
                    .and_then(Value::as_array)
                    .is_some_and(|programs| {
                        !programs
                            .iter()
                            .any(|program| program.as_str() == command_program(stage))
                    })
                || !facts.iter().any(|fact| {
                    fact.get("usage").and_then(Value::as_str) != Some("cwd-prefix")
                        && fact.get("stageIndex").and_then(Value::as_u64) == Some(index as u64)
                })
            {
                return false;
            }
        }
    }
    let scopes = expr
        .get("scopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let exact = expr
        .get("allowExactPaths")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let forbidden = expr
        .get("forbidPathSegments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected = |fact: &Value| {
        scopes
            .iter()
            .any(|scope| scope.as_str() == fact.get("scope").and_then(Value::as_str))
            || fact
                .get("absolutePath")
                .and_then(Value::as_str)
                .is_some_and(|path| {
                    exact
                        .iter()
                        .any(|candidate| candidate.as_str() == Some(path))
                })
    };
    let forbidden_fact = |fact: &Value| {
        fact.get("absolutePath")
            .and_then(Value::as_str)
            .is_some_and(|path| {
                path.split(['/', '\\'])
                    .any(|segment| forbidden.iter().any(|item| item.as_str() == Some(segment)))
            })
    };
    match expr.get("mode").and_then(Value::as_str) {
        Some("all-in") => {
            (!facts.is_empty() || requirement == Some("zero-or-more"))
                && facts
                    .iter()
                    .all(|fact| !forbidden_fact(fact) && selected(fact))
        }
        Some("none-in") => facts
            .iter()
            .all(|fact| !forbidden_fact(fact) && !selected(fact)),
        Some("some-in") => facts
            .iter()
            .any(|fact| !forbidden_fact(fact) && selected(fact)),
        _ => false,
    }
}
fn composition_match(shape: &Value, expr: &Value) -> bool {
    if !is_bash(shape)
        || blocks(shape).is_empty()
        || stages(shape).is_empty()
        || stages(shape).len() < expr.get("minStages").and_then(Value::as_u64).unwrap_or(1) as usize
    {
        return false;
    }
    let allowed: HashSet<&str> = expr
        .get("operators")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let fallback: Option<HashSet<&str>> = expr
        .get("orFallback")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect());
    let fallback_index = blocks(shape).len().saturating_sub(1);
    let operator_index = blocks(shape).len().saturating_sub(2);
    for (index, block) in blocks(shape).iter().enumerate() {
        if block.get("operator").and_then(Value::as_str) == Some("or")
            && (fallback.is_none()
                || index != operator_index
                || !bare_fallback(
                    blocks(shape).get(fallback_index),
                    fallback.as_ref().unwrap(),
                ))
        {
            return false;
        }
        if block.get("background").and_then(Value::as_bool) == Some(true)
            && expr.get("allowBackground").and_then(Value::as_bool) != Some(true)
        {
            return false;
        }
        if let Some(op) = block.get("operator").and_then(Value::as_str) {
            if op != "or" && !allowed.contains(op) {
                return false;
            }
        }
    }
    let is_or = blocks(shape)
        .iter()
        .any(|block| block.get("operator").and_then(Value::as_str) == Some("or"));
    if is_or
        && (fallback.is_none()
            || fallback_index == 0
            || blocks(shape)
                .get(fallback_index)
                .and_then(|b| b.get("operator"))
                .is_some())
    {
        return false;
    }
    let fallback_programs = fallback.unwrap_or_default();
    let mut stage_index = 0;
    for (index, block) in blocks(shape).iter().enumerate() {
        let is_fallback = index == fallback_index
            && operator_index < blocks(shape).len()
            && blocks(shape)
                .get(operator_index)
                .and_then(|b| b.get("operator"))
                .and_then(Value::as_str)
                == Some("or")
            && !fallback_programs.is_empty();
        for stage in block
            .get("pipeline")
            .and_then(|p| p.get("stages"))
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
        {
            let current_stage_index = stage_index;
            stage_index += 1;
            if stage.get("kind").and_then(Value::as_str) != Some("command")
                || (!is_fallback
                    && !eval_expr(
                        expr.get("stage").unwrap_or(&Value::Null),
                        &single_stage_shape(shape, stage, current_stage_index),
                    ))
            {
                return false;
            }
        }
        if is_fallback
            && block
                .get("pipeline")
                .and_then(|p| p.get("stages"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len)
                != 1
        {
            return false;
        }
    }
    true
}
fn bare_fallback(block: Option<&Value>, programs: &HashSet<&str>) -> bool {
    let Some(block) = block else { return false };
    if block.get("background").and_then(Value::as_bool) == Some(true)
        || block
            .get("pipeline")
            .and_then(|p| p.get("stages"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
            != 1
        || block
            .get("pipeline")
            .and_then(|p| p.get("pipeTargets"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
            != 0
    {
        return false;
    }
    let stage = block
        .get("pipeline")
        .and_then(|p| p.get("stages"))
        .and_then(Value::as_array)
        .and_then(|v| v.first());
    stage.is_some_and(|stage| {
        stage.get("kind").and_then(Value::as_str) == Some("command")
            && stage
                .get("program")
                .and_then(|p| p.get("resolvable"))
                .and_then(Value::as_bool)
                == Some(true)
            && programs.contains(
                stage
                    .get("program")
                    .and_then(|p| p.get("program"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )
            && args(stage).is_empty()
            && flags(stage).is_empty()
            && environment(stage).is_empty()
            && substitutions(stage).is_empty()
            && redirects(stage).is_empty()
    })
}
