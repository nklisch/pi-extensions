//! Native engine contract types exported to TypeScript with `ts-rs`.
//!
//! These types deliberately contain data only. Runtime adapters, filesystem
//! access and Pi API values remain outside this crate. The generated TypeScript
//! files are produced by `pnpm
//! contracts:generate`; never edit them directly.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Shape and diagnostics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ShapeDiagnostic {
    pub code: String,
    pub message: String,
    pub severity: DiagnosticSeverity,
    #[ts(optional)]
    pub source: Option<SourceSpan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentAssignment {
    pub name: String,
    pub value: String,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashFlag {
    pub raw: String,
    pub name: String,
    pub short: bool,
    #[ts(optional)]
    pub value: Option<String>,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashStageProgram {
    pub program: String,
    pub resolvable: bool,
    pub arguments: Vec<String>,
    pub flags: Vec<BashFlag>,
    pub environment: Vec<EnvironmentAssignment>,
    #[ts(optional)]
    pub variable_references: Option<Vec<BashLoopVariableReference>>,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum RedirectStream {
    #[ts(rename = "stdout")]
    Stdout,
    #[ts(rename = "stderr")]
    Stderr,
    #[ts(rename = "stdin")]
    Stdin,
    #[ts(rename = "fd")]
    Fd,
    #[ts(rename = "both")]
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum RedirectTargetKind {
    File,
    Fd,
    Heredoc,
    Herestring,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct Redirect {
    pub stream: RedirectStream,
    pub target_kind: RedirectTargetKind,
    pub target: String,
    pub append: bool,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum SubstitutionKind {
    Command,
    Process,
    Arithmetic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct Substitution {
    pub kind: SubstitutionKind,
    pub raw: String,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum BashControlConstruct {
    If,
    For,
    While,
    Until,
    Case,
    Select,
    Function,
    BraceGroup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum BashIteratorEntryKind {
    LiteralWord,
    LiteralGlob,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashIteratorEntry {
    pub kind: BashIteratorEntryKind,
    pub raw: String,
    pub literal: String,
    pub quote: QuoteKind,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum QuoteKind {
    None,
    Single,
    Double,
    Mixed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashLoopVariableReference {
    pub name: String,
    pub raw: String,
    pub quote: LoopQuoteKind,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum LoopQuoteKind {
    None,
    Single,
    Double,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashForLoopKeywordSpans {
    #[ts(optional)]
    pub r#for: Option<SourceSpan>,
    #[ts(optional)]
    pub r#in: Option<SourceSpan>,
    #[ts(optional)]
    pub r#do: Option<SourceSpan>,
    #[ts(optional)]
    pub done: Option<SourceSpan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashConditionalArm {
    pub test: BashPipeline,
    pub body: BashBlock,
    #[ts(optional)]
    pub if_or_else_span: Option<SourceSpan>,
    #[ts(optional)]
    pub then_span: Option<SourceSpan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum CompoundIteratorReason {
    Substitution,
    Arithmetic,
    Indirect,
    Parameter,
    Brace,
    Extglob,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum CompoundBodyReason {
    NestedForm,
    UnsupportedStage,
    Function,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum CompoundFeatureReason {
    Select,
    ForArithmetic,
    Case,
    While,
    Until,
    HeredocInCompound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(tag = "kind")]
#[serde(tag = "kind")]
#[ts(rename_all_fields = "camelCase")]
#[serde(rename_all_fields = "camelCase")]
pub enum BashStage {
    #[ts(rename = "command")]
    #[serde(rename = "command")]
    Command {
        program: BashStageProgram,
        substitutions: Vec<Substitution>,
        redirects: Vec<Redirect>,
        span: SourceSpan,
    },
    #[ts(rename = "subshell")]
    #[serde(rename = "subshell")]
    Subshell { span: SourceSpan },
    #[ts(rename = "control-flow")]
    #[serde(rename = "control-flow")]
    ControlFlow {
        construct: BashControlConstruct,
        span: SourceSpan,
    },
    #[ts(rename = "for-loop")]
    #[serde(rename = "for-loop")]
    ForLoop {
        variable: String,
        variable_span: SourceSpan,
        iterator: Vec<BashIteratorEntry>,
        body: BashBlock,
        keyword_spans: BashForLoopKeywordSpans,
        span: SourceSpan,
    },
    #[ts(rename = "brace-group")]
    #[serde(rename = "brace-group")]
    BraceGroup {
        body: BashBlock,
        redirects: Vec<Redirect>,
        span: SourceSpan,
    },
    #[ts(rename = "conditional")]
    #[serde(rename = "conditional")]
    Conditional {
        arms: Vec<BashConditionalArm>,
        #[ts(optional)]
        #[serde(default)]
        else_body: Option<BashBlock>,
        #[ts(optional)]
        #[serde(default)]
        else_span: Option<SourceSpan>,
        span: SourceSpan,
    },
    #[ts(rename = "unsupported")]
    #[serde(rename = "unsupported")]
    Unsupported { reason: String, span: SourceSpan },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum BashListOperator {
    And,
    Or,
    Seq,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashPipeline {
    pub stages: Vec<BashStage>,
    pub pipe_targets: Vec<String>,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashBlock {
    pub pipeline: BashPipeline,
    #[ts(optional)]
    pub operator: Option<BashListOperator>,
    #[ts(optional)]
    pub background: Option<bool>,
    pub span: SourceSpan,
}

// ---------------------------------------------------------------------------
// Path-fact context and envelopes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum PathScope {
    WritableProject,
    Project,
    Temp,
    Home,
    SafeHome,
    SensitiveHome,
    AgentSupport,
    System,
    Outside,
    Denied,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum PathUsageKind {
    CwdPrefix,
    Argument,
    FlagValue,
    RedirectTarget,
    ImplicitTemp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum PathAccess {
    Read,
    Write,
    Create,
    ReadWrite,
    Cwd,
    Temp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum PathUnknownReason {
    DynamicExpansion,
    GlobExpansion,
    BraceExpansion,
    UnsupportedShellLiteral,
    UnsupportedShellSyntax,
    MissingOperand,
    NonFileRedirect,
    UnresolvedCwdPrefix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum IteratorSourceKind {
    LiteralWord,
    LiteralGlob,
    Mixed,
    Opaque,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum LoopVariableUnknownReason {
    OpaqueIterator,
    IteratorMixedUnknown,
    OuterScopeVariable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PathFactProjectScope {
    pub roots: Vec<String>,
    pub writable_directories: Vec<String>,
    pub temp_directories: Vec<String>,
    pub denied_directories: Vec<String>,
    pub safe_home_directories: Vec<String>,
    #[ts(optional)]
    pub agent_support_directories: Option<Vec<String>>,
    pub unknown_path_behavior: UnknownPathBehavior,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum UnknownPathBehavior {
    Review,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ToolPathFactContext {
    pub cwd: String,
    pub project_scope: PathFactProjectScope,
    #[ts(optional)]
    pub home_directory: Option<String>,
    #[ts(optional)]
    pub system_path_prefixes: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashPathFactContext {
    pub cwd: String,
    pub project_scope: PathFactProjectScope,
    #[ts(optional)]
    pub home_directory: Option<String>,
    #[ts(optional)]
    pub system_path_prefixes: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PathFactsResolvedConfig {
    pub cwd: String,
    pub project_scope: PathFactProjectScope,
    #[ts(optional)]
    pub home_directory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashPathFactProvenanceEntry {
    pub raw: String,
    #[ts(optional)]
    pub literal: Option<String>,
    #[ts(optional)]
    pub concrete_absolute_path: Option<String>,
    #[ts(optional)]
    pub static_prefix_absolute_path: Option<String>,
    pub scope: PathScope,
    pub matched_scopes: Vec<PathScope>,
    pub quote: QuoteKind,
    #[ts(optional)]
    pub unknown_reason: Option<PathUnknownReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(tag = "kind")]
#[serde(tag = "kind")]
#[ts(rename_all_fields = "camelCase")]
#[serde(rename_all_fields = "camelCase")]
pub enum BashPathFactProvenance {
    #[ts(rename = "loop-variable")]
    #[serde(rename = "loop-variable")]
    LoopVariable {
        variable_name: String,
        iterator_source_kind: IteratorSourceKind,
        iterator_entries: Vec<BashPathFactProvenanceEntry>,
        loop_stage_index: u32,
        #[ts(optional)]
        #[serde(default)]
        unknown_reason: Option<LoopVariableUnknownReason>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashPathFact {
    pub id: String,
    #[ts(optional)]
    pub stage_index: Option<u32>,
    #[ts(optional)]
    pub program: Option<String>,
    pub usage: PathUsageKind,
    pub access: PathAccess,
    pub raw: String,
    #[ts(optional)]
    pub literal: Option<String>,
    #[ts(optional)]
    pub absolute_path: Option<String>,
    pub scope: PathScope,
    pub matched_scopes: Vec<PathScope>,
    pub normalization: PathNormalization,
    pub is_absolute: bool,
    pub is_relative: bool,
    pub has_parent_traversal: bool,
    pub quote: QuoteKind,
    pub dynamic: bool,
    #[ts(optional)]
    pub unknown_reason: Option<PathUnknownReason>,
    pub source: SourceSpan,
    #[ts(optional)]
    pub provenance: Option<BashPathFactProvenance>,
    #[ts(optional)]
    pub glob_approximation: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum PathNormalization {
    Lexical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashPathFacts {
    pub base_cwd: String,
    pub effective_cwd: String,
    #[ts(optional)]
    pub cwd_prefix: Option<BashPathFact>,
    pub facts: Vec<BashPathFact>,
    pub has_unknown: bool,
    pub has_denied: bool,
    pub has_outside_project: bool,
    pub has_system_path: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum PiBuiltinToolOperation {
    ReadFile,
    ListDirectory,
    FindFiles,
    SearchFileContents,
    StatusRead,
    StateRead,
    WorkspaceSearch,
    Interactive,
    Mutation,
    AgentDispatch,
    NetworkRead,
    EmbeddedShell,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ToolPathFact {
    pub id: String,
    #[ts(optional)]
    pub tool_name: Option<String>,
    pub usage: ToolPathUsage,
    pub access: ToolPathAccess,
    pub raw: String,
    #[ts(optional)]
    pub literal: Option<String>,
    #[ts(optional)]
    pub absolute_path: Option<String>,
    pub scope: PathScope,
    pub matched_scopes: Vec<PathScope>,
    pub normalization: PathNormalization,
    pub is_absolute: bool,
    pub is_relative: bool,
    pub has_parent_traversal: bool,
    pub dynamic: bool,
    #[ts(optional)]
    pub unknown_reason: Option<PathUnknownReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum ToolPathUsage {
    Argument,
    ImplicitCwd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum ToolPathAccess {
    Read,
    Write,
    Create,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ToolPathFacts {
    pub base_cwd: String,
    pub effective_cwd: String,
    pub facts: Vec<ToolPathFact>,
    pub has_unknown: bool,
    pub has_denied: bool,
    pub has_outside_project: bool,
    pub has_system_path: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PiBuiltinToolPathInput {
    pub key: String,
    pub raw: String,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(tag = "kind")]
#[serde(tag = "kind")]
#[ts(rename_all_fields = "camelCase")]
#[serde(rename_all_fields = "camelCase")]
pub enum PiToolMutationFacts {
    #[ts(rename = "edit")]
    #[serde(rename = "edit")]
    Edit {
        target_path: String,
        #[ts(optional)]
        #[serde(default)]
        edit_count: Option<u32>,
        #[ts(optional)]
        #[serde(default)]
        old_text_length: Option<u32>,
        #[ts(optional)]
        #[serde(default)]
        new_text_length: Option<u32>,
        #[ts(optional)]
        #[serde(default)]
        replace_all: Option<bool>,
        creates_content: bool,
    },
    #[ts(rename = "write")]
    #[serde(rename = "write")]
    Write {
        target_path: String,
        #[ts(optional)]
        #[serde(default)]
        content_length: Option<u32>,
        #[ts(type = "\"unknown\"")]
        overwrites: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum MutationTrustBoundaryKind {
    None,
    ProjectOverlay,
    PolicyPack,
    ReviewerConfig,
    ExecutableHook,
    PackageScript,
    UserOwnedConfig,
    SensitiveHome,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct MutationTrustBoundaryClassification {
    pub kind: MutationTrustBoundaryKind,
    #[ts(optional)]
    pub matched_pattern: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PiBuiltinToolShape {
    #[ts(type = "\"pi-tool\"")]
    pub kind: String,
    pub tool_name: String,
    pub operation: PiBuiltinToolOperation,
    #[ts(type = "unknown")]
    pub raw_input: JsonValue,
    pub path_inputs: Vec<PiBuiltinToolPathInput>,
    pub diagnostics: Vec<ShapeDiagnostic>,
    #[ts(optional)]
    #[serde(default)]
    pub embedded_shell: Option<EmbeddedShellProjection>,
    #[ts(optional)]
    pub mutation_facts: Option<PiToolMutationFacts>,
    #[ts(optional)]
    pub trust_boundary: Option<MutationTrustBoundaryClassification>,
    #[ts(optional)]
    pub path_facts: Option<ToolPathFacts>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedShellProjection {
    #[ts(optional)]
    #[serde(default)]
    pub command: Option<Box<BashCommandShape>>,
    #[ts(optional)]
    #[serde(default)]
    pub working_directory: Option<String>,
    #[ts(optional)]
    #[serde(default)]
    pub timeout: Option<f64>,
    pub diagnostics: Vec<ShapeDiagnostic>,
    #[ts(optional)]
    #[serde(default)]
    pub working_directory_fact: Option<ToolPathFact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PiBuiltinToolSpec {
    pub tool_name: String,
    pub operation: PiBuiltinToolOperation,
    #[ts(optional)]
    pub path_key: Option<String>,
    #[ts(optional)]
    pub path_optional: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BashCommandShape {
    #[ts(type = "\"bash\"")]
    pub kind: String,
    pub raw_command: String,
    #[ts(optional)]
    pub cwd_prefix: Option<String>,
    pub blocks: Vec<BashBlock>,
    pub stages: Vec<BashStage>,
    pub diagnostics: Vec<ShapeDiagnostic>,
    #[ts(optional)]
    pub path_facts: Option<BashPathFacts>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct UnknownToolShape {
    #[ts(type = "\"unknown\"")]
    pub kind: String,
    pub tool_name: String,
    #[ts(type = "unknown")]
    pub raw_input: JsonValue,
    pub diagnostics: Vec<ShapeDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(untagged)]
#[serde(untagged)]
pub enum ToolShape {
    Bash(BashCommandShape),
    PiTool(PiBuiltinToolShape),
    Unknown(UnknownToolShape),
}

// ---------------------------------------------------------------------------
// Matcher DSL contract (39 inspectable combinators in current matchers.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum BlockOperator {
    And,
    Or,
    Seq,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum CompositionOperator {
    And,
    Seq,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum PathScopeMatcherMode {
    AllIn,
    NoneIn,
    SomeIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum PathFactsRequirement {
    OneOrMore,
    ZeroOrMore,
    PerCommandStage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum CompoundForm {
    For,
    BraceGroup,
    If,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum PiFileMutationToolName {
    Edit,
    Write,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum MutationShapeKind {
    WellFormed,
    Create,
    Replace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PathScopeMatcherExpr {
    #[ts(type = "\"pathScope\"")]
    pub kind: String,
    pub mode: PathScopeMatcherMode,
    pub scopes: Vec<PathScope>,
    #[ts(optional)]
    pub programs: Option<Vec<String>>,
    #[ts(optional)]
    pub usages: Option<Vec<PathUsageKind>>,
    #[ts(optional)]
    pub allow_exact_paths: Option<Vec<String>>,
    #[ts(optional)]
    pub forbid_path_segments: Option<Vec<String>>,
    #[ts(optional)]
    pub require_facts: Option<PathFactsRequirement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(tag = "kind")]
#[serde(tag = "kind")]
#[ts(rename_all_fields = "camelCase")]
#[serde(rename_all_fields = "camelCase")]
pub enum MatcherExpr {
    #[ts(rename = "always")]
    #[serde(rename = "always")]
    Always,
    #[ts(rename = "tool")]
    #[serde(rename = "tool")]
    Tool { tool: String },
    #[ts(rename = "program")]
    #[serde(rename = "program")]
    Program { name: String },
    #[ts(rename = "arg0In")]
    #[serde(rename = "arg0In")]
    Arg0In { values: Vec<String> },
    #[ts(rename = "argAt")]
    #[serde(rename = "argAt")]
    ArgAt { index: u32, value: String },
    #[ts(rename = "argCount")]
    #[serde(rename = "argCount")]
    ArgCount {
        #[ts(optional)]
        #[serde(default)]
        min: Option<u32>,
        #[ts(optional)]
        #[serde(default)]
        max: Option<u32>,
    },
    #[ts(rename = "envAssignmentCount")]
    #[serde(rename = "envAssignmentCount")]
    EnvAssignmentCount {
        #[ts(optional)]
        #[serde(default)]
        min: Option<u32>,
        #[ts(optional)]
        #[serde(default)]
        max: Option<u32>,
    },
    #[ts(rename = "argMatches")]
    #[serde(rename = "argMatches")]
    ArgMatches { index: u32, pattern: String },
    #[ts(rename = "flagPresent")]
    #[serde(rename = "flagPresent")]
    FlagPresent { name: String },
    #[ts(rename = "flagMatches")]
    #[serde(rename = "flagMatches")]
    FlagMatches {
        #[ts(optional)]
        #[serde(default)]
        names: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        prefixes: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        short_chars: Option<Vec<String>>,
    },
    #[ts(rename = "flagAllowlist")]
    #[serde(rename = "flagAllowlist")]
    FlagAllowlist {
        #[ts(optional)]
        #[serde(default)]
        names: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        short_chars: Option<Vec<String>>,
    },
    #[ts(rename = "flagValueIn")]
    #[serde(rename = "flagValueIn")]
    FlagValueIn {
        names: Vec<String>,
        values: Vec<String>,
        #[ts(optional)]
        #[serde(default)]
        allow_undefined_value: Option<bool>,
    },
    #[ts(rename = "flagCount")]
    #[serde(rename = "flagCount")]
    FlagCount {
        #[ts(optional)]
        #[serde(default)]
        names: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        short_chars: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        max: Option<u32>,
        #[ts(optional)]
        #[serde(default)]
        min: Option<u32>,
    },
    #[ts(rename = "anyArgMatches")]
    #[serde(rename = "anyArgMatches")]
    AnyArgMatches { pattern: String },
    #[ts(rename = "envAssignmentNameIn")]
    #[serde(rename = "envAssignmentNameIn")]
    EnvAssignmentNameIn {
        #[ts(optional)]
        #[serde(default)]
        names: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        prefixes: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        case_insensitive_prefixes: Option<Vec<String>>,
    },
    #[ts(rename = "noSubstitution")]
    #[serde(rename = "noSubstitution")]
    NoSubstitution,
    #[ts(rename = "noStdoutRedirect")]
    #[serde(rename = "noStdoutRedirect")]
    NoStdoutRedirect,
    #[ts(rename = "redirect")]
    #[serde(rename = "redirect")]
    Redirect {
        #[ts(optional)]
        #[serde(default)]
        stream: Option<RedirectStream>,
        #[ts(optional)]
        #[serde(default)]
        target: Option<String>,
        #[ts(optional)]
        #[serde(default)]
        target_kind: Option<RedirectTargetKind>,
    },
    #[ts(rename = "pipeline")]
    #[serde(rename = "pipeline")]
    Pipeline { target: String },
    #[ts(rename = "operator")]
    #[serde(rename = "operator")]
    Operator { op: BlockOperator },
    #[ts(rename = "stageEvery")]
    #[serde(rename = "stageEvery")]
    StageEvery { inner: Box<MatcherExpr> },
    #[ts(rename = "stageSome")]
    #[serde(rename = "stageSome")]
    StageSome { inner: Box<MatcherExpr> },
    #[ts(rename = "compoundForm")]
    #[serde(rename = "compoundForm")]
    CompoundForm { form: CompoundForm },
    #[ts(rename = "bodyStagesAllReadOnly")]
    #[serde(rename = "bodyStagesAllReadOnly")]
    BodyStagesAllReadOnly,
    #[ts(rename = "bodyStagesAllScopeIn")]
    #[serde(rename = "bodyStagesAllScopeIn")]
    BodyStagesAllScopeIn { scopes: Vec<PathScope> },
    #[ts(rename = "iteratorScopesAllIn")]
    #[serde(rename = "iteratorScopesAllIn")]
    IteratorScopesAllIn { scopes: Vec<PathScope> },
    #[ts(rename = "noBodySubstitution")]
    #[serde(rename = "noBodySubstitution")]
    NoBodySubstitution,
    #[ts(rename = "noBodyShellWrap")]
    #[serde(rename = "noBodyShellWrap")]
    NoBodyShellWrap,
    #[ts(rename = "noBodyRedirectTo")]
    #[serde(rename = "noBodyRedirectTo")]
    NoBodyRedirectTo,
    #[ts(rename = "diagnosticCode")]
    #[serde(rename = "diagnosticCode")]
    DiagnosticCode { code: String },
    #[ts(rename = "composition")]
    #[serde(rename = "composition")]
    Composition {
        stage: Box<MatcherExpr>,
        operators: Vec<CompositionOperator>,
        #[ts(optional)]
        #[serde(default)]
        allow_background: Option<bool>,
        #[ts(optional)]
        #[serde(default)]
        min_stages: Option<u32>,
        #[ts(optional)]
        #[serde(default)]
        or_fallback: Option<Vec<String>>,
    },
    #[ts(rename = "all")]
    #[serde(rename = "all")]
    All { of: Vec<Box<MatcherExpr>> },
    #[ts(rename = "any")]
    #[serde(rename = "any")]
    Any { of: Vec<Box<MatcherExpr>> },
    #[ts(rename = "not")]
    #[serde(rename = "not")]
    Not { of: Box<MatcherExpr> },
    #[ts(rename = "mutationTool")]
    #[serde(rename = "mutationTool")]
    MutationTool { tools: Vec<PiFileMutationToolName> },
    #[ts(rename = "mutationShape")]
    #[serde(rename = "mutationShape")]
    MutationShape { shape: MutationShapeKind },
    #[ts(rename = "mutationTrustBoundary")]
    #[serde(rename = "mutationTrustBoundary")]
    MutationTrustBoundary {
        r#in: Vec<MutationTrustBoundaryKind>,
    },
    #[ts(rename = "pathScope")]
    #[serde(rename = "pathScope")]
    PathScope {
        mode: PathScopeMatcherMode,
        scopes: Vec<PathScope>,
        #[ts(optional)]
        #[serde(default)]
        programs: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        usages: Option<Vec<PathUsageKind>>,
        #[ts(optional)]
        #[serde(default)]
        allow_exact_paths: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        forbid_path_segments: Option<Vec<String>>,
        #[ts(optional)]
        #[serde(default)]
        require_facts: Option<PathFactsRequirement>,
    },
}

// ---------------------------------------------------------------------------
// Decision and policy packs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum DecisionEffect {
    Allow,
    Deny,
    Review,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum DecisionSource {
    Shipped,
    UserGlobal,
    UserProject,
    TrustedRepo,
    Package,
    Generated,
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct DecisionProvenance {
    pub source: DecisionSource,
    #[ts(optional)]
    pub pack_id: Option<String>,
    #[ts(optional)]
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub effect: DecisionEffect,
    pub reason: String,
    pub provenance: DecisionProvenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum PackWarningLevel {
    Info,
    Warning,
    Danger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PolicyPackDocLink {
    pub label: String,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PolicyPackWarning {
    pub level: PackWarningLevel,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PolicyPackExample {
    pub outcome: DecisionEffect,
    pub shape: String,
    #[ts(optional)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PolicyPackMetadata {
    #[ts(optional)]
    pub title: Option<String>,
    #[ts(optional)]
    pub description: Option<String>,
    #[ts(optional)]
    pub docs: Option<Vec<PolicyPackDocLink>>,
    #[ts(optional)]
    pub tags: Option<Vec<String>>,
    #[ts(optional)]
    pub warnings: Option<Vec<PolicyPackWarning>>,
    #[ts(optional)]
    pub examples: Option<Vec<PolicyPackExample>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    pub id: String,
    pub effect: DecisionEffect,
    pub r#match: MatcherExpr,
    pub reason: String,
    pub provenance: DecisionProvenance,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PolicyPack {
    #[ts(type = "1")]
    pub version: u32,
    pub id: String,
    #[ts(optional)]
    pub metadata: Option<PolicyPackMetadata>,
    pub rules: Vec<PolicyRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct EffectivePolicy {
    #[ts(optional)]
    pub floor: Option<Vec<PolicyRule>>,
    #[ts(optional)]
    pub active: Option<Vec<PolicyRule>>,
    #[ts(optional)]
    pub rules: Option<Vec<PolicyRule>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CompileError {
    #[ts(optional)]
    pub pack_id: Option<String>,
    #[ts(optional)]
    pub rule_id: Option<String>,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct PackCompileResult {
    #[ts(optional)]
    pub pack: Option<PolicyPack>,
    pub errors: Vec<CompileError>,
}

// ---------------------------------------------------------------------------
// Replay model and validation reports
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum ReplayStatus {
    FastPath,
    Review,
    HardBlock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum CorpusExpectedLabel {
    FastPath,
    Review,
    HardBlock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum CorpusFidelity {
    High,
    Redacted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum CorpusSource {
    Session,
    Audit,
    Corpus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum ReplayReviewerMode {
    Model,
    Human,
    BlockAndLog,
    ModeOff,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayReviewerOutcome {
    pub mode: ReplayReviewerMode,
    pub final_effect: DecisionEffect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CorpusEntry {
    pub command: String,
    pub tool_name: String,
    #[ts(type = "unknown")]
    #[ts(optional)]
    pub tool_input: Option<JsonValue>,
    #[ts(optional)]
    pub tool_call_id: Option<String>,
    #[ts(optional)]
    pub session_id: Option<String>,
    #[ts(optional)]
    pub timestamp: Option<String>,
    pub source: CorpusSource,
    pub sources: Vec<CorpusSource>,
    pub provenance: String,
    #[ts(optional)]
    pub deterministic_outcome: Option<DecisionEffect>,
    #[ts(optional)]
    pub reviewer_outcome: Option<ReplayReviewerOutcome>,
    #[ts(optional)]
    pub expected_label: Option<CorpusExpectedLabel>,
    pub fidelity: CorpusFidelity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CountByLabel {
    pub label: String,
    pub calls: u32,
    #[ts(optional)]
    pub unique_commands: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayCorpus {
    pub entries: Vec<CorpusEntry>,
    /** JSON boundary uses arrays; the TS acquisition layer keeps its Map locally. */
    pub source_summary: Vec<CountByLabel>,
    pub unmatched_audit_entries: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CapturedOutcome {
    pub label: String,
    #[ts(optional)]
    pub deterministic_effect: Option<DecisionEffect>,
    #[ts(optional)]
    pub reviewer: Option<ReplayReviewerOutcome>,
    #[ts(optional)]
    pub fixture_expected: Option<CorpusExpectedLabel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ToolCallIdentity {
    pub record_id: String,
    pub tool_name: String,
    pub command: String,
    #[ts(type = "unknown")]
    #[ts(optional)]
    pub tool_input: Option<JsonValue>,
    #[ts(optional)]
    pub tool_call_id: Option<String>,
    #[ts(optional)]
    pub session_id: Option<String>,
    #[ts(optional)]
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct SourceFidelity {
    pub source: CorpusSource,
    pub sources: Vec<CorpusSource>,
    pub provenance: String,
    pub fidelity: CorpusFidelity,
    pub redacted: bool,
    pub low_fidelity_reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ParsedShapeSummary {
    pub tool_kind: String,
    #[ts(optional)]
    pub primary_executable: Option<String>,
    #[ts(optional)]
    pub tool_operation: Option<PiBuiltinToolOperation>,
    pub arguments: Vec<String>,
    pub flags: Vec<String>,
    pub operator_shape: Vec<String>,
    pub has_substitution: bool,
    pub has_stdout_redirect: bool,
    pub diagnostic_codes: Vec<String>,
    #[ts(optional)]
    pub parse_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ParsedEvidence {
    #[ts(optional)]
    pub shape: Option<ToolShape>,
    pub summary: ParsedShapeSummary,
    pub diagnostics: Vec<ShapeDiagnostic>,
    #[ts(optional)]
    pub path_facts: Option<ReplayPathFacts>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(untagged)]
pub enum ReplayPathFacts {
    Bash(Box<BashPathFacts>),
    Tool(Box<ToolPathFacts>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayedDecision {
    pub decision: Decision,
    pub status: ReplayStatus,
    pub provenance: DecisionProvenance,
    #[ts(optional)]
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CommandFamilyKey {
    pub id: String,
    pub tool_name: String,
    pub kind: String,
    #[ts(optional)]
    pub executable: Option<String>,
    #[ts(optional)]
    pub semantic_argument: Option<String>,
    #[ts(optional)]
    pub operation: Option<PiBuiltinToolOperation>,
    pub operator_shape: Vec<String>,
    pub has_substitution: bool,
    pub has_stdout_redirect: bool,
    pub has_parse_diagnostics: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CorpusRecord {
    pub id: String,
    pub identity: ToolCallIdentity,
    pub source: SourceFidelity,
    pub command: String,
    pub tool_name: String,
    pub captured: CapturedOutcome,
    pub parsed: ParsedEvidence,
    pub replayed: ReplayedDecision,
    pub family: CommandFamilyKey,
    #[ts(type = "unknown")]
    pub original_entry: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CorpusQuerySummarySnapshot {
    pub total_records: u32,
    pub total_unique_commands: u32,
    pub model_review_calls: u32,
    pub model_review_unique_commands: u32,
    pub redacted_calls: u32,
    pub low_fidelity_calls: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayDeltaTransitionCount {
    pub transition: String,
    pub calls: u32,
    pub unique_commands: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayDeltaImprovement {
    pub review_to_allow_calls: u32,
    pub review_to_allow_unique_commands: u32,
    #[ts(type = "number | null")]
    pub review_reduction_percent: Option<f64>,
    pub remaining_review_calls: u32,
    pub unchanged_review_calls: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayDeltaBlockedSummary {
    pub unknown_tool_calls: u32,
    #[ts(type = "number | null")]
    pub unknown_path_calls: Option<u32>,
    pub sealed_floor_block_calls: u32,
    pub active_deny_block_calls: u32,
    pub low_fidelity_calls: u32,
    pub redacted_calls: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayDeltaRegression {
    pub transition: String,
    pub kind: String,
    pub calls: u32,
    pub unique_commands: u32,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayDeltaChangedRecord {
    pub record_id: String,
    pub command: String,
    pub tool_name: String,
    pub family_id: String,
    pub baseline_status: ReplayStatus,
    pub candidate_status: ReplayStatus,
    pub transition: String,
    #[ts(optional)]
    pub baseline_rule_id: Option<String>,
    #[ts(optional)]
    pub candidate_rule_id: Option<String>,
    pub baseline_reason: String,
    pub candidate_reason: String,
    pub fidelity: CorpusFidelity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayDeltaFamily {
    pub family_id: String,
    pub tool_name: String,
    #[ts(optional)]
    pub executable: Option<String>,
    pub calls: u32,
    pub unique_commands: u32,
    pub baseline_status_counts: Vec<CountByLabel>,
    pub candidate_status_counts: Vec<CountByLabel>,
    pub transitions: Vec<ReplayDeltaTransitionCount>,
    pub review_to_allow_calls: u32,
    pub regressions: Vec<ReplayDeltaRegression>,
    pub unchanged_review_calls: u32,
    pub sealed_floor_block_calls: u32,
    pub unknown_tool_calls: u32,
    #[ts(type = "number | null")]
    pub unknown_path_calls: Option<u32>,
    pub sample_record_ids: Vec<String>,
    pub sample_commands: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum ReplayDeltaStatus {
    NotRun,
    Passed,
    Regression,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ReplayDelta {
    pub version: u32,
    pub status: ReplayDeltaStatus,
    #[ts(optional)]
    pub not_run: Option<ProposalNotRunReason>,
    pub baseline: CorpusQuerySummarySnapshot,
    pub candidate: CorpusQuerySummarySnapshot,
    pub changed_calls: u32,
    pub changed_unique_commands: u32,
    pub transitions: Vec<ReplayDeltaTransitionCount>,
    pub improvement: ReplayDeltaImprovement,
    pub blocked: ReplayDeltaBlockedSummary,
    pub regressions: Vec<ReplayDeltaRegression>,
    pub changed_families: Vec<ReplayDeltaFamily>,
    pub changed_records: Vec<ReplayDeltaChangedRecord>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct ProposalNotRunReason {
    pub code: String,
    pub message: String,
    pub severity: ProposalNotRunSeverity,
    #[ts(type = "unknown")]
    #[ts(optional)]
    pub details: Option<JsonValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum ProposalNotRunSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct AdversarialCase {
    pub id: String,
    pub command: String,
    pub category: AdversarialCaseCategory,
    pub expectation: AdversarialCaseExpectation,
    pub rationale: String,
    pub source: AdversarialCaseSource,
    #[ts(optional)]
    pub derived_from: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum AdversarialCaseCategory {
    PathScope,
    Quoting,
    Substitution,
    Redirect,
    Operator,
    Pipeline,
    CwdPrefix,
    ProgramSpecific,
    ParserFootgun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum AdversarialCaseExpectation {
    NotFastPath,
    HardBlock,
    Review,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum AdversarialCaseSource {
    Template,
    SampleMutation,
    ProgramCatalog,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct AdversarialCaseResult {
    pub case_id: String,
    pub command: String,
    pub category: AdversarialCaseCategory,
    pub expectation: AdversarialCaseExpectation,
    pub outcome: AdversarialCaseResultOutcome,
    #[ts(optional)]
    pub actual_status: Option<ReplayStatus>,
    #[ts(optional)]
    pub actual_rule_id: Option<String>,
    #[ts(optional)]
    pub actual_reason: Option<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum AdversarialCaseResultOutcome {
    Passed,
    Failed,
    Skipped,
    Errored,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct AdversarialValidationReport {
    pub version: u32,
    pub proposal_id: String,
    pub status: AdversarialValidationStatus,
    #[ts(optional)]
    pub not_run: Option<ProposalNotRunReason>,
    pub generated_case_count: u32,
    pub evaluated_case_count: u32,
    pub failed_case_count: u32,
    pub skipped_case_count: u32,
    pub cases: Vec<AdversarialCase>,
    pub results: Vec<AdversarialCaseResult>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(rename_all = "kebab-case")]
#[serde(rename_all = "kebab-case")]
pub enum AdversarialValidationStatus {
    NotRun,
    Passed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CorpusQuerySummary {
    pub total_records: u32,
    pub total_unique_commands: u32,
    pub replay_status_counts: Vec<CountByLabel>,
    pub captured_outcome_counts: Vec<CountByLabel>,
    pub source_counts: Vec<CountByLabel>,
    pub model_review_calls: u32,
    pub model_review_unique_commands: u32,
    pub low_fidelity_calls: u32,
    pub redacted_calls: u32,
    pub unmatched_audit_entries: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CommandFamilySummary {
    pub family: CommandFamilyKey,
    pub calls: u32,
    pub unique_commands: u32,
    pub replay_status_counts: Vec<CountByLabel>,
    pub captured_outcome_counts: Vec<CountByLabel>,
    pub model_review_calls: u32,
    pub captured_denial_calls: u32,
    pub low_fidelity_calls: u32,
    pub redacted_calls: u32,
    pub sources: Vec<CorpusSource>,
    pub sample_record_ids: Vec<String>,
    pub sample_commands: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct CorpusQueryModel {
    pub records: Vec<CorpusRecord>,
    pub families: Vec<CommandFamilySummary>,
    pub summary: CorpusQuerySummary,
    pub warnings: Vec<String>,
}
