//! Native policy composition and conservative sealed-floor overlap analysis.
//!
//! The overlap reducer is deliberately conservative: `unknown` is a load-time
//! error for allow rules.  It mirrors the old TypeScript proof rather than
//! attempting to decide arbitrary regular-language intersections.  In
//! particular, existential floor witnesses (`stageSome`) and canonical
//! compound bundles are handled explicitly because those are the safety
//! boundaries where a naive top-level conjunction reduction is unsound.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const APPROVED_COMPOUND_SCOPES: &[&str] = &["project", "writable-project", "temp"];
const REQUIRED_COMPOUND_KINDS: &[&str] = &[
    "compoundForm",
    "bodyStagesAllReadOnly",
    "noBodySubstitution",
    "noBodyShellWrap",
    "noBodyRedirectTo",
    "iteratorScopesAllIn",
    "bodyStagesAllScopeIn",
];

#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Overlap {
    Overlap,
    Disjoint,
    Unknown,
}

impl Overlap {
    fn as_str(self) -> &'static str {
        match self {
            Self::Overlap => "overlap",
            Self::Disjoint => "disjoint",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quantifier {
    Universal,
    Existential,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
enum Field {
    Tool(HashSet<String>),
    CompoundForm(String),
    CompoundBodyEffect(String),
    Program(HashSet<String>),
    Arg0(HashSet<String>),
    ArgAt {
        index: usize,
        values: HashSet<String>,
    },
    ArgCount {
        min: Option<u64>,
        max: Option<u64>,
    },
    EnvAssignmentCount {
        min: Option<u64>,
        max: Option<u64>,
    },
    Flag(String),
    Present(String),
    Redirect {
        stream: Option<String>,
        target: Option<String>,
        target_kind: Option<String>,
    },
    Pipeline(String),
    Operator(String),
    CompositionStage(Value),
    PathScope {
        mode: String,
        scopes: HashSet<String>,
        require_facts: Option<String>,
        programs: Option<HashSet<String>>,
    },
    MutationShape(String),
    MutationTrustBoundary(HashSet<String>),
}

#[derive(Debug, Clone)]
struct Constraint {
    quantifier: Quantifier,
    field: Field,
}

#[derive(Debug, Clone)]
enum ConjunctiveSet {
    Universal,
    Empty,
    Unknown,
    Concrete(Vec<Constraint>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverlapRole {
    Allow,
    Floor,
}

#[derive(Debug, Clone)]
struct ActiveRule<'a> {
    pack: &'a Value,
    rule: &'a Value,
    path: String,
}

/// Compose a request of the form `{ floor: pack, active: [pack, ...] }`.
///
/// Packs have already crossed the native compiler in normal runtime use, so
/// their rule matchers are `MatcherExpr` values.  The function still validates
/// the surrounding pack/rule shape enough to keep a malformed direct caller
/// fail-closed and to preserve the loader's stable error paths.
pub fn compose_policy(request: &Value) -> Value {
    let Some(request) = request.as_object() else {
        return json!({"policy": null, "warnings": [], "errors": [composition_error(None, None, "$", "expected composition request object")]});
    };

    let Some(floor) = request.get("floor") else {
        return json!({"policy": null, "warnings": [], "errors": [composition_error(None, None, "floor", "expected sealed floor pack")]});
    };
    let Some(floor_rules) = floor.get("rules").and_then(Value::as_array) else {
        return json!({"policy": null, "warnings": [], "errors": [composition_error(pack_id(floor), None, "floor.rules", "expected rules array")]});
    };

    let mut errors = Vec::new();
    for (index, rule) in floor_rules.iter().enumerate() {
        if rule.get("effect").and_then(Value::as_str) != Some("deny") {
            errors.push(composition_error(
                pack_id(floor),
                rule_id(rule),
                &format!("floor.rules[{index}]"),
                "sealed floor must be deny-only",
            ));
        }
    }
    if !errors.is_empty() {
        return json!({"policy": null, "warnings": [], "errors": errors});
    }

    let active_packs = match request.get("active").and_then(Value::as_array) {
        Some(packs) => packs,
        None => {
            return json!({"policy": null, "warnings": [], "errors": [composition_error(None, None, "active", "expected active pack array")]});
        }
    };

    let mut active_entries = Vec::new();
    for (pack_index, pack) in active_packs.iter().enumerate() {
        let Some(rules) = pack.get("rules").and_then(Value::as_array) else {
            errors.push(composition_error(
                pack_id(pack),
                None,
                &format!("active[{pack_index}].rules"),
                "expected rules array",
            ));
            continue;
        };
        for (rule_index, rule) in rules.iter().enumerate() {
            active_entries.push(ActiveRule {
                pack,
                rule,
                path: format!("active[{pack_index}].rules[{rule_index}]"),
            });
        }
    }

    for entry in &active_entries {
        if entry.rule.get("effect").and_then(Value::as_str) != Some("allow") {
            continue;
        }
        let Some(expr) = entry.rule.get("match") else {
            errors.push(unknown_matcher_error(entry));
            continue;
        };
        let canonical = canonicality(expr);
        if canonical.0 && !canonical.1 {
            errors.push(composition_error(
                pack_id(entry.pack),
                rule_id(entry.rule),
                &entry.path,
                &format!(
                    "compound allow rule must use approved canonical bundle: {}",
                    canonical
                        .2
                        .unwrap_or_else(|| "invalid canonical bundle".to_owned())
                ),
            ));
            continue;
        }

        for floor_rule in floor_rules {
            if floor_rule.get("effect").and_then(Value::as_str) != Some("deny") {
                continue;
            }
            let overlap = classify_rule_overlap(expr, floor_rule.get("match"));
            if overlap == Overlap::Disjoint {
                continue;
            }
            let message = match overlap {
                Overlap::Overlap => format!(
                    "allow rule overlaps sealed-floor deny `{}`",
                    rule_id(floor_rule).unwrap_or_default()
                ),
                Overlap::Unknown => format!(
                    "allow rule has undecidable overlap with sealed-floor deny `{}`; refine the matcher to be provably disjoint",
                    rule_id(floor_rule).unwrap_or_default()
                ),
                Overlap::Disjoint => unreachable!(),
            };
            errors.push(composition_error(
                pack_id(entry.pack),
                rule_id(entry.rule),
                &entry.path,
                &message,
            ));
        }
    }

    if !errors.is_empty() {
        return json!({"policy": null, "warnings": [], "errors": errors});
    }

    let floor_rules = floor_rules.to_vec();
    let active_rules = active_entries
        .into_iter()
        .map(|entry| entry.rule.clone())
        .collect::<Vec<_>>();
    json!({
        "policy": {"floor": floor_rules, "active": active_rules},
        "warnings": [],
        "errors": []
    })
}

/// Validate one active pack against a supplied sealed floor without allocating
/// a policy handle. The request is `{ floor: pack, pack: pack }`; keeping the
/// floor explicit preserves the filesystem-free native boundary.
pub fn validate_pack_against_floor(request: &Value) -> Value {
    let Some(object) = request.as_object() else {
        return json!({"warnings": [], "errors": [composition_error(None, None, "$", "expected validation request object")]});
    };
    let Some(floor) = object.get("floor") else {
        return json!({"warnings": [], "errors": [composition_error(None, None, "floor", "expected sealed floor pack")]});
    };
    let Some(pack) = object.get("pack") else {
        return json!({"warnings": [], "errors": [composition_error(None, None, "pack", "expected policy pack")]});
    };
    let request = json!({"floor": floor, "active": [pack]});
    let result = compose_policy(&request);
    json!({
        "warnings": result.get("warnings").cloned().unwrap_or_else(|| json!([])),
        "errors": result.get("errors").cloned().unwrap_or_else(|| json!([])),
    })
}

/// Return the conservative overlap verdict for two compiled matcher IRs.
pub fn classify_overlap_json(left: &Value, right: &Value) -> &'static str {
    std::panic::catch_unwind(|| classify_overlap(left, right).as_str()).unwrap_or("unknown")
}

/// Return `{ applies, ok, reason? }` for the canonical compound allow proof.
pub fn validate_compound_allow_canonicality(expr: &Value) -> Value {
    let (applies, ok, reason) = canonicality(expr);
    let mut result = Map::new();
    result.insert("applies".into(), json!(applies));
    if applies {
        result.insert("ok".into(), json!(ok));
        if let Some(reason) = reason {
            result.insert("reason".into(), json!(reason));
        }
    }
    Value::Object(result)
}

fn classify_rule_overlap(allow: &Value, floor: Option<&Value>) -> Overlap {
    let Some(floor) = floor else {
        return Overlap::Unknown;
    };
    classify_overlap(allow, floor)
}

fn classify_overlap(left: &Value, right: &Value) -> Overlap {
    if kind(left) == Some("any") {
        return combine_or(
            array(left, "of")
                .map(|values| {
                    values
                        .iter()
                        .map(|child| classify_overlap(child, right))
                        .collect()
                })
                .unwrap_or_default(),
        );
    }
    if kind(right) == Some("any") {
        return combine_or(
            array(right, "of")
                .map(|values| {
                    values
                        .iter()
                        .map(|child| classify_overlap(left, child))
                        .collect()
                })
                .unwrap_or_default(),
        );
    }

    let left_reduced = reduce_conjunctive(left, OverlapRole::Allow);
    let right_reduced = reduce_conjunctive(right, OverlapRole::Floor);
    match (&left_reduced, &right_reduced) {
        (ConjunctiveSet::Empty, _) | (_, ConjunctiveSet::Empty) => Overlap::Disjoint,
        (ConjunctiveSet::Unknown, _) | (_, ConjunctiveSet::Unknown) => Overlap::Unknown,
        (ConjunctiveSet::Universal, _) | (_, ConjunctiveSet::Universal) => Overlap::Overlap,
        (ConjunctiveSet::Concrete(a), ConjunctiveSet::Concrete(b)) => {
            if compatible(a, b) {
                Overlap::Overlap
            } else {
                Overlap::Disjoint
            }
        }
    }
}

fn reduce_conjunctive(expr: &Value, role: OverlapRole) -> ConjunctiveSet {
    if kind(expr) == Some("not")
        && array_of_kinds(
            expr.get("of"),
            &[
                "flagMatches",
                "envAssignmentNameIn",
                "arg0In",
                "argAt",
                "stageSome",
                "flagValueIn",
                "flagCount",
                "anyArgMatches",
                "flagAllowlist",
            ],
        )
    {
        return ConjunctiveSet::Universal;
    }

    if let Some(constraints) = canonical_constraints(expr) {
        return ConjunctiveSet::Concrete(constraints);
    }

    match kind(expr) {
        Some("always") => ConjunctiveSet::Universal,
        Some(
            "tool" | "mutationTool" | "program" | "arg0In" | "argAt" | "flagPresent"
            | "noSubstitution" | "noStdoutRedirect" | "redirect" | "pipeline" | "operator"
            | "argCount" | "envAssignmentCount",
        ) => atom_constraint(expr, Quantifier::Universal)
            .map(|constraint| ConjunctiveSet::Concrete(vec![constraint]))
            .unwrap_or(ConjunctiveSet::Unknown),
        Some("pathScope") => path_scope_constraint(expr)
            .map(|constraint| ConjunctiveSet::Concrete(vec![constraint]))
            .unwrap_or(ConjunctiveSet::Unknown),
        Some("argMatches" | "anyArgMatches" | "flagAllowlist" | "flagValueIn" | "flagCount") => {
            ConjunctiveSet::Universal
        }
        Some("mutationShape" | "mutationTrustBoundary" | "flagMatches" | "envAssignmentNameIn") => {
            ConjunctiveSet::Unknown
        }
        Some("all") => reduce_all(array(expr, "of").unwrap_or(&[]), role),
        Some("stageEvery") => reduce_conjunctive(expr.get("inner").unwrap_or(&Value::Null), role),
        Some("any") => reduce_conjunctive_any(array(expr, "of").unwrap_or(&[])),
        Some("composition") => {
            let stage = expr.get("stage").unwrap_or(&Value::Null);
            let Some(family_programs) = necessary_program_set(stage) else {
                return ConjunctiveSet::Unknown;
            };
            if family_programs.is_empty() {
                return ConjunctiveSet::Empty;
            }
            let mut programs = family_programs;
            for fallback in array(expr, "orFallback").unwrap_or(&[]) {
                if let Some(fallback) = fallback.as_str() {
                    programs.insert(fallback.to_owned());
                }
            }
            ConjunctiveSet::Concrete(vec![
                Constraint {
                    quantifier: Quantifier::Universal,
                    field: Field::Program(programs),
                },
                Constraint {
                    quantifier: Quantifier::Universal,
                    field: Field::CompositionStage(stage.clone()),
                },
            ])
        }
        Some("stageSome") => {
            if role == OverlapRole::Allow {
                return ConjunctiveSet::Unknown;
            }
            let necessary =
                reduce_necessary_stage_constraints(expr.get("inner").unwrap_or(&Value::Null));
            match necessary {
                ConjunctiveSet::Concrete(constraints) if constraints.is_empty() => {
                    ConjunctiveSet::Unknown
                }
                other => other,
            }
        }
        Some(
            "not"
            | "compoundForm"
            | "bodyStagesAllReadOnly"
            | "bodyStagesAllScopeIn"
            | "iteratorScopesAllIn"
            | "noBodySubstitution"
            | "noBodyShellWrap"
            | "noBodyRedirectTo"
            | "diagnosticCode",
        ) => ConjunctiveSet::Unknown,
        _ => ConjunctiveSet::Unknown,
    }
}

fn reduce_all(children: &[Value], role: OverlapRole) -> ConjunctiveSet {
    if children.is_empty() {
        return ConjunctiveSet::Empty;
    }
    let mut constraints = Vec::new();
    let mut mutation_refiners = Vec::new();
    for child in children {
        if let Some(refiner) = mutation_refiner_constraint(child) {
            mutation_refiners.push(refiner);
            continue;
        }
        match reduce_conjunctive(child, role) {
            ConjunctiveSet::Unknown => return ConjunctiveSet::Unknown,
            ConjunctiveSet::Empty => return ConjunctiveSet::Empty,
            ConjunctiveSet::Universal => {}
            ConjunctiveSet::Concrete(values) => constraints.extend(values),
        }
    }
    if !mutation_refiners.is_empty() && !has_concrete_mutation_tool_constraint(&constraints) {
        return ConjunctiveSet::Unknown;
    }
    constraints.extend(mutation_refiners);
    if constraints.is_empty() {
        ConjunctiveSet::Universal
    } else {
        ConjunctiveSet::Concrete(constraints)
    }
}

fn reduce_conjunctive_any(children: &[Value]) -> ConjunctiveSet {
    if children.is_empty() {
        return ConjunctiveSet::Empty;
    }
    let constraints = children
        .iter()
        .map(reduce_single_atom)
        .collect::<Option<Vec<_>>>();
    let Some(constraints) = constraints else {
        return ConjunctiveSet::Unknown;
    };
    let Some(field_name) = simple_field_name(constraints.first().map(|v| &v.field)) else {
        return ConjunctiveSet::Unknown;
    };
    if !constraints
        .iter()
        .all(|constraint| simple_field_name(Some(&constraint.field)) == Some(field_name))
    {
        return ConjunctiveSet::Unknown;
    }
    match field_name {
        "tool" | "program" | "arg0" => {
            let mut values = HashSet::new();
            for constraint in constraints {
                match constraint.field {
                    Field::Tool(mut v) | Field::Program(mut v) | Field::Arg0(mut v) => {
                        values.extend(v.drain());
                    }
                    _ => return ConjunctiveSet::Unknown,
                }
            }
            let field = match field_name {
                "tool" => Field::Tool(values),
                "program" => Field::Program(values),
                _ => Field::Arg0(values),
            };
            ConjunctiveSet::Concrete(vec![Constraint {
                field,
                quantifier: Quantifier::Universal,
            }])
        }
        "flag" | "argAt" => ConjunctiveSet::Universal,
        _ => ConjunctiveSet::Unknown,
    }
}

fn reduce_single_atom(expr: &Value) -> Option<Constraint> {
    match kind(expr) {
        Some("tool" | "mutationTool" | "program" | "arg0In" | "argAt" | "flagPresent") => {
            atom_constraint(expr, Quantifier::Universal)
        }
        _ => None,
    }
}

fn atom_constraint(expr: &Value, quantifier: Quantifier) -> Option<Constraint> {
    let field = match kind(expr)? {
        "tool" => Field::Tool([single_string(expr, "tool")?].into_iter().collect()),
        "mutationTool" => {
            let values = strings(expr, "tools");
            Field::Tool(if values.is_empty() {
                ["edit".to_owned(), "write".to_owned()]
                    .into_iter()
                    .collect()
            } else {
                values
            })
        }
        "program" => Field::Program([single_string(expr, "name")?].into_iter().collect()),
        "arg0In" => Field::Arg0(strings(expr, "values")),
        "argAt" => Field::ArgAt {
            index: expr.get("index").and_then(Value::as_u64).unwrap_or(0) as usize,
            values: [single_string(expr, "value")?].into_iter().collect(),
        },
        "argCount" => Field::ArgCount {
            min: expr.get("min").and_then(Value::as_u64),
            max: expr.get("max").and_then(Value::as_u64),
        },
        "envAssignmentCount" => Field::EnvAssignmentCount {
            min: expr.get("min").and_then(Value::as_u64),
            max: expr.get("max").and_then(Value::as_u64),
        },
        "flagPresent" => Field::Flag(single_string(expr, "name")?),
        "noSubstitution" => Field::Present("noSubstitution".to_owned()),
        "noStdoutRedirect" => Field::Present("noStdoutRedirect".to_owned()),
        "redirect" => Field::Redirect {
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
        "pipeline" => Field::Pipeline(single_string(expr, "target")?),
        "operator" => Field::Operator(single_string(expr, "op")?),
        _ => return None,
    };
    Some(Constraint { quantifier, field })
}

fn path_scope_constraint(expr: &Value) -> Option<Constraint> {
    Some(Constraint {
        quantifier: Quantifier::Universal,
        field: Field::PathScope {
            mode: single_string(expr, "mode")?,
            scopes: strings(expr, "scopes"),
            require_facts: expr
                .get("requireFacts")
                .and_then(Value::as_str)
                .map(str::to_owned),
            programs: expr.get("programs").map(|_| strings(expr, "programs")),
        },
    })
}

fn mutation_refiner_constraint(expr: &Value) -> Option<Constraint> {
    let field = match kind(expr)? {
        "mutationShape" => Field::MutationShape(single_string(expr, "shape")?),
        "mutationTrustBoundary" => Field::MutationTrustBoundary(strings(expr, "in")),
        _ => return None,
    };
    Some(Constraint {
        quantifier: Quantifier::Universal,
        field,
    })
}

fn has_concrete_mutation_tool_constraint(constraints: &[Constraint]) -> bool {
    constraints.iter().any(|constraint| {
        matches!(&constraint.field, Field::Tool(values) if !values.is_empty() && values.iter().all(|value| value == "edit" || value == "write"))
    })
}

fn canonical_constraints(expr: &Value) -> Option<Vec<Constraint>> {
    let children = array(expr, "of")?;
    let (_, ok, _) = canonicality(expr);
    if !ok {
        return None;
    }
    Some(vec![
        Constraint {
            quantifier: Quantifier::Universal,
            field: Field::CompoundForm("for".to_owned()),
        },
        Constraint {
            quantifier: Quantifier::Universal,
            field: Field::CompoundBodyEffect("read-only".to_owned()),
        },
    ])
    .filter(|_| !children.is_empty())
}

fn canonicality(expr: &Value) -> (bool, bool, Option<String>) {
    if !contains_compound_allow_matcher(expr) {
        return (false, false, None);
    }
    let Some(children) = array(expr, "of") else {
        return (
            true,
            false,
            Some(
                "compound allow must be an all(...) conjunction of the approved canonical bundle"
                    .to_owned(),
            ),
        );
    };
    let mut seen = HashSet::new();
    for child in children {
        let Some(child_kind) = kind(child) else {
            return (
                true,
                false,
                Some("unsupported matcher in compound allow canonical bundle: unknown".to_owned()),
            );
        };
        if !REQUIRED_COMPOUND_KINDS.contains(&child_kind) {
            return (
                true,
                false,
                Some(format!(
                    "unsupported matcher in compound allow canonical bundle: {child_kind}"
                )),
            );
        }
        if !seen.insert(child_kind.to_owned()) {
            return (
                true,
                false,
                Some(format!(
                    "duplicate matcher in compound allow canonical bundle: {child_kind}"
                )),
            );
        }
        if let Some(reason) = invalid_canonical_child(child) {
            return (true, false, Some(reason));
        }
    }
    let missing = REQUIRED_COMPOUND_KINDS
        .iter()
        .filter(|required| !seen.contains(**required))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return (
            true,
            false,
            Some(format!(
                "compound allow canonical bundle is missing required matcher(s): {}",
                missing.join(", ")
            )),
        );
    }
    (true, true, None)
}

fn contains_compound_allow_matcher(expr: &Value) -> bool {
    if matches!(
        kind(expr),
        Some(
            "compoundForm"
                | "bodyStagesAllReadOnly"
                | "bodyStagesAllScopeIn"
                | "iteratorScopesAllIn"
                | "noBodySubstitution"
                | "noBodyShellWrap"
                | "noBodyRedirectTo"
                | "diagnosticCode"
        )
    ) {
        return true;
    }
    match kind(expr) {
        Some("all" | "any") => array(expr, "of")
            .is_some_and(|children| children.iter().any(contains_compound_allow_matcher)),
        Some("not") => expr.get("of").is_some_and(contains_compound_allow_matcher),
        Some("stageEvery" | "stageSome") => expr
            .get("inner")
            .is_some_and(contains_compound_allow_matcher),
        Some("composition") => expr
            .get("stage")
            .is_some_and(contains_compound_allow_matcher),
        _ => false,
    }
}

fn invalid_canonical_child(expr: &Value) -> Option<String> {
    match kind(expr)? {
        "compoundForm" => {
            let form = expr.get("form").and_then(Value::as_str).unwrap_or("");
            (form != "for").then(|| {
                format!("compound allow canonical bundle requires compoundForm(for), got {form}")
            })
        }
        "iteratorScopesAllIn" | "bodyStagesAllScopeIn" => {
            let scopes = strings(expr, "scopes");
            let valid = !scopes.is_empty()
                && scopes
                    .iter()
                    .all(|scope| APPROVED_COMPOUND_SCOPES.contains(&scope.as_str()));
            (!valid).then(|| {
                format!(
                    "{} may only use project, writable-project, and temp scopes",
                    kind(expr).unwrap_or("compound scope")
                )
            })
        }
        _ => None,
    }
}

fn necessary_program_set(expr: &Value) -> Option<HashSet<String>> {
    match kind(expr) {
        Some("program") => single_string(expr, "name").map(|value| [value].into_iter().collect()),
        Some("all") => {
            let children = array(expr, "of")?;
            if children.is_empty() {
                return None;
            }
            let mut result: Option<HashSet<String>> = None;
            for child in children {
                let Some(values) = necessary_program_set(child) else {
                    continue;
                };
                if let Some(existing) = result.as_mut() {
                    existing.retain(|value| values.contains(value));
                } else {
                    result = Some(values);
                }
            }
            result
        }
        Some("any") => {
            let children = array(expr, "of")?;
            if children.is_empty() {
                return Some(HashSet::new());
            }
            let mut values = HashSet::new();
            for child in children {
                let branch = necessary_program_set(child)?;
                values.extend(branch);
            }
            Some(values)
        }
        Some("stageEvery") => necessary_program_set(expr.get("inner").unwrap_or(&Value::Null)),
        _ => None,
    }
}

fn reduce_necessary_stage_constraints(expr: &Value) -> ConjunctiveSet {
    let reduced = match kind(expr) {
        Some("tool" | "program" | "arg0In" | "argAt" | "flagPresent") => {
            atom_constraint(expr, Quantifier::Existential)
                .map(|constraint| ConjunctiveSet::Concrete(vec![constraint]))
                .unwrap_or(ConjunctiveSet::Unknown)
        }
        Some("all") => merge_necessary_all(array(expr, "of").unwrap_or(&[])),
        Some("any") => merge_necessary_any(array(expr, "of").unwrap_or(&[])),
        _ => ConjunctiveSet::Concrete(Vec::new()),
    };
    let ConjunctiveSet::Concrete(mut constraints) = reduced else {
        return reduced;
    };
    let Some(programs) = necessary_program_set(expr) else {
        return ConjunctiveSet::Concrete(constraints);
    };
    if programs.is_empty() {
        return ConjunctiveSet::Empty;
    }
    constraints.retain(|constraint| !matches!(constraint.field, Field::Program(_)));
    constraints.insert(
        0,
        Constraint {
            quantifier: Quantifier::Existential,
            field: Field::Program(programs),
        },
    );
    ConjunctiveSet::Concrete(constraints)
}

fn merge_necessary_all(children: &[Value]) -> ConjunctiveSet {
    if children.is_empty() {
        return ConjunctiveSet::Empty;
    }
    let mut merged: HashMap<String, Constraint> = HashMap::new();
    for child in children {
        let reduced = reduce_necessary_stage_constraints(child);
        if matches!(reduced, ConjunctiveSet::Empty) {
            return ConjunctiveSet::Empty;
        }
        let ConjunctiveSet::Concrete(values) = reduced else {
            return ConjunctiveSet::Unknown;
        };
        for constraint in values {
            let key = necessary_constraint_key(&constraint);
            if let Some(previous) = merged.get(&key).cloned() {
                let Some(intersected) = intersect_necessary_constraints(&previous, &constraint)
                else {
                    return ConjunctiveSet::Empty;
                };
                merged.insert(key, intersected);
            } else {
                merged.insert(key, constraint);
            }
        }
    }
    ConjunctiveSet::Concrete(merged.into_values().collect())
}

fn merge_necessary_any(children: &[Value]) -> ConjunctiveSet {
    if children.is_empty() {
        return ConjunctiveSet::Empty;
    }
    let branches = children
        .iter()
        .filter_map(|child| match reduce_necessary_stage_constraints(child) {
            ConjunctiveSet::Concrete(values) => Some(values),
            _ => None,
        })
        .collect::<Vec<_>>();
    if branches.is_empty() {
        return ConjunctiveSet::Empty;
    }
    let mut common_keys: HashSet<String> =
        branches[0].iter().map(necessary_constraint_key).collect();
    for branch in branches.iter().skip(1) {
        let keys: HashSet<String> = branch.iter().map(necessary_constraint_key).collect();
        common_keys.retain(|key| keys.contains(key));
    }
    let mut constraints = Vec::new();
    for key in common_keys {
        let entries = branches
            .iter()
            .map(|branch| {
                branch
                    .iter()
                    .find(|constraint| necessary_constraint_key(constraint) == key)
            })
            .collect::<Option<Vec<_>>>();
        let Some(entries) = entries else { continue };
        let Some(first) = entries.first() else {
            continue;
        };
        let field = match &first.field {
            Field::Program(_) => union_field_values(&entries, |field| match field {
                Field::Program(values) => Some(values),
                _ => None,
            })
            .map(Field::Program),
            Field::Arg0(_) => union_field_values(&entries, |field| match field {
                Field::Arg0(values) => Some(values),
                _ => None,
            })
            .map(Field::Arg0),
            Field::Tool(_) => union_field_values(&entries, |field| match field {
                Field::Tool(values) => Some(values),
                _ => None,
            })
            .map(Field::Tool),
            Field::ArgAt { index, .. } => union_field_values(&entries, |field| match field {
                Field::ArgAt { values, .. } => Some(values),
                _ => None,
            })
            .map(|values| Field::ArgAt {
                index: *index,
                values,
            }),
            _ => Some(first.field.clone()),
        };
        if let Some(field) = field {
            constraints.push(Constraint {
                quantifier: first.quantifier,
                field,
            });
        }
    }
    ConjunctiveSet::Concrete(constraints)
}

fn union_field_values<'a, F>(entries: &[&'a Constraint], get: F) -> Option<HashSet<String>>
where
    F: Fn(&'a Field) -> Option<&'a HashSet<String>>,
{
    let mut values = HashSet::new();
    for entry in entries {
        values.extend(get(&entry.field)?.iter().cloned());
    }
    Some(values)
}

fn necessary_constraint_key(constraint: &Constraint) -> String {
    match &constraint.field {
        Field::ArgAt { index, .. } => format!("argAt:{index}"),
        Field::Flag(name) => format!("flag:{name}"),
        Field::Program(_) => "program".to_owned(),
        Field::Arg0(_) => "arg0".to_owned(),
        Field::Tool(_) => "tool".to_owned(),
        _ => field_name(&constraint.field).to_owned(),
    }
}

fn intersect_necessary_constraints(left: &Constraint, right: &Constraint) -> Option<Constraint> {
    if field_name(&left.field) != field_name(&right.field) {
        return Some(left.clone());
    }
    let field = match (&left.field, &right.field) {
        (Field::Program(a), Field::Program(b)) => intersect_sets(a, b).map(Field::Program),
        (Field::Arg0(a), Field::Arg0(b)) => intersect_sets(a, b).map(Field::Arg0),
        (Field::Tool(a), Field::Tool(b)) => intersect_sets(a, b).map(Field::Tool),
        (
            Field::ArgAt {
                index: ai,
                values: a,
            },
            Field::ArgAt {
                index: bi,
                values: b,
            },
        ) if ai == bi => intersect_sets(a, b).map(|values| Field::ArgAt { index: *ai, values }),
        _ => Some(left.field.clone()),
    }?;
    Some(Constraint {
        field,
        quantifier: Quantifier::Existential,
    })
}

fn compatible(left: &[Constraint], right: &[Constraint]) -> bool {
    if composition_stage_disjoint_from_floor(left, right)
        || composition_stage_disjoint_from_floor(right, left)
    {
        return false;
    }
    left.iter()
        .all(|a| right.iter().all(|b| constraints_compatible(a, b)))
}

fn composition_stage_disjoint_from_floor(composition: &[Constraint], floor: &[Constraint]) -> bool {
    let stage = composition
        .iter()
        .find_map(|constraint| match &constraint.field {
            Field::CompositionStage(stage) => Some(stage),
            _ => None,
        });
    let programs = floor.iter().find_map(|constraint| match &constraint.field {
        Field::Program(values) => Some(values),
        _ => None,
    });
    let arg0 = floor.iter().find_map(|constraint| match &constraint.field {
        Field::Arg0(values) => Some(values),
        _ => None,
    });
    match (stage, programs, arg0) {
        (Some(stage), Some(programs), Some(arg0)) => stage_matcher_disjoint(stage, programs, arg0),
        _ => false,
    }
}

fn stage_matcher_disjoint(
    expr: &Value,
    programs: &HashSet<String>,
    arg0: &HashSet<String>,
) -> bool {
    if kind(expr) == Some("any") {
        return array(expr, "of").is_some_and(|children| {
            !children.is_empty()
                && children
                    .iter()
                    .all(|child| stage_matcher_disjoint(child, programs, arg0))
        });
    }
    if kind(expr) != Some("all") {
        return false;
    }
    for child in array(expr, "of").unwrap_or(&[]) {
        if kind(child) == Some("program")
            && single_string(child, "name").is_some_and(|name| !programs.contains(&name))
        {
            return true;
        }
        if kind(child) == Some("arg0In")
            && !strings(child, "values")
                .iter()
                .any(|value| arg0.contains(value))
        {
            return true;
        }
        if kind(child) == Some("argCount")
            && child
                .get("max")
                .and_then(Value::as_u64)
                .is_some_and(|max| max < 1)
        {
            return true;
        }
    }
    false
}

fn constraints_compatible(left: &Constraint, right: &Constraint) -> bool {
    if matches!(
        (&left.field, &right.field),
        (Field::PathScope { .. }, _)
            | (_, Field::PathScope { .. })
            | (Field::MutationShape(_), _)
            | (_, Field::MutationShape(_))
            | (Field::MutationTrustBoundary(_), _)
            | (_, Field::MutationTrustBoundary(_))
            | (Field::CompositionStage(_), _)
            | (_, Field::CompositionStage(_))
    ) {
        return true;
    }
    if let (Field::Tool(a), Field::Tool(b)) = (&left.field, &right.field) {
        return !has_universal_witness(left, right) || sets_intersect(a, b);
    }
    if let (Field::Tool(values), other) = (&left.field, &right.field) {
        if is_bash_only(other) {
            return !has_universal_witness(left, right) || values.contains("bash");
        }
    }
    if let (other, Field::Tool(values)) = (&left.field, &right.field) {
        if is_bash_only(other) {
            return !has_universal_witness(left, right) || values.contains("bash");
        }
    }
    if is_read_only_compound_body_vs_program(&left.field, &right.field)
        || is_read_only_compound_body_vs_program(&right.field, &left.field)
    {
        return false;
    }
    match (&left.field, &right.field) {
        (Field::Program(a), Field::Program(b)) | (Field::Arg0(a), Field::Arg0(b)) => {
            !has_universal_witness(left, right) || sets_intersect(a, b)
        }
        (
            Field::Arg0(a),
            Field::ArgAt {
                index: 0,
                values: b,
            },
        )
        | (
            Field::ArgAt {
                index: 0,
                values: a,
            },
            Field::Arg0(b),
        ) => !has_universal_witness(left, right) || sets_intersect(a, b),
        (Field::ArgCount { .. }, Field::Arg0(values)) => {
            arg_count_allows_arg0(left) && !values.is_empty()
        }
        (Field::Arg0(values), Field::ArgCount { .. }) => {
            arg_count_allows_arg0(right) && !values.is_empty()
        }
        (
            Field::ArgCount {
                min: a_min,
                max: a_max,
            },
            Field::ArgCount {
                min: b_min,
                max: b_max,
            },
        ) => ranges_overlap(*a_min, *a_max, *b_min, *b_max),
        (
            Field::ArgAt {
                index: ai,
                values: a,
            },
            Field::ArgAt {
                index: bi,
                values: b,
            },
        ) => ai != bi || !has_universal_witness(left, right) || sets_intersect(a, b),
        _ => true,
    }
}

fn has_universal_witness(left: &Constraint, right: &Constraint) -> bool {
    left.quantifier == Quantifier::Universal || right.quantifier == Quantifier::Universal
}

fn arg_count_allows_arg0(constraint: &Constraint) -> bool {
    match constraint.field {
        Field::ArgCount { max, .. } => max.is_none_or(|max| max >= 1),
        _ => true,
    }
}

fn ranges_overlap(
    left_min: Option<u64>,
    left_max: Option<u64>,
    right_min: Option<u64>,
    right_max: Option<u64>,
) -> bool {
    let min = left_min.unwrap_or(0).max(right_min.unwrap_or(0));
    let max = left_max
        .unwrap_or(u64::MAX)
        .min(right_max.unwrap_or(u64::MAX));
    min <= max
}

fn is_bash_only(field: &Field) -> bool {
    matches!(
        field,
        Field::CompoundForm(_)
            | Field::Program(_)
            | Field::Arg0(_)
            | Field::ArgAt { .. }
            | Field::Flag(_)
            | Field::Redirect { .. }
            | Field::Pipeline(_)
            | Field::Operator(_)
            | Field::CompositionStage(_)
    )
}

fn is_read_only_compound_body_vs_program(left: &Field, right: &Field) -> bool {
    matches!(left, Field::CompoundBodyEffect(effect) if effect == "read-only")
        && matches!(right, Field::Program(values) if values.iter().all(|program| !program_can_be_read_only(program)))
}

fn program_can_be_read_only(program: &str) -> bool {
    crate::effect_registry().as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry.get("program").and_then(Value::as_str) == Some(program)
                && entry.get("class").and_then(Value::as_str) == Some("read-only")
        })
    })
}

fn combine_or(results: Vec<Overlap>) -> Overlap {
    if results.contains(&Overlap::Overlap) {
        Overlap::Overlap
    } else if results.contains(&Overlap::Unknown) {
        Overlap::Unknown
    } else {
        Overlap::Disjoint
    }
}

fn field_name(field: &Field) -> &'static str {
    match field {
        Field::Tool(_) => "tool",
        Field::CompoundForm(_) => "compoundForm",
        Field::CompoundBodyEffect(_) => "compoundBodyEffect",
        Field::Program(_) => "program",
        Field::Arg0(_) => "arg0",
        Field::ArgAt { .. } => "argAt",
        Field::ArgCount { .. } => "argCount",
        Field::EnvAssignmentCount { .. } => "envAssignmentCount",
        Field::Flag(_) => "flag",
        Field::Present(_) => "present",
        Field::Redirect { .. } => "redirect",
        Field::Pipeline(_) => "pipeline",
        Field::Operator(_) => "operator",
        Field::CompositionStage(_) => "compositionStage",
        Field::PathScope { .. } => "pathScope",
        Field::MutationShape(_) => "mutationShape",
        Field::MutationTrustBoundary(_) => "mutationTrustBoundary",
    }
}

fn simple_field_name(field: Option<&Field>) -> Option<&'static str> {
    field.map(field_name)
}

fn strings(value: &Value, field: &str) -> HashSet<String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn single_string(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn array<'a>(value: &'a Value, field: &str) -> Option<&'a [Value]> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
}

fn kind(value: &Value) -> Option<&str> {
    value.get("kind").and_then(Value::as_str)
}

fn array_of_kinds(value: Option<&Value>, kinds: &[&str]) -> bool {
    value.and_then(Value::as_object).is_some_and(|_| {
        kind(value.unwrap_or(&Value::Null)).is_some_and(|kind| kinds.contains(&kind))
    })
}

fn intersect_sets(left: &HashSet<String>, right: &HashSet<String>) -> Option<HashSet<String>> {
    let values = left
        .iter()
        .filter(|value| right.contains(*value))
        .cloned()
        .collect::<HashSet<_>>();
    (!values.is_empty()).then_some(values)
}

fn sets_intersect(left: &HashSet<String>, right: &HashSet<String>) -> bool {
    left.iter().any(|value| right.contains(value))
}

fn pack_id(pack: &Value) -> Option<&str> {
    pack.get("id").and_then(Value::as_str)
}

fn rule_id(rule: &Value) -> Option<&str> {
    rule.get("id").and_then(Value::as_str)
}

fn unknown_matcher_error(entry: &ActiveRule<'_>) -> Value {
    composition_error(
        pack_id(entry.pack),
        rule_id(entry.rule),
        &entry.path,
        "allow rule matcher is not inspectable; refine the matcher to be provably disjoint or use a trusted module",
    )
}

fn composition_error(
    pack_id: Option<&str>,
    rule_id: Option<&str>,
    path: &str,
    message: &str,
) -> Value {
    json!({"packId": pack_id, "ruleId": rule_id, "path": path, "message": message})
}

#[cfg(test)]
mod tests {
    use super::{classify_overlap, compose_policy, validate_compound_allow_canonicality, Overlap};
    use serde_json::json;

    #[test]
    fn classifies_structural_program_overlap() {
        assert_eq!(
            classify_overlap(
                &json!({"kind":"program","name":"git"}),
                &json!({"kind":"program","name":"git"})
            ),
            Overlap::Overlap
        );
        assert_eq!(
            classify_overlap(
                &json!({"kind":"program","name":"git"}),
                &json!({"kind":"program","name":"rm"})
            ),
            Overlap::Disjoint
        );
        assert_eq!(
            classify_overlap(
                &json!({"kind":"not","of":{"kind":"program","name":"rm"}}),
                &json!({"kind":"program","name":"rm"})
            ),
            Overlap::Unknown
        );
    }

    #[test]
    fn stage_some_floor_uses_existential_program_witness() {
        let allow = json!({"kind":"all","of":[{"kind":"program","name":"git"},{"kind":"arg0In","values":["status"]}]});
        let floor = json!({"kind":"stageSome","inner":{"kind":"all","of":[{"kind":"program","name":"rm"},{"kind":"arg0In","values":["/"]}]}});
        assert_eq!(classify_overlap(&allow, &floor), Overlap::Disjoint);
    }

    #[test]
    fn compose_rejects_floor_overlap() {
        let result = compose_policy(&json!({
            "floor":{"id":"floor","rules":[{"id":"deny-rm","effect":"deny","match":{"kind":"program","name":"rm"}}]},
            "active":[{"id":"active","rules":[{"id":"allow-rm","effect":"allow","match":{"kind":"program","name":"rm"}}]}]
        }));
        assert_eq!(
            result["errors"][0]["message"],
            "allow rule overlaps sealed-floor deny `deny-rm`"
        );
    }

    #[test]
    fn canonicality_requires_the_whole_bundle() {
        let result = validate_compound_allow_canonicality(
            &json!({"kind":"all","of":[{"kind":"compoundForm","form":"for"}]}),
        );
        assert_eq!(result["applies"], true);
        assert_eq!(result["ok"], false);
    }
}
