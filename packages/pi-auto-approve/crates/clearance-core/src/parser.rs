//! Native bash parser and shape projection.
//!
//! The projection intentionally mirrors the old TypeScript shape contract instead of
//! exposing tree-sitter nodes. This keeps grammar details behind the core boundary and
//! makes every uncertainty visible as a diagnostic on the returned shape.

use crate::contracts::*;
use std::collections::HashSet;
use tree_sitter::{Node, Parser};

const ARGUMENT_NODES: &[&str] = &[
    "word",
    "string",
    "raw_string",
    "translated_string",
    "ansi_c_string",
    "number",
    "concatenation",
    "command_substitution",
    "process_substitution",
    "arithmetic_expansion",
    "simple_expansion",
    "string_expansion",
    "expansion",
    "brace_expression",
];
const VARIABLE_NODES: &[&str] = &["simple_expansion", "string_expansion", "expansion"];
const DYNAMIC_NODES: &[&str] = &[
    "command_substitution",
    "process_substitution",
    "arithmetic_expansion",
    "simple_expansion",
    "string_expansion",
    "expansion",
    "brace_expression",
];

#[derive(Clone, Copy)]
struct LoopScope<'a> {
    name: &'a str,
}

type ProjectWord = (String, SourceSpan, bool);
type LeadingOptionsResult = (Vec<ProjectWord>, SourceSpan, Vec<String>);
type UnwrapResult = (
    String,
    Vec<ProjectWord>,
    Vec<EnvironmentAssignment>,
    SourceSpan,
);

struct Projector<'a> {
    source: &'a str,
    diagnostics: Vec<ShapeDiagnostic>,
}

impl<'a> Projector<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            diagnostics: Vec::new(),
        }
    }

    fn span(&self, node: Node<'_>) -> SourceSpan {
        SourceSpan {
            start: node.start_byte() as u32,
            end: node.end_byte() as u32,
        }
    }

    fn text(&self, node: Node<'_>) -> &'a str {
        self.source
            .get(node.start_byte()..node.end_byte())
            .unwrap_or("")
    }

    fn children<'b>(&self, node: Node<'b>) -> Vec<Node<'b>> {
        let mut cursor = node.walk();
        node.children(&mut cursor).collect()
    }

    fn named_children<'b>(&self, node: Node<'b>) -> Vec<Node<'b>> {
        let mut cursor = node.walk();
        node.named_children(&mut cursor).collect()
    }

    fn node_has_type(&self, node: Node<'_>, types: &[&str]) -> bool {
        if types.contains(&node.kind()) {
            return true;
        }
        self.named_children(node)
            .into_iter()
            .any(|child| self.node_has_type(child, types))
    }

    fn collect_nodes<'b>(&self, node: Node<'b>, types: &[&str], out: &mut Vec<Node<'b>>) {
        if types.contains(&node.kind()) {
            out.push(node);
        }
        for child in self.named_children(node) {
            self.collect_nodes(child, types, out);
        }
    }

    fn parse_diagnostics(&self, node: Node<'_>, out: &mut Vec<ShapeDiagnostic>) {
        if node.is_missing() {
            out.push(ShapeDiagnostic {
                code: "bash:parse-missing".to_owned(),
                message: format!("missing syntax node near offset {}", node.start_byte()),
                severity: DiagnosticSeverity::Error,
                source: Some(self.span(node)),
            });
        } else if node.is_error() {
            out.push(ShapeDiagnostic {
                code: "bash:parse-error".to_owned(),
                message: format!("parse error near offset {}", node.start_byte()),
                severity: DiagnosticSeverity::Error,
                source: Some(self.span(node)),
            });
        }
        for child in self.children(node) {
            self.parse_diagnostics(child, out);
        }
    }

    fn project_stream(
        &mut self,
        container: Node<'_>,
        scope: Option<LoopScope<'_>>,
    ) -> Vec<BashBlock> {
        let children = self.children(container);
        self.project_stream_from_children(container, &children, scope)
    }

    fn project_stream_from_children(
        &mut self,
        container: Node<'_>,
        children: &[Node<'_>],
        scope: Option<LoopScope<'_>>,
    ) -> Vec<BashBlock> {
        let mut blocks = Vec::new();
        let mut previous: Option<Node<'_>> = None;
        for &child in children {
            if child.kind() == "comment" {
                continue;
            }
            if child.kind() == "list" {
                let nested = self.project_stream(child, scope);
                for block in nested {
                    self.append_block(&mut blocks, block, previous, child);
                }
                previous = Some(child);
                continue;
            }
            if child.kind() == "ERROR" || child.is_missing() {
                continue;
            }
            if self.is_block_node(child.kind()) {
                let block = self.project_block(child, scope);
                self.append_block(&mut blocks, block, previous, child);
                previous = Some(child);
                continue;
            }
            if !child.is_named() {
                self.apply_operator(&mut blocks, child);
            }
        }
        // `list` nodes hide newlines from the grammar. A separator newline is a
        // sequential list operator, but only when the preceding block has no
        // explicit operator already.
        if blocks.len() > 1 {
            for i in 1..blocks.len() {
                if blocks[i - 1].operator.is_none() {
                    let left = blocks[i - 1].span.end as usize;
                    let right = blocks[i].span.start as usize;
                    if self.source.get(left..right).unwrap_or("").contains('\n') {
                        blocks[i - 1].operator = Some(BashListOperator::Seq);
                    }
                }
            }
        }
        let _ = container;
        blocks
    }

    fn append_block(
        &mut self,
        blocks: &mut Vec<BashBlock>,
        block: BashBlock,
        _previous: Option<Node<'_>>,
        _current: Node<'_>,
    ) {
        blocks.push(block);
    }

    fn apply_operator(&mut self, blocks: &mut [BashBlock], token: Node<'_>) {
        let Some(last) = blocks.last_mut() else {
            return;
        };
        match token.kind() {
            "&&" => last.operator = Some(BashListOperator::And),
            "||" => last.operator = Some(BashListOperator::Or),
            ";" => last.operator = Some(BashListOperator::Seq),
            "&" => {
                last.background = Some(true);
                self.diagnostics.push(ShapeDiagnostic {
                    code: "bash:background-operator".to_owned(),
                    message: "Background execution is recognized but requires review".to_owned(),
                    severity: DiagnosticSeverity::Warning,
                    source: Some(self.span(token)),
                });
            }
            _ => {}
        }
    }

    fn project_block(&mut self, node: Node<'_>, scope: Option<LoopScope<'_>>) -> BashBlock {
        let pipeline = self.project_pipeline(node, scope);
        BashBlock {
            pipeline,
            operator: None,
            background: None,
            span: self.span(node),
        }
    }

    fn project_pipeline(&mut self, node: Node<'_>, scope: Option<LoopScope<'_>>) -> BashPipeline {
        let stage_nodes: Vec<Node<'_>> = if node.kind() == "pipeline" {
            self.named_children(node)
                .into_iter()
                .filter(|n| self.is_stage_node(n.kind()))
                .collect()
        } else {
            vec![node]
        };
        let stages: Vec<BashStage> = stage_nodes
            .into_iter()
            .map(|n| self.project_stage(n, scope))
            .collect();
        let pipe_targets = stages
            .iter()
            .skip(1)
            .map(|stage| match stage {
                BashStage::Command { program, .. } if program.resolvable => program.program.clone(),
                _ => String::new(),
            })
            .collect();
        BashPipeline {
            stages,
            pipe_targets,
            span: self.span(node),
        }
    }

    fn project_stage(&mut self, node: Node<'_>, scope: Option<LoopScope<'_>>) -> BashStage {
        match node.kind() {
            "command" => self.project_command(node, scope),
            "declaration_command" => self.project_declaration(node),
            "test_command" => self.project_test(node),
            "redirected_statement" => self.project_redirected(node, scope),
            "for_statement" => {
                if self
                    .children(node)
                    .into_iter()
                    .find(|child| child.kind() != "comment")
                    .map(|child| child.kind())
                    == Some("select")
                {
                    self.compound_feature("select", node);
                    BashStage::ControlFlow {
                        construct: BashControlConstruct::Select,
                        span: self.span(node),
                    }
                } else {
                    self.project_for(node)
                }
            }
            "c_style_for_statement" => {
                self.compound_feature("for-arithmetic", node);
                BashStage::ControlFlow {
                    construct: BashControlConstruct::For,
                    span: self.span(node),
                }
            }
            "compound_statement" => self.project_brace(node, scope),
            "if_statement" => self.project_if(node, scope),
            "case_statement" => {
                self.compound_feature("case", node);
                BashStage::ControlFlow {
                    construct: BashControlConstruct::Case,
                    span: self.span(node),
                }
            }
            "while_statement" => {
                let construct = if self
                    .children(node)
                    .into_iter()
                    .find(|child| child.kind() != "comment")
                    .map(|child| child.kind())
                    == Some("until")
                {
                    self.compound_feature("until", node);
                    BashControlConstruct::Until
                } else {
                    self.compound_feature("while", node);
                    BashControlConstruct::While
                };
                BashStage::ControlFlow {
                    construct,
                    span: self.span(node),
                }
            }
            "until_statement" => {
                self.compound_feature("until", node);
                BashStage::ControlFlow {
                    construct: BashControlConstruct::Until,
                    span: self.span(node),
                }
            }
            "select_statement" => {
                self.compound_feature("select", node);
                BashStage::ControlFlow {
                    construct: BashControlConstruct::Select,
                    span: self.span(node),
                }
            }
            "subshell" => {
                self.diagnostics.push(ShapeDiagnostic {
                    code: "bash:subshell-unsupported".to_owned(),
                    message: "Subshells are recognized but not modeled and require review"
                        .to_owned(),
                    severity: DiagnosticSeverity::Warning,
                    source: Some(self.span(node)),
                });
                BashStage::Subshell {
                    span: self.span(node),
                }
            }
            "function_definition" => {
                self.unsupported(
                    node,
                    "function_definition is recognized but not modeled and requires review",
                );
                BashStage::ControlFlow {
                    construct: BashControlConstruct::Function,
                    span: self.span(node),
                }
            }
            _ => {
                self.unsupported(node, &format!("Unsupported bash stage: {}", node.kind()));
                BashStage::Unsupported {
                    reason: node.kind().to_owned(),
                    span: self.span(node),
                }
            }
        }
    }

    fn project_command(&mut self, node: Node<'_>, scope: Option<LoopScope<'_>>) -> BashStage {
        let mut env = Vec::new();
        let mut args = Vec::new();
        let mut flags = Vec::new();
        let mut substitutions = Vec::new();
        let mut variable_refs = Vec::new();
        let mut words = Vec::new();
        let mut command_name = None;
        let mut ended = false;

        for child in self.named_children(node) {
            match child.kind() {
                "comment" => {}
                "variable_assignment" => {
                    env.push(self.environment_assignment(child));
                    self.collect_substitutions(child, &mut substitutions);
                }
                "command_name" => {
                    command_name = Some(child);
                    words.push((
                        self.text(child).to_owned(),
                        self.span(child),
                        !self.node_has_type(child, DYNAMIC_NODES),
                    ));
                }
                kind if self.is_redirect_node(kind) => {
                    let redirect = self.project_redirect(child);
                    self.collect_substitutions(child, &mut substitutions);
                    // Redirects are collected below from the same ordered children.
                    let _ = redirect;
                }
                kind if ARGUMENT_NODES.contains(&kind) => {
                    self.collect_substitutions(child, &mut substitutions);
                    if let Some(reference) = self.loop_reference(child, scope) {
                        variable_refs.push(reference);
                    } else {
                        self.variable_expansion_diagnostics(child);
                    }
                    let raw = self.text(child).to_owned();
                    if raw == "--" {
                        ended = true;
                    } else if ended {
                        args.push(raw.clone());
                    } else {
                        classify_argument(&raw, self.span(child), &mut args, &mut flags);
                    }
                    words.push((
                        raw,
                        self.span(child),
                        !self.node_has_type(child, DYNAMIC_NODES),
                    ));
                }
                _ => self.unsupported(
                    child,
                    &format!("Unsupported command child: {}", child.kind()),
                ),
            }
        }
        let mut redirects = Vec::new();
        for redirect_node in self.named_children(node) {
            if self.is_redirect_node(redirect_node.kind()) {
                redirects.push(self.project_redirect(redirect_node));
            }
        }
        if let Some(name) = command_name {
            self.collect_substitutions(name, &mut substitutions);
        }
        dedupe_substitutions(&mut substitutions);
        let (program, resolvable) = match command_name {
            Some(name) if !self.node_has_type(name, DYNAMIC_NODES) => {
                (self.text(name).to_owned(), true)
            }
            Some(name) => {
                self.diagnostics.push(ShapeDiagnostic {
                    code: "bash:unresolvable-program".to_owned(),
                    message:
                        "Command program contains dynamic expansion and cannot be matched safely"
                            .to_owned(),
                    severity: DiagnosticSeverity::Warning,
                    source: Some(self.span(name)),
                });
                (String::new(), false)
            }
            None => (String::new(), false),
        };
        let program_span = command_name
            .map(|n| self.span(n))
            .unwrap_or(SourceSpan { start: 0, end: 0 });
        let stage = BashStage::Command {
            program: BashStageProgram {
                program,
                resolvable,
                arguments: args,
                flags,
                environment: env,
                variable_references: Some(variable_refs),
                span: program_span,
            },
            substitutions,
            redirects,
            span: self.span(node),
        };
        self.unwrap_stage(stage, words)
    }

    fn project_declaration(&mut self, node: Node<'_>) -> BashStage {
        let mut env = Vec::new();
        let mut args = Vec::new();
        let mut flags = Vec::new();
        let mut substitutions = Vec::new();
        let mut ended = false;
        let command_span = self
            .children(node)
            .into_iter()
            .find(|n| n.kind() == "export")
            .map(|n| self.span(n))
            .unwrap_or(self.span(node));
        for child in self.named_children(node) {
            match child.kind() {
                "variable_assignment" => {
                    env.push(self.environment_assignment(child));
                    self.collect_substitutions(child, &mut substitutions);
                    self.variable_expansion_diagnostics(child);
                }
                "variable_name" => env.push(EnvironmentAssignment {
                    name: self.text(child).to_owned(),
                    value: String::new(),
                    span: self.span(child),
                }),
                kind if ARGUMENT_NODES.contains(&kind) => {
                    self.collect_substitutions(child, &mut substitutions);
                    self.variable_expansion_diagnostics(child);
                    let raw = self.text(child).to_owned();
                    if raw == "--" {
                        ended = true;
                    } else if ended {
                        args.push(raw);
                    } else {
                        classify_argument(&raw, self.span(child), &mut args, &mut flags);
                    }
                }
                _ => self.unsupported(
                    child,
                    &format!("Unsupported declaration child: {}", child.kind()),
                ),
            }
        }
        dedupe_substitutions(&mut substitutions);
        BashStage::Command {
            program: BashStageProgram {
                program: "export".to_owned(),
                resolvable: true,
                arguments: args,
                flags,
                environment: env,
                variable_references: Some(Vec::new()),
                span: command_span,
            },
            substitutions,
            redirects: Vec::new(),
            span: self.span(node),
        }
    }

    fn project_test(&mut self, node: Node<'_>) -> BashStage {
        let opening = self
            .children(node)
            .into_iter()
            .find(|n| n.kind() == "[" || n.kind() == "[[");
        let mut substitutions = Vec::new();
        for child in self.named_children(node) {
            self.collect_substitutions(child, &mut substitutions);
            self.variable_expansion_diagnostics(child);
        }
        dedupe_substitutions(&mut substitutions);
        BashStage::Command {
            program: BashStageProgram {
                program: if opening.map(|n| n.kind() == "[[").unwrap_or(false) {
                    "[["
                } else {
                    "["
                }
                .to_owned(),
                resolvable: true,
                arguments: Vec::new(),
                flags: Vec::new(),
                environment: Vec::new(),
                variable_references: Some(Vec::new()),
                span: opening.map(|n| self.span(n)).unwrap_or(self.span(node)),
            },
            substitutions,
            redirects: Vec::new(),
            span: self.span(node),
        }
    }

    fn project_redirected(&mut self, node: Node<'_>, scope: Option<LoopScope<'_>>) -> BashStage {
        let base = self
            .named_children(node)
            .into_iter()
            .find(|n| !self.is_redirect_node(n.kind()));
        let mut redirects = Vec::new();
        for redirect_node in self.named_children(node) {
            if self.is_redirect_node(redirect_node.kind()) {
                redirects.push(self.project_redirect(redirect_node));
            }
        }
        let mut stage = match base {
            Some(n) => self.project_stage(n, scope),
            None => {
                self.unsupported(node, "Redirected statement has no base command");
                BashStage::Unsupported {
                    reason: "redirected_statement".to_owned(),
                    span: self.span(node),
                }
            }
        };
        match &mut stage {
            BashStage::Command {
                redirects: existing,
                substitutions,
                ..
            } => {
                for redirect_node in self
                    .named_children(node)
                    .into_iter()
                    .filter(|n| self.is_redirect_node(n.kind()))
                {
                    self.collect_substitutions(redirect_node, substitutions);
                }
                existing.extend(redirects);
                // The outer redirected statement owns the full span.
                if let BashStage::Command { span, .. } = &mut stage {
                    *span = self.span(node);
                }
            }
            BashStage::BraceGroup {
                redirects: existing,
                span,
                ..
            } => {
                existing.extend(redirects);
                *span = self.span(node);
            }
            _ => self.unsupported(
                node,
                "Redirects on non-command stages are not modeled and require review",
            ),
        }
        stage
    }

    fn project_for(&mut self, node: Node<'_>) -> BashStage {
        let variable = node.child_by_field_name("variable");
        let body = node.child_by_field_name("body");
        let (Some(variable), Some(body)) = (variable, body) else {
            self.compound_feature("for-arithmetic", node);
            return BashStage::ControlFlow {
                construct: BashControlConstruct::For,
                span: self.span(node),
            };
        };
        let iterator_nodes: Vec<Node<'_>> = self
            .named_children(node)
            .into_iter()
            .filter(|n| {
                n.start_byte() >= variable.end_byte()
                    && n.end_byte() <= body.start_byte()
                    && !self.is_block_node(n.kind())
            })
            .collect();
        let mut iterator_groups: Vec<(String, SourceSpan, Node<'_>)> = Vec::new();
        for iter in iterator_nodes {
            let current_span = self.span(iter);
            if let Some((raw, span, _)) = iterator_groups.last_mut() {
                let gap = self
                    .source
                    .get(span.end as usize..current_span.start as usize)
                    .unwrap_or("");
                if !gap.chars().any(char::is_whitespace) {
                    raw.push_str(self.text(iter));
                    span.end = current_span.end;
                    continue;
                }
            }
            iterator_groups.push((self.text(iter).to_owned(), current_span, iter));
        }
        let mut entries = Vec::new();
        let mut unsupported = None;
        for (raw, iter_span, iter_node) in iterator_groups {
            if let Some(reason) = iterator_reason(&raw, &iter_node, self) {
                unsupported = Some((reason, iter_span));
                continue;
            }
            let decoded = decode_literal(&raw);
            entries.push(BashIteratorEntry {
                kind: if decoded.glob {
                    BashIteratorEntryKind::LiteralGlob
                } else {
                    BashIteratorEntryKind::LiteralWord
                },
                raw,
                literal: decoded.literal,
                quote: decoded.quote,
                span: iter_span,
            });
        }
        if entries.is_empty() && unsupported.is_none() {
            unsupported = Some((CompoundIteratorReason::Parameter, self.span(variable)));
        }
        if let Some((reason, span)) = unsupported {
            self.compound_iterator(reason, span);
            return BashStage::ControlFlow {
                construct: BashControlConstruct::For,
                span: self.span(node),
            };
        }
        let scope = LoopScope {
            name: self.text(variable),
        };
        let body_block = self.project_compound_body(body, Some(scope));
        if let Some((reason, span)) = compound_body_unsupported(&body_block) {
            self.compound_body(reason, span);
            return BashStage::ControlFlow {
                construct: BashControlConstruct::For,
                span: self.span(node),
            };
        }
        BashStage::ForLoop {
            variable: self.text(variable).to_owned(),
            variable_span: self.span(variable),
            iterator: entries,
            body: body_block,
            keyword_spans: self.for_keyword_spans(node, body),
            span: self.span(node),
        }
    }

    fn project_brace(&mut self, node: Node<'_>, scope: Option<LoopScope<'_>>) -> BashStage {
        let children = self.children(node);
        let open = children.iter().position(|n| n.kind() == "{");
        let close = children.iter().rposition(|n| n.kind() == "}");
        let start = open.map(|i| i + 1).unwrap_or(0);
        let end = close.unwrap_or(children.len());
        let body =
            self.project_compound_body_from_children(&children[start..end], self.span(node), scope);
        if let Some((reason, span)) = compound_body_unsupported(&body) {
            self.compound_body(reason, span);
            return BashStage::ControlFlow {
                construct: BashControlConstruct::BraceGroup,
                span: self.span(node),
            };
        }
        BashStage::BraceGroup {
            body,
            redirects: Vec::new(),
            span: self.span(node),
        }
    }

    fn project_if(&mut self, node: Node<'_>, scope: Option<LoopScope<'_>>) -> BashStage {
        let children = self.children(node);
        let then_index = children.iter().position(|n| n.kind() == "then");
        let Some(then_index) = then_index else {
            self.compound_body(CompoundBodyReason::UnsupportedStage, self.span(node));
            return BashStage::ControlFlow {
                construct: BashControlConstruct::If,
                span: self.span(node),
            };
        };
        let if_index = children.iter().position(|n| n.kind() == "if").unwrap_or(0);
        let condition_nodes: Vec<Node<'_>> = children[if_index + 1..then_index]
            .iter()
            .copied()
            .filter(|n| n.is_named() && n.kind() != "comment")
            .collect();
        if condition_nodes.len() != 1 {
            self.compound_body(CompoundBodyReason::UnsupportedStage, self.span(node));
            return BashStage::ControlFlow {
                construct: BashControlConstruct::If,
                span: self.span(node),
            };
        }
        let test = self.project_pipeline(condition_nodes[0], scope);
        if test.stages.iter().any(
            |s| !matches!(s, BashStage::Command { substitutions, .. } if substitutions.is_empty()),
        ) {
            self.compound_body(CompoundBodyReason::UnsupportedStage, self.span(node));
            return BashStage::ControlFlow {
                construct: BashControlConstruct::If,
                span: self.span(node),
            };
        }
        let body_end = children
            .iter()
            .enumerate()
            .skip(then_index + 1)
            .find(|(_, n)| {
                n.kind() == "elif_clause" || n.kind() == "else_clause" || n.kind() == "fi"
            })
            .map(|(i, _)| i)
            .unwrap_or(children.len());
        let body = self.project_compound_body_from_children(
            &children[then_index + 1..body_end],
            self.span(node),
            scope,
        );
        if let Some((reason, span)) = compound_body_unsupported(&body) {
            self.compound_body(reason, span);
            return BashStage::ControlFlow {
                construct: BashControlConstruct::If,
                span: self.span(node),
            };
        }
        let mut arms = vec![BashConditionalArm {
            test,
            body,
            if_or_else_span: children.get(if_index).map(|n| self.span(*n)),
            then_span: children.get(then_index).map(|n| self.span(*n)),
        }];
        let mut else_body = None;
        let mut else_span = None;
        for (i, child) in children.iter().enumerate() {
            if child.kind() == "elif_clause" {
                if let Some(arm) = self.project_elif(*child, scope) {
                    arms.push(arm);
                }
            }
            if child.kind() == "else_clause" {
                let ec = self.children(*child);
                let ei = ec.iter().position(|n| n.kind() == "else").unwrap_or(0);
                else_span = ec.get(ei).map(|n| self.span(*n));
                let eb = self.project_compound_body_from_children(
                    &ec[ei + 1..],
                    self.span(*child),
                    scope,
                );
                if let Some((reason, span)) = compound_body_unsupported(&eb) {
                    self.compound_body(reason, span);
                    return BashStage::ControlFlow {
                        construct: BashControlConstruct::If,
                        span: self.span(node),
                    };
                }
                else_body = Some(eb);
            }
            let _ = i;
        }
        BashStage::Conditional {
            arms,
            else_body,
            else_span,
            span: self.span(node),
        }
    }

    fn project_elif(
        &mut self,
        node: Node<'_>,
        scope: Option<LoopScope<'_>>,
    ) -> Option<BashConditionalArm> {
        let children = self.children(node);
        let then_i = children.iter().position(|n| n.kind() == "then")?;
        let kw = children
            .iter()
            .position(|n| n.kind() == "elif")
            .unwrap_or(0);
        let cond: Vec<Node<'_>> = children[kw + 1..then_i]
            .iter()
            .copied()
            .filter(|n| n.is_named() && n.kind() != "comment")
            .collect();
        if cond.len() != 1 {
            return None;
        }
        let end = children.len();
        let body = self.project_compound_body_from_children(
            &children[then_i + 1..end],
            self.span(node),
            scope,
        );
        Some(BashConditionalArm {
            test: self.project_pipeline(cond[0], scope),
            body,
            if_or_else_span: children.get(kw).map(|n| self.span(*n)),
            then_span: children.get(then_i).map(|n| self.span(*n)),
        })
    }

    fn project_compound_body(&mut self, node: Node<'_>, scope: Option<LoopScope<'_>>) -> BashBlock {
        self.project_compound_body_from_children(&self.children(node), self.span(node), scope)
    }

    fn project_compound_body_from_children(
        &mut self,
        children: &[Node<'_>],
        fallback: SourceSpan,
        scope: Option<LoopScope<'_>>,
    ) -> BashBlock {
        let blocks = self.project_stream_from_children_dummy(children, scope);
        let stages = blocks
            .iter()
            .flat_map(|b| b.pipeline.stages.clone())
            .collect();
        let span = span_from_children(children, fallback);
        BashBlock {
            pipeline: BashPipeline {
                stages,
                pipe_targets: Vec::new(),
                span,
            },
            operator: None,
            background: None,
            span,
        }
    }

    fn project_stream_from_children_dummy(
        &mut self,
        children: &[Node<'_>],
        scope: Option<LoopScope<'_>>,
    ) -> Vec<BashBlock> {
        // Compound bodies need their own source child list but no synthetic AST container.
        let mut blocks = Vec::new();
        let mut previous: Option<Node<'_>> = None;
        for &child in children {
            if child.kind() == "comment" {
                continue;
            }
            if child.kind() == "list" {
                for b in self.project_stream(child, scope) {
                    blocks.push(b);
                }
                previous = Some(child);
                continue;
            }
            if child.kind() == "ERROR" || child.is_missing() {
                continue;
            }
            if self.is_block_node(child.kind()) {
                blocks.push(self.project_block(child, scope));
                previous = Some(child);
            } else if !child.is_named() {
                self.apply_operator(&mut blocks, child);
            }
        }
        for i in 1..blocks.len() {
            if blocks[i - 1].operator.is_none()
                && self
                    .source
                    .get(blocks[i - 1].span.end as usize..blocks[i].span.start as usize)
                    .unwrap_or("")
                    .contains('\n')
            {
                blocks[i - 1].operator = Some(BashListOperator::Seq);
            }
        }
        let _ = previous;
        blocks
    }

    fn for_keyword_spans(&self, node: Node<'_>, body: Node<'_>) -> BashForLoopKeywordSpans {
        let token = |n: Node<'_>, kind: &str| {
            self.children(n)
                .into_iter()
                .find(|c| c.kind() == kind)
                .map(|c| self.span(c))
        };
        BashForLoopKeywordSpans {
            r#for: token(node, "for"),
            r#in: token(node, "in"),
            r#do: token(body, "do"),
            done: token(body, "done"),
        }
    }

    fn project_redirect(&mut self, node: Node<'_>) -> Redirect {
        let span = self.span(node);
        let kind = node.kind();
        if kind == "heredoc_redirect" {
            self.diagnostics.push(ShapeDiagnostic {
                code: "bash:heredoc-presence".to_owned(),
                message: "Heredoc body content is not modeled and requires review".to_owned(),
                severity: DiagnosticSeverity::Warning,
                source: Some(span),
            });
            return Redirect {
                stream: RedirectStream::Stdin,
                target_kind: RedirectTargetKind::Heredoc,
                target: self
                    .named_children(node)
                    .into_iter()
                    .find(|n| n.kind() == "heredoc_start")
                    .map(|n| self.text(n).to_owned())
                    .unwrap_or_default(),
                append: false,
                span,
            };
        }
        let children = self.children(node);
        let operator = children
            .iter()
            .find(|n| !n.is_named() && n.kind() != "=")
            .map(|n| n.kind())
            .unwrap_or("");
        let descriptor = self
            .named_children(node)
            .into_iter()
            .find(|n| n.kind() == "file_descriptor")
            .map(|n| self.text(n));
        let target = self.named_children(node).into_iter().rfind(|n| {
            n.kind() != "file_descriptor" && n.kind() != "heredoc_body" && n.kind() != "heredoc_end"
        });
        let target_text = target.map(|n| self.text(n).to_owned()).unwrap_or_default();
        let target_for_prefix = target_text
            .strip_prefix('"')
            .and_then(|text| text.strip_suffix('"'))
            .unwrap_or(&target_text);
        if let Some(target) = target {
            let mut expansions = Vec::new();
            self.collect_nodes(target, VARIABLE_NODES, &mut expansions);
            for expansion in expansions {
                let allowed_tmpdir = (self.text(expansion) == "$TMPDIR"
                    || self.text(expansion) == "${TMPDIR}")
                    && target_for_prefix.starts_with(&format!("{}/", self.text(expansion)));
                if !allowed_tmpdir {
                    self.diagnostics.push(ShapeDiagnostic {
                        code: "bash:redirect-expansion".to_owned(),
                        message:
                            "Redirect target contains shell variable expansion and requires review"
                                .to_owned(),
                        severity: DiagnosticSeverity::Warning,
                        source: Some(self.span(expansion)),
                    });
                }
            }
        }
        if kind == "herestring_redirect" {
            return Redirect {
                stream: RedirectStream::Stdin,
                target_kind: RedirectTargetKind::Herestring,
                target: target_text,
                append: false,
                span,
            };
        }
        let stream = if operator.starts_with("&>") {
            RedirectStream::Both
        } else if descriptor == Some("2") {
            RedirectStream::Stderr
        } else if descriptor.is_some() && descriptor != Some("1") {
            RedirectStream::Fd
        } else if operator.starts_with('<') {
            RedirectStream::Stdin
        } else {
            RedirectStream::Stdout
        };
        let target_kind =
            if operator.contains('&') && target.map(|n| n.kind() == "number").unwrap_or(false) {
                RedirectTargetKind::Fd
            } else {
                RedirectTargetKind::File
            };
        Redirect {
            stream,
            target_kind,
            target: target_text,
            append: operator.contains(">>"),
            span,
        }
    }

    fn environment_assignment(&self, node: Node<'_>) -> EnvironmentAssignment {
        let text = self.text(node);
        let eq = text.find('=');
        let name = self
            .named_children(node)
            .into_iter()
            .find(|n| n.kind() == "variable_name")
            .map(|n| self.text(n))
            .or_else(|| eq.map(|i| &text[..i]))
            .unwrap_or("");
        let value = eq.map(|i| text[i + 1..].to_owned()).unwrap_or_default();
        EnvironmentAssignment {
            name: name.to_owned(),
            value,
            span: self.span(node),
        }
    }

    fn collect_substitutions(&self, node: Node<'_>, out: &mut Vec<Substitution>) {
        let kind = match node.kind() {
            "command_substitution" => Some(SubstitutionKind::Command),
            "process_substitution" => Some(SubstitutionKind::Process),
            "arithmetic_expansion" => Some(SubstitutionKind::Arithmetic),
            _ => None,
        };
        if let Some(kind) = kind {
            out.push(Substitution {
                kind,
                raw: self.text(node).to_owned(),
                span: self.span(node),
            });
        }
        for child in self.named_children(node) {
            self.collect_substitutions(child, out);
        }
    }

    fn variable_expansion_diagnostics(&mut self, node: Node<'_>) {
        let mut nodes = Vec::new();
        self.collect_nodes(node, VARIABLE_NODES, &mut nodes);
        for n in nodes {
            self.diagnostics.push(ShapeDiagnostic {
                code: "bash:variable-expansion".to_owned(),
                message: "Argument contains shell variable expansion and requires review"
                    .to_owned(),
                severity: DiagnosticSeverity::Warning,
                source: Some(self.span(n)),
            });
        }
    }

    fn loop_reference(
        &self,
        node: Node<'_>,
        scope: Option<LoopScope<'_>>,
    ) -> Option<BashLoopVariableReference> {
        let scope = scope?;
        let mut expansions = Vec::new();
        self.collect_nodes(node, VARIABLE_NODES, &mut expansions);
        if expansions.len() != 1 {
            return None;
        }
        let expansion = expansions[0];
        let name = self
            .named_children(expansion)
            .into_iter()
            .find(|n| n.kind() == "variable_name")
            .map(|n| self.text(n))?;
        if name != scope.name {
            return None;
        }
        let raw = self.text(node);
        let exact = raw == self.text(expansion)
            || ((raw.starts_with('"') || raw.starts_with('\''))
                && raw.len() >= 2
                && raw[1..raw.len() - 1] == *self.text(expansion));
        if !exact {
            return None;
        }
        Some(BashLoopVariableReference {
            name: scope.name.to_owned(),
            raw: raw.to_owned(),
            quote: if raw.starts_with('"') {
                LoopQuoteKind::Double
            } else if raw.starts_with('\'') {
                LoopQuoteKind::Single
            } else {
                LoopQuoteKind::None
            },
            span: if raw == self.text(expansion) {
                self.span(expansion)
            } else {
                self.span(node)
            },
        })
    }

    fn unwrap_stage(
        &mut self,
        stage: BashStage,
        mut words: Vec<(String, SourceSpan, bool)>,
    ) -> BashStage {
        let BashStage::Command { .. } = stage else {
            return stage;
        };
        let mut current = stage;
        let mut env = match &current {
            BashStage::Command { program, .. } => program.environment.clone(),
            _ => Vec::new(),
        };
        for _ in 0..8 {
            if words.first().map(|w| !w.2).unwrap_or(true) {
                break;
            }
            if let Some((new_words, span, consumed)) = leading_options(&current, &words) {
                current = self.reproject(&current, &new_words, env.clone());
                words = new_words;
                self.diagnostics.push(ShapeDiagnostic {
                    code: "bash:leading-options-stripped".to_owned(),
                    message: format!(
                        "Stripped leading option(s) {} before classifying {}",
                        consumed.join(", "),
                        words[0].0
                    ),
                    severity: DiagnosticSeverity::Info,
                    source: Some(span),
                });
                continue;
            }
            if let Some(diagnostic) = unmodeled_leading_option(&current, &words) {
                self.diagnostics.push(diagnostic);
            }
            let Some((kind, inner, new_env, span)) = unwrap_one(&words, &env) else {
                break;
            };
            if inner.is_empty() || !inner[0].2 {
                break;
            }
            current = self.reproject(&current, &inner, new_env.clone());
            words = inner;
            env = new_env;
            self.diagnostics.push(ShapeDiagnostic {
                code: "bash:stage-unwrapped".to_owned(),
                message: format!(
                    "Unwrapped {kind} command wrapper before classifying the inner command"
                ),
                severity: DiagnosticSeverity::Info,
                source: Some(span),
            });
        }
        current
    }

    fn reproject(
        &self,
        stage: &BashStage,
        words: &[(String, SourceSpan, bool)],
        env: Vec<EnvironmentAssignment>,
    ) -> BashStage {
        let Some((command, command_span, resolvable)) = words.first() else {
            return stage.clone();
        };
        let mut args = Vec::new();
        let mut flags = Vec::new();
        for (raw, span, _) in words.iter().skip(1) {
            classify_argument(raw, *span, &mut args, &mut flags);
        }
        match stage {
            BashStage::Command {
                substitutions,
                redirects,
                span,
                ..
            } => BashStage::Command {
                program: BashStageProgram {
                    program: command.clone(),
                    resolvable: *resolvable,
                    arguments: args,
                    flags,
                    environment: env,
                    variable_references: Some(Vec::new()),
                    span: *command_span,
                },
                substitutions: substitutions.clone(),
                redirects: redirects.clone(),
                span: *span,
            },
            _ => stage.clone(),
        }
    }

    fn is_redirect_node(&self, kind: &str) -> bool {
        matches!(
            kind,
            "file_redirect" | "herestring_redirect" | "heredoc_redirect"
        )
    }
    fn is_block_node(&self, kind: &str) -> bool {
        matches!(
            kind,
            "pipeline"
                | "command"
                | "declaration_command"
                | "test_command"
                | "redirected_statement"
                | "subshell"
                | "for_statement"
                | "c_style_for_statement"
                | "compound_statement"
                | "if_statement"
                | "case_statement"
                | "while_statement"
                | "until_statement"
                | "select_statement"
                | "function_definition"
        )
    }
    fn is_stage_node(&self, kind: &str) -> bool {
        self.is_block_node(kind) && kind != "pipeline"
    }
    fn unsupported(&mut self, node: Node<'_>, message: &str) {
        self.diagnostics.push(ShapeDiagnostic {
            code: "bash:unmodeled-construct".to_owned(),
            message: message.to_owned(),
            severity: DiagnosticSeverity::Warning,
            source: Some(self.span(node)),
        });
    }
    fn compound_feature(&mut self, reason: &str, node: Node<'_>) {
        self.diagnostics.push(ShapeDiagnostic {
            code: "bash:compound-feature-unsupported".to_owned(),
            message: format!("Compound feature: {reason} — not modeled, requires review"),
            severity: DiagnosticSeverity::Warning,
            source: Some(self.span(node)),
        });
    }
    fn compound_iterator(&mut self, reason: CompoundIteratorReason, span: SourceSpan) {
        self.diagnostics.push(ShapeDiagnostic {
            code: "bash:compound-iterator-unsupported".to_owned(),
            message: format!(
                "Compound iterator: {} — not modeled, requires review",
                serde_json::to_value(reason)
                    .unwrap()
                    .as_str()
                    .unwrap_or("mixed")
            ),
            severity: DiagnosticSeverity::Warning,
            source: Some(span),
        });
    }
    fn compound_body(&mut self, reason: CompoundBodyReason, span: SourceSpan) {
        self.diagnostics.push(ShapeDiagnostic {
            code: "bash:compound-body-unsupported".to_owned(),
            message: format!(
                "Compound body: {} — not modeled, requires review",
                serde_json::to_value(reason)
                    .unwrap()
                    .as_str()
                    .unwrap_or("unsupported-stage")
            ),
            severity: DiagnosticSeverity::Warning,
            source: Some(span),
        });
    }
}

pub fn parse_bash(command: &str) -> BashCommandShape {
    let mut parser = Parser::new();
    let language = tree_sitter_bash::LANGUAGE.into();
    parser
        .set_language(&language)
        .expect("pinned tree-sitter-bash grammar is valid");
    let tree = parser
        .parse(command, None)
        .expect("tree-sitter returned no tree");
    let root = tree.root_node();
    let mut projector = Projector::new(command);
    let mut parse_diagnostics = Vec::new();
    projector.parse_diagnostics(root, &mut parse_diagnostics);
    let blocks = projector.project_stream(root, None);
    let mut diagnostics = parse_diagnostics;
    diagnostics.extend(projector.diagnostics);
    let (cwd_prefix, blocks) = lift_cwd_prefix(command, blocks, &mut diagnostics);
    let stages = blocks
        .iter()
        .flat_map(|b| b.pipeline.stages.clone())
        .collect();
    BashCommandShape {
        kind: "bash".to_owned(),
        raw_command: command.to_owned(),
        cwd_prefix,
        blocks,
        stages,
        diagnostics,
        path_facts: None,
    }
}

fn lift_cwd_prefix(
    _source: &str,
    mut blocks: Vec<BashBlock>,
    diagnostics: &mut Vec<ShapeDiagnostic>,
) -> (Option<String>, Vec<BashBlock>) {
    let Some(first) = blocks.first() else {
        return (None, blocks);
    };
    let Some(BashStage::Command {
        program,
        substitutions,
        redirects,
        ..
    }) = first.pipeline.stages.first()
    else {
        return (None, blocks);
    };
    if program.program != "cd" {
        return (None, blocks);
    }
    let lone = blocks.len() == 1
        && first.pipeline.stages.len() == 1
        && first.operator.is_none()
        && first.background != Some(true);
    if lone {
        return (None, blocks);
    }
    let path = program.arguments.first();
    let can = first.pipeline.stages.len() == 1
        && program.resolvable
        && program.arguments.len() == 1
        && program.flags.is_empty()
        && program.environment.is_empty()
        && substitutions.is_empty()
        && redirects.is_empty()
        && first.operator == Some(BashListOperator::And)
        && first.background != Some(true);
    if can {
        return (path.cloned(), blocks.into_iter().skip(1).collect());
    }
    diagnostics.push(ShapeDiagnostic {
        code: "bash:cwd-prefix-unsupported".to_owned(),
        message: "Leading cd command is not a supported cwd-prefix form and requires review"
            .to_owned(),
        severity: DiagnosticSeverity::Warning,
        source: Some(first.pipeline.stages[0].span()),
    });
    (None, std::mem::take(&mut blocks))
}

fn classify_argument(
    raw: &str,
    span: SourceSpan,
    args: &mut Vec<String>,
    flags: &mut Vec<BashFlag>,
) {
    if raw.starts_with("--") && raw.len() > 2 {
        if let Some(eq) = raw.find('=') {
            flags.push(BashFlag {
                raw: raw.to_owned(),
                name: raw[2..eq].to_owned(),
                short: false,
                value: Some(raw[eq + 1..].to_owned()),
                span,
            });
        } else {
            flags.push(BashFlag {
                raw: raw.to_owned(),
                name: raw[2..].to_owned(),
                short: false,
                value: None,
                span,
            });
        }
    } else if raw.starts_with('-') && raw.len() > 1 {
        flags.push(BashFlag {
            raw: raw.to_owned(),
            name: raw[1..].to_owned(),
            short: true,
            value: None,
            span,
        });
    } else {
        args.push(raw.to_owned());
    }
}
fn dedupe_substitutions(values: &mut Vec<Substitution>) {
    let mut seen = HashSet::new();
    values.retain(|s| seen.insert(format!("{:?}:{}:{}", s.kind, s.span.start, s.span.end)));
}
fn span_from_children(children: &[Node<'_>], fallback: SourceSpan) -> SourceSpan {
    let first = children.iter().find(|n| n.kind() != "comment");
    let last = children.iter().rev().find(|n| n.kind() != "comment");
    match (first, last) {
        (Some(a), Some(b)) => SourceSpan {
            start: a.start_byte() as u32,
            end: b.end_byte() as u32,
        },
        _ => fallback,
    }
}
fn compound_body_unsupported(body: &BashBlock) -> Option<(CompoundBodyReason, SourceSpan)> {
    for stage in &body.pipeline.stages {
        match stage {
            BashStage::Command { redirects, .. }
                if redirects
                    .iter()
                    .any(|r| r.target_kind == RedirectTargetKind::Heredoc) =>
            {
                return Some((CompoundBodyReason::UnsupportedStage, stage.span()))
            }
            BashStage::ControlFlow { construct, span } => {
                return Some((
                    if *construct == BashControlConstruct::Function {
                        CompoundBodyReason::Function
                    } else {
                        CompoundBodyReason::NestedForm
                    },
                    *span,
                ))
            }
            BashStage::ForLoop { span, .. } | BashStage::Conditional { span, .. } => {
                return Some((CompoundBodyReason::NestedForm, *span))
            }
            BashStage::BraceGroup { body, .. } => {
                if let Some(x) = compound_body_unsupported(body) {
                    return Some(x);
                }
            }
            BashStage::Subshell { span } | BashStage::Unsupported { span, .. } => {
                return Some((CompoundBodyReason::UnsupportedStage, *span))
            }
            _ => {}
        }
    }
    None
}
fn iterator_reason<'a>(
    raw: &str,
    node: &Node<'a>,
    p: &Projector<'a>,
) -> Option<CompoundIteratorReason> {
    let mut reasons = Vec::new();
    if p.node_has_type(*node, &["command_substitution", "process_substitution"]) {
        reasons.push(CompoundIteratorReason::Substitution);
    }
    if p.node_has_type(*node, &["arithmetic_expansion"]) {
        reasons.push(CompoundIteratorReason::Arithmetic);
    }
    if unquoted_sequence(raw, "${!") {
        reasons.push(CompoundIteratorReason::Indirect);
    } else if p.node_has_type(*node, VARIABLE_NODES) {
        reasons.push(CompoundIteratorReason::Parameter);
    }
    if unquoted_contains(raw, '{') && (raw.contains(',') || raw.contains("..")) {
        reasons.push(CompoundIteratorReason::Brace);
    }
    if raw.contains("*(")
        || raw.contains("?(")
        || raw.contains("+(")
        || raw.contains("@(")
        || raw.contains("!(")
    {
        reasons.push(CompoundIteratorReason::Extglob);
    }
    reasons.first().map(|_| {
        if reasons.len() > 1 {
            CompoundIteratorReason::Mixed
        } else {
            reasons[0]
        }
    })
}
fn unquoted_sequence(raw: &str, needle: &str) -> bool {
    let mut single = false;
    let mut double = false;
    let chars: Vec<char> = raw.chars().collect();
    for i in 0..chars.len() {
        let c = chars[i];
        if c == '\\' && !single {
            continue;
        }
        if i > 0 && chars[i - 1] == '\\' && !single {
            continue;
        }
        if c == '\'' && !double {
            single = !single;
            continue;
        }
        if c == '"' && !single {
            double = !double;
            continue;
        }
        if !single && raw.get(i..).is_some_and(|tail| tail.starts_with(needle)) {
            return true;
        }
    }
    false
}
fn unquoted_contains(raw: &str, needle: char) -> bool {
    let mut single = false;
    let mut double = false;
    for c in raw.chars() {
        if c == '\'' && !double {
            single = !single;
        } else if c == '"' && !single {
            double = !double;
        } else if c == needle && !single && !double {
            return true;
        }
    }
    false
}
struct Decoded {
    literal: String,
    quote: QuoteKind,
    glob: bool,
}
fn decode_literal(raw: &str) -> Decoded {
    let mut literal = String::new();
    let mut single = false;
    let mut double = false;
    let mut saw_single = false;
    let mut saw_double = false;
    let mut glob = false;
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if single {
            if c == '\'' {
                single = false;
            } else {
                literal.push(c);
            }
        } else if double {
            if c == '"' {
                double = false;
            } else if c == '\\' && i + 1 < chars.len() {
                i += 1;
                literal.push(chars[i]);
            } else {
                literal.push(c);
            }
        } else if c == '\'' {
            single = true;
            saw_single = true;
        } else if c == '"' {
            double = true;
            saw_double = true;
        } else if c == '\\' && i + 1 < chars.len() {
            i += 1;
            literal.push(chars[i]);
        } else {
            if matches!(c, '*' | '?' | '[') {
                glob = true;
            }
            literal.push(c);
        }
        i += 1;
    }
    let quote = if saw_single && saw_double {
        QuoteKind::Mixed
    } else if saw_single {
        QuoteKind::Single
    } else if saw_double {
        QuoteKind::Double
    } else {
        QuoteKind::None
    };
    Decoded {
        literal,
        quote,
        glob,
    }
}

impl BashStage {
    fn span(&self) -> SourceSpan {
        match self {
            BashStage::Command { span, .. }
            | BashStage::Subshell { span }
            | BashStage::ControlFlow { span, .. }
            | BashStage::ForLoop { span, .. }
            | BashStage::BraceGroup { span, .. }
            | BashStage::Conditional { span, .. }
            | BashStage::Unsupported { span, .. } => *span,
        }
    }
}

fn leading_options(stage: &BashStage, words: &[ProjectWord]) -> Option<LeadingOptionsResult> {
    let BashStage::Command { program, .. } = stage else {
        return None;
    };
    let (value_options, equals_options, boolean_options): (&[&str], &[&str], &[&str]) =
        match program.program.as_str() {
            "git" => (
                &["-C", "--git-dir", "--work-tree"],
                &["--git-dir=", "--work-tree="],
                &["--no-pager", "--literal-pathspecs"],
            ),
            "pnpm" => (
                &[
                    "--dir",
                    "-C",
                    "--filter",
                    "-F",
                    "--workspace-concurrency",
                    "--store-dir",
                    "--cache-dir",
                    "--userconfig",
                ],
                &[
                    "--dir=",
                    "--filter=",
                    "--workspace-concurrency=",
                    "--store-dir=",
                    "--cache-dir=",
                    "--userconfig=",
                ],
                &[
                    "-w",
                    "--workspace-root",
                    "-r",
                    "--recursive",
                    "--offline",
                    "--prefer-offline",
                    "--aggregate-output",
                    "--stream",
                ],
            ),
            _ => return None,
        };
    let mut i = 1;
    let mut consumed = Vec::new();
    while i < words.len() {
        let raw = &words[i].0;
        if !raw.starts_with('-') {
            break;
        }
        if raw == "--" {
            consumed.push(raw.clone());
            i += 1;
            break;
        }
        if boolean_options.contains(&raw.as_str()) {
            consumed.push(raw.clone());
            i += 1;
            continue;
        }
        if equals_options.iter().any(|e| raw.starts_with(e)) {
            consumed.push(raw.clone());
            i += 1;
            continue;
        }
        if value_options.contains(&raw.as_str()) {
            if i + 1 >= words.len() || !words[i].2 || !words[i + 1].2 {
                return None;
            }
            consumed.push(raw.clone());
            consumed.push(words[i + 1].0.clone());
            i += 2;
            continue;
        }
        return None;
    }
    if consumed.is_empty() || i >= words.len() || words[i].0.starts_with('-') || !words[i].2 {
        return None;
    }
    let span = SourceSpan {
        start: words[1].1.start,
        end: words[i - 1].1.end,
    };
    Some((
        std::iter::once(words[0].clone())
            .chain(words[i..].iter().cloned())
            .collect(),
        span,
        consumed,
    ))
}

fn unmodeled_leading_option(
    stage: &BashStage,
    words: &[(String, SourceSpan, bool)],
) -> Option<ShapeDiagnostic> {
    let BashStage::Command { program, .. } = stage else {
        return None;
    };
    if !matches!(program.program.as_str(), "git" | "pnpm") {
        return None;
    }
    let value_options: &[&str] = if program.program == "git" {
        &["-C", "--git-dir", "--work-tree"]
    } else {
        &[
            "--dir",
            "-C",
            "--filter",
            "-F",
            "--workspace-concurrency",
            "--store-dir",
            "--cache-dir",
            "--userconfig",
        ]
    };
    let known_options = [
        "--",
        "--no-pager",
        "--literal-pathspecs",
        "-w",
        "--workspace-root",
        "-r",
        "--recursive",
        "--offline",
        "--prefer-offline",
        "--aggregate-output",
        "--stream",
    ];
    let mut index = 1;
    while let Some(option) = words.get(index) {
        if !option.0.starts_with('-') {
            break;
        }
        if known_options.contains(&option.0.as_str()) {
            index += 1;
            continue;
        }
        if option.0.starts_with("--git-dir=")
            || option.0.starts_with("--work-tree=")
            || option.0.starts_with("--dir=")
            || option.0.starts_with("--filter=")
            || option.0.starts_with("--workspace-concurrency=")
            || option.0.starts_with("--store-dir=")
            || option.0.starts_with("--cache-dir=")
            || option.0.starts_with("--userconfig=")
        {
            index += 1;
            continue;
        }
        if value_options.contains(&option.0.as_str()) {
            index += 2;
            continue;
        }
        let has_subcommand = words
            .iter()
            .skip(index + 1)
            .any(|word| !word.0.starts_with('-') && word.2);
        if !has_subcommand {
            return None;
        }
        return Some(ShapeDiagnostic {
            code: "bash:leading-option-unmodeled".to_owned(),
            message: format!(
                "Leading option {} is not modeled for {}; command projection was refused",
                option.0, program.program
            ),
            severity: DiagnosticSeverity::Warning,
            source: Some(option.1),
        });
    }
    None
}

fn unwrap_one(
    words: &[ProjectWord],
    environment: &[EnvironmentAssignment],
) -> Option<UnwrapResult> {
    let first = words.first()?;
    let raw = first.0.as_str();
    let assignment = |word: &(String, SourceSpan, bool)| {
        let eq = word.0.find('=')?;
        if eq == 0
            || !word.0[..eq]
                .chars()
                .all(|c| c == '_' || c.is_ascii_alphanumeric())
        {
            return None;
        }
        Some(EnvironmentAssignment {
            name: word.0[..eq].to_owned(),
            value: word.0[eq + 1..].to_owned(),
            span: word.1,
        })
    };
    if raw == "env" {
        let mut i = 1;
        let mut env = environment.to_vec();
        while i < words.len() {
            if let Some(a) = assignment(&words[i]) {
                env.push(a);
                i += 1;
                continue;
            }
            if ["-i", "--ignore-environment"].contains(&words[i].0.as_str()) {
                i += 1;
                continue;
            }
            if words[i].0 == "-u" || words[i].0 == "--unset" {
                if i + 1 >= words.len() {
                    return None;
                };
                i += 2;
                continue;
            }
            if words[i].0.starts_with("--unset=") {
                i += 1;
                continue;
            }
            if words[i].0 == "--" {
                i += 1;
                break;
            }
            if words[i].0.starts_with('-') {
                return None;
            }
            break;
        }
        if i >= words.len() {
            return None;
        }
        return Some((
            "env".into(),
            words[i..].to_vec(),
            env,
            SourceSpan {
                start: first.1.start,
                end: words[i - 1].1.end,
            },
        ));
    }
    if raw == "timeout" {
        let mut i = 1;
        while i < words.len() {
            let w = &words[i].0;
            if ["-k", "-s", "--kill-after", "--signal"].contains(&w.as_str()) {
                i += 2;
                continue;
            }
            if w.starts_with("--kill-after=")
                || w.starts_with("--signal=")
                || ["--preserve-status", "--foreground", "-v", "--verbose"].contains(&w.as_str())
            {
                i += 1;
                continue;
            }
            break;
        }
        if i >= words.len() || !is_duration(&words[i].0) || i + 1 >= words.len() {
            return None;
        }
        return Some((
            "timeout".into(),
            words[i + 1..].to_vec(),
            environment.to_vec(),
            SourceSpan {
                start: first.1.start,
                end: words[i].1.end,
            },
        ));
    }
    if raw == "rustup"
        && words.get(1).map(|w| w.0.as_str()) == Some("run")
        && words
            .get(2)
            .map(|w| {
                w.0.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            })
            .unwrap_or(false)
        && words.len() > 3
    {
        return Some((
            "rustup run".into(),
            words[3..].to_vec(),
            environment.to_vec(),
            SourceSpan {
                start: first.1.start,
                end: words[2].1.end,
            },
        ));
    }
    if raw == "pnpm" && words.get(1).map(|w| w.0.as_str()) == Some("exec") {
        let mut i = 2;
        if words.get(i).map(|w| w.0.as_str()) == Some("--") {
            i += 1;
        }
        let mut env = environment.to_vec();
        while i < words.len() {
            if let Some(a) = assignment(&words[i]) {
                env.push(a);
                i += 1;
                continue;
            }
            if words[i].0.starts_with('-') {
                return None;
            }
            break;
        }
        if i < words.len() {
            return Some((
                "pnpm exec".into(),
                words[i..].to_vec(),
                env,
                SourceSpan {
                    start: first.1.start,
                    end: words[i - 1].1.end,
                },
            ));
        }
    }
    let project = raw
        .strip_prefix("./")
        .and_then(|s| s.rsplit_once("node_modules/.bin/").map(|(_, b)| b))
        .or_else(|| raw.rsplit_once("node_modules/.bin/").map(|(_, b)| b));
    let system = [
        "/bin/",
        "/sbin/",
        "/usr/bin/",
        "/usr/sbin/",
        "/usr/local/bin/",
    ]
    .iter()
    .find_map(|p| raw.strip_prefix(p));
    if let Some(name) = project
        .or(system)
        .filter(|n| !n.is_empty() && *n != "." && *n != "..")
    {
        let mut inner = words.to_vec();
        inner[0].0 = name.to_owned();
        return Some((
            if project.is_some() {
                "project-bin"
            } else {
                "system-bin"
            }
            .into(),
            inner,
            environment.to_vec(),
            first.1,
        ));
    }
    None
}
fn is_duration(value: &str) -> bool {
    let v = value.trim_matches(['"', '\'']);
    let (digits, unit) = v.split_at(
        v.find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(v.len()),
    );
    !digits.is_empty()
        && digits.chars().filter(|c| *c == '.').count() <= 1
        && digits.parse::<f64>().is_ok()
        && (unit.is_empty() || unit.len() == 1 && "smhd".contains(unit))
}
