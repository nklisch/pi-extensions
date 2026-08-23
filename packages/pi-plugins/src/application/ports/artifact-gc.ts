export type ArtifactGcKind = "staging" | "marketplace" | "revision" | "projection";
export type ArtifactGcCandidate = Readonly<{ kind: ArtifactGcKind; path: string; key: string; mtimeMs: number }>;
export type ArtifactGcReport = Readonly<{ removed: number; retained: number; deferred: boolean; incompleteEvidence: boolean }>;
export type ArtifactGc = Readonly<{ sweep(input: Readonly<{ referenced: ReadonlySet<string>; retainKinds?: readonly ArtifactGcKind[]; signal: AbortSignal; now?: number }>): Promise<ArtifactGcReport> }>;
