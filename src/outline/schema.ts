export const OUTLINE_ENTRY_TYPE = "rp-outline";
export const OUTLINE_PROPOSAL_ENTRY_TYPE = "rp-outline-proposal";
export const OUTLINE_CHAT_ENTRY_TYPE = "rp-outline-chat";
export const OUTLINE_CHAT_CLEAR_TYPE = "rp-outline-chat-clear";

export type OutlineDiscussionFocus = "open" | "next-beat" | "dialogue" | "character" | "diagnose" | "daily";
export type ArcShapeRole = "setup" | "rising" | "hardest" | "climax";
export type OutlinePaceIntent = "seed" | "normal" | "push" | "building" | "climaxing";
export type OutlineArcBeatOutcome = "progressing" | "uncertain" | "fulfilled" | "failed" | "rerouted";

export interface OutlineSceneAdvice {
	recommendedBeat: string;
	openingMove: string;
	playerObjective: string;
	naturalReason: string;
	intendedConsequence: string;
	characterMoves: string[];
	conversationTargets: Array<{ character: string; reason: string; openingTopic: string; risk: string }>;
	dialogueCues: string[];
	pressure: string;
	playerSpace: string;
	stopPoint: string;
	alternatives: string[];
	mixedRoute: string;
}

export interface OutlineDailyPlan {
	title: string; genre: string; duration: string; location: string; participants: string[]; initiator: string;
	surfaceActivity: string; privateIntent: string; sweetBeats: string[]; friction: string; misunderstanding: string;
	characterBoundaries: string[]; relationshipChange: string; playerChoices: string[]; stopPoint: string;
	followUpSeeds: string[]; researchRefs: string[];
	entryCondition: string; continuityHook: string; whyNow: string;
	intensity: "light" | "medium" | "strong";
	initiativeType: string; pressureType: string; choiceType: string; relationshipEffect: string;
}

export type OutlineNodeStatus = "candidate" | "active" | "blocked" | "fulfilled" | "bypassed" | "abandoned" | "contradicted";
export type OutlineRigidity = "hard" | "soft" | "open";
export type OutlineVisibility = "public" | "spoiler" | "secret";
export type ForeshadowingStatus = "conceived" | "prepared" | "planted" | "reinforced" | "activated" | "partially-revealed" | "resolved" | "abandoned" | "invalidated";
export type OutlineActuality = "plan" | "guidance" | "established";

export interface OutlineSource {
	id: string;
	kind: "research" | "user" | "narrative" | "rp-state" | "world" | "lore";
	title: string;
	locator: string;
	note: string;
}

export interface OutlineNode {
	id: string;
	title: string;
	summary: string;
	status: OutlineNodeStatus;
	rigidity: OutlineRigidity;
	visibility: OutlineVisibility;
	actuality: OutlineActuality;
	sourceRefs: string[];
	dependsOn: string[];
}

export interface OutlineArc extends OutlineNode { beats: string[] }
export interface OutlineCharacterArc extends OutlineNode { character: string; from: string; toward: string }
export interface OutlineThread extends OutlineNode { question: string; nextPressure: string }
export interface OutlineMilestone extends OutlineNode { criteria: string[] }
export interface OutlineForeshadowing extends OutlineNode {
	foreshadowingStatus: ForeshadowingStatus;
	setup: string;
	payoff: string;
	evidenceRefs: string[];
}
export interface OutlineSetting extends OutlineNode { key: string; value: string }

export interface OutlineAlignment {
	summary: string;
	confidence: number;
	conflicts: string[];
	updatedFromRefs: string[];
}

export interface OutlineState {
	version: 1;
	revision: number;
	parentHash: string;
	hash: string;
	premise: string;
	constraints: OutlineNode[];
	arcs: OutlineArc[];
	characterArcs: OutlineCharacterArc[];
	threads: OutlineThread[];
	milestones: OutlineMilestone[];
	foreshadowing: OutlineForeshadowing[];
	currentFocus: string[];
	alignment: OutlineAlignment;
	settings: OutlineSetting[];
	sources: OutlineSource[];
}

export type OutlineCollectionName = "constraints" | "arcs" | "characterArcs" | "threads" | "milestones" | "foreshadowing" | "settings";

export interface OutlineCollectionPatch {
	collection: OutlineCollectionName;
	upsert?: Array<OutlineNode | OutlineArc | OutlineCharacterArc | OutlineThread | OutlineMilestone | OutlineForeshadowing | OutlineSetting>;
	deleteIds?: string[];
}

export interface OutlinePatch {
	premise?: string;
	currentFocus?: string[];
	alignment?: OutlineAlignment;
	collections?: OutlineCollectionPatch[];
	addSources?: OutlineSource[];
}

export interface OutlineProposal {
	version: 1;
	id: string;
	mode: "manual" | "automatic";
	baseRevision: number;
	baseHash: string;
	patch: OutlinePatch;
	rationale: string;
	researchInspirationIds: string[];
	createdAt?: string;
	/** Branch guard captured before model work. */
	baseLeafId?: string;
	proposalHash?: string;
	kind?: "chat" | "bootstrap" | "reconcile" | "foreshadowing";
}

export type OutlineAuditCode = "revision-conflict" | "hash-conflict" | "leaf-conflict" | "invalid-patch" | "id-mutation" | "source-forgery" | "hard-constraint-deletion" | "hard-constraint-downgrade" | "plan-promoted-to-fact" | "foreshadowing-evidence" | "invalid-status-transition" | "confirmation-required" | "automatic-high-risk";
export interface OutlineAuditIssue { code: OutlineAuditCode; severity: "warning" | "error"; path?: string; message: string }
export interface OutlineAudit { version: 1; verdict: "approve" | "reject"; issues: OutlineAuditIssue[]; summary: string }

export interface OutlineResearchInspiration {
	id: string;
	title: string;
	url: string;
	excerpt: string;
	note: string;
	/** Research is idea material only and never establishes story facts. */
	actuality: "inspiration";
}

export interface OutlineChatRequest {
	requestId: string;
	message: string;
	mode: "manual" | "automatic";
	baseRevision: number;
	baseHash: string;
	selectedNodeIds: string[];
	research: OutlineResearchInspiration[];
	focus: OutlineDiscussionFocus;
}

export interface OutlineChatResult {
	requestId: string;
	reply: string;
	proposal?: OutlineProposal;
	audit?: OutlineAudit;
	warnings: string[];
	focus?: OutlineDiscussionFocus;
	sceneAdvice?: OutlineSceneAdvice;
	dailyPlan?: OutlineDailyPlan;
	dailyPlans?: OutlineDailyPlan[];
}

export interface OutlineChatEntry {
	version: 1;
	requestId: string;
	baseLeafId: string;
	focus: OutlineDiscussionFocus;
	user: string;
	answer: string;
	options: unknown[];
	warnings: string[];
	sceneAdvice?: OutlineSceneAdvice;
	dailyPlan?: OutlineDailyPlan;
	dailyPlans?: OutlineDailyPlan[];
	createdAt: string;
}

export interface OutlineProposalEntry {
	version: 1;
	proposal: OutlineProposal;
	audit?: OutlineAudit;
	status: "pending" | "approved" | "rejected";
	proposalHash?: string;
	reason?: string;
	committedRevision?: number;
	committedHash?: string;
	createdAt: string;
}
