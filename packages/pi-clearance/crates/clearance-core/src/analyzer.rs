use crate::contracts::*;
use crate::parser::parse_bash;
use serde::Deserialize;
use serde_json::{json, Map, Value};

pub fn analyze_tool(tool_name: &str, input: Value) -> ToolShape {
    if tool_name == "bash" {
        let Some(command) = input.get("command").and_then(Value::as_str) else {
            return ToolShape::Bash(BashCommandShape {
                kind: "bash".into(),
                raw_command: String::new(),
                cwd_prefix: None,
                blocks: Vec::new(),
                stages: Vec::new(),
                diagnostics: vec![diagnostic(
                    "tool:malformed-bash-input",
                    "Bash tool input must include a string command",
                    DiagnosticSeverity::Error,
                )],
                path_facts: None,
            });
        };
        return ToolShape::Bash(parse_bash(command));
    }

    let Some(operation) = operation_for(tool_name) else {
        return ToolShape::Unknown(UnknownToolShape {
            kind: "unknown".into(),
            tool_name: tool_name.into(),
            raw_input: input,
            diagnostics: vec![diagnostic(
                "tool:unsupported",
                &format!("Tool \"{tool_name}\" is not yet analyzed by pi-clearance"),
                DiagnosticSeverity::Warning,
            )],
        });
    };

    let mut diagnostics = Vec::new();
    let mut path_inputs = Vec::new();
    let record = input.as_object();
    let (path_key, path_optional) = path_spec(tool_name);
    if let Some(path_key) = path_key {
        match record.and_then(|r| r.get(path_key)) {
            None if !path_optional => diagnostics.push(diagnostic("pi-tool:missing-path-input", &format!("Tool \"{tool_name}\" input must include a string \"{path_key}\" path"), DiagnosticSeverity::Error)),
            None => {}
            Some(value) if value.is_string() => {
                let raw = value.as_str().unwrap_or_default().to_owned();
                path_inputs.push(PiBuiltinToolPathInput { key: path_key.into(), raw: raw.clone(), required: !path_optional });
                if raw.is_empty() { diagnostics.push(diagnostic("pi-tool:empty-path-input", &format!("Tool \"{tool_name}\" path input \"{path_key}\" must not be empty"), DiagnosticSeverity::Error)); }
                if let Some(reason) = lexical_path_reason(&raw) { diagnostics.push(diagnostic("pi-tool:unresolved-path-input", &format!("Tool \"{tool_name}\" path input \"{path_key}\" contains {reason} and requires review"), DiagnosticSeverity::Warning)); }
            }
            Some(value) => diagnostics.push(diagnostic("pi-tool:invalid-path-input", &format!("Tool \"{tool_name}\" input field \"{path_key}\" must be a single string path, got {}", json_type(value)), DiagnosticSeverity::Error)),
        }
    } else if record.is_none() && !is_embedded(operation) {
        diagnostics.push(diagnostic(
            "pi-tool:malformed-input",
            &format!("Tool \"{tool_name}\" input must be a JSON object"),
            DiagnosticSeverity::Error,
        ));
    }

    let mutation_facts = if matches!(operation, PiBuiltinToolOperation::Mutation)
        && matches!(tool_name, "edit" | "write")
    {
        mutation_facts(
            tool_name,
            record,
            path_inputs.first().map(|p| p.raw.as_str()),
            &mut diagnostics,
        )
    } else {
        None
    };
    let embedded_shell = if is_embedded(operation) {
        Some(project_embedded_shell(record, &mut diagnostics))
    } else {
        None
    };
    if is_embedded(operation) {
        if let Some(projection) = embedded_shell.as_ref() {
            if let Some(cwd) = projection.working_directory.as_ref() {
                path_inputs.push(PiBuiltinToolPathInput {
                    key: "workingDirectory".into(),
                    raw: cwd.clone(),
                    required: false,
                });
            }
        }
    }
    ToolShape::PiTool(PiBuiltinToolShape {
        kind: "pi-tool".into(),
        tool_name: tool_name.into(),
        operation,
        raw_input: input,
        path_inputs,
        diagnostics,
        embedded_shell,
        mutation_facts,
        trust_boundary: None,
        path_facts: None,
    })
}

fn operation_for(name: &str) -> Option<PiBuiltinToolOperation> {
    Some(match name {
        "read" => PiBuiltinToolOperation::ReadFile,
        "ls" => PiBuiltinToolOperation::ListDirectory,
        "find" | "fffind" => PiBuiltinToolOperation::FindFiles,
        "grep" | "ffgrep" => PiBuiltinToolOperation::SearchFileContents,
        "edit"
        | "write"
        | "todo"
        | "create_goal"
        | "create_goal_from_template"
        | "update_goal"
        | "clear_goal"
        | "enqueue_goal"
        | "start_queued_goal"
        | "dequeue_goal"
        | "remove_queued_goal" => PiBuiltinToolOperation::Mutation,
        "multi_grep" => PiBuiltinToolOperation::WorkspaceSearch,
        "jobs" | "get_subagent_result" | "list_subagent_models" => {
            PiBuiltinToolOperation::StatusRead
        }
        "get_goal" | "list_goal_templates" | "list_goal_queue" => PiBuiltinToolOperation::StateRead,
        "ask_user_question" => PiBuiltinToolOperation::Interactive,
        "zai_web_search" | "fetch_content" | "search_repo_docs" | "get_repo_structure"
        | "read_repo_file" | "umans_web_search" | "umans_vision" => {
            PiBuiltinToolOperation::NetworkRead
        }
        "background" | "monitor" => PiBuiltinToolOperation::EmbeddedShell,
        "subagent" | "steer_subagent" => PiBuiltinToolOperation::AgentDispatch,
        _ => return None,
    })
}

fn path_spec(name: &str) -> (Option<&'static str>, bool) {
    match name {
        "read" | "edit" | "write" => (Some("path"), false),
        "ls" | "find" | "grep" | "fffind" | "ffgrep" => (Some("path"), true),
        _ => (None, false),
    }
}

fn is_embedded(operation: PiBuiltinToolOperation) -> bool {
    matches!(operation, PiBuiltinToolOperation::EmbeddedShell)
}

fn project_embedded_shell(
    record: Option<&Map<String, Value>>,
    outer: &mut Vec<ShapeDiagnostic>,
) -> EmbeddedShellProjection {
    let Some(record) = record else {
        let d = diagnostic(
            "pi-tool:malformed-embedded-shell-input",
            "Embedded shell input must be an object with a string \"command\" field",
            DiagnosticSeverity::Error,
        );
        outer.push(d.clone());
        return EmbeddedShellProjection {
            command: None,
            working_directory: None,
            timeout: None,
            diagnostics: vec![d],
            working_directory_fact: None,
        };
    };
    let mut diagnostics = Vec::new();
    let command_value = record.get("command");
    let mut command = None;
    match command_value.and_then(Value::as_str) {
        Some(command_text) if !command_text.trim().is_empty() => {
            command = Some(Box::new(parse_bash(command_text)))
        }
        Some(_) => diagnostics.push(embedded_diagnostic(
            "pi-tool:empty-embedded-command",
            "field \"command\" must contain a non-empty shell command",
        )),
        None if command_value.is_none() => diagnostics.push(embedded_diagnostic(
            "pi-tool:missing-embedded-command",
            "input must include a string \"command\" field",
        )),
        None => diagnostics.push(embedded_diagnostic(
            "pi-tool:invalid-embedded-command",
            &format!(
                "field \"command\" must be a string, got {}",
                json_type(command_value.unwrap_or(&Value::Null))
            ),
        )),
    }
    let keys = ["workingDirectory", "working-directory", "cwd"]
        .iter()
        .filter(|key| record.contains_key(**key))
        .copied()
        .collect::<Vec<_>>();
    if keys.len() > 1 {
        diagnostics.push(embedded_diagnostic(
            "pi-tool:ambiguous-working-directory",
            "only one working-directory field may be provided",
        ));
    }
    let working_directory = keys
        .first()
        .and_then(|key| record.get(*key))
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if let Some(key) = keys.first() {
        let value = record.get(*key).unwrap_or(&Value::Null);
        if !value.is_string() || value.as_str() == Some("") {
            diagnostics.push(embedded_diagnostic(
                "pi-tool:invalid-working-directory",
                &format!(
                    "field \"{key}\" must be a non-empty string, got {}",
                    json_type(value)
                ),
            ));
        }
    }
    let timeout = record.get("timeout").and_then(Value::as_f64);
    if record.contains_key("timeout")
        && (timeout.is_none() || timeout.is_some_and(|value| !value.is_finite() || value < 0.0))
    {
        diagnostics.push(embedded_diagnostic(
            "pi-tool:invalid-timeout",
            "field \"timeout\" must be a finite, non-negative number",
        ));
    }
    for key in record.keys() {
        if !matches!(
            key.as_str(),
            "command" | "timeout" | "workingDirectory" | "working-directory" | "cwd"
        ) {
            diagnostics.push(embedded_diagnostic(
                "pi-tool:unsupported-embedded-field",
                &format!("field \"{key}\" is not modeled by the embedded-shell policy projection"),
            ));
        }
    }
    outer.extend(diagnostics.clone());
    EmbeddedShellProjection {
        command,
        working_directory,
        timeout,
        diagnostics,
        working_directory_fact: None,
    }
}

fn mutation_facts(
    name: &str,
    record: Option<&Map<String, Value>>,
    target: Option<&str>,
    diagnostics: &mut Vec<ShapeDiagnostic>,
) -> Option<PiToolMutationFacts> {
    let Some(record) = record else {
        diagnostics.push(diagnostic(
            "pi-tool:malformed-mutation-input",
            &format!("Tool \"{name}\" mutation input is malformed: input must be a JSON object"),
            DiagnosticSeverity::Error,
        ));
        return None;
    };
    let Some(target_path) = target else {
        diagnostics.push(diagnostic(
            "pi-tool:malformed-mutation-input",
            &format!(
                "Tool \"{name}\" mutation input is malformed: a string \"path\" target is required"
            ),
            DiagnosticSeverity::Error,
        ));
        return None;
    };
    if name == "write" {
        let content = record.get("content");
        if !content.is_some_and(Value::is_string) {
            diagnostics.push(diagnostic(
                "pi-tool:malformed-mutation-input",
                &format!(
                    "Tool \"write\" mutation input is malformed: field \"content\" is {}",
                    if content.is_some() {
                        "not a string"
                    } else {
                        "required"
                    }
                ),
                DiagnosticSeverity::Error,
            ));
        }
        return Some(PiToolMutationFacts::Write {
            target_path: target_path.into(),
            content_length: content
                .and_then(Value::as_str)
                .map(|s| s.chars().count() as u32),
            overwrites: "unknown".into(),
        });
    }
    if name == "edit" {
        if let Some(edits) = record.get("edits") {
            let Some(edits) = edits.as_array() else {
                diagnostics.push(diagnostic("pi-tool:malformed-mutation-input", "Tool \"edit\" mutation input is malformed: field \"edits\" must be a non-empty array", DiagnosticSeverity::Error));
                return Some(PiToolMutationFacts::Edit {
                    target_path: target_path.into(),
                    edit_count: None,
                    old_text_length: None,
                    new_text_length: None,
                    replace_all: None,
                    creates_content: false,
                });
            };
            if edits.is_empty() {
                diagnostics.push(diagnostic("pi-tool:malformed-mutation-input", "Tool \"edit\" mutation input is malformed: field \"edits\" must contain at least one edit entry", DiagnosticSeverity::Error));
            }
            for legacy_key in ["oldText", "newText", "replaceAll"] {
                if record.contains_key(legacy_key) {
                    diagnostics.push(diagnostic("pi-tool:malformed-mutation-input", &format!("Tool \"edit\" mutation input is malformed: field \"{legacy_key}\" cannot be mixed with batched \"edits\" entries"), DiagnosticSeverity::Error));
                }
            }
            let mut old_len = 0u32;
            let mut new_len = 0u32;
            let mut valid_old = true;
            let mut valid_new = true;
            let mut creates = false;
            for (index, entry) in edits.iter().enumerate() {
                let Some(entry) = entry.as_object() else {
                    valid_old = false;
                    valid_new = false;
                    diagnostics.push(diagnostic("pi-tool:malformed-mutation-input", &format!("Tool \"edit\" mutation input is malformed: field \"edits[{index}]\" must be an object"), DiagnosticSeverity::Error));
                    continue;
                };
                match entry.get("oldText").and_then(Value::as_str) {
                    Some(value) => {
                        old_len += value.chars().count() as u32;
                        if value.is_empty() {
                            creates = true;
                            diagnostics.push(diagnostic("pi-tool:edit-empty-replacement", "Tool \"edit\" oldText is empty, so the edit behaves like content creation/replacement", DiagnosticSeverity::Warning));
                        }
                    }
                    None => {
                        valid_old = false;
                        diagnostics.push(diagnostic("pi-tool:malformed-mutation-input", &format!("Tool \"edit\" mutation input is malformed: field \"edits[{index}].oldText\" is required"), DiagnosticSeverity::Error));
                    }
                }
                match entry.get("newText").and_then(Value::as_str) {
                    Some(value) => new_len += value.chars().count() as u32,
                    None => {
                        valid_new = false;
                        diagnostics.push(diagnostic("pi-tool:malformed-mutation-input", &format!("Tool \"edit\" mutation input is malformed: field \"edits[{index}].newText\" is required"), DiagnosticSeverity::Error));
                    }
                }
            }
            return Some(PiToolMutationFacts::Edit {
                target_path: target_path.into(),
                edit_count: Some(edits.len() as u32),
                old_text_length: valid_old.then_some(old_len),
                new_text_length: valid_new.then_some(new_len),
                replace_all: None,
                creates_content: creates,
            });
        }
        let old = record.get("oldText").and_then(Value::as_str);
        let new = record.get("newText").and_then(Value::as_str);
        if new.is_none() {
            diagnostics.push(diagnostic(
                "pi-tool:malformed-mutation-input",
                "Tool \"edit\" mutation input is malformed: field \"newText\" is required",
                DiagnosticSeverity::Error,
            ));
        }
        if record.contains_key("oldText") && old.is_none() {
            diagnostics.push(diagnostic(
                "pi-tool:malformed-mutation-input",
                "Tool \"edit\" mutation input is malformed: field \"oldText\" must be a string",
                DiagnosticSeverity::Error,
            ));
        }
        if old == Some("") {
            diagnostics.push(diagnostic("pi-tool:edit-empty-replacement", "Tool \"edit\" oldText is empty, so the edit behaves like content creation/replacement", DiagnosticSeverity::Warning));
        }
        return Some(PiToolMutationFacts::Edit {
            target_path: target_path.into(),
            edit_count: Some(1),
            old_text_length: old.map(|s| s.chars().count() as u32),
            new_text_length: new.map(|s| s.chars().count() as u32),
            replace_all: record.get("replaceAll").and_then(Value::as_bool),
            creates_content: !record.contains_key("oldText") || old == Some(""),
        });
    }
    None
}

fn lexical_path_reason(raw: &str) -> Option<&'static str> {
    if raw.contains('$') || raw.contains('`') || raw.contains("$(") || raw.contains("<(") {
        Some("runtime expansion")
    } else if raw.contains('{') || raw.contains('}') {
        Some("brace syntax")
    } else if raw.contains('*') || raw.contains('?') || raw.contains('[') || raw.contains(']') {
        Some("glob syntax")
    } else if raw.starts_with('~') && !raw.starts_with("~/") {
        Some("unsupported tilde-user syntax")
    } else {
        None
    }
}
fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
fn diagnostic(code: &str, message: &str, severity: DiagnosticSeverity) -> ShapeDiagnostic {
    ShapeDiagnostic {
        code: code.into(),
        message: message.into(),
        severity,
        source: None,
    }
}
fn embedded_diagnostic(code: &str, message: &str) -> ShapeDiagnostic {
    diagnostic(
        code,
        &format!("Embedded shell input {message}"),
        DiagnosticSeverity::Error,
    )
}

/// The effect table is native data. TypeScript consumes this JSON only to build
/// authoring-facing pack guards; classification itself remains in this module.
pub fn effect_registry() -> Value {
    let mut entries = Vec::new();
    let readonly_all = [
        ("ls", "read-only-directory-listing", "read-only"),
        ("cat", "read-only-file-concatenation", "read-only"),
        ("head", "read-only-file-head", "read-only"),
        ("wc", "read-only-file-count", "read-only"),
        ("file", "read-only-file-metadata", "read-only"),
        ("stat", "read-only-file-status", "read-only"),
        ("pwd", "read-only-print-cwd", "read-only"),
        ("uname", "read-only-system-name", "read-only"),
        ("whoami", "read-only-user-name", "read-only"),
        ("id", "read-only-user-identity", "read-only"),
        ("tree", "read-only-tree-inspection", "read-only"),
        ("du", "read-only-disk-usage-inspection", "read-only"),
        ("df", "read-only-filesystem-usage-inspection", "read-only"),
        ("nl", "read-only-numbered-file-inspection", "read-only"),
        ("readlink", "read-only-link-inspection", "read-only"),
        ("realpath", "read-only-path-resolution", "read-only"),
        ("basename", "read-only-basename-inspection", "read-only"),
        ("dirname", "read-only-dirname-inspection", "read-only"),
        (
            "which",
            "read-only-command-location-inspection",
            "read-only",
        ),
        (
            "whereis",
            "read-only-command-search-inspection",
            "read-only",
        ),
        (
            "type",
            "read-only-shell-command-type-inspection",
            "read-only",
        ),
        ("locate", "read-only-indexed-path-search", "read-only"),
        ("sha1sum", "read-only-checksum-inspection", "read-only"),
        ("sha224sum", "read-only-checksum-inspection", "read-only"),
        ("sha256sum", "read-only-checksum-inspection", "read-only"),
        ("sha384sum", "read-only-checksum-inspection", "read-only"),
        ("sha512sum", "read-only-checksum-inspection", "read-only"),
        ("md5sum", "read-only-checksum-inspection", "read-only"),
        ("b2sum", "read-only-checksum-inspection", "read-only"),
        ("shasum", "read-only-checksum-inspection", "read-only"),
        ("diff", "read-only-file-difference-inspection", "read-only"),
        ("ps", "read-only-process-inspection", "read-only"),
        ("pgrep", "read-only-process-search", "read-only"),
        ("uptime", "read-only-uptime-inspection", "read-only"),
        ("groups", "read-only-group-inspection", "read-only"),
        ("sleep", "read-only-delay", "read-only"),
        ("date", "read-only-date-inspection", "read-only"),
        (
            "command",
            "read-only-command-existence-inspection",
            "read-only",
        ),
        ("hostname", "read-only-hostname-inspection", "read-only"),
        ("test", "read-only-test-predicate", "read-only"),
        ("[", "read-only-test-predicate", "read-only"),
        ("[[", "read-only-test-predicate", "read-only"),
        ("cd", "read-only-cwd-change-in-fresh-shell", "read-only"),
        ("export", "read-only-environment-declaration", "read-only"),
        ("set", "read-only-shell-option-declaration", "read-only"),
        ("echo", "read-only-stdout-value", "read-only"),
        ("printf", "read-only-formatted-stdout-value", "read-only"),
        ("jq", "read-only-json-filter", "read-only"),
        ("uniq", "read-only-line-filter", "read-only"),
        ("cut", "read-only-field-filter", "read-only"),
        ("tr", "read-only-character-filter", "read-only"),
        ("tail", "read-only-tail-without-follow", "read-only"),
        ("grep", "read-only-grep-compound-compatible", "read-only"),
        (
            "rg",
            "read-only-ripgrep-without-rewrite-or-preprocessor",
            "read-only",
        ),
        (
            "find",
            "read-only-find-without-mutating-action",
            "read-only",
        ),
        ("sort", "read-only-sort-without-output-file", "read-only"),
        (
            "sed",
            "read-only-sed-print-only-without-in-place",
            "read-only",
        ),
    ];
    for (program, reason, class) in readonly_all {
        let file_inputs = if !matches!(
            program,
            "pwd"
                | "uname"
                | "whoami"
                | "id"
                | "ps"
                | "pgrep"
                | "uptime"
                | "groups"
                | "sleep"
                | "hostname"
                | "test"
                | "["
                | "[["
                | "cd"
                | "export"
                | "set"
                | "echo"
                | "printf"
                | "tr"
                | "uniq"
                | "date"
                | "command"
        ) {
            Some(
                json!({ "kind": "positional", "mode": if matches!(program, "head"|"tail"|"jq"|"cut"|"grep"|"rg"|"find"|"sort"|"sed") { "program-specific" } else { "all" } }),
            )
        } else {
            None
        };
        entries.push(json!({ "program": program, "class": class, "reason": reason, "fileInputs": file_inputs }));
    }
    entries.extend([
        ("mv", "write", "filesystem-move-write"), ("cp", "write", "filesystem-copy-write"), ("install", "write", "filesystem-install-write"),
        ("mkdir", "write", "filesystem-directory-create"), ("touch", "write", "filesystem-file-touch"), ("mktemp", "write", "filesystem-temp-create"),
        ("tee", "write", "filesystem-stream-write"), ("dd", "write", "filesystem-block-write"), ("ln", "write", "filesystem-link-write"),
        ("truncate", "write", "filesystem-size-write"), ("rm", "destructive", "filesystem-remove"), ("rmdir", "destructive", "filesystem-directory-remove"),
        ("shred", "destructive", "filesystem-destructive-overwrite"), ("curl", "network", "network-transfer"), ("wget", "network", "network-download"),
        ("scp", "network", "network-copy"), ("rsync", "network", "network-sync"), ("ssh", "network", "network-remote-shell"), ("nc", "network", "network-connection"),
        ("ftp", "network", "network-file-transfer"), ("sh", "shell-wrap", "shell-wrapper"), ("bash", "shell-wrap", "shell-wrapper"),
        ("zsh", "shell-wrap", "shell-wrapper"), ("dash", "shell-wrap", "shell-wrapper"), ("ksh", "shell-wrap", "shell-wrapper"),
        ("fish", "shell-wrap", "shell-wrapper"), ("eval", "shell-wrap", "shell-eval-wrapper"), ("source", "shell-wrap", "shell-source-wrapper"),
        ("exec", "shell-wrap", "shell-exec-wrapper"), ("xargs", "shell-wrap", "shell-argument-wrapper"), ("env", "shell-wrap", "shell-env-wrapper"),
    ].into_iter().map(|(program, class, reason)| json!({ "program": program, "class": class, "reason": reason })));
    for entry in &mut entries {
        let program = entry
            .get("program")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let condition = match program {
            "date" => Some(json!({ "forbidAnyFlag": ["s", "set"], "forbidShortFlagChars": ["s"] })),
            "tail" => Some(
                json!({ "forbidAnyFlag": ["f", "F", "follow"], "forbidShortFlagChars": ["f", "F"] }),
            ),
            "grep" => Some(json!({ "requireArgumentShape": "none" })),
            "rg" => Some(
                json!({ "forbidAnyFlag": ["replace", "pre", "pre-glob", "r"], "forbidFlagNamePrefixes": ["replace", "pre", "pre-glob"], "forbidShortFlagChars": ["r"], "forbidArgumentFlags": ["--replace", "--pre", "--pre-glob", "-r"] }),
            ),
            "find" => Some(
                json!({ "forbidAnyFlag": ["delete", "exec", "execdir", "ok", "okdir", "fprint", "fprintf", "fls"], "forbidFlagNamePrefixes": ["delete", "exec", "execdir", "ok", "okdir", "fprint", "fprintf", "fls"], "forbidArgumentFlags": ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"] }),
            ),
            "sort" => Some(
                json!({ "forbidAnyFlag": ["o", "output", "compress-program"], "forbidFlagNamePrefixes": ["o", "output", "compress-program"], "forbidShortFlagChars": ["o"], "forbidArgumentFlags": ["-o", "--output", "--compress-program"] }),
            ),
            "sed" => Some(
                json!({ "requireAnyFlag": ["n"], "forbidAnyFlag": ["i", "in-place"], "forbidFlagNamePrefixes": ["i", "in-place"], "forbidShortFlagChars": ["i"], "requireArgumentShape": "sed-print-only" }),
            ),
            "command" => Some(json!({ "requireAnyFlag": ["v", "V"] })),
            "tree" => Some(
                json!({ "forbidAnyFlag": ["o", "output"], "forbidArgumentFlags": ["-o", "--output"] }),
            ),
            _ => None,
        };
        if let Some(condition) = condition {
            entry
                .as_object_mut()
                .unwrap()
                .insert("condition".into(), condition);
        }
    }
    Value::Array(entries)
}

pub fn stage_file_input_indices(stage: &BashStage) -> Vec<u32> {
    let BashStage::Command { program, .. } = stage else {
        return Vec::new();
    };
    let (class, _) = classify_stage_effect(stage);
    if class != "read-only" {
        return Vec::new();
    }
    let all = |program: &BashStageProgram| (0..program.arguments.len() as u32).collect::<Vec<_>>();
    match program.program.as_str() {
        "ls" | "cat" | "wc" | "file" | "stat" | "tree" | "du" | "df" | "nl" | "readlink"
        | "realpath" | "basename" | "dirname" | "which" | "whereis" | "type" | "locate"
        | "sha1sum" | "sha224sum" | "sha256sum" | "sha384sum" | "sha512sum" | "md5sum"
        | "b2sum" | "shasum" | "diff" => all(program),
        "head" | "tail" => indices_after_values(program, &["n", "lines", "c", "bytes"]),
        "grep" => grep_indices(
            program,
            &[
                "e",
                "regexp",
                "f",
                "file",
                "A",
                "after-context",
                "B",
                "before-context",
                "C",
                "context",
                "m",
                "max-count",
                "label",
                "include",
                "exclude",
                "exclude-dir",
            ],
        ),
        "rg" => grep_indices(
            program,
            &[
                "e",
                "regexp",
                "f",
                "file",
                "g",
                "glob",
                "type",
                "type-add",
                "type-not",
                "m",
                "max-count",
                "A",
                "after-context",
                "B",
                "before-context",
                "C",
                "context",
                "replace",
                "pre",
                "pre-glob",
            ],
        ),
        "cut" => indices_after_values(
            program,
            &[
                "b",
                "bytes",
                "c",
                "characters",
                "d",
                "delimiter",
                "f",
                "fields",
            ],
        ),
        "sort" => indices_after_values(
            program,
            &[
                "k",
                "key",
                "S",
                "buffer-size",
                "T",
                "temporary-directory",
                "t",
                "field-separator",
            ],
        ),
        "sed" => {
            if program.arguments.len() > 1 {
                (1..program.arguments.len() as u32).collect()
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    }
}
fn indices_after_values(program: &BashStageProgram, names: &[&str]) -> Vec<u32> {
    let consumed = program
        .flags
        .iter()
        .filter(|f| names.contains(&f.name.as_str()) && f.value.is_none())
        .count();
    if consumed > program.arguments.len()
        || !program
            .arguments
            .iter()
            .take(consumed)
            .all(|v| !v.is_empty())
    {
        return Vec::new();
    }
    (consumed as u32..program.arguments.len() as u32).collect()
}
fn grep_indices(program: &BashStageProgram, values: &[&str]) -> Vec<u32> {
    let consumed = program
        .flags
        .iter()
        .filter(|f| values.contains(&f.name.as_str()) && f.value.is_none())
        .count();
    let offset = consumed
        + usize::from(
            !program
                .flags
                .iter()
                .any(|f| f.name == "e" || f.name == "regexp"),
        );
    if program.arguments.len() <= offset {
        Vec::new()
    } else {
        (offset as u32..program.arguments.len() as u32).collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MutationContext {
    project_scope: PathFactProjectScope,
    home_directory: Option<String>,
}

pub fn classify_mutation_trust_boundary(
    path: Option<&str>,
    context: Value,
) -> MutationTrustBoundaryClassification {
    let Some(path) = path.filter(|value| !value.trim().is_empty()) else {
        return MutationTrustBoundaryClassification {
            kind: MutationTrustBoundaryKind::Unknown,
            matched_pattern: Some("missing-path".into()),
        };
    };
    let Ok(context) = serde_json::from_value::<MutationContext>(context) else {
        return MutationTrustBoundaryClassification {
            kind: MutationTrustBoundaryKind::Unknown,
            matched_pattern: Some("invalid-context".into()),
        };
    };
    let normalized = normalize_path(path);
    let segments = path_segments(&normalized);
    let basename = segments.last().cloned().unwrap_or_default();
    let project_roots = context
        .project_scope
        .roots
        .iter()
        .chain(context.project_scope.writable_directories.iter())
        .map(|root| normalize_path(root))
        .collect::<Vec<_>>();
    if !project_roots.iter().any(|root| within(&normalized, root))
        && sensitive_home(&normalized, context.home_directory.as_deref())
    {
        return classification(MutationTrustBoundaryKind::SensitiveHome, "sensitive-home");
    }
    if let Some(home) = context
        .home_directory
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let home = normalize_path(home);
        if within(&normalized, &format!("{home}/.config/pi"))
            || within(&normalized, &format!("{home}/.pi"))
        {
            return classification(MutationTrustBoundaryKind::UserOwnedConfig, "home-pi-config");
        }
    }
    if segments.len() >= 2
        && segments[segments.len() - 2] == "packs"
        && (basename.ends_with(".json") || basename.ends_with(".ts"))
    {
        return classification(
            MutationTrustBoundaryKind::PolicyPack,
            "**/packs/*.{json,ts}",
        );
    }
    if basename.starts_with("reviewer-prompts")
        || (basename.starts_with("reviewer")
            && (basename.ends_with(".json") || basename.ends_with(".yaml")))
    {
        return classification(
            MutationTrustBoundaryKind::ReviewerConfig,
            "**/reviewer*.{json,yaml}|**/reviewer-prompts*",
        );
    }
    if segments
        .iter()
        .rev()
        .nth(1)
        .is_some_and(|parent| parent == "hooks" || parent == ".hooks")
        || (segments.len() >= 2
            && segments[segments.len() - 2] == "extensions"
            && basename.ends_with(".ts"))
    {
        return classification(
            MutationTrustBoundaryKind::ExecutableHook,
            "**/{hooks,.hooks}/*|**/extensions/*.ts",
        );
    }
    if basename == "package.json" || basename == "pnpm-workspace.yaml" {
        return classification(MutationTrustBoundaryKind::PackageScript, &basename);
    }
    if matches!(
        basename.as_str(),
        "AGENTS.md" | "CLAUDE.md" | "pi.config.json" | "pi.config.yaml"
    ) || segments
        .iter()
        .any(|segment| matches!(segment.as_str(), ".pi" | ".claude" | ".agents"))
    {
        return classification(
            MutationTrustBoundaryKind::ProjectOverlay,
            "AGENTS.md|CLAUDE.md|pi.config.*|**/{.pi,.claude,.agents}/**",
        );
    }
    classification(MutationTrustBoundaryKind::None, "")
}

fn classification(
    kind: MutationTrustBoundaryKind,
    pattern: &str,
) -> MutationTrustBoundaryClassification {
    MutationTrustBoundaryClassification {
        kind,
        matched_pattern: if pattern.is_empty() {
            None
        } else {
            Some(pattern.into())
        },
    }
}
fn normalize_path(value: &str) -> String {
    let mut output = Vec::new();
    let replaced = value.replace('\\', "/");
    for segment in replaced.split('/') {
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
fn within(candidate: &str, root: &str) -> bool {
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}
fn sensitive_home(path: &str, home: Option<&str>) -> bool {
    let Some(home) = home else { return false };
    let home = normalize_path(home);
    if !within(path, &home) || path == home {
        return false;
    }
    let relative = path
        .strip_prefix(&home)
        .unwrap_or("")
        .trim_start_matches('/');
    let parts = path_segments(relative);
    let basename = parts.last().map(String::as_str).unwrap_or("");
    let sensitive_dirs = [
        [".ssh"].as_slice(),
        [".gnupg"].as_slice(),
        [".aws"].as_slice(),
        [".config", "gnupg"].as_slice(),
        [".config", "systemd"].as_slice(),
        [".config", "keyring"].as_slice(),
        [".password-store"].as_slice(),
        [".docker"].as_slice(),
        [".kube"].as_slice(),
    ];
    if sensitive_dirs.iter().any(|prefix| {
        parts.len() >= prefix.len()
            && prefix
                .iter()
                .enumerate()
                .all(|(i, segment)| parts[i] == *segment)
    }) {
        return true;
    }
    if parts == [".pi", "agent", "auth.json"]
        || parts == [".pi", "agent", "models.json"]
        || (parts.len() == 3
            && parts[0] == ".config"
            && matches!(parts[1].as_str(), "gh" | "glab" | "glab-cli")
            && matches!(parts[2].as_str(), "hosts.yml" | "hosts.yaml"))
        || (parts.len() == 2 && parts[0] == ".cargo" && parts[1] == "credentials.toml")
    {
        return true;
    }
    let sensitive_names = [
        ".netrc",
        ".env",
        ".npmrc",
        ".pypirc",
        "access_token",
        "access_token.json",
        "auth",
        "auth.json",
        "credentials",
        "credentials.json",
        "secret",
        "secrets",
        "token",
        "token.json",
        "tokens",
    ];
    if sensitive_names.contains(&basename) || basename.starts_with(".env.") {
        return true;
    }
    parts
        .first()
        .is_some_and(|segment| segment.starts_with('.'))
        && (basename.ends_with(".pem")
            || basename.ends_with(".key")
            || basename == "id_rsa"
            || basename.starts_with("id_")
            || basename.ends_with("_rsa")
            || basename.ends_with("_ed25519")
            || basename.ends_with(".p12")
            || basename.ends_with(".pfx"))
}

pub fn classify_stage_effect(stage: &BashStage) -> (&'static str, &'static str) {
    let BashStage::Command {
        program,
        substitutions,
        redirects,
        ..
    } = stage
    else {
        return ("unknown", "non-command-stage");
    };
    if !program.resolvable {
        return ("unknown", "unresolvable-program");
    }
    if !substitutions.is_empty() {
        return ("unknown", "stage-substitution");
    }
    if redirects.iter().any(|r| {
        r.target_kind == RedirectTargetKind::File
            && matches!(
                r.stream,
                RedirectStream::Stdout
                    | RedirectStream::Stderr
                    | RedirectStream::Both
                    | RedirectStream::Fd
            )
    }) {
        return ("write", "file-output-redirect");
    }
    let p = program.program.as_str();
    let readonly = [
        "ls",
        "cat",
        "head",
        "wc",
        "file",
        "stat",
        "pwd",
        "uname",
        "whoami",
        "id",
        "tree",
        "du",
        "df",
        "nl",
        "readlink",
        "realpath",
        "basename",
        "dirname",
        "which",
        "whereis",
        "type",
        "locate",
        "sha1sum",
        "sha224sum",
        "sha256sum",
        "sha384sum",
        "sha512sum",
        "md5sum",
        "b2sum",
        "shasum",
        "diff",
        "ps",
        "pgrep",
        "uptime",
        "groups",
        "sleep",
        "date",
        "hostname",
        "test",
        "[",
        "[[",
        "cd",
        "export",
        "set",
        "echo",
        "printf",
        "jq",
        "uniq",
        "cut",
        "tr",
        "tail",
        "grep",
        "rg",
        "find",
        "sort",
        "sed",
        "command",
    ];
    let write = [
        "mv", "cp", "install", "mkdir", "touch", "mktemp", "tee", "dd", "ln", "truncate",
    ];
    let destructive = ["rm", "rmdir", "shred"];
    let network = ["curl", "wget", "scp", "rsync", "ssh", "nc", "ftp"];
    let shell = [
        "sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "source", "exec", "xargs", "env",
    ];
    if readonly.contains(&p) {
        if p == "date"
            && (program
                .flags
                .iter()
                .any(|f| f.name == "s" || f.name == "set" || (f.short && f.name.contains('s'))))
        {
            return ("unknown", "forbidden-flag-present");
        }
        if p == "tail"
            && program.flags.iter().any(|f| {
                f.name == "f"
                    || f.name == "F"
                    || f.name == "follow"
                    || (f.short && f.name.contains('f'))
            })
        {
            return ("unknown", "forbidden-flag-present");
        }
        if p == "sed"
            && program.flags.iter().any(|f| {
                f.name == "i"
                    || f.name == "in-place"
                    || f.name.starts_with("i.")
                    || (f.short && f.name.starts_with('i'))
            })
        {
            return ("unknown", "forbidden-flag-present");
        }
        if p == "sed" && !program.flags.iter().any(|f| f.name == "n") {
            return ("unknown", "missing-required-flag");
        }
        if p == "sed" {
            let script = program
                .arguments
                .first()
                .map(|value| value.trim_matches(|c| c == '\'' || c == '"'))
                .unwrap_or("");
            if script.contains("w ") || script.contains("/w") {
                return ("unknown", "argument-shape-unsupported");
            }
        }
        if p == "command" && !program.flags.iter().any(|f| f.name == "v" || f.name == "V") {
            return ("unknown", "missing-required-flag");
        }
        if ["find", "rg", "sort", "grep"].contains(&p)
            && program.flags.iter().any(|f| {
                matches!(
                    f.name.as_str(),
                    "delete"
                        | "exec"
                        | "execdir"
                        | "ok"
                        | "okdir"
                        | "fprint"
                        | "fprintf"
                        | "fls"
                        | "replace"
                        | "pre"
                        | "pre-glob"
                        | "o"
                        | "output"
                        | "compress-program"
                ) || (p == "sort" && f.short && f.name.starts_with('o'))
                    || (p == "rg" && f.short && f.name.contains('r'))
            })
        {
            return ("unknown", "forbidden-flag-present");
        }
        return (
            "read-only",
            match p {
                "ls" => "read-only-directory-listing",
                "cat" => "read-only-file-concatenation",
                "echo" => "read-only-stdout-value",
                "pwd" => "read-only-print-cwd",
                "sed" => "read-only-sed-print-only-without-in-place",
                "find" => "read-only-find-without-mutating-action",
                "sort" => "read-only-sort-without-output-file",
                "tail" => "read-only-tail-without-follow",
                "grep" => "read-only-grep-compound-compatible",
                "rg" => "read-only-ripgrep-without-rewrite-or-preprocessor",
                "command" => "read-only-command-existence-inspection",
                _ => "read-only-command",
            },
        );
    }
    if write.contains(&p) {
        return (
            "write",
            match p {
                "mv" => "filesystem-move-write",
                "cp" => "filesystem-copy-write",
                "install" => "filesystem-install-write",
                "mkdir" => "filesystem-directory-create",
                "touch" => "filesystem-file-touch",
                "mktemp" => "filesystem-temp-create",
                "tee" => "filesystem-stream-write",
                "dd" => "filesystem-block-write",
                "ln" => "filesystem-link-write",
                _ => "filesystem-size-write",
            },
        );
    }
    if destructive.contains(&p) {
        return (
            "destructive",
            match p {
                "rm" => "filesystem-remove",
                "rmdir" => "filesystem-directory-remove",
                _ => "filesystem-destructive-overwrite",
            },
        );
    }
    if network.contains(&p) {
        return (
            "network",
            match p {
                "curl" => "network-transfer",
                "wget" => "network-download",
                "scp" => "network-copy",
                "rsync" => "network-sync",
                "ssh" => "network-remote-shell",
                "nc" => "network-connection",
                _ => "network-file-transfer",
            },
        );
    }
    if shell.contains(&p) {
        return (
            "shell-wrap",
            match p {
                "eval" => "shell-eval-wrapper",
                "source" => "shell-source-wrapper",
                "exec" => "shell-exec-wrapper",
                "xargs" => "shell-argument-wrapper",
                "env" => "shell-env-wrapper",
                _ => "shell-wrapper",
            },
        );
    }
    ("unknown", "program-not-registered")
}
