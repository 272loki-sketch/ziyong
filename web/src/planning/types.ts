export type OutlineMode = "manual" | "suggest" | "auto";
export type OutlineResearchMode = "off" | "manual" | "auto";
export type OutlineDiscussionFocus = "open" | "next-beat" | "dialogue" | "character" | "diagnose" | "daily";
export type ArcShapeRole = "setup" | "rising" | "hardest" | "climax";
export type OutlinePaceIntent = "seed" | "normal" | "push" | "building" | "climaxing";
export type OutlineVisibility = "public" | "spoiler" | "secret";
export type OutlineRigidity = "hard" | "soft" | "open";
export type ForeshadowingStatus = "conceived" | "prepared" | "planted" | "reinforced" | "activated" | "partially-revealed" | "resolved" | "abandoned" | "invalidated";

export interface OutlineNode {
	id: string;
	title: string;
	summary?: string;
	status?: string;
	rigidity?: OutlineRigidity;
	visibility?: OutlineVisibility;
	actuality?: "plan" | "guidance" | "established";
	beats?: string[];
	question?: string;
	nextPressure?: string;
	criteria?: string[];
	character?: string;
	from?: string;
	toward?: string;
	foreshadowingStatus?: ForeshadowingStatus;
	setup?: string;
	payoff?: string;
	evidenceRefs?: string[];
}

export interface OutlineState {
	version?: 1;
	revision: number;
	parentHash?: string;
	hash: string;
	premise?: string;
	constraints?: OutlineNode[];
	arcs?: OutlineNode[];
	characterArcs?: OutlineNode[];
	threads?: OutlineNode[];
	milestones?: OutlineNode[];
	foreshadowing?: OutlineNode[];
	currentFocus?: string[];
	alignment?: { summary?: string; confidence?: number; conflicts?: string[] };
	// Optional metadata accepted from older history serializers.
	createdAt?: string;
	timestamp?: string;
	summary?: string;
	rationale?: string;
}

export interface OutlineAuditIssue { severity?: "warning" | "error"; code?: string; message?: string; path?: string }
export interface OutlineAudit { version?: 1; verdict?: "approve" | "reject"; summary?: string; issues?: OutlineAuditIssue[] }
export interface OutlineProposal {
	version?: 1;
	id: string;
	mode?: "manual" | "automatic";
	baseRevision: number;
	baseHash: string;
	baseLeafId?: string;
	kind?: "chat" | "bootstrap" | "reconcile" | "foreshadowing";
	rationale?: string;
	patch?: Record<string, unknown>;
	researchInspirationIds?: string[];
	proposalHash?: string;
	createdAt?: string;
}

export interface OutlineProposalEntry {
	version?: 1;
	proposal: OutlineProposal;
	proposalHash?: string;
	audit?: OutlineAudit;
	status: "pending" | "approved" | "committed" | "rejected";
	reason?: string;
	committedRevision?: number;
	committedHash?: string;
	createdAt?: string;
}
export interface OutlinePendingProposal { entryId: string; entry: OutlineProposalEntry }
export interface OutlineProposalView extends OutlineProposal {
	proposalHash: string;
	audit?: OutlineAudit;
	status: OutlineProposalEntry["status"];
	risk?: string;
}

export interface OutlineResearchSource { id: string; title: string; url: string; accessedAt: string }
export type ResearchConfidence = "legacy-claimed" | "system-grounded" | "audited";
export interface OutlineResearchMechanism { id: string; sourceIds: string[]; mechanism: string; appliesWhen: string; failureWarning: string; locator?: string; evidenceSummary?: string; confidence?: ResearchConfidence; enabled?: boolean; usage?: { selected: number; usedByDirector: number; adopted: number; dismissed: number } }
export interface OutlineResearchCard { version: 1; cardKey: string; mechanismIds: string[]; updatedAt: string }
export type CorpusDocStatus = "pending" | "cleaning" | "mapping" | "reducing" | "extracting" | "ready" | "failed" | "paused";
export interface CorpusDocument {
	id: string;
	title: string;
	sourceKind: "upload" | "url";
	originName: string;
	chars: number;
	encoding: string;
	chapterCount: number;
	chunkCount: number;
	status: CorpusDocStatus;
	cardKey: string;
	error?: string;
	synopsisPreview?: string;
	tropeCount?: number;
	dailyPatternCount?: number;
	assetCount?: number;
	createdAt: string;
	updatedAt: string;
	workId?: string;
	parentDocId?: string;
	sourceVersion?: number;
	updateRelation?: "initial" | "append-only" | "independent";
}
export interface CorpusChunkDigest { index: number; chars: number; chapters: string[]; summary: string }
export interface CorpusArcDigest { title: string; chunkRange: [number, number]; summary: string }
export interface CorpusDigest {
	version: 1;
	docId: string;
	chunks: CorpusChunkDigest[];
	arcs: CorpusArcDigest[];
	synopsis: string;
	structure: { plotSpine: string; characterArcs: string; hooksAndPacing: string };
	extractedCount: number;
	dailyPatterns?: CorpusDailyPattern[];
	assets?: NarrativeAsset[];
	assetCount?: number;
	updatedAt: string;
}
export interface CorpusDailyPattern { title: string; setting: string; surfaceActivity: string; initiative: string; sweetBeat: string; friction: string; misunderstanding: string; microChange: string; escalationLimit: string; naturalStop: string; failureWarning: string; locator: string }
export type NarrativeAssetKind = "scene-pattern" | "relationship-beat" | "dialogue-move";
export interface NarrativeAsset { kind: NarrativeAssetKind; title: string; mechanism: string; appliesWhen: string; failureWarning: string; opening: string; progression: string[]; turn: string; stopPoint: string; relationshipStage: string; pressure: string; desiredExperience: string; locator: string }
export interface CorpusWorkbenchResponse {
	documents: CorpusDocument[];
	running?: Array<{ docId: string; step: string; done: number; total: number }>;
}
export interface CorpusCreateResponse { doc: CorpusDocument; estimatedCalls: number }
export interface CorpusDiscoveryResponse {
	status: "started" | "busy";
	candidateCount: number;
	selected: Array<{ url: string; title: string }>;
	queued: Array<{ url: string; title: string }>;
	errors: Array<{ url: string; message: string }>;
}
export interface CorpusDetailResponse { doc: CorpusDocument; digest: CorpusDigest | null }
export interface OutlineResearchView {
	sources: OutlineResearchSource[];
	mechanisms: OutlineResearchMechanism[];
	cards: OutlineResearchCard[];
	documents: CorpusDocument[];
}

export interface OutlineResearchSourceRow { id: string; query: string; title: string; snippet: string; url: string }
export interface OutlineResearchResultRow { query: string; results?: Array<{ title: string; url: string; snippet: string }>; error?: string; rejected?: string }
export interface OutlineResearchSearch {
	queries: string[];
	results: OutlineResearchResultRow[];
	sources: OutlineResearchSourceRow[];
	extracted: Array<{ mechanism: string; appliesWhen: string; failureWarning: string; sourceIds: string[] }>;
}
export interface OutlineResearchSearchResponse { view: OutlineResearchView; search: OutlineResearchSearch }

export interface ResearchSearchLog {
	id: string;
	createdAt: string;
	topic: string;
	queries: string[];
	sources: OutlineResearchSourceRow[];
	extracted: Array<{ mechanism: string; appliesWhen: string; failureWarning: string; sourceIds: string[] }>;
}
export interface ResearchSearchLogsResponse { logs: ResearchSearchLog[] }
export interface ResearchSearchScheduleStatus { enabled: boolean; running: boolean; lastRunAt?: string; lastStatus?: "completed" | "partial" | "failed" | "skipped"; lastTopics?: string[]; lastCompleted?: number; lastErrors?: Array<{ topic: string; message: string }> }
export interface ResearchSearchScheduleRun { status: "started" | "busy" | "skipped"; topics: string[]; completed: number; errors: Array<{ topic: string; message: string }> }

export interface OutlineSettings { mode: OutlineMode; researchMode: OutlineResearchMode }
export interface OutlineViewResponse {
	state: OutlineState;
	projection: unknown;
	pending: OutlinePendingProposal[];
	settings: OutlineSettings;
	invalidEntries: number;
	proposalRisks?: Record<string, { highRisk: string[]; issues: OutlineAuditIssue[]; requiresConfirmation: boolean }>;
	// Accepted for a rolling deployment where an older web-facing adapter may still be present.
	publicView?: OutlineState | null;
	proposals?: OutlineProposalView[];
	chats?: OutlineChatHistory[];
}
export interface OutlineHistoryResponse { current: OutlineState; history: OutlineState[]; invalidEntries: number }

export interface OutlineChatOption {
	id?: string;
	title?: string;
	experience?: string;
	mechanism?: string;
	tradeoffs?: string | string[];
	label?: string;
	text?: string;
	value?: string;
}
export interface OutlineChatResponse {
	requestId: string;
	reply: string;
	options?: Array<string | OutlineChatOption>;
	proposal?: OutlineProposal;
	proposalHash?: string;
	audit?: OutlineAudit;
	warnings: string[];
	focus?: OutlineDiscussionFocus;
	sceneAdvice?: OutlineSceneAdvice;
	dailyPlan?: OutlineDailyPlan;
	dailyPlans?: OutlineDailyPlan[];
}
export interface OutlineSceneAdvice { recommendedBeat: string; openingMove: string; playerObjective: string; naturalReason: string; intendedConsequence: string; characterMoves: string[]; conversationTargets: Array<{ character: string; reason: string; openingTopic: string; risk: string }>; dialogueCues: string[]; pressure: string; playerSpace: string; stopPoint: string; alternatives: string[]; mixedRoute: string }
export interface OutlineDailyPlan { title: string; genre: string; duration: string; location: string; participants: string[]; initiator: string; surfaceActivity: string; privateIntent: string; sweetBeats: string[]; friction: string; misunderstanding: string; characterBoundaries: string[]; relationshipChange: string; playerChoices: string[]; stopPoint: string; followUpSeeds: string[]; researchRefs: string[]; entryCondition: string; continuityHook: string; whyNow: string; intensity: "light" | "medium" | "strong"; initiativeType: string; pressureType: string; choiceType: string; relationshipEffect: string }
export interface OutlineChatHistory { version: 1; requestId: string; baseLeafId: string; focus: OutlineDiscussionFocus; user: string; answer: string; options: Array<string | OutlineChatOption>; warnings: string[]; sceneAdvice?: OutlineSceneAdvice; dailyPlan?: OutlineDailyPlan; dailyPlans?: OutlineDailyPlan[]; createdAt: string }
export interface OutlineReconcileResponse { proposal?: OutlineProposal; committed?: boolean; stable?: boolean }
export interface OutlineSettingsResponse { settings: OutlineSettings }

export type DiagnosticStatus = "success" | "degraded" | "skipped" | "reused" | "failed" | "committed" | "rejected" | "pending" | "stable" | "unavailable" | "approved";
export interface TurnDiagnosticStage { id: string; label: string; status: DiagnosticStatus; summary: string; details?: Record<string, unknown> }

export interface PlanFactComparison { version: 1; selectedEvent: string; actualOutcome: string; eventStatus: "not-used" | "partially-advanced" | "advanced" | "diverged"; foreshadowingStatus: "not-planted" | "suggested" | "planted"; nextPressure: string; evidence: string[] }
export interface TurnDiagnosticView {
	version: 1;
	entryId: string;
	narrativeChars: number;
	curtainChars: number;
	timeline: { thinking: number; tools: number; text: number };
	stages: TurnDiagnosticStage[];
	artifacts: { prep?: Record<string, unknown>; workflow?: Record<string, unknown>; curtain?: string; curtainTruncated?: boolean; patchAudit?: unknown[]; commits: Array<{ type: string; status?: DiagnosticStatus; summary: string; data?: Record<string, unknown> }> };
}
export interface TurnDiagnosticsResponse { version: 1; turns: TurnDiagnosticView[] }

/** 记忆面板类型 */
export interface MemoryEventCard {
	id: string;
	sourceKey?: string;
	status: "candidate" | "active" | "resolved" | "retired";
	importance: "core" | "major" | "normal" | "minor";
	title: string;
	turnRange?: { from: number; to: number };
	participants?: string[];
	time?: string;
	location?: string;
	arc?: string;
	tags: string[];
	recallAnchors: string[];
	summary: string;
	evidenceLevel: "source-backed" | "summary-only";
	sourceRefs: Array<{ entryId: string; entryType?: string; turn?: number }>;
	links?: Array<{ to: string; type: "caused_by" | "evolved_from" | "resolved_the" | "contradicts"; note?: string }>;
}
export interface MemoryEventsResponse { events: MemoryEventCard[]; total: number }
export interface MemoryDiffRecord { ts: string; op: "create" | "merge" | "update" | "skip"; eventId: string; title: string; arc?: string; reason: string }
export interface MemoryDiffResponse { diff: MemoryDiffRecord[]; total: number }
