/**
 * 台上引擎（PLAN-RP-HARNESS M1）——RP 原生回合循环（R1 循环自持）。
 *
 * 一拍 = 装配（f(分支)）→ 一次流式生成（M1 零工具）→ assistant 落树 → 谢幕。
 * 没有 steer/followUp 队列，没有续轮判定：harness 知道自己在哪一幕。
 *
 * 竞态两律（R9）在此落地：
 * - 回合互斥：忙时新输入进队列，本拍收尾后依序开演；
 * - 谢幕由 harness 判定：流结束即收轮，不存在模型可续的循环。
 *
 * 依赖全部注入（SessionManager / 模型 / 流函数），可用 faux provider 离线整测。
 */

import { join } from "node:path";
import { selectDatabasePluginWorldbookEntries, databasePluginWorldbookParts, insertDatabasePluginDepthEntries, placeDatabasePluginCharacterEntries, type DatabasePluginPreparedPrompt } from "./database-plugin-prompt.ts";
import { existingEcologyReference } from "./passive-ecology.ts";
import { buildAgentPresentationMaterials, parseAgentPresentation, parseAgentPresentationPlan, presentationPlainText, presentationSegments, authoredImages } from "./agent-presentation.ts";
import { projectPresentation } from "../presentation.ts";
import { runAgentTurn } from "./agent-turn.ts";
import { classifyModelFailure, isNativeToolsUnsupported, type ModelAttemptDiagnostic } from "./model-failure.ts";
import { executeDirectorBatch, directorMainSkill, type DirectorContext, type DirectorReport } from "./agent-director.ts";
import { isGenerationMode, type GenerationMode, type GenerationWorkflow } from "./generation-mode.ts";
import { mkdirSync, writeFileSync } from "node:fs";

import { applyProjectedSamplers } from "../samplers.ts";
import { extractDraftBody, extractDraftRules } from "../draft.ts";
import {
	appendOverlayEntry,
	loreFingerprint,
	overlayPathFor,
	scanEntries,
	searchEntries,
} from "../lorebook.ts";
import { loadCodexEntries } from "../codex.ts";
import { formatPanelIndex, formatPanelSnapshot, loadPanels } from "../panels.ts";
import { dir } from "../paths.ts";
import { classifyTag, scanTaggedBlocks } from "../postprocess.ts";
import { formatRosterIndex, formatState, saveState } from "../state.ts";
import { isBackstageText } from "../stance.ts";
import type { LorebookEntry } from "../types.ts";
import {
	buildStageInjection,
	buildStageSystemPrompt,
	codexNamesFromBranch,
	detectsLanguageMismatch,
	formatLoreIndex,
	rebuildHistory,
	stateFromBranch,
	type BranchEntryLike,
} from "./assemble.ts";
import {
	assemblePresetAfter,
	constantLoreOf,
	loadStageConfig,
	loadStageMaterials,
	type AssembledPiece,
	type StageMaterials,
} from "./materials.ts";
import {
	MANUAL_MIN_COMPACT_CHARS,
	runCompaction,
	serializeForSummary,
	SUMMARY_ENTRY_TYPE,
	type CompactOutcome,
	type RpSummaryData,
} from "./compact.ts";
import { repairKnownCharacterIdentityState, runScribeTurn, STATE_ENTRY_TYPE } from "./scribe-run.ts";
import { WriterContextPreflight, isConfirmedContextOverflow } from "./context-preflight.ts";
import { TurnPerformanceCollector, TURN_PERFORMANCE_ENTRY_TYPE, type PerformancePhase, type PerformanceStatus } from "./performance.ts";
import {
	LITERARY_PROFILE_ENTRY_TYPE,
	buildCharacterProfilePrompt,
	buildPersonaProfilePrompt,
	literaryProfileFromBranch,
	normalizeLiteraryArtifact,
	shouldRefreshLiteraryProfile,
	countCompletedNarrativeTurns,
	type LiteraryProfileData,
} from "./literary-profile.ts";
import {
	buildLiteraryDirectorPrompt,
	formatLiteraryDirection,
	parseLiteraryDirection,
	type LiteraryDirection,
} from "./literary-director.ts";
import {
	buildLiteraryContinuityPrompt,
	parseLiteraryContinuity,
	shouldRunContinuity,
	type LiteraryContinuity,
} from "./literary-continuity.ts";
import { buildPlanFactPrompt, parsePlanFact, type PlanFactComparison } from "./plan-fact.ts";
import {
	buildPlotAdaptationPrompt,
	formatPlotAdaptation,
	parsePlotAdaptation,
	plotAdaptationFromNovelProjection,
	mergePlotAdaptations,
	type PlotAdaptation,
} from "./plot-adaptation.ts";
import {
	buildSceneConductorPrompt,
	formatSceneConductor,
	parseSceneConductor,
	type SceneConductor,
} from "./scene-conductor.ts";
import {
	LITERARY_WORLD_ENTRY_TYPE,
	literaryWorldFromBranch,
} from "./literary-world.ts";
import {
	LITERARY_ECOLOGY_ENTRY_TYPE,
	buildEcologyCardPrompt,
	buildEcologyGlobalPrompt,
	buildEcologyRuntimePrompt,
	buildEcologySearchPlanPrompt,
	commitLiteraryEcologyRound,
	degradedLiteraryEcologyRound,
	ecologySearchQueries,
	applyEcologyUsage,
	formatLiteraryEcologyInjection,
	literaryEcologyFromBranch,
	loadEcologyPools,
	normalizeEcologyCardPool,
	normalizeEcologyGlobalPool,
	normalizeLiteraryEcologyState,
	saveEcologyPools,
	validateEcologyTransition,
	type LiteraryEcologyState,
} from "./literary-ecology.ts";
import {
	MAX_LOOKUPS,
	MAX_ROUNDS,
	runStageTool,
	skillReadTool,
	stageTools,
	writeTools,
	type MemoryHitLike,
	type MemoryRecallHitLike,
	type StageTool,
	type StageToolDeps,
	type ToolRunResult,
} from "./tools.ts";
import { unifiedStageToolNames, unifiedStageReadToolNames, unifiedStageWriteToolNames } from "../tools/adapters/stage.ts";
import { narrativeMemoryWindow } from "../memory/narrative-window.ts";
import { canonicalEventId } from "../memory/event-id.ts";
import {
	mcpStageTools,
	mcpStageToolNames,
	runMcpStageTool,
	type McpStageDeps,
} from "./mcp-stage.ts";
import {
	mediaStageToolNames,
	mediaStageTools,
	runMediaStageTool,
	type MediaStageResult,
} from "./media-stage.ts";
import { assistantStageTool, runAssistantStageTool } from "./assistant-stage.ts";
import type { MemoryChunkLike } from "../tools/memory.ts";
import { wantsManualWebResearch } from "../tools/web-research.ts";
import { resolveStepModel, type SideModelStep } from "../model-routing.ts";
import { outlineFromBranch } from "../outline/state.ts";
import { projectOutline } from "../outline/projection.ts";
import { workflowSkill } from "./skill-store.ts";
import { worldModuleSkillPacks } from "./skill-store.ts";
import { commitNovelPlayState, prepareNovelPlayTurn, type NovelPlayProjection, type PreparedNovelPlayTurn } from "../novel-play/runtime.ts"; // novel-play-runtime-integration-v2
import { novelPlayContextForBranch } from "../novel-play/runtime.ts";
import {
	WORLD_MANIFEST_ENTRY_TYPE,
	buildWorldProfilePrompt,
	defaultCardWorldProfile,
	loadCardWorldProfile,
	manifestFromProfile,
	normalizeCardWorldProfile,
	profileNeedsAnalysis,
	saveCardWorldProfile,
	worldManifestFromBranch,
	worldCardKey,
	worldProfileFingerprint,
} from "./literary-world-profile.ts";
import {
	WORLD_AUDIT_ENTRY_TYPE,
	buildBeatFactPrompt,
	buildWorldAuditPrompt,
	buildWorldProposalPrompt,
	normalizeBeatFactEnvelope,
	normalizeWorldTransitionAudit,
	worldAuditEntry,
	worldTransitionHash,
	commitModularWorldTransition,
	dueWorldModules,
	normalizeModularWorldProposal,
	type WorldTransitionAuditEntry,
} from "./literary-world-transition.ts";
import { formatModularWorldInjection, modularWorldFromBranch, projectLiteraryWorldV1 } from "./literary-world-modular.ts";
import { ecologySignalsForWorld, worldSignalsForEcology } from "./literary-world-signals.ts";
import { buildCurtainRerollMaterials, finalizeCurtainText } from "./curtain-materials.ts";
import {
	createWorkspace,
	finalTimeline,
	splitDraftSegments,
	projectedState,
	planStepBudget,
	recordSegment,
	runWriteTool,
	type TurnWorkspace,
	type WorkspaceDeps,
} from "./workspace.ts";

// ---------------- 依赖面（结构类型，不引 @liyuan/agent-runtime） ----------------

export interface StageSessionManager {
	getBranch(): unknown[];
	getLeafId(): string | null;
	appendMessage(message: unknown): string;
	appendCustomMessageEntry(customType: string, content: string, display: boolean): string;
	/** CustomEntry（不进 LLM 上下文）：账本快照用 */
	appendCustomEntry(customType: string, data?: unknown): string;
	getSessionId(): string;
	flush(): void;
	/** 将下一条回复明确挂到目标父节点；用于 reroll 保持 assistant sibling 结构。 */
	branch?(entryId: string): void;
	appendModelChange?(provider: string, modelId: string): string;
	appendThinkingLevelChange?(level: string): string;
}

/**
 * 模型/思考档切换是会话元数据，不是用户切分支。
 * 它们可能在旁路模型请求期间追加到当前叶；不能因此丢弃本拍已经生成的正文。
 */
const isSessionMetadataEntry = (entry: BranchEntryLike): boolean =>
	entry.type === "model_change" || entry.type === "thinking_level_change" || (entry.type === "custom" && entry.customType === "rp-database-memory");

const turnLeafIsStable = (sm: StageSessionManager, anchorId: string | null): boolean => {
	if (!anchorId) return false;
	if (sm.getLeafId() === anchorId) return true;
	const branch = sm.getBranch() as BranchEntryLike[];
	const anchorIndex = branch.findIndex((entry) => entry.id === anchorId);
	return anchorIndex >= 0 && branch.slice(anchorIndex + 1).every(isSessionMetadataEntry);
};

type SessionMetadata = { type: "model_change"; provider: string; modelId: string } | { type: "thinking_level_change"; thinkingLevel: string };

const latestTurnMetadata = (sm: StageSessionManager, anchorId: string | null): SessionMetadata[] => {
	if (!turnLeafIsStable(sm, anchorId)) return [];
	const branch = sm.getBranch() as BranchEntryLike[];
	const latest = new Map<string, SessionMetadata>();
	for (const entry of branch.slice(branch.findIndex(row => row.id === anchorId) + 1)) {
		const row = entry as unknown as Record<string, unknown>;
		let metadata: SessionMetadata | undefined;
		if (row.type === "model_change" && typeof row.provider === "string" && typeof row.modelId === "string") metadata = { type: "model_change", provider: row.provider, modelId: row.modelId };
		if (row.type === "thinking_level_change" && typeof row.thinkingLevel === "string") metadata = { type: "thinking_level_change", thinkingLevel: row.thinkingLevel };
		if (metadata) { latest.delete(metadata.type); latest.set(metadata.type, metadata); }
	}
	return [...latest.values()];
};

const restoreTurnLeafAfterMetadata = (sm: StageSessionManager, anchorId: string | null): boolean => {
	if (!turnLeafIsStable(sm, anchorId)) return false;
	if (sm.getLeafId() !== anchorId) {
		if (!sm.branch || !anchorId) return false;
		// 无重建方法的宿主不能静默丢弃设置。
		if (latestTurnMetadata(sm, anchorId).some(row => row.type === "model_change" ? !sm.appendModelChange : !sm.appendThinkingLevelChange)) return false;
		sm.branch(anchorId);
	}
	return true;
};

const retainTurnMetadata = (sm: StageSessionManager, narrativeEntryId: string, pending: SessionMetadata[]): void => {
	const branch = sm.getBranch() as BranchEntryLike[];
	const index = branch.findIndex(row => row.id === narrativeEntryId);
	if (index < 0) return; // 已切支，绝不重演旧设置。
	const newerTypes = new Set(branch.slice(index + 1).filter(isSessionMetadataEntry).map(row => row.type));
	for (const row of pending) {
		if (newerTypes.has(row.type)) continue;
		if (row.type === "model_change") sm.appendModelChange?.(row.provider, row.modelId);
		else sm.appendThinkingLevelChange?.(row.thinkingLevel);
	}
};

export interface StageModelLike {
	id: string;
	provider?: string;
	contextWindow?: number;
	api?: unknown;
	baseUrl?: string;
	[k: string]: unknown;
}

/** @liyuan/ai streamSimple 的结构子集 */
export type StageStreamFn = (
	model: StageModelLike,
	context: { systemPrompt?: string; messages: unknown[] },
	options?: Record<string, unknown>,
) => AsyncIterable<StageStreamEvent> & { result(): Promise<AssistantMsgLike> };

export interface AssistantMsgLike {
	role: "assistant";
	content: Array<{
		type: string;
		text?: string;
		thinking?: string;
		name?: string;
		arguments?: Record<string, unknown>;
	}>;
	stopReason?: string;
	errorMessage?: string;
	[k: string]: unknown;
}

export interface StageStreamEvent {
	type: string;
	delta?: string;
	contentIndex?: number;
	toolCall?: { name?: string; arguments?: Record<string, unknown> };
	partial?: AssistantMsgLike;
	message?: AssistantMsgLike;
	error?: AssistantMsgLike;
}

export interface StageSubmission {
	generationMode?: GenerationMode;
	clientMessageId?: string;
	expectedSessionId?: string;
	onAccepted?: (entryId: string) => void;
}

interface StageRequestObservation {
	diagnostics?: ModelAttemptDiagnostic[];
	collector?: TurnPerformanceCollector;
	phase: PerformancePhase;
	preflight?: WriterContextPreflight;
	notify?: (message: string) => void;
}

export interface StageTurnEndInfo {
	aborted: boolean;
	/** 非空 = 本拍以错误收场（已通知，无正文落树） */
	error?: string;
	/** 落树的 assistant 条目 id（错误/空拍时无） */
	entryId?: string;
}

export interface StageEventBook {
	everyNTurns: () => number;
	getCursor: () => string | undefined;
	setCursor: (entryId: string) => void;
	listEvents: () => Array<{ id: string; title: string; arc?: string; status?: string; importance?: string; summary?: string }>;
}

export interface StageEvents {
	onTurnStart?: () => void;
	/** 流式增量（转 WS delta 帧；kind 对应正文/思考通道） */
	/**
	 * 流式增量。draft=true 表示该增量是 draft_write 参数的转发
	 * （稿件流 = 替换语义：多稿重交原地更新，前端不得叠加）；
	 * reset=true 表示本次调用的首个分片（前端据此清掉旧稿）。
	 */
	onDelta?: (kind: "text" | "thinking", delta: string, draft?: boolean, reset?: boolean) => void;
	/**
	 * 中间轮旁白清理：稿落地前的工具轮吐出的 text（读题/计划旁白）已流式上屏，
	 * 但不是正文——通知前端把它收进过程条并从正文区移除（8/09 实弹：读题文字
	 * 先挂在正文顶部、落树后又拼到正文尾部）。
	 */
	onStreamClear?: () => void;
	/**
	 * 稿件分段重同步（修复后）：前端把屏上全部稿段**原位**替换为 segments。
	 * 与 onDelta 的稿件流互补——流式分片管「一段段长出来」，resync 管「原地变新」：
	 * draft_edit 改稿成功后按当前稿全量重切下发，修后的段就是用户看到的段。
	 */
	onDraftResync?: (segments: string[]) => void;
	onTurnEnd?: (info: StageTurnEndInfo) => void;
	/** 面向用户的告警（宏降级等）；每种只发一次 */
	onNotify?: (level: "info" | "warning" | "error", text: string) => void;
	/** 过程条短句（验收/修订进度；kind:"note" 形态，无需工具名） */
	onActivity?: (detail: string) => void;
}

export interface StageEngineDeps {
	cwd: string;
	getSessionManager: () => StageSessionManager;
	getModel: () => StageModelLike | undefined;
	/** 按 provider/id 查完整模型对象；旁路覆盖使用，不改变剧情总插头 */
	findModel?: (provider: string, id: string) => StageModelLike | undefined;
	/** 渠道改名后的侧模型重定位；仅在宿主能无歧义确定模型时返回。 */
	findModelById?: (id: string) => StageModelLike | undefined;
	getAuth: (model: StageModelLike) => Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	/** 会话当前思考档（用户自由，引擎透传） */
	getThinking?: () => string | undefined;
	/** 账本磁盘缓存路径（.liyuan-state/<sessionId>.json）；给出则场记落盘（fs.watch → state 帧） */
	getStateFile?: (sessionId: string) => string | undefined;
	/** 剧情库检索（memory_search 工具用）；未注入 = 该工具恒返回无命中 */
	searchMemory?: (sessionId: string, query: string) => Promise<MemoryHitLike[]>;
	databasePluginMemory?: {
		enabled(): boolean;
		before(userText: string, signal?: AbortSignal): Promise<DatabasePluginPreparedPrompt>;
		after(sourceEntryId?: string, signal?: AbortSignal): Promise<void>;
		recentHistoryMessages(): number;
	};
	/**
	 * PLAN-RP-MEMORY：拍前自动召回（第一阶段：事件/纪要与证据合并检索）。
	 * 未注入 = 主演无【剧情记忆】注入（退化为旧行为）。调用方承诺内部做 budget/topK。
	 */
	recallForTurn?: (sessionId: string, query: string) => Promise<MemoryRecallHitLike[]>;
	/** 扫荡型召回：按弧线聚合事件卡为有限骨架块，不加载原文。 */
	recallArcsForTurn?: (sessionId: string) => Promise<Array<{ arc: string; text: string; events: number }>>;
	/**
	 * PLAN-RP-MEMORY：按事件 id 回读原文证据（第二阶段：事件 → sourceRefs → 证据块）。
	 * 未注入 = 事件召回不附带证据；主演只拿到事件定位。
	 */
	recallEvidence?: (sessionId: string, eventId: string) => Promise<MemoryRecallHitLike[]>;
	/**
	 * PLAN-RP-MEMORY：拍前召回开关（对齐 config.injectOnTurn）。resolve false 则跳过本拍召回。
	 * 未注入 = 只要宿主有 recallForTurn 就召。
	 */
	shouldRecallForTurn?: (sessionId: string) => Promise<boolean>;
	/** 滚动事件提取的游标与既有事件预览。 */
	eventBook?: (sessionId: string) => StageEventBook | undefined;
	/**
	 * 向量库写侧三件（M-D3）。均由宿主按「当前对话 + 当前卡」绑定 MemoryScope 后注入——
	 * **作用域不经模型**（PLAN-RP-TOOLING M-D3：scope 全隐藏），引擎只透传 sessionId。
	 * 未注入 = 台上无对应工具（依赖缺失的工具不上清单）。
	 */
	addMemory?: (
		sessionId: string,
		input: { text: string; title?: string },
	) => Promise<{ added: number; total: number; chunks: number }>;
	listMemory?: (sessionId: string, storeId: string) => MemoryChunkLike[] | Promise<MemoryChunkLike[]>;
	deleteMemory?: (sessionId: string, storeId: string, id: string) => boolean | Promise<boolean>;
	/** 按需联网查证。隐私、查询额度、代理和网络请求由宿主执行。 */
	webResearch?: (queries: string[], maxResults: number, signal?: AbortSignal) => Promise<import("../tools/web-research.ts").WebResearchItem[]>;
	/**
	 * 面板读写（M-D5）。由宿主按当前会话绑定 artifacts 文件后注入。
	 * 未注入 = 台上无面板工具（依赖缺失的工具不上清单）。
	 */
	loadPanels?: (sessionId: string) => Record<string, { name: string; kind: "markdown" | "svg" | "html"; content: string; archived?: boolean }>;
	writePanel?: (sessionId: string, input: { name: string; kind: string; content: string }) => { ok: true; created: boolean; reopened: boolean; activeCount: number; overLimit: boolean } | { ok: false; error: string };
	closePanel?: (sessionId: string, name: string) => { ok: boolean; error?: string };
	/** 被压缩裁掉的早期正文归档进剧情库（供 memory_search 召回细节）；未注入 = 只落摘要不归档 */
	archiveCompacted?: (
		sessionId: string,
		text: string,
		opts?: {
			sourceRefs?: Array<{ entryId: string; entryType?: string; turn?: number; charFrom?: number; charTo?: number }>;
			perEntry?: Array<{ entryId: string; entryType?: string; turn?: number; text: string }>;
		},
	) => Promise<void>;
	/**
	 * PLAN-RP-MEMORY：事件卡入库（旁路产物）。未注入 = 无事件索引（不影响摘要与归档）。
	 */
	upsertEventDigest?: (
		sessionId: string,
		event: import("../memory/types.ts").RpEventDigest,
	) => Promise<{ stored: boolean }>;
	/**
	 * 世界书条目启停落盘（lorebook_toggle 工具用，M-D2）：写 config.disabledLore 并重装素材。
	 * 由宿主注入——落盘与热重载归 server/ 侧（引擎不碰 server 的 writeJsonWithBackup）。
	 * 未注入 = 台上无 lorebook_toggle 工具。
	 */
	setDisabledLore?: (fingerprints: string[], enabled: boolean) => number;
	/**
	 * MCP 外设（8/06 重新接线）：宿主注入 hub 的两个能力，台上据此挂 mcp__ 工具。
	 * 未注入 = 台上无 MCP 工具（依赖缺失的工具不上清单）。
	 * hub 单例由宿主持有——引擎不自建，避免第二个实例（见 src/mcp.ts 的 globalThis 槽）。
	 */
	mcp?: McpStageDeps;
	/**
	 * 媒体交付工具（8/06 重接）：show_image/audio/video/html + tts。
	 * 与 MCP 同源的断链——消费端（wire.ts）一直健在，缺的是台上生产端。
	 * false/省略 = 不挂（tts 另需服务端 TTS 环境，由 ttsAvailable 决定）。
	 */
	media?: boolean;
	/** TTS 环境是否就绪（未就绪则 tts 不上清单——依赖缺失的工具不上清单） */
	ttsAvailable?: () => boolean;
	/**
	 * 剧情决策询问（ask 工具，P7 接回）：弹出选择卡等用户应答。
	 * 应答 = 用户选择的选项原文（作为新输入回喂模型，计划据此重拟）；
	 * undefined = 用户停止（笔还给用户，本拍收束）。
	 * 未注入 = 台上无 ask 工具（依赖缺失的工具不上清单）。
	 */
	askUser?: (question: string, options: string[], signal?: AbortSignal) => Promise<string | undefined>;
	streamFn: StageStreamFn;
	events?: StageEvents;
}

// ---------------- 引擎 ----------------

const nowMsg = (text: string) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
});

const textOfAssistant = (m: AssistantMsgLike | null): string => {
	if (!m) return "";
	return m.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("")
		.trim();
};

// ---------------- 五注入（PLAN-RECTIFY §2.3：轮次层全部送模文案，文案即规格） ----------------

/** 规划卡：每拍第 1 轮随末端注入送达（工作区新建必空） */
export const PLAN_CARD =
	"【第 1 步·规划】本拍还没有计划。读取本拍材料，用 `beat_plan` 列短路标；规划与首次正文写入分轮。";

/** 记账注入：seal（含兜底封笔）之后第一件事；本拍已有落账（结构信号）时跳过 */
export const CREATIVE_REVIEW_INJECTION =
	"【分段回看】稿纸已更新。下一轮继续用 draft_append，修订用 draft_edit，完成本拍用 draft_seal。";

export const LEDGER_INJECTION =
	"【记账】已封笔。核对本拍变动并落账：世界状态用 `world_state_update`（物品/时间/位置/关系），" +
	"表格与面板用 `panel_write` 同步。没有变动就直接停。";

// 不人为压缩单次交付；正文 Agent 的分段/轮次控制负责边界，供应商自身上限负责容量。
export const DEFAULT_MAIN_MAX_TOKENS = 32768;
export const FIRST_CALL_MAX_TOKENS = 32768;
/** 格式收尾沿用主演本拍上下文，只放宽输出容量，不再重复送料完整卡与预设。 */
export const CURTAIN_MAX_TOKENS = 32768;

/** maxTokens 是单次 provider 总输出上限（含供应商计入其中的 thinking），不是整拍正文上限。 */
export function mainStageMaxTokens(
	model: StageModelLike,
	wordRange?: { min: number; max: number },
): number {
	const wanted = wordRange
		? Math.max(4096, Math.min(32768, Math.ceil(wordRange.max * 2) + 2048))
		: DEFAULT_MAIN_MAX_TOKENS;
	const modelCap = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : wanted;
	return Math.min(wanted, modelCap);
}

export interface StageRerollPrep {
	generationMode?: GenerationMode;
	literaryContinuity?: LiteraryContinuity;
	literaryDirection?: string;
	literaryDirectionData?: LiteraryDirection;
	literaryEcology?: LiteraryEcologyState;
	plotAdaptation?: PlotAdaptation;
	planFact?: PlanFactComparison;
	sceneConductor?: SceneConductor;
}

/** 主演格式收尾的独立容量：触顶收场同样必须使用，不能退回正文轮的 8k。 */
export function curtainMaxTokens(model: StageModelLike): number {
	return typeof model.maxTokens === "number" && model.maxTokens > 0
		? model.maxTokens
		: CURTAIN_MAX_TOKENS;
}

/** 净正文字数（不含格式区块、不计空白），仅用于流程门与观测指标。 */
const draftBodyCharsOf = (ws: TurnWorkspace): number =>
	ws.draft.trim() ? extractDraftBody(ws.draft).replace(/\s+/g, "").length : 0;
/** 初次请求之外的自动重试次数；429、短暂网关错误和网络错误由 provider 按退避处理。 */
const MODEL_MAX_RETRIES = 9;
/** provider 已负责退避重试；引擎层只额外做一次流式→非流式恢复，避免重试乘法。 */
const WRITER_OUTER_RETRIES = 1;

/** 中转错用 tokenizer 时会把模型控制 token 和占位符直接作为正文返回。 */
export function looksLikeCorruptedModelText(text: string): boolean {
	const source = text.trim();
	if (!source) return false;
	if (/<[｜|]?begin[▁_ ]of[▁_ ]sentence[｜|]?>/i.test(source)) return true;
	const hashes = (source.match(/#/g) ?? []).length;
	const meaningful = (source.match(/[\p{L}\p{N}]/gu) ?? []).length;
	return source.length >= 120 && hashes >= 24 && hashes > meaningful * 0.8;
}

const trimContentBodyRepeat = (body: string, inner: string): string => {
	const draft = body.trim();
	const content = inner.trimStart();
	if (!draft || !content) return inner;
	for (let size = Math.min(draft.length, content.length); size > 0; size--) {
		if (content.startsWith(draft.slice(-size))) {
			const rest = content.slice(size).trim();
			return rest ? `\n${rest}` : "";
		}
	}
	return inner;
};

/**
 * 进度行：每轮替换语义（替代开工卡/回看卡）。只投影路标和段数。
 * 拍前导演工件与当前稿是每轮的事实源，不再通过 skill 工具制造额外停顿。
 * wordRange 只调节 provider 容量，不在轮次层测量或授权新增事件；单拍边界由工作区预算负责。
 */
export function progressLine(ws: TurnWorkspace, packNames?: string[], forcedSkills?: string[]): string {
	const parts: string[] = [];
	if (ws.plan.length > 0) {
		const i = ws.plan.findIndex((s) => !s.done);
		if (i >= 0) parts.push(`路标 ${i + 1}/${ws.plan.length}「${ws.plan[i]!.text}」`);
	}
	parts.push(`已演 ${ws.appends} 段`);
	const packs = packNames?.length ? `可读场面包：${packNames.join(" / ")}。` : "";
	const forced = forcedSkills?.length ? `每个路标落笔前先 \`skill_read\`${forcedSkills.map((name) => `「${name}」`).join("")}构思本路标。` : "";
	return `【进度】${parts.join("；")}。${packs}${forced}`;
}

/** 轻量历史回照预判：普通拍不发云端 embedding，明确过去/旧账信号才进入召回。 */
export function shouldRecallHistory(userText: string): boolean {
	if (/还记得|记得吗|第一次|初次|初遇|当年|那天|那次|曾经|旧事|回想|回忆|再次提到|又提到|那把|那封|那个约定|你说过|我说过|从头(讲|说|聊|回忆|梳理)|一路走来|这一路|这些年|往事|来龙去脉|经历了(什么|哪些)|整个过程|怎么(走到|变成|发展到)/u.test(userText)) return true;
	// Bare temporal modifiers such as "以前的几个朋友" describe a noun;
	// they are not a request to retrieve old story facts.
	return /(?:以前|过去|之前)(?:.{0,12})(?:发生|提到|见过|认识|说过|答应|约定|经历|相处|故事|事情)/u.test(userText);
}

export function classifyRecallIntent(userText: string): "point" | "sweep" {
	return /从头(讲|说|聊|回忆|梳理)|一路走来|这一路|这些年|往事|来龙去脉|经历了(什么|哪些)|整个过程|怎么(走到|变成|发展到)|从(相识|初遇|第一次见面)(讲|说|聊|回忆|起)/u.test(userText)
		? "sweep"
		: "point";
}

/** 用户本拍明确要求推进时间或移动场景时，放开单拍边界。 */
export function userAuthorizesTransition(userText: string): boolean {
	return /(?:跳到|推进到|切到|转到|等到|来到|前往|赶往|去往|回到|离开|出发去|带我去).{0,24}|(?:^|[我你他她它咱们，。！？!?\s])到(?:了)?[^，。！？!?]{0,24}|(?:^|[，。！？!?\s])(?:次日|翌日|第二天|几天后|数日后|数小时后|稍后|片刻后|放学后|傍晚|夜晚|深夜)(?:[，。！？!?\s]|$).{0,20}(?:继续|开始|去|到|见|找|做|发生)/u.test(userText);
}

export function isToolUnsupportedError(error: string): boolean {
	return isNativeToolsUnsupported(error);
}

export function looksLikeTextualToolProtocol(text: string): boolean {
	const source = text.trim();
	if (!source) return false;
	if (/<[｜|]{0,2}DSML[｜|]{0,2}(?:tool_calls|invoke)|<\/?(?:tool_call|function_call|invoke)\b/i.test(source)) return true;
	return /^(?:```(?:json)?\s*)?(?:beat_plan|beat_step_done|draft_append|draft_write|draft_edit|draft_seal|world_state_update|lorebook_search|memory_search)\s*\(/i.test(source);
}

export function extractPureTextNarrative(text: string): string {
	// Some card presets wrap the complete answer in a narrative container. The
	// generic panel stripper treats every top-level tag as non-prose, so unwrap
	// these known body containers before removing nested status/option blocks.
	const preserved: string[] = [];
	let unwrapped = text.replace(/<(image(?:Tag)?|options)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, block => {
		const token = `\uE000LIYUAN_PRESENTATION_${preserved.length}\uE001`;
		preserved.push(block); return token;
	});
	let outerRemoved = false;
	// Cards may nest both known prose containers (main_output > content).
	// Unwrap every outer body layer before the generic format-block stripper;
	// a missing closing tag must preserve already-generated prose as well.
	while (true) {
		const open = /<(content|main_output)\b[^>]*>/i.exec(unwrapped);
		if (open?.index === undefined || (outerRemoved && unwrapped.slice(0, open.index).trim())) break;
		const bodyStart = open.index + open[0].length;
		let bodyEnd = unwrapped.length, nesting = 1;
		const sameTag = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, "gi");
		for (const tag of unwrapped.slice(bodyStart).matchAll(sameTag)) {
			if (tag[1]) nesting--;
			else if (!/\/\s*>$/.test(tag[0])) nesting++;
			if (nesting === 0) { bodyEnd = bodyStart + tag.index!; break; }
		}
		unwrapped = unwrapped.slice(bodyStart, bodyEnd);
		outerRemoved = true;
	}
	// Remove complete format blocks while preserving narrative before and after
	// them. If a provider stops inside a final format block, the tag scanner's
	// hanging-block rule drops that unfinished tail without dropping earlier prose.
	const body = extractDraftBody(unwrapped);
	if (!body.replace(/\uE000LIYUAN_PRESENTATION_\d+\uE001/g, "").trim()) return "";
	return body.replace(/\uE000LIYUAN_PRESENTATION_(\d+)\uE001/g, (_, index) => preserved[Number(index)] ?? "");
}

const WRITER_STREAM_TIMEOUT_MS = 900_000;

async function* streamWithTimeout(
	stream: AsyncIterable<StageStreamEvent>,
	timeoutMs = WRITER_STREAM_TIMEOUT_MS,
	signal?: AbortSignal,
): AsyncGenerator<StageStreamEvent> {
	const iterator = stream[Symbol.asyncIterator]();
	const deadline = Date.now() + timeoutMs;
	try {
		while (true) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`主演请求超时（${timeoutMs}ms）`);
			let timer: ReturnType<typeof setTimeout> | undefined;
			let onAbort: (() => void) | undefined;
			try {
				const stopped = new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(new Error("主演请求已取消"));
					if (signal?.aborted) onAbort();
					else signal?.addEventListener("abort", onAbort, { once: true });
				});
				const result = await Promise.race([
					iterator.next(),
					stopped,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => reject(new Error(`主演请求超时（${timeoutMs}ms）`)), remaining);
					}),
				]);
				if (result.done) return;
				yield result.value;
			} finally {
				if (timer) clearTimeout(timer);
				if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			}
		}
	} finally {
		// 某些坏网关不响应 abort/return；不能再 await 它，否则超时保护本身也会卡住。
		void iterator.return?.();
	}
}

export function sideTextTimeoutMs(step: SideModelStep): number {
	if (step === "writer") return 900_000;
	if (step === "compaction") return 120_000;
	if (step === "memoryEvents") return 60_000;
	// The configured side models can spend well over a minute on structured
	// Chinese planning. Keep a finite per-step cap without killing valid work.
	return 600_000;
}

export function sideTextRetryLimit(step: SideModelStep): number {
	if (step.startsWith("director")) return 0;
	if (step === "writer") return MODEL_MAX_RETRIES;
	if (step === "memoryEvents") return 1;
	return Math.min(3, MODEL_MAX_RETRIES);
}

/** 判定注入：收笔前一次性；不回报篇幅，续写/收笔归模型判断。 */
export function verdictInjection(_userName: string): string {
	return "【判定】继续写正文用 `draft_append`，修订用 `draft_edit`，完成本拍用 `draft_seal`。";
}

/**
 * PLAN-RP-MEMORY：召回命中 → 注入块。
 * kind 标注〔事件〕/〔纪要〕/〔早期归档〕，注入块不敦促模型逐字复述。
 */
function formatMemoryRecallHit(
	h: MemoryRecallHitLike,
	_index: number,
): { tag: string; kind: "event" | "digest" | "evidence"; text: string } | null {
	if (!h?.text) return null;
	const kind = h.meta?.kind;
	const tag = (kind === "event" && h.meta?.eventId)
		? `${h.meta.eventId}`
		: h.meta?.title || (kind === "event" ? "事件" : kind === "evidence" ? "早期归档" : "纪要");
	let kindLabel: "event" | "digest" | "evidence";
	if (kind === "event") kindLabel = "event";
	else if (kind === "evidence") kindLabel = "evidence";
	else kindLabel = "digest";
	let readable = h.text;
	if (kind === "event") {
		try {
			const event = JSON.parse(h.text) as { title?: string; summary?: string; tags?: string[]; recallAnchors?: string[] };
			readable = [event.title, event.summary, event.tags?.length ? `标签：${event.tags.join("、")}` : ""].filter(Boolean).join("\n");
		} catch {
			// 旧事件块不是 JSON 时保留原文。
		}
	}
	const text = readable.length > 600 ? `${readable.slice(0, 600)}…` : readable;
	return { tag, kind: kindLabel, text };
}

/** 解析事件候选旁路输出：{ events: RpEventDigest[] }，宽容解析（剥围栏/首 { 试切）。 */
function parseMemoryEventPayload(text: string, allowedRefs: Array<{ entryId: string; entryType?: string; turn?: number; textBasis?: "rpNarrative" | "entryText"; charFrom?: number; charTo?: number }> = []): import("../memory/types.ts").RpEventDigest[] | null {
	let t = text.trim();
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) t = fence[1].trim();
	let idx = 0;
	while (true) {
		const start = t.indexOf("{", idx);
		if (start === -1) break;
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		for (let i = start; i < t.length; i++) {
			const ch = t[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if ( ch === '"') inStr = false;
				continue;
			}
			if ( ch === '"') inStr = true;
			else if ( ch === "{") depth++;
			else if ( ch === "}") {
				depth--;
				if (depth === 0) { end = i; break; }
			}
		}
		if (end === -1) break;
		try {
			const obj = JSON.parse(t.slice(start, end + 1)) as { events?: unknown };
			if (!obj || typeof obj !== "object" || !Array.isArray(obj.events)) { idx = start + 1; continue; }
			const out: import("../memory/types.ts").RpEventDigest[] = [];
			for (const e of obj.events) {
				if (!e || typeof e !== "object") continue;
				const o = e as Record<string, unknown>;
				if (typeof o.id !== "string" || !o.id) continue;
				if (typeof o.title !== "string" || !o.title.trim()) continue;
				const importance = o.importance === "core" || o.importance === "major" || o.importance === "normal" ? o.importance : "normal";
				out.push({
					kind: "rp-event-digest",
					id: o.id,
					...(o.op === "create" || o.op === "skip" || (typeof o.op === "string" && o.op.startsWith("merge:")) ? { op: o.op as import("../memory/types.ts").RpEventDigest["op"] } : {}),
					...(typeof o.sourceKey === "string" && o.sourceKey ? { sourceKey: o.sourceKey } : {}),
					title: String(o.title),
					status: o.status === "active" || o.status === "candidate" || o.status === "resolved" || o.status === "retired" ? o.status : "active",
					importance,
					tags: Array.isArray(o.tags) ? o.tags.map(String).filter(Boolean) : [],
					recallAnchors: Array.isArray(o.recallAnchors) ? o.recallAnchors.map(String).filter(Boolean) : [],
					summary: typeof o.summary === "string" ? o.summary : "",
					evidenceLevel: o.evidenceLevel === "source-backed" ? "source-backed" : "summary-only",
					...(typeof o.time === "string" && o.time ? { time: o.time } : {}),
					...(typeof o.location === "string" && o.location ? { location: o.location } : {}),
					...(Array.isArray(o.participants) ? { participants: o.participants.map(String).filter(Boolean) } : {}),
					...(typeof o.arc === "string" && o.arc.trim() ? { arc: o.arc.trim() } : {}),
					...(Array.isArray(o.links) ? {
						links: o.links
							.filter((link): link is Record<string, unknown> => !!link && typeof link === "object" && typeof (link as Record<string, unknown>).to === "string")
							.filter((link) => ["caused_by", "evolved_from", "resolved_the", "contradicts"].includes(String(link.type)))
							.map((link) => ({ to: String(link.to), type: String(link.type) as import("../memory/types.ts").RpEventLinkType, ...(typeof link.note === "string" ? { note: link.note } : {}) }))
					} : {}),
					sourceRefs: Array.isArray(o.sourceRefs)
						? o.sourceRefs
							.filter((ref): ref is Record<string, unknown> => !!ref && typeof ref === "object" && typeof (ref as Record<string, unknown>).entryId === "string")
							.filter((ref) => allowedRefs.length === 0 || allowedRefs.some((allowed) => allowed.entryId === ref.entryId))
							.map((ref) => {
								const host = allowedRefs.find((allowed) => allowed.entryId === ref.entryId);
								const lower = host?.charFrom ?? 0, upper = host?.charTo;
								const requestedFrom = typeof ref.charFrom === "number" && Number.isFinite(ref.charFrom) ? Math.floor(ref.charFrom) : host?.charFrom;
								const requestedTo = typeof ref.charTo === "number" && Number.isFinite(ref.charTo) ? Math.floor(ref.charTo) : upper;
								const charFrom = requestedFrom === undefined ? undefined : Math.max(lower, Math.min(upper ?? requestedFrom, requestedFrom));
								const charTo = requestedTo === undefined ? undefined : Math.max(charFrom ?? lower, Math.min(upper ?? requestedTo, requestedTo));
								return { entryId: String(ref.entryId), entryType: host?.entryType ?? (typeof ref.entryType === "string" ? ref.entryType : undefined),
									turn: host?.turn ?? (typeof ref.turn === "number" ? ref.turn : undefined), ...(charFrom !== undefined ? { charFrom } : {}),
									...(charTo !== undefined ? { charTo } : {}), ...(host?.textBasis ? { textBasis: host.textBasis } : {}) };
							})
						: [],
				});
			}
			return out;
		} catch {
			idx = start + 1;
		}
	}
	return null;
}

/** 进度行替换语义：移除 convo 里上一条【进度】再推新行（判定/记账/谢幕一次性，不替换） */
function replaceProgressLine(convo: unknown[], line: string): void {
	for (let k = convo.length - 1; k >= 0; k--) {
		const msg = convo[k] as { role?: string; content?: Array<{ type?: string; text?: string }> };
		const txt = Array.isArray(msg.content) ? msg.content.map((c) => c.text ?? "").join("") : "";
		if (msg.role === "user" && txt.startsWith("【进度】")) {
			convo.splice(k, 1);
			break;
		}
	}
	convo.push(nowMsg(line));
}

/**
 * 定稿合并：稿件为主体；text 通道里**格式特征**的尾巴（状态栏占位 / catsay / w2g…）
 * 拼回，纯文本增量（闲聊收笔）丢弃——树上正文 = 用户最终该看到的全部内容。
 *
 * 模型常把 draft_write 理解成「交正文」，把格式栈尾巴走普通 text 通道输出。
 * 旧逻辑 `ws.draft.trim() ? ws.draft : text` 是二选一，尾巴连同 token 一起被丢弃
 * （8/05 实锤：模型思考里宣告「body, status bar, and cat commentary」，
 * draft_write 只交了 679 字正文，状态栏与咪咪点评凭空蒸发）。
 * 但也不能无脑全拼——纯文本尾巴（"就这样吧。"）是收笔闲聊，不该进正文。
 */
const TAG_NAME_SRC = "[A-Za-z_\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff.\\-]*";
const FENCE_LINE_RE = /^```/m;
const FENCE_BLOCK_RE = /```[\s\S]*?```/g;
/** 逐个扫标签名，用于跳过 fold/strip 类（它们不是格式内容） */
const TAG_SCAN_RE = new RegExp(`<(${TAG_NAME_SRC})(?:\\s[^>]*)?\\/?\\s*>`, "g");
/** 成对块，用于把 fold/strip 类整块从尾巴里剔掉 */
const SELF_CLOSING_RE = new RegExp(`<(${TAG_NAME_SRC})(?:\\s[^>]*)?\\/\\s*>`, "g");

/**
 * 尾巴里格式内容的起点（第一个尖括号标签或行首 ``` 围栏）；没有 → -1。
 *
 * 8/10 实弹收口：旧口径整串检验、整串拼接——元话语（收笔自检逐条、ask 开场白
 * 起了又劝退）挂在格式块前面时跟着一起进定稿（HK 5 会话 11 拍：7 个裸尾巴段
 * 里 3 个带元话语，41 个稿段 0 违约）。改为**只取格式内容**：从第一个标签/围栏
 * 起切，之前的自由文本一律丢弃；纯自由文本尾巴（闲聊收笔）仍整段不进正文。
 */
export const formatTailStart = (tail: string): number => {
	TAG_SCAN_RE.lastIndex = 0;
	let tag = -1;
	for (let m = TAG_SCAN_RE.exec(tail); m; m = TAG_SCAN_RE.exec(tail)) {
		if (classifyTag(m[1]!) === "unwrap") {
			tag = m.index;
			break;
		}
	}
	const fence = FENCE_LINE_RE.exec(tail)?.index ?? -1;
	if (tag < 0) return fence;
	return fence < 0 ? tag : Math.min(tag, fence);
};



/**
 * 尾巴 → **只留格式内容**：格式类标签块 + ``` 围栏块，按原序拼回；块之外的自由文本
 * 一律丢弃。
 *
 * 8/10 只挡了「格式块之前」的自由文本（起点切一刀）。8/16 实弹暴露另一半：模型在
 * 尾巴里把**整段正文重述了一遍**，夹在 `<time_format>` 与 `<options>` 之间——起点切
 * 不到它（它在第一个格式块之后），`trimContentBodyRepeat` 也管不到（它只认
 * `<content>` 包裹的重述）。于是定稿里正文出现两遍。
 *
 * 判据仍是「块 vs 非块」，不认名字：块＝成对标签（policy 由 classifyTag 定，fold/strip
 * 类不算格式内容）或 ``` 围栏。
 */
const formatContentOnly = (tail: string): string => {
	type Span = { start: number; end: number; text: string };
	const spans: Span[] = [];
	// 先剥 HTML 注释再扫块（同 extractDraftBody）：注释里的 `<Prism>` 这类会被当成无闭合
	// 标签，一路吃到文末，把注释后面的裸重述正文整段包进「格式块」（8/16 实弹踩到）。
	const src = tail.replace(/<!--[\s\S]*?-->/g, "");
	FENCE_BLOCK_RE.lastIndex = 0;
	for (let m = FENCE_BLOCK_RE.exec(src); m; m = FENCE_BLOCK_RE.exec(src)) {
		spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	}
	for (const b of scanTaggedBlocks(src)) {
		if (b.policy !== "unwrap") continue; // fold/strip 类不是格式内容
		if (b.hanging) continue; // 无闭合＝不是成形的格式块，别拿它当筐把正文装进来
		spans.push({ start: b.start, end: b.end, text: b.raw });
	}
	// 自闭合格式标签（`<StatusPlaceHolderImpl/>` 这类占位符）——scanTaggedBlocks 只找成对块
	SELF_CLOSING_RE.lastIndex = 0;
	for (let m = SELF_CLOSING_RE.exec(src); m; m = SELF_CLOSING_RE.exec(src)) {
		if (classifyTag(m[1]!) !== "unwrap") continue;
		spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	}
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const kept: Span[] = [];
	for (const s of spans) {
		const last = kept[kept.length - 1];
		if (last && s.start < last.end) continue; // 被前一块覆盖（嵌套/重叠）
		kept.push(s);
	}
	return kept
		.map((s) => s.text.trim())
		.filter(Boolean)
		.join("\n\n");
};

/**
 * 逐字相同的格式块去重（8/10 实弹：预设状态栏规则＋谢幕注入双指令源下，
 * 模型把同一份状态栏在一条尾巴里输出了两遍）。零名单零识别——块＝任意
 * `<Tag>…</Tag>`，只删与已见块**完全相同**的重复，内容有任何差异都不动。
 */
export const dedupeIdenticalBlocks = (s: string): string => {
	const seen = new Set<string>();
	return s
		.replace(/<([A-Za-z][\w-]*)>[\s\S]*?<\/\1>/g, (block) => {
			const key = block.trim();
			if (seen.has(key)) return "";
			seen.add(key);
			return block;
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
};

/**
 * 有些 ST 卡要求谢幕时重交 `<main_output><content>正文…` 整包。梨园的正文已经在
 * 稿纸里，若照收会把同一段故事落树两次。这里保留卡的容器与 content 内格式件，
 * 但以稿纸替换 content 里的自由文本；正文仍只有一个权威来源。
 */
export const mergeWrappedContent = (draft: string, text: string): string | null => {
	const open = /<content(?:\s[^>]*)?>/i.exec(text);
	if (!open || open.index === undefined) return null;
	const bodyStart = open.index + open[0].length;
	const close = /<\/content\s*>/i.exec(text.slice(bodyStart));
	if (!close || close.index === undefined) return null;
	const bodyEnd = bodyStart + close.index;
	const inner = text.slice(bodyStart, bodyEnd);
	const blocks = inner.match(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>|<([A-Za-z_][\w.-]*)(?:\s[^>]*)?\s*\/>|```[\s\S]*?```/g) ?? [];
	const beforeDraft: string[] = [];
	const afterDraft: string[] = [];
	for (const block of blocks) {
		const tag = /^<([A-Za-z_][\w.-]*)/i.exec(block)?.[1]?.toLowerCase();
		if (tag === "time" || tag === "ai_guide") beforeDraft.push(block.trim());
		else afterDraft.push(block.trim());
	}
	const content = [...beforeDraft, draft.trim(), ...afterDraft].filter(Boolean).join("\n\n");
	return `${text.slice(0, bodyStart)}\n${content}\n${text.slice(bodyEnd)}`.trim();
};

export const mergeFinalText = (draft: string, text: string): string => {
	const d = draft.trim();
	const t = text.trim();
	if (!d) {
		// 空工作区不能让状态栏或样式围栏冒充正文落树。普通直出正文仍原样保留。
		const body = extractDraftBody(t);
		const formatOnly = !body || /^```(?:css|html)?\s*[\s\S]*```$/i.test(body);
		return formatOnly ? "" : dedupeIdenticalBlocks(t);
	}
	if (!t || d === t) return d;
	// 稿件已包含 text（模型边写边交，text 是半截）：稿件已是全量
	if (d.includes(t)) return d;
	// ST 整包格式兼容：容器保留，content 的自由文本由权威稿纸替换。
	const wrapped = mergeWrappedContent(d, t);
	if (wrapped) return dedupeIdenticalBlocks(wrapped);
	// text 含稿件且稿件之前没有格式块时，取稿件之后的增量；格式在稿件两侧时必须整段扫块。
	const idx = t.indexOf(d);
	const prefix = idx > 0 ? t.slice(0, idx) : "";
	const tail = idx >= 0 && formatTailStart(prefix) < 0 ? t.slice(idx + d.length) : t;
	const from = formatTailStart(tail);
	if (from < 0) return d;
	// 尾巴只留格式内容（块之外的自由文本／重述正文一律丢）；`<content>` 里重述的正文再裁一次
	const tailPart = formatContentOnly(tail.slice(from))
		.replace(/<content>([\s\S]*?)<\/content>/g, (whole, inner: string) => {
			const trimmed = trimContentBodyRepeat(d, inner);
			return trimmed ? `<content>${trimmed}</content>` : "";
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return dedupeIdenticalBlocks([d, tailPart].filter(Boolean).join("\n\n"));
};

export class StageEngine {
	#deps: StageEngineDeps;
	#backgroundController: AbortController | null = null;
	#pendingBackground: (() => void) | null = null;
	#backgroundTimer: ReturnType<typeof setTimeout> | undefined;

	#busy = false;
	#queue: Array<{ text: string; sessionId: string; cardPath: string; submission?: StageSubmission; resolve: () => void; reject: (error: unknown) => void }> = [];
	#abort: AbortController | null = null;
	#warnedMacros = "";
	#warnedAuditDrop = 0;
	#warnedProtocolDrop = "";
	#warnedSideModelFallbacks = new Set<string>();
	#lastAssemblyJson = "";
	/** 当前拍在后台准备的双池任务；不阻塞正文，下一拍开始前消费并合并。 */
	#ecologyPoolPrep: Promise<{ cardPath: string; cardName: string; pools: ReturnType<typeof loadEcologyPools>; warnings: string[] }> | null = null;
	#ecologyPoolReady: { cardPath: string; cardName: string; pools: ReturnType<typeof loadEcologyPools>; warnings: string[] } | null = null;
	#ecologyPoolWrite = Promise.resolve();
	#memoryEventWrite = Promise.resolve();
	/** 非关键路径候选：本拍开始后台算，下一拍只在原分支后代上采用；永不阻塞当前正文。 */
	#literaryProfilePrepRunning = false;
	#literaryProfileReady: { sessionId: string; cardPath: string; sourceLeafId: string; data: LiteraryProfileData } | null = null;
	#worldProfilePrepRunning = false;
	#worldProfileReady: { sessionId: string; cardPath: string; sourceLeafId: string; profile: import("./literary-world-profile.ts").CardWorldProfile } | null = null;

	constructor(deps: StageEngineDeps) {
		this.#deps = deps;
	}

	get isStreaming(): boolean {
		return this.#busy;
	}

	/** 用户新输入开一拍：先落 user 消息再开演；忙时排队（流式中送达的输入不打断叙事） */
	async performTurn(userText: string, submission?: StageSubmission): Promise<void> {
		submission = submission ? { ...submission } : undefined;
		const submittedMode = submission?.generationMode ?? loadStageConfig(this.#deps.cwd).generationMode;
		if (isGenerationMode(submittedMode)) submission = { ...submission, generationMode: submittedMode };
		this.#validateSubmission(submission);
		if (this.#busy) {
			const sm = this.#deps.getSessionManager();
			const cardPath = loadStageConfig(this.#deps.cwd).card;
			return new Promise<void>((resolve, reject) => this.#queue.push({ text: userText, sessionId: sm.getSessionId(), cardPath, submission, resolve, reject }));
		}
		await this.#run(userText, undefined, submission);
		await this.#drain();
	}

	/** 正文阶段再生成：叶已钉在 user，复用上一版拍前工件，直接从 writer 开始。 */
	async regenerate(prep?: StageRerollPrep): Promise<void> {
		if (this.#busy) return;
		await this.#run(null, prep);
		await this.#drain();
	}

	/** 只重生成当前回复的非正文格式；正文、账本和后台世界快照均保持不动。 */
	async regenerateCurtain(): Promise<void> {
		if (this.#busy) return;
		const ev = this.#deps.events ?? {};
		this.#busy = true;
		this.#abort = new AbortController();
		ev.onTurnStart?.();
		try {
			const sm = this.#deps.getSessionManager();
			const branch = sm.getBranch() as BranchEntryLike[];
			let target: BranchEntryLike | undefined;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				const details = entry.message?.details;
				if (entry.type === "message" && entry.message?.role === "assistant" && details && typeof details === "object" && typeof (details as Record<string, unknown>).rpNarrative === "string") {
					target = entry;
					break;
				}
			}
			if (!target?.id || !target.message?.details || typeof target.message.details !== "object") {
				ev.onNotify?.("error", "当前分支没有可重生成状态栏的正文。");
				return;
			}
			const details = target.message.details as Record<string, unknown>;
			const narrative = String(details.rpNarrative ?? "").trim();
			if (!narrative) {
				ev.onNotify?.("error", "当前回复没有独立正文工件。");
				return;
			}
			const materials = loadStageMaterials(this.#deps.cwd);
			if (isGenerationMode(details.rpGenerationMode)) {
				const result = await this.#deliverAgentPresentation(materials, sm, String(target.id), narrative,
					typeof details.rpAuthorDraft === "string" ? details.rpAuthorDraft : narrative,
					anchor => this.#deps.getSessionManager() === sm && turnLeafIsStable(sm, anchor));
				if (!result.ok) ev.onNotify?.("error", `卡格式重做失败：${result.error}；原有交付保持不变。`);
				else ev.onActivity?.("卡格式完整交付已更新，正文事实保持不变");
				return;
			}
			const curtainSkill = workflowSkill(materials.skillFiles, "curtain");
			const boundedMaterials = buildCurtainRerollMaterials({ card: materials.card, entries: materials.entries, preset: materials.preset, statusBarFormats: materials.statusBarFormats });
			const systemPrompt = `你在执行梨园的独立格式收尾。正文已经冻结，禁止复述、改写、概括或包裹正文。只生成 materials.formatPlan.modelTags；deterministicTags 由代码补齐，nativeTags 由梨园权威状态投影，forbiddenTags 禁止输出。不得借用历史回复或其他角色卡的格式。输出完整闭合后立即结束。\n\n# 工作流 Skill\n${curtainSkill?.body ?? "严格依据 formatPlan 生成当前卡要求的模型格式。"}`;
			const userText = JSON.stringify({
				materials: boundedMaterials,
				frozen_narrative: narrative,
				current_state: stateFromBranch(branch),
				current_world: literaryWorldFromBranch(branch),
				previous_curtain: typeof details.rpCurtain === "string" ? details.rpCurtain : "",
			}, null, 2);
			ev.onActivity?.(`状态栏重Roll素材：${userText.length.toLocaleString()} 字（已裁剪，未送料 rawCard/完整世界书）`);
			ev.onActivity?.("状态栏重Roll：复用正文，仅重做非正文格式");
			// 不替用户决定思考档：省略 reasoning，让 writer 模型完全采用上游默认行为。
			const result = await this.#sideText("writer", systemPrompt, userText, 32768, undefined);
			if (typeof result !== "string") {
				ev.onNotify?.("error", `状态栏重Roll失败：${result.error}`);
				return;
			}
			const nextCurtain = finalizeCurtainText(result, boundedMaterials.formatPlan);
			// 只接受像完整交付的结果。上游默认思考偶尔会只吐出一个起始“<”；
			// 这种截断不能覆盖当前可用状态栏，更不能落树永久污染刷新结果。
			const tagStack: string[] = [];
			for (const match of nextCurtain.matchAll(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g)) {
				const full = match[0];
				const name = match[1].toLowerCase();
				if (/^<\//.test(full)) {
					if (tagStack[tagStack.length - 1] === name) tagStack.pop();
				} else if (!/\/>$/.test(full) && !["br", "hr", "img", "input", "meta", "link"].includes(name)) {
					tagStack.push(name);
				}
			}
			if (nextCurtain.length < 8 || nextCurtain === "<" || tagStack.length > 0) {
				ev.onNotify?.("error", "状态栏重Roll结果不完整，已保留原状态栏。系统不会自动重试；如需再试，请手动点击“重Roll状态栏”。");
				return;
			}
			if (sm.getLeafId() !== branch[branch.length - 1]?.id) {
				ev.onNotify?.("warning", "状态栏结果已丢弃：生成期间切换了分支。");
				return;
			}
			sm.appendCustomEntry("rp-curtain-override", {
				targetEntryId: target.id,
				curtain: nextCurtain,
				createdAt: Date.now(),
			});
			sm.flush();
			ev.onActivity?.("状态栏已生成新版本");
		} catch (error) {
			ev.onNotify?.("error", `状态栏重Roll失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#abort = null;
			this.#busy = false;
			// 没有新正文 entryId：宿主据此不会把状态栏重Roll误当成新剧情归档。
			ev.onTurnEnd?.({ aborted: false });
		}
	}

	async retryPendingSettlement(): Promise<StageTurnEndInfo> {
		if(this.#busy)return {aborted:false,error:"正在生成，请先等待或停止"};
		const sm=this.#deps.getSessionManager(),sessionId=sm.getSessionId(),ev=this.#deps.events??{};
		const calls:ModelAttemptDiagnostic[]=[],obs:StageRequestObservation={phase:"settlement.recovery",diagnostics:calls};
		this.#busy=true;this.#abort=new AbortController();ev.onTurnStart?.();let result:StageTurnEndInfo={aborted:false};
		const timer=setTimeout(()=>this.#abort?.abort(),(loadStageConfig(this.#deps.cwd).generationTimeoutMinutes??60)*60000);
		try { const materials=loadStageMaterials(this.#deps.cwd);await this.#recoverPendingTurn(materials,sm,ev,anchor=>this.#deps.getSessionManager()===sm&&sm.getSessionId()===sessionId&&turnLeafIsStable(sm,anchor),obs); }
		catch(e){result={aborted:!!this.#abort?.signal.aborted,error:e instanceof Error?e.message:String(e)};ev.onNotify?.("error",result.error??"恢复失败");}
		finally{
			clearTimeout(timer);if(calls.length&&this.#deps.getSessionManager()===sm){const receipt=[...(sm.getBranch() as BranchEntryLike[])].reverse().find(e=>e.customType==="rp-turn-settlement")?.data as {narrativeEntryId?:string}|undefined;sm.appendCustomEntry("rp-model-diagnostics",{version:1,narrativeEntryId:receipt?.narrativeEntryId??null,calls});sm.flush();}
			this.#busy=false;this.#abort=null;ev.onTurnEnd?.(result);
		}
		if(result.error){for(const queued of this.#queue.splice(0))queued.reject(new Error("结算尚未恢复，新输入未受理；草稿保留"));}
		else void this.#drain();
		return result;
	}

	/** 强制停止本拍：已流出的部分正文仍落树可见 */
	abort(): void {
		this.#abort?.abort(); this.#backgroundController?.abort(); clearTimeout(this.#backgroundTimer); this.#pendingBackground = null;
		const queued = this.#queue.splice(0);
		for (const item of queued) item.reject(new Error("本拍已停止，排队输入已取消"));
	}

	async #drain(): Promise<void> {
		while (this.#queue.length > 0 && !this.#busy) {
			const next = this.#queue.shift();
			if (!next) continue;
			const sm = this.#deps.getSessionManager();
			if (sm.getSessionId() !== next.sessionId || loadStageConfig(this.#deps.cwd).card !== next.cardPath) {
				next.reject(new Error("排队期间切换了会话或角色卡，输入已取消"));
				continue;
			}
			try { await this.#run(next.text, undefined, next.submission); next.resolve(); } catch (error) { next.reject(error); }
		}
	}

	#validateSubmission(submission?: StageSubmission): void {
		if (submission?.expectedSessionId !== undefined && submission.expectedSessionId !== this.#deps.getSessionManager().getSessionId()) {
			throw new Error("输入绑定的会话已变化，未接受此输入");
		}
	}

	#consumeEcologyPoolPrep(cardPath: string, cardName: string): void {
		const candidate = this.#ecologyPoolReady;
		if (!candidate) return;
		if (candidate.cardPath !== cardPath) { this.#ecologyPoolReady = null; return; }
		this.#ecologyPoolReady = null;
		this.#ecologyPoolWrite = this.#ecologyPoolWrite.then(() => {
			// 重新读取最新池再合并，避免覆盖 aftermath 刚累计的 useCount。
			const latest = loadEcologyPools(this.#deps.cwd, cardPath, cardName);
			const global = normalizeEcologyGlobalPool(candidate.pools.global, latest.global) ?? latest.global;
			const card = normalizeEcologyCardPool(candidate.pools.card, latest.card) ?? latest.card;
			saveEcologyPools(this.#deps.cwd, cardPath, { global, card });
			for (const warning of candidate.warnings) this.#deps.events?.onActivity?.(warning);
			this.#deps.events?.onActivity?.(`鲜活世界备料完成：全局 ${global.prototypes.length} 原型 / 本卡 ${card.templates.length} 模板`);
		}).catch(() => undefined);
	}

	#branchContains(branch: BranchEntryLike[], entryId: string): boolean {
		return branch.some((entry) => entry.id === entryId);
	}

	/** 下一拍采用已完成的文学画像；尚在运行就继续用旧画像，不等待。 */
	#consumeLiteraryProfileReady(cardPath: string): void {
		const ready = this.#literaryProfileReady;
		if (!ready) return;
		const sm = this.#deps.getSessionManager();
		if (ready.sessionId !== sm.getSessionId() || ready.cardPath !== cardPath || !this.#branchContains(sm.getBranch() as BranchEntryLike[], ready.sourceLeafId)) {
			this.#literaryProfileReady = null;
			return;
		}
		sm.appendCustomEntry(LITERARY_PROFILE_ENTRY_TYPE, ready.data);
		sm.flush();
		this.#literaryProfileReady = null;
		this.#deps.events?.onActivity?.("文学画像：后台候选已在本拍采用");
	}

	#startLiteraryProfilePrep(materials: StageMaterials, branch: BranchEntryLike[]): void {
		if (this.#literaryProfilePrepRunning || this.#literaryProfileReady) return;
		const { config, card } = materials;
		if (config.literaryQuality !== "profile" && config.literaryQuality !== "guided") return;
		if (!shouldRefreshLiteraryProfile(branch, config.literaryProfileEveryNTurns ?? 8)) return;
		const sm = this.#deps.getSessionManager();
		const sourceLeafId = sm.getLeafId();
		if (!sourceLeafId) return;
		const sessionId = sm.getSessionId();
		const { history, summary } = rebuildHistory(branch);
		const state = stateFromBranch(branch);
		const previous = literaryProfileFromBranch(branch);
		const characterPrompt = buildCharacterProfilePrompt({ card, state, summary, history, userName: config.userName });
		const personaPrompt = buildPersonaProfilePrompt({ userPersona: config.userPersona, userMessages: history.filter((message) => message.role === "user").map((message) => message.text), summary, recentStory: history, userName: config.userName });
		this.#literaryProfilePrepRunning = true;
		this.#deps.events?.onActivity?.("文学画像：已在后台更新，完成后下一拍生效");
		void Promise.all([
			this.#sideText("literaryCharacter", `${characterPrompt.systemPrompt}\n\n# 工作流 skill：Sogon\n${workflowSkill(materials.skillFiles, "character")?.body ?? ""}`, characterPrompt.userText, 8192, "off", undefined),
			this.#sideText("literaryPersona", `${personaPrompt.systemPrompt}\n\n# 工作流 skill：Sigon\n${workflowSkill(materials.skillFiles, "persona")?.body ?? ""}`, personaPrompt.userText, 6144, "off", undefined),
		]).then(([characterResult, personaResult]) => {
			const warnings: string[] = [];
			const character = typeof characterResult === "string" ? normalizeLiteraryArtifact(characterResult, 16_000) : (warnings.push(`角色画像：${characterResult.error}`), previous?.character);
			const persona = typeof personaResult === "string" ? normalizeLiteraryArtifact(personaResult, 10_000) : (warnings.push(`用户画像：${personaResult.error}`), previous?.persona);
			if (character || persona) this.#literaryProfileReady = { sessionId, cardPath: config.card, sourceLeafId, data: { version: 1, sourceLeafId, completedTurns: countCompletedNarrativeTurns(branch), ...(character ? { character } : {}), ...(persona ? { persona } : {}), ...(warnings.length ? { warnings } : {}) } };
		}).catch((error) => console.error(`[stage-literary-profile] 后台更新失败：${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.#literaryProfilePrepRunning = false; });
	}

	#consumeWorldProfileReady(materials: StageMaterials): void {
		const ready = this.#worldProfileReady;
		if (!ready) return;
		const sm = this.#deps.getSessionManager();
		const branch = sm.getBranch() as BranchEntryLike[];
		if (ready.sessionId !== sm.getSessionId() || ready.cardPath !== materials.config.card || !this.#branchContains(branch, ready.sourceLeafId)) {
			this.#worldProfileReady = null;
			return;
		}
		saveCardWorldProfile(this.#deps.cwd, materials.config.card, ready.profile, materials.card);
		if (!worldManifestFromBranch(branch, ready.profile.cardKey)) sm.appendCustomEntry(WORLD_MANIFEST_ENTRY_TYPE, manifestFromProfile(ready.profile));
		sm.flush();
		this.#worldProfileReady = null;
		this.#deps.events?.onActivity?.("角色卡世界画像：后台候选已在本拍采用");
	}

	#startWorldProfilePrep(materials: StageMaterials, branch: BranchEntryLike[]): void {
		if (this.#worldProfilePrepRunning || this.#worldProfileReady || materials.config.literaryWorldEnabled !== true) return;
		const { config, card } = materials;
		const fingerprint = worldProfileFingerprint({ card, entries: materials.entries, preset: materials.preset, greetingIndex: config.greetingIndex });
		const profile = loadCardWorldProfile(this.#deps.cwd, config.card, card.name, fingerprint, card);
		if (!profileNeedsAnalysis(profile, fingerprint, countCompletedNarrativeTurns(branch))) return;
		const skill = workflowSkill(materials.skillFiles, "world-profile");
		const sm = this.#deps.getSessionManager();
		const sourceLeafId = sm.getLeafId();
		if (!skill || !sourceLeafId) return;
		const sessionId = sm.getSessionId();
		const prompt = buildWorldProfilePrompt({ skillBody: skill.body, card, entries: materials.entries, preset: materials.preset, greetingIndex: config.greetingIndex, previous: profile, recentHistory: rebuildHistory(branch).history });
		this.#worldProfilePrepRunning = true;
		this.#deps.events?.onActivity?.("角色卡世界画像：已在后台分析，完成后下一拍生效");
		void this.#sideText("worldProfile", prompt.systemPrompt, prompt.userText, 12288, "off", this.#backgroundController?.signal).then((result) => {
			if (typeof result !== "string") { this.#deps.events?.onActivity?.(`角色卡世界画像：后台分析失败（${result.error}）`); return; }
			const base = profile ?? defaultCardWorldProfile(this.#deps.cwd, config.card, card.name, fingerprint, card);
			const next = normalizeCardWorldProfile(result, base, { preserveStatus: !!profile, sourceFingerprint: fingerprint, analyzedTurns: countCompletedNarrativeTurns(branch) });
			if (next) {
				// 卡级画像不是分支运行态，生成成功即原子落盘；Manifest 仍在下一拍按来源叶采用。
				saveCardWorldProfile(this.#deps.cwd, config.card, next, card);
				this.#worldProfileReady = { sessionId, cardPath: config.card, sourceLeafId, profile: next };
			} else this.#deps.events?.onActivity?.("角色卡世界画像：输出不可解析，未覆盖旧画像");
		}).catch((error) => console.error(`[world-profile] 后台分析失败：${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.#worldProfilePrepRunning = false; });
	}

	#startEcologyPoolPrep(input: {
		cardPath: string;
		card: StageMaterials["card"];
		entries: StageMaterials["entries"];
		state: ReturnType<typeof stateFromBranch>;
		history: ReturnType<typeof rebuildHistory>["history"];
		userText: string;
		userName: string;
		globalSkill: NonNullable<ReturnType<typeof workflowSkill>>;
		cardSkill: NonNullable<ReturnType<typeof workflowSkill>>;
		pools: ReturnType<typeof loadEcologyPools>;
		signal?: AbortSignal;
	}): void {
		if (this.#ecologyPoolPrep || this.#ecologyPoolReady) return;
		const task = (async () => {
			let pools = input.pools;
			const warnings: string[] = [];
			const queryPrompt = buildEcologySearchPlanPrompt(input.globalSkill.body, { global: pools.global, card: input.card, state: input.state, userText: input.userText, userName: input.userName });
			const queryResult = await this.#sideText("ecologySearch", queryPrompt.systemPrompt, queryPrompt.userText, 2048, "off", input.signal);
			if (typeof queryResult !== "string") warnings.push(`鲜活世界备料：检索规划失败（${queryResult.error}）`);
			const queries = typeof queryResult === "string" ? ecologySearchQueries(queryResult) : [];
			const batches: Promise<import("../tools/web-research.ts").WebResearchItem[]>[] = [];
			if (this.#deps.webResearch) {
				for (let index = 0; index < queries.length; index += 3) {
					batches.push(this.#deps.webResearch(queries.slice(index, index + 3), 5, input.signal).catch(() => []));
				}
			}
			const research = (await Promise.all(batches)).flat();
			const usable = research.filter((item) => (item.results?.length ?? 0) > 0);
			if (usable.length) {
				const prompt = buildEcologyGlobalPrompt(input.globalSkill.body, { global: pools.global, research: usable, card: input.card, userText: input.userText });
				const result = await this.#sideText("ecologyGlobal", prompt.systemPrompt, prompt.userText, 16384, "off", input.signal);
				if (typeof result === "string") pools = { ...pools, global: normalizeEcologyGlobalPool(result, pools.global) ?? pools.global };
				else warnings.push(`鲜活世界备料：全局池失败（${result.error}）`);
			} else warnings.push("鲜活世界备料：本拍搜索无有效结果，保留全局池");
			const cardPrompt = buildEcologyCardPrompt(input.cardSkill.body, { global: pools.global, cardPool: pools.card, card: input.card, lore: input.entries, state: input.state, history: input.history });
			const cardResult = await this.#sideText("ecologyCard", cardPrompt.systemPrompt, cardPrompt.userText, 16384, "off", input.signal);
			if (typeof cardResult === "string") pools = { ...pools, card: normalizeEcologyCardPool(cardResult, pools.card) ?? pools.card };
			else warnings.push(`鲜活世界备料：角色卡池失败（${cardResult.error}）`);
			return { cardPath: input.cardPath, cardName: input.card.name, pools, warnings };
		})().catch((error) => ({ cardPath: input.cardPath, cardName: input.card.name, pools: input.pools, warnings: [`鲜活世界备料异常：${error instanceof Error ? error.message : String(error)}`] }));
		this.#ecologyPoolPrep = task;
		void task.then((candidate) => {
			if (input.signal?.aborted) { if(this.#ecologyPoolPrep===task)this.#ecologyPoolPrep=null; return; }
			if (this.#ecologyPoolPrep === task) {
				this.#ecologyPoolReady = candidate;
				this.#ecologyPoolPrep = null;
			}
		});
	}

	async #run(userText: string | null, rerollPrep?: StageRerollPrep, submission?: StageSubmission): Promise<void> {
		this.#validateSubmission(submission);
		clearTimeout(this.#backgroundTimer); this.#backgroundController?.abort(); this.#backgroundController = null; this.#pendingBackground = null;
		const ev = this.#deps.events ?? {};
		this.#busy = true;
		ev.onTurnStart?.();
		let endInfo: StageTurnEndInfo = { aborted: false };
		const cfg = loadStageConfig(this.#deps.cwd);
		const requestedMode = submission?.generationMode ?? rerollPrep?.generationMode ?? cfg.generationMode;
		const minutes = typeof cfg.generationTimeoutMinutes === "number" ? Math.max(1, Math.min(120, cfg.generationTimeoutMinutes)) : requestedMode === "director" ? 60 : 30;
		const controller = new AbortController(); this.#abort = controller;
		let budgetExpired = false;
		const budgetTimer = setTimeout(() => { budgetExpired = true; controller.abort(); ev.onNotify?.("error", `本拍总体预算${minutes}分钟已到，保留已有正文与未完成收据，不跳过失败阶段。`); }, minutes * 60_000);
		try {
			endInfo = await this.#turn(userText, rerollPrep, submission);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ev.onNotify?.("error", `本拍开演失败：${msg}`);
			endInfo = { aborted: false, error: msg };
		} finally {
			clearTimeout(budgetTimer);
			if (budgetExpired) endInfo = { ...endInfo, aborted: true, error: endInfo.error ?? "本拍总体时间预算耗尽" };
			this.#busy = false;
			this.#abort = null;
			ev.onTurnEnd?.(endInfo);
			if (!endInfo.aborted && !endInfo.error && this.#pendingBackground) {
				const launch = this.#pendingBackground;
				this.#backgroundTimer = setTimeout(() => { if (!this.#busy && !this.#queue.length && this.#pendingBackground === launch) { this.#pendingBackground = null; launch(); } }, 2000);
			}
		}
	}

	async #turn(userText: string | null, rerollPrep?: StageRerollPrep, submission?: StageSubmission): Promise<StageTurnEndInfo> {
		const { cwd, events: rawEv = {} } = this.#deps;
		const turnStartedAt = Date.now();
		const sm = this.#deps.getSessionManager();
		this.#abort ??= new AbortController();
		const turnSessionId = sm.getSessionId();
		const ownsSession = () => this.#deps.getSessionManager() === sm && sm.getSessionId() === turnSessionId;
		let discardPerformance = false;
		const stableLeaf = (anchor: string | null) => {
			const stable = ownsSession() && turnLeafIsStable(sm, anchor);
			if (!stable) discardPerformance = true;
			return stable;
		};
		const collector = new TurnPerformanceCollector();
		const modelDiagnostics: ModelAttemptDiagnostic[] = [];
		const preflight = new WriterContextPreflight();
		let committedNarrativeId: string | undefined;
		const beatLog: Array<{ ts: number; ev: string; data: string }> = [];
		const _blog = (event: string, data: string) => beatLog.push({ ts: Date.now(), ev: event, data });
		const ev: typeof rawEv = {
			...rawEv,
			onDelta: (kind, delta, draft, reset) => { if (draft && delta.trim()) collector.narrative(); _blog(draft ? "draft_delta" : kind === "thinking" ? "thinking" : "text", delta); rawEv.onDelta?.(kind, delta, draft, reset); },
			onStreamClear: () => { _blog("stream_clear", ""); rawEv.onStreamClear?.(); },
			onDraftResync: (segments) => { if (segments.some(segment => segment.trim())) collector.narrative(); _blog("draft_resync", segments.join("\n---\n")); rawEv.onDraftResync?.(segments); },
			onActivity: (detail) => { _blog("activity", detail); rawEv.onActivity?.(detail); },
			onNotify: (level, text) => { _blog("notify", `[${level}] ${text}`); rawEv.onNotify?.(level, text); },
		};

		const observation = (phase: PerformancePhase): StageRequestObservation => ({ collector, phase, diagnostics: modelDiagnostics, ...(phase === "writer" || phase === "curtain" ? { preflight, notify: (message: string) => ev.onNotify?.("warning", message) } : {}) });
		const turnSideText = (phase: PerformancePhase, step: SideModelStep, sp: string, ut: string, maxTokens = 8192, reasoning: string | undefined = "off", signal: AbortSignal | undefined = this.#abort?.signal) => this.#sideText(step, sp, ut, maxTokens, reasoning, signal, observation(phase));
		const repairStructured = (phase: PerformancePhase, step: SideModelStep, prompt: {systemPrompt:string;userText:string}, invalid:string, errors:string[], maxTokens=8192) => this.#repairStructured(step,prompt,invalid,errors,maxTokens,observation(phase));

		const measureAwait = async <T>(phase: PerformancePhase, work: Promise<T>): Promise<T> => {
			const end = collector.beginPhase(phase);
			try { const value = await work; end("success"); return value; }
			catch (error) { end("failed"); throw error; }
		};

		const endPrep = collector.beginPhase("prep");
		try {

		// 素材现读：改卡/改预设/挂书即时生效
		const materials = loadStageMaterials(cwd);
		const { config, card } = materials;
		const selectedMode = submission?.generationMode ?? rerollPrep?.generationMode ?? config.generationMode;
		// 无模式的 SDK 调用暂保留历史工具协议；Web 宿主始终绑定两种新模式之一。
		const generationMode = isGenerationMode(selectedMode) ? selectedMode : undefined;
		let agentWorkflow: GenerationWorkflow | undefined;
		const settlementWarnings: string[] = [];
		const pendingOwnerTools: Array<{ name: string; args: Record<string, unknown> }> = [];
		if (generationMode) await this.#recoverPendingTurn(materials, sm, ev, stableLeaf, observation("settlement.recovery"));
		// 非关键候选只消费已经完成的结果；尚未完成就沿用旧工件，绝不等它们出正文。
		if (userText !== null && !rerollPrep) {
			this.#consumeWorldProfileReady(materials);
			if (!generationMode) this.#consumeLiteraryProfileReady(config.card);
			// 生态双池同样不等待：后台尚未完成时，本拍继续用磁盘现有池。
			if (generationMode !== "direct") this.#consumeEcologyPoolPrep(config.card, card.name);
		}
		if (materials.macroWarnings.length > 0) {
			const key = materials.macroWarnings.join(",");
			if (key !== this.#warnedMacros) {
				this.#warnedMacros = key;
				ev.onNotify?.("warning", `预设含未支持的宏（已置空处理）：${materials.macroWarnings.join("、")}`);
			}
		}

		const baseModel = this.#deps.getModel();
		if (!baseModel) {
			ev.onNotify?.("error", "尚未配置剧情模型——请先在「连接」面板选择模型。");
			return { aborted: false, error: "no-model" };
		}
		const rawCardData = materials.rawCard.data && typeof materials.rawCard.data === "object" ? materials.rawCard.data as Record<string, unknown> : materials.rawCard;
		const rawExtensions = rawCardData.extensions && typeof rawCardData.extensions === "object" ? rawCardData.extensions as Record<string, unknown> : {};
		const isNovelPlayCard = !!(rawExtensions as { liyuanNovelPlay?: unknown }).liyuanNovelPlay;
		// Novel Play cards are created from a snapshot and must follow the current
		// session writer, not freeze the model routing that existed at card creation.
		const writerStepModels = isNovelPlayCard ? { ...(config.stepModels ?? {}), writer: undefined } : config.stepModels;
		// 主演插头（writer）：正文生成可单独指定高级模型；未配置则继承剧情总插头。
		// 旁路步骤（场记/压缩/导演等）走各自插头，不受这里影响。
		const resolved = resolveStepModel(
			"writer",
			writerStepModels,
			baseModel,
			(provider, id) => this.#deps.findModel?.(provider, id),
			(id) => this.#deps.findModelById?.(id),
		);
		let model = resolved.model ?? baseModel;
		if (resolved.fallback && resolved.requested) {
			const key = `writer:${resolved.requested.provider}/${resolved.requested.id}`;
			if (!this.#warnedSideModelFallbacks.has(key)) {
				this.#warnedSideModelFallbacks.add(key);
				ev.onNotify?.("warning", `主演插头配置的模型 ${resolved.requested.provider}/${resolved.requested.id} 不可用，本次已继承剧情总插头。`);
			}
		}
		this.#abort ??= new AbortController();

		let branch = sm.getBranch() as BranchEntryLike[];
		// 卡级画像已存在但当前分支尚无 Manifest 时，在新 user 落树之前播种。
		// assistant 必须保持为 user 的直接子节点，否则 reroll/swipe 无法识别 sibling 变体。
		const profileFingerprint = worldProfileFingerprint({ card, entries: materials.entries, preset: materials.preset, greetingIndex: config.greetingIndex });
		const existingWorldProfile = loadCardWorldProfile(cwd, config.card, card.name, profileFingerprint, card);
		if (userText !== null && config.literaryWorldEnabled === true && existingWorldProfile && !worldManifestFromBranch(branch, existingWorldProfile.cardKey)) {
			sm.appendCustomEntry(WORLD_MANIFEST_ENTRY_TYPE, manifestFromProfile(existingWorldProfile));
			sm.flush();
			branch = sm.getBranch() as BranchEntryLike[];
			ev.onActivity?.("角色卡世界画像：已为当前分支采用现有画像");
		}
		let expectedTurnLeafId = sm.getLeafId();
		if (userText !== null) {
			// 接受回执只代表 user 已可靠落树，不代表主演已生成成功。
			this.#validateSubmission(submission);
			expectedTurnLeafId = sm.appendMessage({ ...nowMsg(userText), ...((submission?.clientMessageId !== undefined || generationMode) ? { details: { ...(submission?.clientMessageId !== undefined ? { rpClientMessageId: submission.clientMessageId } : {}), ...(generationMode ? { rpGenerationMode: generationMode } : {}) } } : {}) });
			sm.flush();
			try { submission?.onAccepted?.(expectedTurnLeafId); } catch { ev.onActivity?.("输入已落树，但接受回执回调失败"); }
		}
		// 上下文 = f(分支)
		branch = sm.getBranch() as BranchEntryLike[];
		if (userText !== null && !rerollPrep) {
			if (!generationMode) this.#startWorldProfilePrep(materials, branch);
			if (!generationMode) this.#startLiteraryProfilePrep(materials, branch);
		}
		const rawState = stateFromBranch(branch);
		const identityHints = Object.fromEntries(Object.keys(rawState.characters).flatMap(name => materials.entries
			.filter(entry => !entry.constant && entry.keys.some(key => key === name || name.includes(key) || key.includes(name)))
			.slice(0, 2).map(entry => [name, entry.content.slice(0, 1200)])));
		const identityRepair = repairKnownCharacterIdentityState(rawState, identityHints);
		const state = identityRepair.state;
		const novelPlayContext = novelPlayContextForBranch(cwd, materials.rawCard, branch);
		const rebuiltHistory = rebuildHistory(branch, materials.promptRules);
		const databasePluginEnabled = this.#deps.databasePluginMemory?.enabled() === true;
		const { lastUserText, lastNarrativeText } = rebuiltHistory;
		const history = databasePluginEnabled ? rebuiltHistory.history.slice(-this.#deps.databasePluginMemory!.recentHistoryMessages()) : rebuiltHistory.history;
		const summary = rebuiltHistory.summary; // Legacy branch summaries remain read-only migration evidence; no old summary model continues running.
		if (databasePluginEnabled) {
			const receipts = branch.filter(e => e.type === "custom" && e.customType === "rp-database-memory").map(e => e.data as { sourceEntryId?: string; status?: string });
			const latest = receipts.at(-1);
			if (latest?.status === "pending" && latest.sourceEntryId) { await this.#deps.databasePluginMemory!.after(latest.sourceEntryId, this.#abort?.signal); sm.appendCustomEntry("rp-database-memory", {sourceEntryId:latest.sourceEntryId,status:"complete"}); sm.flush(); }
		}
		const literaryProfile = generationMode ? undefined : literaryProfileFromBranch(branch);
		const committedEcology = literaryEcologyFromBranch(branch);
		let literaryEcology = committedEcology;
		const latestUserEntry = [...branch].reverse().find(entry => entry.message?.role === "user");
		const latestUserEntryId = latestUserEntry?.id;
		const userContent = latestUserEntry?.message?.content;
		const latestUserOriginalText = typeof userContent === "string" ? userContent : Array.isArray(userContent) ? userContent.filter(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string").map(part => part.text).join("") : userText ?? "";
		const worldManifest = worldManifestFromBranch(branch, existingWorldProfile?.cardKey);
		const modularWorld = modularWorldFromBranch(branch, worldManifest);
		const adaptiveWorldEnabled = config.literaryWorldEnabled === true && !!worldManifest;
		let literaryDirectionData = generationMode === "director" ? undefined : rerollPrep?.literaryDirectionData;
		let literaryDirection = literaryDirectionData ? formatLiteraryDirection(literaryDirectionData) : undefined;
		let plotAdaptation = generationMode ? undefined : rerollPrep?.plotAdaptation;
		let sceneConductor = generationMode ? undefined : rerollPrep?.sceneConductor;
		let novelProjection: NovelPlayProjection | undefined;
		let preparedNovelPlay: PreparedNovelPlayTurn | undefined;
		let planFact: PlanFactComparison | undefined;
		// A reroll is a writer retry. If the previous turn has prep artifacts they
		// are carried in rerollPrep; otherwise do not rebuild slow optional prep.
		const rerollWithoutPrep = userText === null && !rerollPrep;
		const directorRequested = generationMode === "direct" ? true : !generationMode && !rerollPrep && !rerollWithoutPrep && config.literaryQuality === "guided" && !isBackstageText(lastUserText);
		if (!history.some((m) => m.role === "user")) {
			ev.onNotify?.("error", "没有可开演的用户输入。");
			return { aborted: false, error: "no-user-input" };
		}

		const languageMismatch = lastNarrativeText
			? detectsLanguageMismatch(lastNarrativeText, config.language)
			: false;
		const windowText = history
			.slice(-config.scanDepth)
			.map((m) => m.text)
			.join("\n");
		const activated = scanEntries(materials.entries, windowText, config.maxLoreInjections);
		const identityReference = Object.entries(identityHints).map(([name, content]) => `${name}：${content}`).join("\n\n").slice(0, 6000);

		// 面板快照（M1 读磁盘缓存；写侧与分支化随 M3）
		let panelIndex: string | undefined;
		try {
			const panels = loadPanels(join(dir(cwd, "artifacts"), `${sm.getSessionId()}.json`));
			panelIndex = formatPanelSnapshot(panels) ?? formatPanelIndex(panels) ?? undefined;
		} catch {
			panelIndex = undefined;
		}

		// 旧会话遗留的戏外轮：不注预设末端模板（不按剧情模板硬写）
		const legacyBackstage = !generationMode && !!lastUserText && isBackstageText(lastUserText);
		const ecologyGlobalSkill = workflowSkill(materials.skillFiles, "ecology-global");
		const ecologyCardSkill = workflowSkill(materials.skillFiles, "ecology-card");
		const ecologyRuntimeSkill = workflowSkill(materials.skillFiles, "ecology-runtime");
		let ecologyPools = loadEcologyPools(cwd, config.card, card.name);
		const passiveEcology = generationMode && config.literaryEcologyEnabled ? existingEcologyReference({ cardPool: ecologyPools.card, globalPool: ecologyPools.global, ecology: literaryEcology, state, history, userText: lastUserText }) : undefined;
		if (false && !rerollPrep && config.literaryEcologyEnabled === true && !legacyBackstage && ecologyGlobalSkill && ecologyCardSkill && ecologyRuntimeSkill) {
			const sourceLeafId = sm.getLeafId();
			if (sourceLeafId) {
				ev.onActivity?.("鲜活世界：搜索素材并更新双池");
				const queryPrompt = buildEcologySearchPlanPrompt(ecologyGlobalSkill.body, { global: ecologyPools.global, card, state, userText: lastUserText, userName: config.userName });
				const queryResult = await this.#sideText("ecologySearch", queryPrompt.systemPrompt, queryPrompt.userText, 2048);
				if (typeof queryResult !== "string") ev.onActivity?.(`鲜活世界：检索规划失败（${queryResult.error}）`);
				const queries = typeof queryResult === "string" ? ecologySearchQueries(queryResult) : [];
				const research = [] as import("../tools/web-research.ts").WebResearchItem[];
				if (queries.length && this.#deps.webResearch) {
					for (let index = 0; index < queries.length; index += 3) {
						const batch = await this.#deps.webResearch(queries.slice(index, index + 3), 5, this.#abort.signal).catch(() => []);
						research.push(...batch);
					}
				}
				const usableResearch = research.filter((item) => (item.results?.length ?? 0) > 0);
				if (usableResearch.length) {
					const globalPrompt = buildEcologyGlobalPrompt(ecologyGlobalSkill.body, { global: ecologyPools.global, research: usableResearch, card, userText: lastUserText });
					const globalResult = await this.#sideText("ecologyGlobal", globalPrompt.systemPrompt, globalPrompt.userText, 16384);
					if (typeof globalResult === "string") {
						const next = normalizeEcologyGlobalPool(globalResult, ecologyPools.global);
						if (next) ecologyPools = { ...ecologyPools, global: next };
						else ev.onActivity?.("鲜活世界：全局原型池输出不可解析，保留旧池");
					} else ev.onActivity?.(`鲜活世界：全局原型池更新失败（${globalResult.error}）`);
				} else {
					ev.onActivity?.("鲜活世界：本拍没有可用搜索结果，保留全局原型池");
				}
				const cardPrompt = buildEcologyCardPrompt(ecologyCardSkill.body, { global: ecologyPools.global, cardPool: ecologyPools.card, card, lore: materials.entries, state, history });
				const cardResult = await this.#sideText("ecologyCard", cardPrompt.systemPrompt, cardPrompt.userText, 16384);
				if (typeof cardResult === "string") {
					const next = normalizeEcologyCardPool(cardResult, ecologyPools.card);
					if (next) ecologyPools = { ...ecologyPools, card: next };
					else ev.onActivity?.("鲜活世界：角色卡生态池输出不可解析，保留旧池");
				} else ev.onActivity?.(`鲜活世界：角色卡生态池更新失败（${cardResult.error}）`);
				const arrivalPrompt = buildEcologyRuntimePrompt(ecologyRuntimeSkill.body, { phase: "arrival", ecology: literaryEcology, global: ecologyPools.global, cardPool: ecologyPools.card, lore: materials.entries, state, history, userText: lastUserText });
				const arrivalResult = await turnSideText("prep.arrival", "ecologyRuntime", arrivalPrompt.systemPrompt, arrivalPrompt.userText, 8192);
				if (stableLeaf(sourceLeafId)) {
					if (typeof arrivalResult === "string") {
						const next = normalizeLiteraryEcologyState(arrivalResult, literaryEcology);
						if (next) literaryEcology = next;
						else ev.onActivity?.("鲜活世界：拍前生态输出不可解析，沿用上一快照");
					} else ev.onActivity?.(`鲜活世界：拍前生态失败（${arrivalResult.error}），沿用上一快照`);
					saveEcologyPools(cwd, config.card, ecologyPools);
				} else {
					ev.onActivity?.("鲜活世界拍前结果已丢弃（期间切换了分支）");
				}
			}
		}
		let literaryContinuity: LiteraryContinuity | undefined = rerollPrep?.literaryContinuity;
		const prepLeafId = sm.getLeafId();
		// Mandatory native database preparation runs before optional side timers.
		// A failed/cancelled recall must not leave their ten-minute timer running.
		let databasePreparedPrompt: DatabasePluginPreparedPrompt | undefined;
		if (databasePluginEnabled) {
			ev.onActivity?.("原数据库插件：执行原生召回与本轮输入写回");
			databasePreparedPrompt = await this.#deps.databasePluginMemory!.before(lastUserText, this.#abort?.signal);
			if (!stableLeaf(prepLeafId)) return { aborted: true };
			if (typeof databasePreparedPrompt?.userInput !== "string" || !Array.isArray(databasePreparedPrompt.worldbookEntries)) throw new Error("数据库没有交付原生发送前处理结果");
		}
		const databaseWorldbookEntries = databasePreparedPrompt
			? selectDatabasePluginWorldbookEntries(databasePreparedPrompt.worldbookEntries, (history.at(-1)?.role === "user" ? history.slice(0, -1) : history).map(m => m.text), databasePreparedPrompt.userInput) : [];
		const databaseWorldbook = databasePluginWorldbookParts(databaseWorldbookEntries);
		const databaseSystemSlots = placeDatabasePluginCharacterEntries(materials.presetBefore, databaseWorldbook);
		const databaseSourceTexts = databasePreparedPrompt ? [databasePreparedPrompt.userInput, ...databaseWorldbookEntries.map(e => e.content)] : [];
		const writerUserInput = databasePreparedPrompt?.userInput ?? lastUserText;
		// 拍前旁路共享总预算；建议工件超时只会降级，不得阻塞正文入口。
		let prepFinished = false;
		const prepController = new AbortController();
		// 停止按钮必须同时取消拍前旁路；否则导演/排演/生态请求仍会继续跑完。
		this.#abort.signal.addEventListener("abort", () => prepController.abort(), { once: true });
		const prepBudgetMs = 10 * 60_000;
		// Each optional side step gets a realistic two-minute window. Steps are
		// independent: a timeout skips only that step, while later prep and the
		// writer can continue with the materials already available.
		const prepStepWaitMs = 120_000;
		const waitPrep = async <T>(work: Promise<T>, fallback: T, timeoutMs = prepStepWaitMs): Promise<T> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					work,
					new Promise<T>((resolve) => {
						timer = setTimeout(() => {
							ev.onActivity?.(`拍前旁路超时（${Math.round(timeoutMs / 1000)}秒），已跳过并继续正文`);
							resolve(fallback);
						}, timeoutMs);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		};
		const prepTimer = setTimeout(() => {
			prepController.abort();
			ev.onActivity?.(`拍前准备达到总预算（${Math.round(prepBudgetMs / 1000)}秒），正文按已有材料继续`);
		}, prepBudgetMs);
		const arrivalRequested = !generationMode && !rerollPrep && !rerollWithoutPrep && config.literaryEcologyEnabled === true && !legacyBackstage && !!ecologyRuntimeSkill;
		const continuityRequested = !generationMode && !rerollPrep && !rerollWithoutPrep && config.literaryQuality === "guided" && !legacyBackstage && shouldRunContinuity({ state, history, summary, userText: lastUserText });
		const arrivalPromise: Promise<LiteraryEcologyState | undefined> = arrivalRequested
			? Promise.resolve().then(async () => {
				ev.onActivity?.("鲜活世界：匹配当前人物与场所");
				const prompt = buildEcologyRuntimePrompt(ecologyRuntimeSkill.body, { phase: "arrival", ecology: literaryEcology, global: ecologyPools.global, cardPool: ecologyPools.card, lore: materials.entries, state, history, userText: latestUserOriginalText, userEntryId: latestUserEntryId });
				const result = await turnSideText("prep.arrival", "ecologyRuntime", prompt.systemPrompt, prompt.userText, 8192, "off", prepController.signal);
				if (typeof result !== "string") { ev.onActivity?.(`鲜活世界：拍前生态失败（${result.error}），沿用上一快照`); return undefined; }
				const parsed = normalizeLiteraryEcologyState(result, literaryEcology);
				if (!parsed) { ev.onActivity?.("鲜活世界：拍前生态输出不可解析，沿用上一快照"); return undefined; }
				const errors = validateEcologyTransition(literaryEcology, parsed, worldSignalsForEcology(modularWorld), { latestUserText: latestUserOriginalText, latestUserEntryId, committedState: committedEcology });
				for (const warning of (parsed as typeof parsed & { commitmentWarnings?: string[] }).commitmentWarnings ?? []) ev.onActivity?.(`鲜活世界承诺来源门禁：${warning}`);
				if (errors.length) { collector.status("prep.arrival", "degraded"); ev.onActivity?.(`鲜活世界：拍前生态候选被拒绝（${errors.join("；")}），沿用上一快照`); return undefined; }
				ev.onActivity?.("鲜活世界：抵达候选已生成");
				return parsed;
			})
			: Promise.resolve(undefined);
		const continuityPromise: Promise<LiteraryContinuity | undefined> = continuityRequested
			? Promise.resolve().then(async () => {
				ev.onActivity?.("文学连续性：补充当前场景约束");
				const prompt = buildLiteraryContinuityPrompt({
					state,
					history,
					summary,
					activatedLore: activated,
					userText: lastUserText,
					charName: card.name,
					userName: config.userName,
				});
				const result = await turnSideText(
					"prep.continuity", "literaryContinuity",
					`${prompt.systemPrompt}\n\n# 工作流 skill：文学连续性\n${workflowSkill(materials.skillFiles, "continuity")?.body ?? ""}`,
					prompt.userText,
					2048,
					"off",
					prepController.signal,
				);
				if (typeof result !== "string") { ev.onActivity?.(`文学连续性：生成失败（${result.error}），本拍无补充工件`); return undefined; }
				const parsed = parseLiteraryContinuity(result);
				if (!parsed) ev.onActivity?.("文学连续性：输出不可解析，本拍无补充工件");
				return parsed;
			})
			: Promise.resolve(undefined);
		// PLAN-RP-MEMORY：拍前自动召回——受 injectOnTurn 配置与宿主依赖双重门控；不进正文关键路径（缺失即降级）。
		const memoryRecallRequested =
			!databasePluginEnabled && !rerollPrep && !legacyBackstage && !!this.#deps.recallForTurn && (!!generationMode || shouldRecallHistory(lastUserText));
		const memoryRecallMode = generationMode && !shouldRecallHistory(lastUserText) ? "sweep" : classifyRecallIntent(lastUserText);
		const memoryRecallPromise: Promise<MemoryRecallHitLike[] | undefined> =
			memoryRecallRequested && (!generationMode || memoryRecallMode === "point")
				? Promise.resolve().then(async () => {
					const shouldRecall = await (this.#deps.shouldRecallForTurn?.(sm.getSessionId()) ?? true);
					if (!shouldRecall) return undefined;
					const hits = await Promise.race([
						this.#deps.recallForTurn!(sm.getSessionId(), lastUserText),
						new Promise<MemoryRecallHitLike[]>((resolve) => setTimeout(() => resolve([]), 15_000)),
					]);
					if (!hits || hits.length === 0) return undefined;
					// 命中事件的证据再沿 sourceRefs 取回（第二阶段；失败降级为仅有事件定位）
					const withEvidence: MemoryRecallHitLike[] = [];
					for (const h of hits) {
						withEvidence.push(h);
						if (h.meta?.kind === "event" && h.meta?.eventId && this.#deps.recallEvidence) {
							const evd = await this.#deps.recallEvidence(sm.getSessionId(), h.meta.eventId).catch(() => []);
							withEvidence.push(...evd.map((e) => ({ ...e, meta: { ...e.meta, kind: "evidence" as const } })));
						}
					}
					return withEvidence;
				}).catch(() => undefined)
				: Promise.resolve(undefined);
		const memoryArcPromise =
			memoryRecallRequested && memoryRecallMode === "sweep" && this.#deps.recallArcsForTurn
				? Promise.race([
					Promise.resolve().then(async () => (await (this.#deps.shouldRecallForTurn?.(sm.getSessionId()) ?? true)) ? this.#deps.recallArcsForTurn!(sm.getSessionId()) : []).catch(() => []),
					new Promise<Array<{ arc: string; text: string; events: number }>>((resolve) => setTimeout(() => resolve([]), 5_000)),
				])
				: Promise.resolve([]);
		const [arrivalCandidate, continuityCandidate, memoryHits, memoryArcs] = await Promise.all([
			waitPrep(arrivalPromise, undefined, 190_000),
			waitPrep(continuityPromise, undefined),
			measureAwait("prep.memoryRecall", memoryRecallPromise),
			measureAwait("prep.memoryArcs", memoryArcPromise),
		]);
		if (stableLeaf(prepLeafId)) {
			if (arrivalCandidate) literaryEcology = arrivalCandidate;
			if (continuityCandidate) literaryContinuity = continuityCandidate;
			if (arrivalCandidate) ev.onActivity?.("鲜活世界：抵达候选已采用");
		} else {
			ev.onActivity?.("拍前生态/连续性结果已丢弃（期间切换了分支）");
		}
		// 记忆回照注入块（叶守卫：只在当前分支仍相同时采用）
		let memoryRecallBlocks: Array<{ tag: string; kind: "event" | "digest" | "evidence" | "arc"; text: string }> | undefined;
		if ((memoryHits || memoryArcs.length) && stableLeaf(prepLeafId)) {
			const seenRecall = new Set<string>();
			const points = ((memoryHits ?? []) as MemoryRecallHitLike[])
				.map((h, i) =>
					formatMemoryRecallHit(h, i),
				)
				.filter((b): b is { tag: string; kind: "event" | "digest" | "evidence"; text: string } => {
					if (!b) return false;
					const key = `${b.kind}|${b.tag}|${b.text.slice(0, 80)}`;
					if (seenRecall.has(key)) return false;
					seenRecall.add(key);
					return true;
				})
				.slice(0, 6);
			const arcs = memoryArcs.map((arc) => ({ tag: arc.arc, kind: "arc" as const, text: arc.text }));
			const combined = [...arcs, ...points];
			memoryRecallBlocks = [];
			let recallChars = 0;
			for (const block of combined) {
				const remaining = 2_500 - recallChars;
				if (remaining < 80) break;
				const next = block.text.length > remaining ? { ...block, text: `${block.text.slice(0, remaining - 1)}…` } : block;
				memoryRecallBlocks.push(next);
				recallChars += next.text.length;
			}
		} else if ((memoryHits || memoryArcs.length) && !stableLeaf(prepLeafId)) {
			ev.onActivity?.("剧情记忆召回已丢弃（期间切换了分支）");
		}
		if (!generationMode && !rerollPrep && config.literaryEcologyEnabled === true && !legacyBackstage && ecologyGlobalSkill && ecologyCardSkill) {
			const poolSignal = new AbortController();
			this.#startEcologyPoolPrep({ cardPath: config.card, card, entries: materials.entries, state, history, userText: lastUserText, userName: config.userName, globalSkill: ecologyGlobalSkill, cardSkill: ecologyCardSkill, pools: ecologyPools, signal: poolSignal.signal });
			ev.onActivity?.("鲜活世界：已在后台搜索并准备下一拍素材");
		}
		// 小说开演独立于生态开关。它只读取原始卡扩展、不可变作品包和当前权威分支。
		if (generationMode !== "direct" && !rerollPrep && !rerollWithoutPrep && !legacyBackstage) {
			const novelSkill = materials.skillFiles.find(skill => skill.dir === "小说分支校准");
			if (novelSkill) {
				preparedNovelPlay = await waitPrep(prepareNovelPlayTurn({
					cwd, rawCard: materials.rawCard, branch, expectedLeafId: prepLeafId, skillBody: novelSkill.body,
					getLeafId: () => sm.getLeafId(),
					modelCall: async (systemPrompt, modelInput) => {
						const result = await turnSideText("prep.novelCalibration", "plotAdaptation", systemPrompt, modelInput, 4096, "off", prepController.signal);
						return typeof result === "string" ? result : undefined;
					},
				}), undefined);
				novelProjection = preparedNovelPlay?.projection;
				if (novelProjection) plotAdaptation = plotAdaptationFromNovelProjection(novelProjection);
				else ev.onActivity?.("小说分支校准：本拍无可用候选，按当前事实继续");
			}
		}

		// 剧情卡—生态适配：卡池是长期卡级语法，运行态给出眼前人物/地点；本步骤把抽象模板
		// 变形成当前故事可用的因果候选。候选不落事实，正文实际发生后才由场记/大纲校准。
		const plotAdaptationRequested = !generationMode && !rerollPrep && !rerollWithoutPrep && config.literaryEcologyEnabled === true && !legacyBackstage;
		if (plotAdaptationRequested) {
			ev.onActivity?.("生态剧情适配：按当前剧情卡编排事件候选");
			const sourceLeafId = sm.getLeafId();
			const prompt = buildPlotAdaptationPrompt({
				card, cardPool: ecologyPools.card, globalPool: ecologyPools.global, ecology: literaryEcology,
				outline: projectOutline(outlineFromBranch(branch), "director"), state, history, summary,
				userText: lastUserText, userName: config.userName, novelProjection,
			});
			const result = await waitPrep(turnSideText("prep.plotAdaptation", "plotAdaptation", prompt.systemPrompt, prompt.userText, 8192, undefined, prepController.signal), { error: "拍前等待窗口已到，正文按现有材料继续" });
			if (typeof result === "string" && stableLeaf(sourceLeafId)) {
				plotAdaptation = mergePlotAdaptations(plotAdaptation, parsePlotAdaptation(result));
				if (!plotAdaptation) ev.onActivity?.("生态剧情适配：输出不可解析，本拍不采用候选");
			} else if (typeof result !== "string") {
				ev.onActivity?.(`生态剧情适配：生成失败（${result.error}），正文按原流程继续`);
			}
		}
		const directorPromise = (async () => {
		if (directorRequested) {
			ev.onActivity?.("文学导演：规划当前单拍边界");
			const sourceLeafId = sm.getLeafId();
			const prompt = buildLiteraryDirectorPrompt({
				state,
				history,
				summary: [summary, ...databaseSourceTexts].filter(Boolean).join("\n\n") || undefined,
				literaryProfile,
				continuity: literaryContinuity,
				ecology: config.literaryEcologyEnabled === true ? [formatLiteraryEcologyInjection(literaryEcology), passiveEcology].filter(Boolean).join("\n\n") || undefined : undefined,
				plotAdaptation: formatPlotAdaptation(plotAdaptation),
				activatedLore: activated,
				userText: lastUserText,
				charName: card.name,
				userName: config.userName,
				characterIdentityIndex: identityReference || undefined,
				characterCard: generationMode === "direct" ? card : undefined,
				userPersona: generationMode === "direct" ? config.userPersona : undefined,
				outline: projectOutline(outlineFromBranch(branch), "director"),
			});
			const result = await turnSideText(
				"prep.director", "literaryDirector",
				`${prompt.systemPrompt}\n\n# 工作流 skill：拍前导演\n${workflowSkill(materials.skillFiles, "director")?.body ?? ""}`,
				prompt.userText,
				2048,
				undefined,
				prepController.signal,
			);
			if (!prepFinished && stableLeaf(sourceLeafId) && typeof result === "string") {
				literaryDirectionData = parseLiteraryDirection(result) ?? undefined;
				literaryDirection = literaryDirectionData ? formatLiteraryDirection(literaryDirectionData) : undefined;
			} else if (typeof result !== "string") {
				ev.onActivity?.(`文学导演：生成失败（${result.error}），主演将无导演工件继续`);
			}
		}
		})();
		// 场面编排只吸收导演与生态适配候选。角色动机已经由导演统一处理，
		// 不再按出场人数额外调用模型做逐角色排演。
		await waitPrep(directorPromise, undefined);
		// 排演后的场面编排：把各角色的独立动机变成可见动作链。它不写正文，也不创造事实，
		// 只把本拍候选的因果与信息边界交给主演。
		const sceneConductorRequested = !generationMode && !rerollPrep && !rerollWithoutPrep && !legacyBackstage && (!!plotAdaptation || !!literaryDirectionData);
		if (sceneConductorRequested) {
			ev.onActivity?.("场面编排：组织角色行动与信息差");
			const sourceLeafId = sm.getLeafId();
			const prompt = buildSceneConductorPrompt({ plot: plotAdaptation, direction: literaryDirectionData, outline: projectOutline(outlineFromBranch(branch), "director") });
			const result = await waitPrep(turnSideText("prep.sceneConductor", "sceneConductor", prompt.systemPrompt, prompt.userText, 4096, undefined, prepController.signal), { error: "拍前等待窗口已到，正文按导演方向继续" });
			if (typeof result === "string" && stableLeaf(sourceLeafId)) {
				sceneConductor = parseSceneConductor(result);
				if (!sceneConductor) ev.onActivity?.("场面编排：输出不可解析，主演按导演方向继续");
			} else if (typeof result !== "string") ev.onActivity?.(`场面编排：生成失败（${result.error}），主演按现有材料继续`);
		}
		clearTimeout(prepTimer);
		prepFinished = true;
		endPrep(this.#abort?.signal.aborted ? "aborted" : "success");

		// 历史后段每拍重装（{{lastusermessage}} 在此生效）：原文原序直通末端，不再拆层。
		const phAll = legacyBackstage ? [] : (assemblePresetAfter(materials, lastUserText) ?? []);
		// M-C2：外部插件协议条目退场（世界书/卡内嵌通道 H 类）——每套组合只播报一次
		if (materials.protocolDrops.length > 0) {
			const key = materials.protocolDrops.map((d) => `${d.family}:${d.title}`).join("|");
			if (key !== this.#warnedProtocolDrop) {
				this.#warnedProtocolDrop = key;
				const chars = materials.protocolDrops.reduce((n, d) => n + d.chars, 0);
				const titles = materials.protocolDrops.map((d) => `${d.label}「${d.title}」`).join("、");
				console.error(
					`[stage] 外部插件协议退场：${materials.protocolDrops.length} 条 / ${chars} 字（${titles}）——梨园以工具记账，无需模型手写格式块`,
				);
			}
		}

		// 装配报告落盘（PLAN §5.3 可视化）：装载期静态面 + 本拍历史后段；内容变了才写
		this.#writeAssemblyReport(cwd, materials, phAll);

		// M-A 工具组。预设 D/E 方法论直接作为本拍写作指导，不再制造 skill_read 工具轮。
		// 回合工作区 = 正文工件的落点；字数目标在此提取一次（数据，供末端注入）。
		// 读侧依赖先建：统一层按注入情况决定哪些世界书工具上清单（M-D2）。
		// 可读名单：拉取档 skill 文件（常驻档已随 system 全文送达，不重复上单）+ 进口 topic 包。
		// 必定读取（每轮）skill：受理门强制落笔前先读（认 frontmatter `每轮` 标志，不认具体名字）
		const forcedSkills = generationMode ? [] : materials.skillFiles.filter((f) => f.everyBeat).map((f) => f.name);
		const skillNames = materials.skillFiles.filter((f) => !f.resident && (!generationMode || (!f.workflow && !f.everyBeat))).map((f) => f.name);
		const readDeps = this.#toolDeps(lastUserText);
		// MCP 外设（8/06 重接）：hub 里本会话已连接的工具并入清单。
		// 空数组＝没启用/没连上，与「未注入 mcp 依赖」同效——都不上清单。
		const mcpTools = mcpStageTools(this.#deps.mcp);
		// 媒体交付（8/06 重接）：tts 另需服务端环境，未就绪不上清单
		const mediaOpts = { tts: this.#deps.ttsAvailable?.() === true };
		const mediaTools = this.#deps.media ? mediaStageTools(config.language, mediaOpts) : [];
		// 助手委托（8/06 重接）：runner 未注册时不上清单
		const assistantTool = assistantStageTool();
		// 正文只运行稿纸工具；共创询问接口不接入台上工具清单。
		const ws = createWorkspace();
		const wsDeps: WorkspaceDeps = {
			rules: extractDraftRules([...materials.presetRuleTexts, ...phAll.map((b) => b.text)]),
			userName: config.userName,
			charName: card.name,
			baseState: state,
			loreEntries: materials.entries,
			transitionAuthorized: userAuthorizesTransition(lastUserText),
		};
		const allTools = [
			...stageTools(config.language, readDeps),
			...(skillNames.length > 0 ? [skillReadTool(config.language, skillNames)] : []),
			...writeTools(config.language, planStepBudget(wsDeps.rules.wordRange)),
			...mediaTools,
			...(assistantTool ? [assistantTool] : []),
			...mcpTools,
		];
		const configuredToolSupport = (model.compat as { supportsTools?: boolean } | undefined)?.supportsTools !== false;
		const readOnlyToolNames = new Set([...unifiedStageReadToolNames(readDeps), "world_state_get", "skill_read"]);
		const deferredBusinessWrites = new Set(unifiedStageWriteToolNames(readDeps).filter(name => name !== "worldline_back"));
		const ownerBusinessTools = new Set([...deferredBusinessWrites, ...mcpTools.map(t => t.name), ...mediaTools.map(t => t.name), ...(assistantTool ? [assistantTool.name] : []), "panel_write", "panel_close"]);
		const tools = configuredToolSupport ? (generationMode ? allTools.filter(t => readOnlyToolNames.has(t.name) || ownerBusinessTools.has(t.name)) : allTools) : [];
		if (!configuredToolSupport) ev.onActivity?.("主演 API 已配置为不支持工具，本拍使用纯文本模式");

		const systemPrompt = buildStageSystemPrompt({
			card,
			config,
			constantLore: constantLoreOf(materials),
			// 预设装配段：原文原序，marker 已按预设作者的位置填入梨园材料
			presetBefore: databaseSystemSlots.presetBefore,
			databaseWorldbook: databaseSystemSlots.remaining,
			declaredMarkers: materials.declaredMarkers,
			// skill 素材位（M-R2）：常驻包全文 + 拉取包 L1 索引，无包零痕迹
			skills: materials.skillFiles,
			tools: tools.length > 0,
			generationMode,
			// MCP 外设索引进 system（不进每拍注入）：会话内字节稳定，不破前缀缓存。
			// 与旧 director.ts 同一位置——工具清单里有 mcp__ 工具，这里说明它们是什么。
			mcpTools: mcpTools.map((t) => ({ name: t.name, description: t.description })),
		});
		const injection = buildStageInjection({
			state,
			activatedLore: activated,
			card,
			config,
			presetTail: phAll.map((p) => p.text),
			languageMismatch,
			panelIndex,
			...(wsDeps.rules.wordRange ? { wordRange: wsDeps.rules.wordRange } : {}),
			loreIndex: formatLoreIndex(materials.entries),
			rosterIndex: formatRosterIndex(state),
			literaryCharacterProfile: literaryProfile?.character,
			literaryPersonaProfile: literaryProfile?.persona,
			literaryDirection,
			plotAdaptation: formatPlotAdaptation(plotAdaptation),
			sceneConductor: formatSceneConductor(sceneConductor),
			literaryWorld: adaptiveWorldEnabled ? formatModularWorldInjection(modularWorld, worldManifest) : undefined,
			literaryEcology: config.literaryEcologyEnabled === true ? formatLiteraryEcologyInjection(literaryEcology) : undefined,
			existingEcology: passiveEcology,
			memoryRecall: memoryRecallBlocks,
					novelPlayContext,
				novelSceneRecall: novelProjection?.sceneRecall?.map(item => `- ${item.title}：${item.summary}\n  原文证据：${item.quote}`).join("\n") || undefined,
				characterIdentityIndex: identityReference || undefined,
			writerGuidance: materials.writerGuidance,
			writerWorkflow: generationMode === "director" ? undefined : workflowSkill(materials.skillFiles, generationMode === "direct" ? "writer-direct" : "writer")?.body,
		});
		const curtainSkill = workflowSkill(materials.skillFiles, "curtain");
		const curtainMaterials = buildCurtainRerollMaterials({ card, entries: materials.entries, preset: materials.preset, statusBarFormats: materials.statusBarFormats });
		const curtain = !generationMode && (curtainMaterials.formatPlan.modelTags.length || curtainMaterials.formatPlan.deterministicTags.length)
			? `【主演·最终状态栏与图片交付】正文已经完成并封笔。现在仍由你本人完成本拍最终交付：先保证正文已经完整落稿，再按 formatPlan 输出状态栏等格式区块。当前卡要求图片交付，因此必须至少输出一份完整的 <image>... </image>（或兼容的 <imageTag>... </imageTag>）块；块内按 NAI4 规则写出 image### 场景与分角色提示词 ### 的内容。图片块应根据本拍刚写的正文和最终状态生成，不能凭空补写事件；格式轻微偏离不影响交付。只生成 formatPlan.modelTags；deterministicTags 由代码补齐；nativeTags 由梨园权威状态投影；forbiddenTags 禁止输出。不要复述、改写或压缩正文。\n\n# 工作流 skill\n${curtainSkill?.body ?? "依据当前卡材料生成非正文格式。"}\n\n# formatPlan\n${JSON.stringify(curtainMaterials, null, 2)}`
			: undefined;

		// 末端消息 = 动态注入 + 本拍用户原话。
		// 宿主状态放在本轮输入之前；插件开启时，本轮输入是上游实际写回
		// 的完整成品，不要求召回标签之前的用户原文仍占最后一句。
		// 原世界书的depth=0投送还可以跟在其后，不擅自搬回前面。
		// 旧宿主顺序规则：用户当拍的话放在宿主状态之后。
		// 注入块（世界状态/索引等）压在提问之后时，模型会把提问读成历史里的旧话，
		// 于是既不检索也不正面回应——8/03 实测：同一提问，挪到注入之后立刻触发 lorebook_search。
		const endsWithUser = history[history.length - 1]?.role === "user";
		const past = endsWithUser ? history.slice(0, -1) : history;
		// 规划卡（五注入之一）：每拍第 1 轮随末端注入送达（工作区新建必空），用户话保持最后一句。
		const injWithCard = !generationMode && tools.length > 0 ? `${injection}\n\n${PLAN_CARD}` : injection;
		const tailText = endsWithUser ? `${injWithCard}\n\n${writerUserInput}` : injWithCard;

		const buildWriterMessages = (tail: string): unknown[] => insertDatabasePluginDepthEntries([
			// M4 前情提要：被 rp-summary 覆盖的早期剧情在此回读（历史里那段已整体不存在）。
			// 以 user 角色打头，措辞与 system「消息流约定」里的【前情提要】对上。
			...(summary
				? [
						{
							role: "user",
							content: [{ type: "text", text: `【前情提要】以下是更早剧情的接力摘要，是既定事实：\n\n${summary}` }],
							timestamp: 0,
						},
					]
				: []),
			...past.map((m) =>
				m.role === "user"
					? { role: "user", content: [{ type: "text", text: m.text }], timestamp: 0 }
					: {
							role: "assistant",
							content: [{ type: "text", text: m.text }],
							api: "openai-completions",
							provider: "history",
							model: "history",
							usage: {
								input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: 0,
						},
			),
			{ role: "user", content: [{ type: "text", text: tail }], timestamp: Date.now() },
		], databaseWorldbook.depthEntries);
		const messages = buildWriterMessages(tailText);
		const writerInput = {
			systemChars: systemPrompt.length,
			summaryChars: summary?.length ?? 0,
			historyChars: past.reduce((total, message) => total + message.text.length, 0),
			injectionChars: injection.length,
			latestUserChars: endsWithUser ? history[history.length - 1].text.length : 0,
			toolSchemaChars: JSON.stringify(tools).length,
		};
		const writerInitialChars = Object.values(writerInput).reduce((total, chars) => total + chars, 0);
		const pureTextSystemPrompt = tools.length === 0
			? systemPrompt
			: buildStageSystemPrompt({
				card,
				config,
				constantLore: constantLoreOf(materials),
				presetBefore: databaseSystemSlots.presetBefore,
				databaseWorldbook: databaseSystemSlots.remaining,
				declaredMarkers: materials.declaredMarkers,
				skills: materials.skillFiles,
				tools: false,
				generationMode,
				mcpTools: [],
			});
		const pureTextTail = endsWithUser ? `${injection}\n\n${writerUserInput}` : injection;
		const pureTextMessages = buildWriterMessages(pureTextTail);

		const endWriter = collector.beginPhase("writer");
		const { apiKey, headers } = await this.#deps.getAuth(model);
		// 部分兼容中转会拦截 SDK 默认的 OpenAI/Node User-Agent；与 server/main.ts 旁路保持一致。
		const requestHeaders = model.baseUrl?.includes("magicv4.ltd") ? { ...(headers ?? {}), "user-agent": "undici" } : headers;
		const mainCallMaxTokens = mainStageMaxTokens(model, wsDeps.rules.wordRange);
		const firstCallMaxTokens = Math.min(
			FIRST_CALL_MAX_TOKENS,
			typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : FIRST_CALL_MAX_TOKENS,
		);
		const options: Record<string, unknown> = {
			apiKey,
			headers: requestHeaders,
			signal: this.#abort.signal,
			sessionId: sm.getSessionId(),
			maxTokens: firstCallMaxTokens,
			maxRetries: MODEL_MAX_RETRIES,
		};
		const thinking = this.#deps.getThinking?.();
		// Some OpenAI-compatible chat/completions gateways reject function tools
		// whenever reasoning_effort is present. Respect the model compatibility
		// declaration instead of forwarding the session thinking level blindly.
		const supportsReasoningEffort = (model.compat as { supportsReasoningEffort?: boolean } | undefined)?.supportsReasoningEffort;
		if (thinking && !(tools.length > 0 && supportsReasoningEffort !== true)) options.reasoning = thinking;
		const samplers = materials.presetDoc?.samplers;
		if (samplers && Object.keys(samplers).length > 0) {
			options.onPayload = (payload: unknown, m: StageModelLike) => {
				if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
				return applyProjectedSamplers(payload as Record<string, unknown>, samplers, {
					provider: m.provider,
					modelId: m.id,
					baseUrl: m.baseUrl,
					api: typeof m.api === "string" ? m.api : undefined,
				});
			};
		}

		let writerSystemPrompt = systemPrompt;
		let writerMessages = messages;
		let writerTools = tools;
		let toolFallbackUsed = tools.length === 0;
		let s: ReturnType<StageStreamFn>;
		let final: AssistantMsgLike | null = null;
		let errored: string | undefined;
		let text = "";
		const fwd = this.#draftForwarder(ev);
		let loopTail = "";
		let curtainText = "";
		let authorDraft = "";
		let presentationDone = false;
		let interruptedDraft = "";
		let enteredAgentLoop = false;
		let stoppedByUser = false;
		let corruptOutput = false;
		if (generationMode) {
			const sourceEntries = branch.flatMap(entry => {
				if (!entry.id || !entry.message || !["user", "assistant"].includes(entry.message.role ?? "")) return [];
				const details = entry.message.details as Record<string, unknown> | undefined;
				const raw = typeof details?.rpNarrative === "string" ? details.rpNarrative : entry.message.content;
				const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter(part => part.type === "text").map(part => part.text ?? "").join("") : "";
				return text ? [{ id: entry.id, text }] : [];
			});
			const expertContext: DirectorContext = {
				sessionId: sm.getSessionId(), leafId: expectedTurnLeafId,
				userText: lastUserText, userPersona: config.userPersona, card: { name: card.name, description: card.description, personality: card.personality, scenario: card.scenario },
				state, history, summary: [summary, ...databaseSourceTexts, ...(memoryRecallBlocks ?? []).map(x => x.text)].filter(Boolean).join("\n\n") || undefined, world: formatModularWorldInjection(modularWorld, worldManifest), ecology: { committed: formatLiteraryEcologyInjection(literaryEcology), existingCandidates: passiveEcology },
				outline: projectOutline(outlineFromBranch(branch), "director"), lore: activated,
				presetText: [...materials.presetBefore.map(p => p.text), ...phAll.map(p => p.text)].join("\n\n"),
				writerPresetText:[...materials.presetBefore.filter(p=>p.source==="block").map(p=>p.text),...phAll.filter(p=>p.source==="block").map(p=>p.text)].join("\n\n"),
				constantLore:constantLoreOf(materials).map((entry,index)=>({id:`constant:${index}`,title:entry.comment,content:entry.content})),
				sources: [
					{ id: "preset", text: [...materials.presetBefore.map(p => p.text), ...phAll.map(p => p.text)].join("\n\n") },
					{ id: "card", text: [card.description, card.personality, card.scenario].join("\n") },
					{ id: "persona", text: config.userPersona },
					{ id: "state", text: JSON.stringify(state) },
					{ id: "world", text: formatModularWorldInjection(modularWorld, worldManifest) ?? "" },
					{ id: "ecology", text: formatLiteraryEcologyInjection(literaryEcology) ?? "" },
					...sourceEntries.slice(-8).reverse(),
					...(summary ? [{ id: "summary", text: summary }] : []),
					...databaseSourceTexts.map((text, index) => ({ id: `memory:database:${index}`, text })),
					...(memoryRecallBlocks ?? []).map((x, index) => ({ id: `memory:${index}`, text: x.text })),
					...activated.map((entry, index) => ({ id: `lore:${index}`, text: entry.content })),
				],
			};
			const priorReports: DirectorReport[] = [];
			const retrievedSources: Array<{ id: string; text: string }> = [];
			let retrievalCount = 0;
			const outcome = await runAgentTurn({
				mode: generationMode, systemPrompt, messages,
				readTools: tools, directorPrompt: directorMainSkill(materials.skillFiles),
				timeoutMs: Math.max(1, (config.generationTimeoutMinutes ?? (generationMode === "director" ? 60 : 30)) * 60_000 - (Date.now() - turnStartedAt)),
				allowDegraded: config.allowDegradedGeneration === true,
				normalizeNarrative: extractPureTextNarrative,
				outputRecoveryPrompt: workflowSkill(materials.skillFiles,"writer-recovery")?.body,
				toolProtocolRecoveryPrompt: workflowSkill(materials.skillFiles,"tool-protocol-repair")?.body,
				toolsSupported: configuredToolSupport, signal: this.#abort.signal, isCurrent: () => stableLeaf(expectedTurnLeafId),
				stream: (context, requestSignal) => {
					const source = this.#observedStream(model, context, { ...options, signal: requestSignal ?? this.#abort?.signal, maxTokens: firstCallMaxTokens }, observation("writer"));
					return { [Symbol.asyncIterator]: () => streamWithTimeout(source, WRITER_STREAM_TIMEOUT_MS, requestSignal ?? this.#abort?.signal), result: () => source.result() };
				},
				read: async (name, args, requestSignal) => {
					if (requestSignal?.aborted || !stableLeaf(expectedTurnLeafId)) return { text: "工具请求已取消或分支改变", isError: true };
					if (name === "skill_read" && !skillNames.includes(String(args.name ?? ""))) return { text: "该 Skill 不在本拍可读清单。" };
					if (deferredBusinessWrites.has(name)) { pendingOwnerTools.push({ name, args: structuredClone(args) }); return { text: "资料/面板操作已暂存，正文保存并结算后才执行。" }; }
					let result: ToolRunResult | MediaStageResult | null | undefined;
					if (mcpTools.some(t => t.name === name)) result = await runMcpStageTool(this.#deps.mcp!, name, args, requestSignal);
					else if (mediaTools.some(t => t.name === name)) result = await runMediaStageTool(cwd, name, args);
					else if (name === "assistant_run") result = await runAssistantStageTool(name, args, requestSignal);
					else result = await this.#runReadTool({ ws, language: config.language }, readDeps, name, args);
					if (requestSignal?.aborted || !stableLeaf(expectedTurnLeafId)) return { text: "迟到工具结果未采用", isError: true };
					if (mediaTools.some(t => t.name === name) && (result as MediaStageResult)?.details && !(result as MediaStageResult).isError) {
						ws.mediaDeliveries ??= []; ws.mediaDeliveries.push({ toolName: name, details: (result as MediaStageResult).details!, text: result!.text });
					}
					// Forward actual read receipts, not private reasoning or helper-authored prose.
					if (result?.text && !(result as MediaStageResult).isError && readOnlyToolNames.has(name) && name !== "skill_read") {
						retrievedSources.push({ id: `retrieval:${++retrievalCount}:${name}`, text: result.text.slice(0, 4_000) });
						if (retrievedSources.length > 4) retrievedSources.shift();
					}
					return result ?? { text: "工具不可用", isError: true };
				},
				experts: async (phase, tasks, draft, requestSignal) => {
					const reports = await executeDirectorBatch({ phase, tasks,
						context: { ...expertContext, sources: [...retrievedSources, ...expertContext.sources], priorReports: [...priorReports], ...(draft ? { draft } : {}) }, skills: materials.skillFiles,
						run: (step, sp, ut, maxTokens, recoverMalformed) => {
							if(recoverMalformed){const previous=[...modelDiagnostics].reverse().find(x=>x.step===step);modelDiagnostics.push({phase:`agent.${phase}`,step,provider:previous?.provider??"validation",model:previous?.model??"schema",attempt:(previous?.attempt??0)+1,status:"failed",kind:"format",reason:"JSON/schema：专家报告字段无效",durationMs:0});}
							return this.#sideText(step, sp, ut, maxTokens, "off", requestSignal ?? this.#abort?.signal, observation(`agent.${phase}` as PerformancePhase), recoverMalformed === true);
						},
						repairMalformed: !!config.analysisRecoveryModel,
						signal: requestSignal ?? this.#abort?.signal, isCurrent: () => stableLeaf(expectedTurnLeafId), onActivity: ev.onActivity });
					if (!requestSignal?.aborted && stableLeaf(expectedTurnLeafId)) priorReports.push(...reports);
					return reports;
				},
				onDelta: (delta, reset) => ev.onDelta?.("text", delta, true, reset),
				onThinking: delta => ev.onDelta?.("thinking", delta),
				onResync: narrative => ev.onDraftResync?.(splitDraftSegments(narrative)), onActivity: ev.onActivity,
			});
			agentWorkflow = outcome.workflow; final = outcome.final; if (outcome.aborted && final) final = { ...final, stopReason: "aborted" }; text = outcome.authorDraft; authorDraft = outcome.authorDraft;
			errored = outcome.error; enteredAgentLoop = true;
			ws.draft = extractDraftBody(extractPureTextNarrative(outcome.narrative)); ws.sealed = !outcome.aborted;
			const structuralDraft = authorDraft.replace(/<(image(?:Tag)?|options)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
			if (!outcome.aborted && authorDraft.trim() && !/<(?:content|main_output)\b/i.test(authorDraft)
				&& (/<[A-Za-z_][\w:.-]*\b[^>]*>/.test(structuralDraft) || /^\s*(?:```(?:json|html)|[\[{])/.test(structuralDraft))) {
				const boundary = await this.#readAuthorNarrative(materials, authorDraft, stableLeaf, expectedTurnLeafId, observation("writer"));
				if (boundary.ok) ws.draft = boundary.narrative;
				else { errored = boundary.error; final = {...(final ?? {role:"assistant",content:[]}),stopReason:"aborted",errorMessage:boundary.error}; }
			}
			if (ws.draft !== outcome.narrative.trim()) ev.onDraftResync?.(splitDraftSegments(ws.draft));
			ws.rounds = outcome.workflow.writerRounds; ws.appends = ws.draft ? 1 : 0;
			ws.timeline = [...(outcome.final?.content ?? []).filter(x => x.type === "thinking" && x.thinking).map(x => ({ kind: "thinking" as const, text: x.thinking! })), ...(ws.draft ? [{ kind: "text" as const, text: ws.draft, draft: true }] : [])];
		} else {
			s = this.#observedStream(model, { systemPrompt: writerSystemPrompt, messages: writerMessages, ...(writerTools.length ? { tools: writerTools } : {}) }, options, observation("writer"));
		// 首轮 writer 若在中途断流（未落任何稿段），自动重发整个请求，避免一次上游故障毁掉整拍。
		// 一旦已有稿段（ws.draft）则保留现有行为（交由 abort 收敛，不无脑重发）。
		for (let writerAttempt = 0; writerAttempt <= WRITER_OUTER_RETRIES; writerAttempt++) {
			let eroded = false;
			try {
			for await (const e of streamWithTimeout(s, WRITER_STREAM_TIMEOUT_MS, this.#abort?.signal)) {
				// provider 可能不会因 AbortSignal 立即结束 async iterator；在事件入口丢弃迟到事件并主动关闭迭代器。
				if (this.#abort?.signal.aborted) {
					try { await (s as ReturnType<StageStreamFn> & { return?: () => Promise<unknown> }).return?.(); } catch { /* provider 已关闭 */ }
					break;
				}
				if (e.type === "done") {
					final = e.message ?? null;
				} else if (e.type === "error") {
					final = e.error ?? null;
					errored = final?.errorMessage || "provider error";
					_blog("provider_error", errored);
					eroded = true;
					break;
				} else if (e.type === "text_delta" && e.delta) {
					text += e.delta;
					ev.onDelta?.("text", e.delta);
				} else if (e.type === "thinking_delta" && e.delta) {
					recordSegment(ws, { kind: "thinking", text: e.delta });
					ev.onDelta?.("thinking", e.delta);
				} else {
					fwd.forward(e);
				}
			}
			} catch (error) {
				if (this.#abort?.signal.aborted) break;
				errored = error instanceof Error ? error.message : String(error);
				_blog("provider_error", errored);
				eroded = true;
			}
			const receivedText = [text, textOfAssistant(final)].filter(Boolean).join("\n");
			if (looksLikeCorruptedModelText(receivedText)) {
				corruptOutput = true;
				errored = "模型返回了异常解码文本，请切换主演模型或稍后重试";
				ev.onDraftResync?.([]);
				ev.onStreamClear?.();
				break;
			}
			const textualToolProtocol = looksLikeTextualToolProtocol(receivedText);
			if (textualToolProtocol && writerTools.length > 0) {
				eroded = true;
				errored = "API 未返回原生工具调用，而是输出了文本化 tool protocol";
				final = null;
				ev.onStreamClear?.();
			}
			// 用户取消：立即停止，不再重发（aborted 半拍仍走既有收敛落树）。
			if (this.#abort?.signal.aborted) break;
			if (eroded && !ws.draft.trim() && writerTools.length > 0 && !toolFallbackUsed && (textualToolProtocol || isToolUnsupportedError(errored ?? ""))) {
				toolFallbackUsed = true;
				writerTools = [];
				writerSystemPrompt = pureTextSystemPrompt;
				writerMessages = pureTextMessages;
				model = { ...model, compat: { ...((model.compat as Record<string, unknown> | undefined) ?? {}), streaming: false } };
				ev.onNotify?.("warning", "主演 API 不支持工具调用，本拍已自动切换为纯文本小说模式。分段、主动检索和主演记账将由系统降级处理。");
				s = this.#observedStream(model, { systemPrompt: writerSystemPrompt, messages: writerMessages }, { ...options, maxRetries: 1 }, observation("writer"));
				text = "";
				final = null;
				errored = undefined;
				continue;
			}
			if (eroded && isConfirmedContextOverflow(errored)) { preflight.confirmedOverflow(message => ev.onNotify?.("warning", message)); break; }
			if (!eroded || ws.draft.trim() || writerAttempt >= WRITER_OUTER_RETRIES) break;
			// 尚未落稿且断流：带退避重发同一个请求。
			ev.onActivity?.(`主演首次生成中途断流，切换非流式重发（第 ${writerAttempt + 1}/${WRITER_OUTER_RETRIES} 次）`);
			await new Promise((r) => setTimeout(r, 400 * Math.min(2 ** writerAttempt, 8)));
			model = { ...model, compat: { ...((model.compat as Record<string, unknown> | undefined) ?? {}), streaming: false } };
			s = this.#observedStream(model, { systemPrompt: writerSystemPrompt, messages: writerMessages, ...(writerTools.length ? { tools: writerTools } : {}) }, options, observation("writer"));
			text = "";
		}
		if (!final && !this.#abort?.signal.aborted) {
			_blog("provider_error", "主演请求未返回最终消息");
		}
		// A gateway can emit a substantial text body and then fail to provide a
		// usable terminal message. Preserve that body as an unfinished reply rather
		// than letting the empty workspace path discard it.
		const forwardedDraft = fwd.pendingText();
		// Provider 可能已经把 draft_write/draft_append 的正文参数送到稿纸，
		// 但在返回 terminal done 前断流。此时 error 对象也不算可重放的 final；
		// 只要有可靠正文，就合成 aborted assistant，避免重连/刷新后整拍蒸发。
		if ((!final || final.stopReason === "error") && (text.trim() || ws.draft.trim() || forwardedDraft.trim()) && !corruptOutput) {
			final = {
				role: "assistant",
				content: [],
				stopReason: "aborted",
				errorMessage: errored || "主演请求未返回最终消息",
			};
		}

		// 尾巴口径（8/09）：稿落地后的 text 通道产出。稿落地前工具轮的旁白（读题/计划）
		// 不算——旁白曾被 mergeFinalText 当尾巴拼到正文尾部（实弹：读题文字跑进正文）。
		// M-A agent 循环（PLAN-RP-AGENT-EXEC §2.3）：思考→工具→看结果→再思考，直到交稿定稿。
		// 首轮无论 stopReason 都进循环——模型直出正文不调工具时由循环做宽进严出代收（D2）。
		if (final && !corruptOutput && writerTools.length === 0) {
			const direct = (text || textOfAssistant(final)).trim();
			if (direct) {
				// Pure-text providers often obey the card's output format even though the
				// degraded writer protocol asks for prose only. Keep narrative and curtain
				// as separate artifacts instead of rejecting an otherwise usable turn.
				const narrative = extractPureTextNarrative(direct);
				const received = runWriteTool(ws, wsDeps, "draft_write", { content: narrative }, true);
				if (received.ok) {
					collector.narrative();
					for (let attempt = 0; attempt < 3 && !ws.sealed; attempt++) runWriteTool(ws, wsDeps, "draft_seal", {});
					// Pure-text output was streamed through the normal text channel. Clear
					// that provisional bubble before the canonical assistant message is
					// rendered, otherwise the same prose appears twice in the UI.
					ev.onStreamClear?.();
					if (narrative !== direct) ev.onDraftResync?.(splitDraftSegments(ws.draft));
					ev.onActivity?.(final.stopReason === "aborted" || final.stopReason === "error" ? "纯文本异常终态已保留未完成正文" : "纯文本正文已收稿");
				} else errored = received.text;
			} else errored = "纯文本主演未返回正文";
		} else if (final && final.stopReason !== "aborted" && !corruptOutput && !isConfirmedContextOverflow(errored || final.errorMessage)) {
			enteredAgentLoop = true;
			// 首次请求即使异常结束，也让开放循环获得一次催稿/恢复机会；后续错误会由 turn 重新写回。
			errored = undefined;
			const loopOptions = { ...options, maxTokens: mainCallMaxTokens };
			const turn = await this.#agentLoop({
				model,
				options: loopOptions,
				systemPrompt: writerSystemPrompt,
				messages: writerMessages,
				first: final,
				tools: writerTools,
				ws,
				wsDeps,
				language: config.language,
				readDeps,
				directText: text,
				// skill_read 名单投影 + 必定读取（每轮）skill 集合（受理门用）
				skillNames,
				forcedSkills,
				events: ev,
				observation: observation("writer"),
				_blog,
			});
			if (turn.final) final = turn.final;
			if (turn.errored) errored = turn.errored;
			stoppedByUser = turn.stoppedByUser === true;
			text += turn.text;
			loopTail = turn.tailText ?? turn.text;
			curtainText = turn.curtainText ?? "";
			interruptedDraft = turn.pendingDraft ?? "";
		}

		}

		endWriter(errored ? "failed" : final?.stopReason === "aborted" || this.#abort?.signal.aborted ? "aborted" : "success");
		let aborted = final?.stopReason === "aborted" || this.#abort?.signal.aborted === true;
		if (errored && ws.draft.trim() && final) {
			final = { ...final, stopReason: "aborted" };
			aborted = true;
		}
		if (!text) text = textOfAssistant(final);

		// M-E 兜底封笔：分段续写完但模型始终没调 draft_seal（催告已给过一轮）。
		// 8/10 起封笔只是状态切换（验收已整体退役），此处仅补齐工件状态。
		if (ws.appends > 0 && !ws.sealed && ws.draft.trim()) {
			for (let attempt = 0; attempt < 3 && !ws.sealed; attempt++) runWriteTool(ws, wsDeps, "draft_seal", {});
		}

		// 定稿 = 工作区稿（工件）；工作区空（中断半拍/循环认栽）退回直出正文
		// **但**模型常把格式栈尾巴（状态栏/catsay 等）走 text 通道而非 draft_write 参数：
		// 二选一会把那部分连内容一起扔掉（8/05 实锤：模型宣告要出「正文+状态栏+咪咪点评」，
		// draft_write 只交了正文，屏上流式见过三样、落树只剩一样）。故此处**合并**：
		// 稿件为主体，text 里**格式特征**的尾巴补回（纯文本闲聊不进正文）。
		const hasFormatPlan = curtainMaterials.formatPlan.modelTags.length > 0 || curtainMaterials.formatPlan.deterministicTags.length > 0;
		if (ws.draft.trim()) {
			if (!generationMode && hasFormatPlan) curtainText = finalizeCurtainText(`${text}\n\n${curtainText}`, curtainMaterials.formatPlan);
			else if (!generationMode) {
				const merged = mergeFinalText(ws.draft, loopTail || text);
				curtainText = merged.startsWith(ws.draft.trim()) ? merged.slice(ws.draft.trim().length).trim() : "";
			}
		} else curtainText = curtainText.trim();
		if (looksLikeCorruptedModelText(ws.draft) || looksLikeCorruptedModelText(interruptedDraft) || looksLikeCorruptedModelText(fwd.pendingText()) || looksLikeCorruptedModelText(text) || looksLikeCorruptedModelText(curtainText)) {
			corruptOutput = true;
			errored = "模型返回了异常解码文本，请切换主演模型或稍后重试";
			curtainText = "";
			ev.onDraftResync?.([]);
			ev.onStreamClear?.();
		}
		const pendingSource = aborted && !corruptOutput
			? interruptedDraft || (!enteredAgentLoop ? fwd.pendingText() : "")
			: "";
		const pendingDraft = ws.draft.trim() && pendingSource.trim() === ws.draft.trim() ? "" : pendingSource;
		const narrativeText = aborted
			? [corruptOutput ? "" : ws.draft.trim(), pendingDraft.trim(), ws.draft.trim() || corruptOutput ? "" : mergeFinalText("", text)].filter(Boolean).join("\n\n")
			: corruptOutput ? "" : ws.draft.trim() || mergeFinalText("", text);
		const finalText = [narrativeText, curtainText].filter(Boolean).join("\n\n");
		// 正文是唯一事实源；对照工件只总结兑现程度，随后由既有 OutlineEngine 读取 rpPrep 校准。
		if (!generationMode && !aborted && narrativeText && (plotAdaptation || sceneConductor)) {
			const prompt = buildPlanFactPrompt({ plot: plotAdaptation, scene: sceneConductor, narrative: narrativeText });
			const result = await turnSideText("settlement.planFact", "scribe", prompt.systemPrompt, prompt.userText, 2048);
			if (typeof result === "string") planFact = parsePlanFact(result);
			else ev.onActivity?.(`计划—事实对照：生成失败（${result.error}），大纲将仅依据正文校准`);
		}

		// 全流程文字留档：beatLog 时序 + merge 四件全部落进 session JSONL
		_blog("merge_input_draft", ws.draft);
		_blog("merge_input_tail", loopTail);
		_blog("merge_output", finalText);

		// 落树：正文以定稿为准（保留思考块，剥离工具调用轨迹）；纯错误/空拍不落
		let entryId: string | undefined;
		let generationLeafChanged = false;
		if (!final && aborted && finalText) final = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" };
		const pendingMetadata = ownsSession() ? latestTurnMetadata(sm, expectedTurnLeafId) : [];
		const turnLeafReady = final && finalText ? ownsSession() && restoreTurnLeafAfterMetadata(sm, expectedTurnLeafId) : stableLeaf(expectedTurnLeafId);
		if (!turnLeafReady) discardPerformance = true;
		if (final && finalText && turnLeafReady) {
			const keep = (final.content ?? []).filter((c) => c.type === "thinking");
			// 时间线随 details 持久化：定稿只留最后一稿正文，但用户要看的
			// 「思考→工具→正文」全链在此保住——resyncAll 全量重放与刷新后仍在。
			// 稿段以定稿为准（工作区空时退回直出正文，时间线里也可能没有稿段）。
			const timeline = finalTimeline(ws, finalText);
			// 时间线正文同样分工件：稿段只放 narrative；谢幕作为独立末段原样保留。
			const narrativeTimeline = finalTimeline(ws, narrativeText);
			if (curtainText.trim()) narrativeTimeline.push({ kind: "text", text: curtainText.trim() });
			const prevDetails =
				final.details && typeof final.details === "object" && !Array.isArray(final.details)
					? (final.details as Record<string, unknown>)
					: undefined;
			const thinkingChars = timeline.reduce((n, segment) => n + (segment.kind === "thinking" ? segment.text.length : 0), 0);
			const usage = final.usage as { output?: number } | undefined;
			const outputTokens = typeof usage?.output === "number"
				? usage.output
				: Math.ceil((thinkingChars + finalText.length) / 4);
			const details = {
				...prevDetails,
				...(generationMode ? { rpGenerationMode: generationMode, rpGenerationWorkflow: agentWorkflow, rpAuthorDraft: authorDraft } : {}),
				...(narrativeTimeline.length ? { rpTimeline: narrativeTimeline } : {}),
				...(narrativeText ? { rpNarrative: narrativeText } : {}),
				...(curtainText.trim() ? { rpCurtain: curtainText.trim() } : {}),
					rpPrep: {
					...(literaryContinuity ? { literaryContinuity } : {}),
					...(literaryDirection ? { literaryDirection } : {}),
					...(literaryDirectionData ? { literaryDirectionData } : {}),
					...(plotAdaptation ? { plotAdaptation } : {}),
					...(planFact ? { planFact } : {}),
					...(sceneConductor ? { sceneConductor } : {}),
					...(config.literaryEcologyEnabled === true ? { literaryEcology } : {}),
					workflowStatus: {
						continuity: rerollPrep?.literaryContinuity ? "reused" : continuityRequested ? (literaryContinuity ? "success" : "degraded") : "skipped",
						director: rerollPrep && (rerollPrep.literaryDirection || rerollPrep.literaryDirectionData) ? "reused" : directorRequested ? (literaryDirection ? "success" : "degraded") : "skipped",
					plotAdaptation: rerollPrep?.plotAdaptation ? "reused" : plotAdaptationRequested ? (plotAdaptation ? "success" : "degraded") : "skipped",
					sceneConductor: rerollPrep?.sceneConductor ? "reused" : sceneConductorRequested ? (sceneConductor ? "success" : "degraded") : "skipped",
						ecologyArrival: rerollPrep?.literaryEcology ? "reused" : arrivalRequested ? (arrivalCandidate ? "success" : "degraded") : "skipped",
						memoryRecall: memoryRecallRequested ? (memoryRecallBlocks?.length ? "success" : "degraded") : "skipped",
					},
					...(memoryRecallRequested ? {
						memoryRecall: {
							triggered: true,
							results: memoryRecallBlocks?.length ?? 0,
							queryChars: lastUserText.length,
							mode: memoryRecallMode,
							arcs: memoryArcs.length,
						},
					} : {}),
				},
					rpWorkflow: {
					planWrites: ws.planWrites,
					writes: ws.writes,
					appends: ws.appends,
					budgetReached: ws.appendLimitReached,
					overBudget: ws.overBudget,
					appendRejects: ws.appendRejects,
					edits: ws.edits,
					lookups: ws.lookups,
					skillReads: ws.skillReads,
					rounds: ws.rounds,
					outputTokens,
					durationMs: Date.now() - turnStartedAt,
					firstCallMaxTokens,
					perCallMaxTokens: mainCallMaxTokens,
					textChannelChars: text.length,
					thinkingChars,
					narrativeChars: draftBodyCharsOf(ws),
				},
				rpModelDiagnostics: modelDiagnostics,
				rpInputComposition: { ...writerInput, initialChars: writerInitialChars },
				rpContextPreflight: preflight.snapshot(),
				...(ws.patchAudit.length ? { rpPatchAudit: ws.patchAudit } : {}),
			};
			if (userText === null) {
				if (expectedTurnLeafId && sm.branch) sm.branch(expectedTurnLeafId);
			}
			entryId = sm.appendMessage({
				...final,
				content: [...keep, { type: "text", text: finalText }],
				details,
			});
			committedNarrativeId = entryId;
			sm.flush();
			// A reroll reuses rpPrep and must not create new novel metadata.
			if (!aborted && userText !== null) {
				commitNovelPlayState({ prepared: preparedNovelPlay, expectedLeafId: entryId, getLeafId: () => sm.getLeafId(), appendCustomEntry: (type, data) => sm.appendCustomEntry(type, data) });
				sm.flush();
			}
			// 设置是 session 元数据而非正文；续在回复之后，assistant 仍是 user 的直子。
			if (ownsSession()) { retainTurnMetadata(sm, entryId, pendingMetadata); sm.flush(); }
		} else if (final && finalText) generationLeafChanged = true;

		// 留档条目必须落在正文**之后**：append 会把叶移到自己身上（_appendEntry），
		// 落在正文之前就把正文垫成它的子节点、不再是 user 的直接子节点，而 swipe 变体
		// （listReplyVariants 只认 user 的直接子节点）随之一个都认不出来——v1.4.1 起
		// reroll 恒显 1/1、旧变体在树上却不可达。空拍（无 final/finalText）照样留档。
		// 生成期间叶已变化时整拍丢弃，不能先写 debug 再把“叶变化”误认成自己造成的。
		if (!generationLeafChanged && (entryId ? ownsSession() && this.#branchContains(sm.getBranch() as BranchEntryLike[], entryId) : stableLeaf(expectedTurnLeafId))) {
			sm.appendCustomEntry("rp-text-debug", { beatLog, draft: ws.draft, loopTail, finalText });
			sm.flush();
		}

		// 媒体交付落树（8/06 重接）：wire 只认树上的 toolResult 出 image/audio/video/html 帧。
		// 落在正文**之后**——屏上顺序与演出顺序一致（先看正文，再看图）。
		// 正文空拍时也要落：用户可能只让「把刚才那张图再给我看看」，没有正文照样得交付。
		if (!generationLeafChanged && ownsSession() && !aborted && ws.mediaDeliveries?.length) {
			for (const d of ws.mediaDeliveries) {
				sm.appendMessage({
					role: "toolResult",
					toolName: d.toolName,
					content: [{ type: "text", text: d.text }],
					details: d.details,
					isError: false,
					timestamp: Date.now(),
				});
			}
			sm.flush();
		}

		if (errored && !aborted && !entryId) {
			ev.onNotify?.("error", `生成失败：${errored}`);
			return { aborted: false, error: errored, entryId };
		}
		if (generationLeafChanged) {
			ev.onActivity?.("正文结果已丢弃（生成期间切换了分支）");
			return { aborted: true };
		}

		// 空手认栽（循环逼稿一次仍无产出）：明说，不再静默丢拍（实弹三拍 0 字正文的教训）
		if (stoppedByUser && !finalText) {
			return { aborted: false };
		}
		if (!errored && !aborted && !finalText) {
			ev.onNotify?.("warning", "本拍模型未交出任何正文（已催稿一次仍空手）——请重试或更换模型。");
			return { aborted: false, error: "no-draft" };
		}

		if (entryId && generationMode) { sm.appendCustomEntry("rp-turn-settlement", { version: 1, narrativeEntryId: entryId, status: aborted ? "pending" : "settling", mode: generationMode }); sm.flush(); }

		// M-A：#revise 旁路停用（8/10 验收整体退役；修改由模型自发 draft_edit 承担）。
		// 记账：world_state_update 干跑验证过的 patch 在此统一落账——
		// 落树刚完成、叶即本拍新条目，无叶漂移窗口；模型是记账主体，harness 只执行。
		if (entryId && !aborted && ws.patches.length > 0) {
			const nextState = projectedState(ws, state);
				sm.appendCustomEntry(STATE_ENTRY_TYPE, { ...nextState, _diagnosticSourceEntryId: entryId });
			const stateFile = this.#deps.getStateFile?.(sm.getSessionId());
			if (stateFile) {
				try {
					saveState(stateFile, nextState);
				} catch {
					// 缓存写失败不影响树上快照（账本权威在树，磁盘只是缓存）
				}
			}
			ev.onActivity?.(`记账 ${ws.patches.length} 笔（模型提交）`);
			sm.flush();
		}

		// 场记兜底（D5）：模型本拍没调 world_state_update 才旁路补账，M-B 视实弹数据决定退役。
		if (entryId && !aborted && narrativeText && ws.patches.length === 0) {
			if (identityRepair.changed) { sm.appendCustomEntry(STATE_ENTRY_TYPE, { ...state, _diagnosticSourceEntryId: entryId, _identityRepair: true }); sm.flush(); }
			const scribeAnchor = sm.getLeafId();
			const r = await runScribeTurn(
				{
					// 2048：账本+名录随剧情增长，patch 可能很长；1024 实测会截断出半截 JSON（8/03）
					sideText: (sp, ut) => turnSideText("settlement.scribe", "scribe", sp, ut, 2048),
					appendStateEntry: (s) => sm.appendCustomEntry(STATE_ENTRY_TYPE, { ...s, _diagnosticSourceEntryId: entryId }),
					getLeafId: () => sm.getLeafId(),
					isLeafStable: stableLeaf,
					stateFile: this.#deps.getStateFile?.(sm.getSessionId()),
					onActivity: (d) => ev.onActivity?.(d),
					identityHints,
				},
				{
					state,
					userText: lastUserText,
					// 场记只读正文事实。状态栏、选项和小剧场属于谢幕投影，绝不能升级进 rp-state。
					assistantText: narrativeText,
					charName: materials.card.name,
					userName: materials.config.userName,
				},
			);
			collector.status("settlement.scribe", r.kind === "stale" ? "aborted" : r.kind === "failed" ? "degraded" : r.kind === "skipped" ? "skipped" : "success");
			if (r.kind === "stale" || !ownsSession() || !this.#branchContains(sm.getBranch() as BranchEntryLike[], entryId) || (r.kind !== "applied" && !stableLeaf(scribeAnchor))) { discardPerformance = true; return { aborted: true, entryId }; }
			if (r.kind === "failed") console.error(`[stage-scribe] 记账跳过：${r.error}`);
			// 场记结果发生在 assistant 已落树之后；追加只读诊断工件，区分
			// “本拍无变化”与“场记失败”，不作为账本权威。
			sm.appendCustomEntry("rp-turn-diagnostic", {
				version: 1,
				sourceEntryId: entryId,
				stage: "scribe",
				kind: r.kind,
				...(r.kind === "skipped" ? { reason: r.reason } : {}),
				...(r.kind === "failed" ? { error: r.error.slice(0, 240) } : {}),
			});
			sm.flush();
			if (generationMode && r.kind === "failed") {
				ev.onNotify?.("warning", "正文已保存，账本尚未结算；下一条输入前会先恢复，不以旧账本继续演出。");
				return { aborted: this.#abort?.signal.aborted === true, entryId, error: "账本结算未完成" };
			}
		}
		if (entryId && generationMode && !aborted) { sm.appendCustomEntry("rp-turn-settlement", { version: 1, narrativeEntryId: entryId, status: "settling", ledgerDone: true, mode: generationMode }); sm.flush(); }

		// 后台世界推演：Skill 即开关、也是规则唯一权威。完整快照落当前分支，
		// 下一拍只注入裁剪投影；叶守卫防止异步推演写入用户已切换的世界线。
		const worldSkill = workflowSkill(materials.skillFiles, "world");
		if (entryId && !aborted && narrativeText && !legacyBackstage) {
			const sourceLeafId = sm.getLeafId();
			if (sourceLeafId) {
				const postBranch = sm.getBranch() as BranchEntryLike[];
				const postState = stateFromBranch(postBranch);
				const currentModularWorld = modularWorldFromBranch(postBranch, worldManifest);
				const currentWorld = projectLiteraryWorldV1(currentModularWorld);
				const currentEcology = literaryEcology;
				const previousEcologyRound = literaryEcologyFromBranch(postBranch).round;
				const currentPools = loadEcologyPools(cwd, config.card, card.name);
				const factsSkill = workflowSkill(materials.skillFiles, "world-facts");
				const auditSkill = workflowSkill(materials.skillFiles, "world-audit");
				const worldPromise = adaptiveWorldEnabled && worldSkill && factsSkill && auditSkill ? (async () => {
					ev.onActivity?.("后台世界：结算本拍事实与时间");
					const baseAudit = (status: WorldTransitionAuditEntry["status"], errors: string[], extra: Partial<WorldTransitionAuditEntry> = {}) => worldAuditEntry({
						status, narrativeEntryId: entryId, baseRound: currentWorld.round,
						...(worldManifest ? { cardKey: worldManifest.cardKey, manifestRevision: worldManifest.profileRevision } : {}),
						baseStateHash: worldTransitionHash(currentWorld), errors, ...extra,
					});
					const factPrompt = buildBeatFactPrompt(factsSkill.body, { userText: lastUserText, narrativeText, rpState: postState, world: currentWorld, history, manifest: worldManifest });
					const factText = await turnSideText("settlement.worldFacts", "literaryWorldFacts", factPrompt.systemPrompt, factPrompt.userText, 8192);
					if (typeof factText !== "string") return { state: undefined, audit: baseAudit("fact-failed", [factText.error]), error: `事实信封失败：${factText.error}` };
					let factResult = normalizeBeatFactEnvelope(factText, { userText: lastUserText, narrativeText });
					if (!factResult.envelope) { const repaired=await repairStructured("settlement.worldFacts","literaryWorldFacts",factPrompt,factText,factResult.errors); if(typeof repaired==="string") factResult=normalizeBeatFactEnvelope(repaired,{userText:lastUserText,narrativeText}); }
					if (!factResult.envelope) return { state: undefined, audit: baseAudit("fact-failed", factResult.errors), error: `事实信封拒绝：${factResult.errors.join("；")}` };
					const envelope = factResult.envelope;
					ev.onActivity?.(`后台世界：已确认 ${envelope.facts.length} 条带证据事实`);
					const dueModules = dueWorldModules(worldManifest, envelope);
					if (worldManifest && dueModules.length === 0) {
						const audit = baseAudit("committed", [], { nextRound: currentModularWorld.round, envelopeHash: worldTransitionHash(envelope), nextStateHash: worldTransitionHash(currentModularWorld), elapsed: envelope.elapsed, audit: { version: 1, verdict: "approve", issues: [], summary: "本拍没有到期的世界模块，世界保持稳定。" } });
						return { state: undefined, audit, error: undefined };
					}
					const modulePacks = worldModuleSkillPacks(materials.skillFiles, dueModules);
					const proposalPrompt = buildWorldProposalPrompt(worldSkill.body, { envelope, world: currentModularWorld, rpState: postState, manifest: worldManifest, dueModuleIds: dueModules.map((module) => module.id), moduleSkillBodies: modulePacks.map((skill) => ({ name: skill.name, body: skill.body })), ecologySignals: ecologySignalsForWorld(currentEcology) });
					const proposalText = await turnSideText("settlement.worldProposal", "literaryWorld", proposalPrompt.systemPrompt, proposalPrompt.userText, 8192);
					if (typeof proposalText !== "string") return { state: undefined, audit: baseAudit("proposal-failed", [proposalText.error], { envelopeHash: worldTransitionHash(envelope), elapsed: envelope.elapsed }), error: `世界提案失败：${proposalText.error}` };
					let proposalResult = normalizeModularWorldProposal(proposalText, currentModularWorld, envelope, worldManifest);
					if (!proposalResult.proposal) { const repaired=await repairStructured("settlement.worldProposal","literaryWorld",proposalPrompt,proposalText,proposalResult.errors); if(typeof repaired==="string") proposalResult=normalizeModularWorldProposal(repaired,currentModularWorld,envelope,worldManifest); }
					if (!proposalResult.proposal) return { state: undefined, audit: baseAudit("rejected", proposalResult.errors, { envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposalText), elapsed: envelope.elapsed }), error: `世界提案拒绝：${proposalResult.errors.join("；")}` };
					let proposal = proposalResult.proposal;
					ev.onActivity?.("后台世界：独立审计因果、主权与信息边界");
					let auditPrompt = buildWorldAuditPrompt(auditSkill.body, { envelope, proposal, world: currentModularWorld, rpState: postState, manifest: worldManifest, preflightWarnings: proposalResult.warnings });
					const auditText = await turnSideText("settlement.worldAudit", "literaryWorldAudit", auditPrompt.systemPrompt, auditPrompt.userText, 8192);
					if (typeof auditText !== "string") return { state: undefined, audit: baseAudit("audit-failed", [auditText.error], { envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposal), elapsed: envelope.elapsed }), error: `世界审计失败：${auditText.error}` };
					let auditResult = normalizeWorldTransitionAudit(auditText, envelope);
					if (!auditResult.audit) { const repaired=await repairStructured("settlement.worldAudit","literaryWorldAudit",auditPrompt,auditText,auditResult.errors); if(typeof repaired==="string") auditResult=normalizeWorldTransitionAudit(repaired,envelope); }
					if (!auditResult.audit) return { state: undefined, audit: baseAudit("audit-failed", auditResult.errors, { envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposal), elapsed: envelope.elapsed }), error: `世界审计不可解析：${auditResult.errors.join("；")}` };
					if(auditResult.audit.verdict!=="approve") {
						const feedback=auditResult.audit.issues.filter(x=>x.severity==="error").map(x=>x.message);
						const fixed=await repairStructured("settlement.worldProposal","literaryWorld",proposalPrompt,JSON.stringify(proposal),feedback.length?feedback:[auditResult.audit.summary]);
						if(typeof fixed==="string") {
							const normalized=normalizeModularWorldProposal(fixed,currentModularWorld,envelope,worldManifest);
							if(normalized.proposal){proposal=normalized.proposal;auditPrompt=buildWorldAuditPrompt(auditSkill.body,{envelope,proposal,world:currentModularWorld,rpState:postState,manifest:worldManifest,preflightWarnings:normalized.warnings});const checked=await turnSideText("settlement.worldAudit","literaryWorldAudit",auditPrompt.systemPrompt,auditPrompt.userText,8192);if(typeof checked==="string")auditResult=normalizeWorldTransitionAudit(checked,envelope);}
						}
					}
					if (!auditResult.audit || auditResult.audit.verdict !== "approve") return { state: undefined, audit: baseAudit("rejected", (auditResult.audit?.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message) ?? auditResult.errors), { envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposal), elapsed: envelope.elapsed, audit: auditResult.audit }), error: `世界提案未通过审计：${auditResult.audit?.summary ?? auditResult.errors.join("；")}` };
					const auditHash = worldTransitionHash(auditResult.audit);
					const nextState = commitModularWorldTransition(currentModularWorld, proposal, auditHash, worldManifest);
					return { state: nextState, audit: baseAudit("committed", [], { nextRound: nextState.round, envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposal), nextStateHash: worldTransitionHash(nextState), elapsed: envelope.elapsed, audit: auditResult.audit }), error: undefined };
				})() : Promise.resolve({ state: undefined, audit: undefined, error: undefined });
				const ecologyPromise = config.literaryEcologyEnabled === true && ecologyRuntimeSkill ? (async () => {
					ev.onActivity?.("鲜活世界：推进人物生活与场所事件");
				const prompt = buildEcologyRuntimePrompt(ecologyRuntimeSkill.body, {
					phase: "aftermath", ecology: currentEcology, global: currentPools.global, cardPool: currentPools.card, lore: materials.entries,
					state: postState, history, userText: latestUserOriginalText, userEntryId: latestUserEntryId, narrativeText, ...(generationMode && entryId ? { trustedNarrative: { entryId, text: narrativeText } } : {}), worldSignals: worldSignalsForEcology(currentModularWorld),
				});
				const result = await turnSideText("settlement.ecology", "ecologyRuntime", prompt.systemPrompt, prompt.userText, 16384);
				if (typeof result !== "string") return { state: degradedLiteraryEcologyRound(currentEcology, previousEcologyRound, "aftermath", result.error), degraded: true, error: result.error };
				let parsed = normalizeLiteraryEcologyState(result, currentEcology);
				if (!parsed) { const repaired=await repairStructured("settlement.ecology","ecologyRuntime",prompt,result,["生态JSON不可解析"],16384); if(typeof repaired==="string") parsed=normalizeLiteraryEcologyState(repaired,currentEcology); }
				if (!parsed) return { state: degradedLiteraryEcologyRound(currentEcology, previousEcologyRound, "aftermath", "输出不可解析"), degraded: true, error: "输出不可解析" };
				const transitionErrors = validateEcologyTransition(currentEcology, parsed, worldSignalsForEcology(currentModularWorld), { latestUserText: latestUserOriginalText, latestUserEntryId, committedState: committedEcology, ...(generationMode && entryId ? { trustedNarrative: { entryId, text: narrativeText } } : {}) });
				for (const warning of (parsed as typeof parsed & { commitmentWarnings?: string[] }).commitmentWarnings ?? []) ev.onActivity?.(`鲜活世界承诺来源门禁：${warning}`);
				if (transitionErrors.length) collector.status("settlement.ecology", "degraded");
				return transitionErrors.length
					? { state: degradedLiteraryEcologyRound(currentEcology, previousEcologyRound, "aftermath", transitionErrors.join("；")), degraded: true, error: transitionErrors.join("；") }
					: { state: commitLiteraryEcologyRound(parsed, previousEcologyRound), degraded: false, error: undefined };
				})() : config.literaryEcologyEnabled === true
					? Promise.resolve({ state: degradedLiteraryEcologyRound(currentEcology, previousEcologyRound, "aftermath", "人物与场所生态 Skill 缺失"), degraded: true, error: "人物与场所生态 Skill 缺失" })
					: Promise.resolve({ state: undefined, degraded: false, error: undefined });
				const [worldResult, ecologyResult] = await Promise.all([worldPromise, ecologyPromise]);
				if (this.#abort?.signal.aborted) return { aborted: true, entryId };
				if (!stableLeaf(sourceLeafId)) {
					ev.onActivity?.("拍后世界/生态结果已丢弃（期间切换了分支）");
					return { aborted: true, entryId };
				} else {
					// 模型并发、树写入串行：审计先留痕，权威世界仍在生态之前。
					if (worldResult.audit) sm.appendCustomEntry(WORLD_AUDIT_ENTRY_TYPE, worldResult.audit);
					if (worldResult.state) { sm.appendCustomEntry(LITERARY_WORLD_ENTRY_TYPE, { ...worldResult.state, _diagnosticSourceEntryId: entryId }); ev.onActivity?.(`后台世界推进至第 ${worldResult.state.round} 轮（已审计）`); }
					else if (worldResult.error) { settlementWarnings.push("world"); ev.onActivity?.(`后台世界推演失败（${worldResult.error}），保留上一快照`); }
					if (ecologyResult.state) {
						if (ecologyResult.degraded) settlementWarnings.push("ecology");
						if (!generationMode || config.allowDegradedGeneration === true || !ecologyResult.degraded) sm.appendCustomEntry(LITERARY_ECOLOGY_ENTRY_TYPE, { ...ecologyResult.state, _diagnosticSourceEntryId: entryId });
						else sm.appendCustomEntry("rp-ecology-audit", {status:"failed",narrativeEntryId:entryId,error:classifyModelFailure(ecologyResult.error??"生态解析失败").reason});
						if (!ecologyResult.degraded) {
							this.#ecologyPoolWrite = this.#ecologyPoolWrite.then(() => {
								const latest = loadEcologyPools(cwd, config.card, card.name);
								saveEcologyPools(cwd, config.card, applyEcologyUsage(latest, ecologyResult.state!));
							}).catch(() => undefined);
						}
						ev.onActivity?.(ecologyResult.degraded ? `鲜活世界：已落降级快照（${ecologyResult.error}）` : `鲜活世界推进至第 ${ecologyResult.state.round} 轮`);
					}
			sm.flush();
		}
		aborted = aborted || this.#abort?.signal.aborted === true;
		if (aborted) return { aborted: true, entryId };
			}
		}

		if (entryId && generationMode && !aborted) { sm.appendCustomEntry("rp-turn-settlement", { version: 1, narrativeEntryId: entryId, status: "settling", ledgerDone: true, worldDone: !settlementWarnings.includes("world"), ecologyDone: !settlementWarnings.includes("ecology"), degradedDomains: settlementWarnings, mode: generationMode }); sm.flush(); }

		// 独立谢幕必须读取场记、世界与生态已经提交后的最终分支状态，不在 writer 循环里提前猜。
		if (entryId && generationMode && !aborted && narrativeText) {
			const result = await this.#deliverAgentPresentation(materials, sm, entryId, narrativeText, authorDraft || text,
				stableLeaf, observation("curtain"));
			presentationDone = result.ok;
			if (!result.ok) { settlementWarnings.push("presentation"); ev.onNotify?.("error", `正文已保存，但卡格式交付失败：${result.error}。留待恢复，不把缺格式当完整成功。`); }
		}
		if (entryId && !generationMode && !aborted && narrativeText && curtain) {
			const curtainLeaf = sm.getLeafId();
			const settledBranch = sm.getBranch() as BranchEntryLike[];
			let nextCurtain = finalizeCurtainText("", curtainMaterials.formatPlan);
			if (curtainMaterials.formatPlan.modelTags.length > 0) {
				ev.onActivity?.("主演格式收尾：读取拍后最终状态生成非正文格式");
				const result = await turnSideText(
					"curtain", "writer",
					`你在执行梨园的独立格式收尾。正文已经冻结；只能生成当前卡 formatPlan 要求的非正文格式。\n\n${curtain}`,
					JSON.stringify({
						materials: curtainMaterials,
						frozen_narrative: narrativeText,
						current_state: stateFromBranch(settledBranch),
						current_world: literaryWorldFromBranch(settledBranch),
						current_ecology: literaryEcologyFromBranch(settledBranch),
					}, null, 2),
					curtainMaxTokens(model),
					undefined,
				);
				if (typeof result === "string") nextCurtain = finalizeCurtainText(result, curtainMaterials.formatPlan);
				else ev.onActivity?.(`主演格式收尾失败（${result.error}），仅保留确定性格式`);
			}
			if (stableLeaf(curtainLeaf) && nextCurtain.trim()) {
				sm.appendCustomEntry("rp-curtain-override", {
					targetEntryId: entryId,
					curtain: nextCurtain.trim(),
					createdAt: Date.now(),
				});
				sm.flush();
			} else if (!stableLeaf(curtainLeaf)) {
				ev.onActivity?.("主演格式收尾结果已丢弃（期间切换了分支）");
				return { aborted: true, entryId };
			}
		}

		// M4 长局压缩：攒够拍数就把早期剧情摘要成 rp-summary（装配时回读为【前情提要】）。
		// 放在谢幕前的最后一步——记账已落，摘要能读到最新账本；叶守卫在 runCompaction 内。
		// 压缩失败/未到期都只是跳过，下一拍会再判一次。
		if (entryId && !aborted && finalText && !databasePluginEnabled) {
			const endCompaction = collector.beginPhase("compaction");
			const compacted = await this.#compact(config.compactEveryNTurns ?? 30, undefined, entryId, observation("compaction"));
			endCompaction(compacted.kind === "failed" ? "degraded" : compacted.kind === "skipped" ? "skipped" : "success");
			this.#memoryEventWrite = this.#memoryEventWrite
				.then(() => this.#rollMemoryEvents(entryId))
				.catch((error) => console.error(`[stage-memory-events] 滚动提取失败：${error instanceof Error ? error.message : String(error)}`));
		}
		if (entryId && generationMode && !aborted && ownsSession() && this.#branchContains(sm.getBranch() as BranchEntryLike[], entryId)) for (const op of pendingOwnerTools) {
			try { const result = await runStageTool(readDeps, op.name, op.args, config.language); sm.flush(); if (result.activity) ev.onActivity?.(result.activity); }
			catch { settlementWarnings.push("asset"); ev.onNotify?.("warning", "资料或面板操作未完成，正文已保留；继续结算实际剧情"); }
		}
		if (entryId && !aborted && !legacyBackstage && databasePluginEnabled) {
			try { await this.#deps.databasePluginMemory!.after(entryId, this.#abort?.signal);
				sm.appendCustomEntry("rp-database-memory", { sourceEntryId: entryId, status: "complete" }); sm.flush(); }
			catch { sm.appendCustomEntry("rp-database-memory", { sourceEntryId: entryId, status: "pending" }); sm.flush(); settlementWarnings.push("memory"); ev.onNotify?.("warning", "正文已保存，但原数据库插件记忆整理失败；保留原数据，不假报入库成功"); }
		}
		if (entryId && generationMode && !aborted) {
			const domainFailures = settlementWarnings.filter(x => x === "world" || x === "ecology" || x === "presentation");
			const strict = config.allowDegradedGeneration !== true;
			sm.appendCustomEntry("rp-turn-settlement", { version: 1, narrativeEntryId: entryId,
				status: strict && domainFailures.length ? "pending" : settlementWarnings.length ? "degraded" : "complete",
				ledgerDone:true,worldDone:!domainFailures.includes("world"),ecologyDone:!domainFailures.includes("ecology"),presentationDone,degradedDomains:settlementWarnings,mode:generationMode }); sm.flush();
			if (strict && domainFailures.length) {
				const error = `正文已保存，但${domainFailures.join("/")}结算仍失败；已留待恢复收据，不用旧快照假装本拍完成。下一输入前必须先恢复。`;
				ev.onNotify?.("error",error); return {aborted:false,entryId,error};
			}
			if (generationMode === "director") this.#pendingBackground = () => {
				if (!ownsSession() || loadStageConfig(cwd).card !== config.card) return;
				this.#backgroundController = new AbortController();
				this.#startWorldProfilePrep(materials,sm.getBranch() as BranchEntryLike[]);
				if (config.literaryEcologyEnabled && ecologyGlobalSkill && ecologyCardSkill) {
					const latest = sm.getBranch() as BranchEntryLike[];
					this.#startEcologyPoolPrep({cardPath:config.card,card,entries:materials.entries,state:stateFromBranch(latest),history:rebuildHistory(latest).history,userText:lastUserText,userName:config.userName,globalSkill:ecologyGlobalSkill,cardSkill:ecologyCardSkill,pools:loadEcologyPools(cwd,config.card,card.name),signal:this.#backgroundController.signal});
				}
			};
		}
		return { aborted, entryId };
		} finally {
			if (modelDiagnostics.length && !discardPerformance && ownsSession()) {
				try { sm.appendCustomEntry("rp-model-diagnostics", { version: 1, narrativeEntryId: committedNarrativeId ?? null, calls: modelDiagnostics }); sm.flush(); } catch { /* Diagnostics are not canonical state. */ }
			}
			const metrics = collector.finish(committedNarrativeId ?? "");
			if (!discardPerformance && committedNarrativeId && ownsSession() && this.#branchContains(sm.getBranch() as BranchEntryLike[], committedNarrativeId)) {
				try { sm.appendCustomEntry(TURN_PERFORMANCE_ENTRY_TYPE, metrics); sm.flush(); }
				catch { rawEv.onActivity?.("本拍性能留痕写入失败（不影响正文权威）"); }
			}
		}
	}




	async #readAuthorNarrative(materials: StageMaterials, authorDraft: string, stable: (anchor:string|null)=>boolean,
		anchor:string|null, observation?:StageRequestObservation): Promise<{ok:true;narrative:string}|{ok:false;error:string}> {
		const skill = workflowSkill(materials.skillFiles,"author-boundary");
		if(!skill)return {ok:false,error:"无法确认当前卡的正文边界，缺少主作者原稿解析Skill"};
		let error = "主作者未返回有效正文边界";
		for(let attempt=0;attempt<2;attempt++) {
			if(!stable(anchor)||this.#abort?.signal.aborted)return {ok:false,error:"正文边界解析已取消或分支改变"};
			this.#deps.events?.onActivity?.("主作者识别当前卡自定义正文结构：只取已写原文，不套固定正文标签");
			const result = await this.#sideText("writer",skill.body,JSON.stringify({phase:"author-boundary",author_draft:authorDraft,
				materials:buildAgentPresentationMaterials({card:materials.card,entries:materials.entries,preset:materials.preset,statusBarFormats:materials.statusBarFormats}),
				...(attempt?{validation_errors:[error]}:{})},null,2),16384,undefined,this.#abort?.signal,observation);
			if(typeof result!=="string"){error=result.error;continue;}
			try {
				const row=JSON.parse(result.trim().replace(/^```(?:json)?\s*|\s*```$/g,""));
				if(!Array.isArray(row.fragments)||!row.fragments.length||row.fragments.length>100)throw new Error("原稿没有可核对的故事正文");
				let cursor=0;const fragments:string[]=[];
				for(const quote of row.fragments){
					if(typeof quote!=="string"||!quote.trim())throw new Error("正文片段不是非空原文字符串");
					const at=authorDraft.indexOf(quote,cursor);
					if(at<0)throw new Error("正文片段改变、遗漏定位或倒置了主作者原文");
					cursor=at+quote.length;fragments.push(quote);
				}
				const narrative=presentationPlainText(fragments.join("\n\n"));
				if(!narrative.trim())throw new Error("原稿只有附属格式，没有故事正文");
				if(!stable(anchor)||this.#abort?.signal.aborted)return {ok:false,error:"迟到正文边界未采用"};
				return {ok:true,narrative};
			}catch(e){error=e instanceof Error?e.message:String(e);}
		}
		return {ok:false,error};
	}

	async #deliverAgentPresentation(materials: StageMaterials, sm: StageSessionManager, entryId: string,
		narrative: string, authorDraft: string, stable: (anchor: string | null) => boolean,
		observation?: StageRequestObservation): Promise<{ok:true} | {ok:false;error:string}> {
		const skill = workflowSkill(materials.skillFiles, "agent-presentation");
		if (!skill) return {ok:false,error:"缺少卡格式完整交付Skill，未用固定标签模板替代"};
		const ownerModel = this.#deps.getModel();
		if (!ownerModel) return {ok:false,error:"未配置正文主作者模型"};
		const anchor = sm.getLeafId(), branch = sm.getBranch() as BranchEntryLike[];
		const manifest = worldManifestFromBranch(branch), world = modularWorldFromBranch(branch, manifest);
		const state = stateFromBranch(branch), ecology = literaryEcologyFromBranch(branch);
		const payload = {
			phase: "agent-presentation", materials: buildAgentPresentationMaterials({card:materials.card,entries:materials.entries,preset:materials.preset,statusBarFormats:materials.statusBarFormats,activated:scanEntries(materials.entries,authorDraft+"\n"+narrative+"\n"+Object.keys(state.characters).join("\n"),materials.config.maxLoreInjections)}),
			frozen_narrative: narrative, frozen_segments:presentationSegments(narrative), authored_images:authoredImages(authorDraft), author_draft: authorDraft, current_user_input: [...branch].reverse().find(entry=>entry.message?.role==="user")?.message?.content, user:{name:materials.config.userName,persona:materials.config.userPersona}, current_state: state,
			current_world: world, current_ecology: ecology, calendar_facts: projectPresentation(state, world, ecology, materials.config.userName).calendar,
		};
		const planSkill = workflowSkill(materials.skillFiles,"presentation-plan");
		if(!planSkill)return {ok:false,error:"缺少卡格式需求识别Skill，未回退固定标签清单"};
		const planningMaterials = {...payload.materials,sources:payload.materials.sources.filter(source=>source.formatCandidate)};
		// Stable card instructions are separate source documents too, not tag-name hints.
		for(const [name,text] of Object.entries(payload.materials.card))if(name!=="name"&&text.trim())planningMaterials.sources.push({id:`card:${name}`,title:`card.${name}`,content:text,formatCandidate:true});
		const validationFailed = (reason:string) => {
			observation?.diagnostics?.push({phase:observation.phase,step:"writer",provider:String(ownerModel.provider??""),model:ownerModel.id,attempt:1,status:"failed",kind:"format",validationOnly:true,durationMs:0,reason:classifyModelFailure(reason).reason});
		};
		let plan:import("./agent-presentation.ts").AgentPresentationPlan|undefined, planError="需求识别未完成";
		for(let attempt=0;attempt<2&&!plan;attempt++){
			if(!stable(anchor)||this.#abort?.signal.aborted)return {ok:false,error:"格式需求识别已取消或分支改变"};
			this.#deps.events?.onActivity?.("主Agent逐份读取当前卡格式原文，确定本拍完整交付清单");
			const result=await this.#sideText("writer",planSkill.body,JSON.stringify({...payload,phase:"presentation-plan",materials:planningMaterials,...(attempt?{validation_errors:[planError]}:{})},null,2),16384,undefined,this.#abort?.signal,observation);
			if(typeof result!=="string"){planError=result.error;continue;}
			const parsed=parseAgentPresentationPlan(result,planningMaterials);
			if(parsed.ok)plan=parsed.plan;else {planError=parsed.error;validationFailed(planError);}
		}
		if(!plan)return {ok:false,error:planError};
		let error = "未收到有效格式交付", attempt = 0, sourceReads = 0;
		for (let requestIndex = 0; requestIndex < 4 && attempt < 2; requestIndex++) {
			if (!stable(anchor) || this.#abort?.signal.aborted) return {ok:false,error:"格式交付已取消或分支变化"};
			this.#deps.events?.onActivity?.(attempt ? "卡格式校验失败：同主作者读取原因后重新交付" : "卡格式完整交付：原文规则、穿插图片与行动选项，两模式同一契约");
			const result = await this.#sideText("writer", skill.body, JSON.stringify({...payload,format_requirements:plan, ...(attempt ? {validation_errors:[error]} : {})},null,2),
				curtainMaxTokens(ownerModel), undefined, this.#abort?.signal, observation);
			if (typeof result !== "string") { error = result.error; attempt++; continue; }
			try {
				const requested = JSON.parse(result.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
				if (Array.isArray(requested.readSources) && requested.readSources.length && sourceReads++ < 2) {
					const enabled = materials.entries.filter(entry => entry.enabled);
					let valid = true;
					for (const id of requested.readSources.slice(0,16)) {
						if (typeof id !== "string" || !payload.materials.sourceIndex.some(source => source.id === id)) { valid=false; break; }
						if (payload.materials.sources.some(source => source.id === id)) continue;
						const index = Number(id.split(":")[1]);
						const source = id.startsWith("lore:") ? enabled[index]?.content : materials.preset?.blocks[index]?.content;
						const title = payload.materials.sourceIndex.find(source => source.id === id)!.title;
						if (typeof source !== "string") { valid=false; break; }
						payload.materials.sources.push({id,title,content:source});
					}
					if (valid) { this.#deps.events?.onActivity?.("卡格式Agent按索引读取原始定义（未截断，不改变输出清单）"); continue; }
				}
			} catch { /* The ordinary validator handles malformed JSON and records a finite retry. */ }
			attempt++;
			const parsed = parseAgentPresentation(result, narrative, authorDraft, plan);
			if (!parsed.ok) {
				error = parsed.error;
				validationFailed(error);
				if (/JSON/.test(error)) {
					const repaired=await this.#repairStructured("writer",{systemPrompt:skill.body,userText:JSON.stringify({...payload,format_requirements:plan})},result,[error],curtainMaxTokens(ownerModel),observation);
					if(typeof repaired==="string"){
						const valid=parseAgentPresentation(repaired,narrative,authorDraft,plan);
						if(valid.ok&&stable(anchor)&&!this.#abort?.signal.aborted){sm.appendCustomEntry("rp-presentation-delivery",{targetEntryId:entryId,...valid.delivery,formatPlan:plan,inputSourceCount:payload.materials.sources.length,inputChars:JSON.stringify(payload.materials).length,retryCount:attempt,createdAt:Date.now()});sm.flush();return {ok:true};}
						if(!valid.ok)error=valid.error;
					}
				}
				continue;
			}
			if (!stable(anchor) || this.#abort?.signal.aborted) return {ok:false,error:"迟到格式结果未采用"};
			sm.appendCustomEntry("rp-presentation-delivery", {targetEntryId:entryId,...parsed.delivery,formatPlan:plan,inputSourceCount:payload.materials.sources.length,inputChars:JSON.stringify(payload.materials).length,retryCount:attempt-1,createdAt:Date.now()});
			sm.flush(); return {ok:true};
		}
		return {ok:false,error};
	}

	/** 半稿或结算失败的正文保留在树上；新输入落树前先补齐镜头账本和启用的领域结算。 */
	async #recoverPendingTurn(materials: StageMaterials, sm: StageSessionManager, ev: StageEvents, stable: (anchor: string | null) => boolean, recoveryObservation?:StageRequestObservation): Promise<void> {
		const branch = sm.getBranch() as BranchEntryLike[];
		const status = new Map<string, { status?: string; ledgerDone?: boolean; worldDone?: boolean; ecologyDone?: boolean; presentationDone?: boolean; degradedDomains?: string[] }>();
		for (const e of branch) if (e.customType === "rp-turn-settlement" && e.data && typeof e.data === "object") {
			const d = e.data as { narrativeEntryId?: string; status?: string }; if (d.narrativeEntryId && d.status) status.set(d.narrativeEntryId, d);
		}
		const strictRecovery = materials.config.allowDegradedGeneration !== true;
		const pending = [...branch].reverse().find(e => {
			if(e.type!=="message"||e.message?.role!=="assistant"||!e.id)return false;
			const receipt=status.get(e.id);return ["pending","settling"].includes(receipt?.status??"") || (strictRecovery && receipt?.status==="degraded" && receipt.degradedDomains?.some(x=>x==="world"||x==="ecology"));
		});
		if (!pending?.id) return;
		const id = pending.id, recordedCheckpoint = status.get(id), details = pending.message?.details as Record<string, unknown> | undefined;
		const checkpoint = recordedCheckpoint?.status === "degraded" && strictRecovery ? { ...recordedCheckpoint, worldDone:!recordedCheckpoint.degradedDomains?.includes("world"),ecologyDone:!recordedCheckpoint.degradedDomains?.includes("ecology") } : recordedCheckpoint;
		const narrative = typeof details?.rpNarrative === "string" ? details.rpNarrative : "";
		const trustedNarrative = ["direct", "director"].includes(String(details?.rpGenerationMode)) ? { entryId: id, text: narrative } : undefined;
		if (!narrative.trim()) { sm.appendCustomEntry("rp-turn-settlement", { version: 1, narrativeEntryId: id, status: "complete", recovered: true }); sm.flush(); return; }
		const at = branch.indexOf(pending), userEntry = branch.slice(0, at).reverse().find(e => e.message?.role === "user");
		const content = userEntry?.message?.content;
		const userText = typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p.type === "text").map(p => p.text ?? "").join("") : "";
		const state = stateFromBranch(branch), { config, card } = materials;
		const side = (step: SideModelStep, sp: string, ut: string, max = 8192) => this.#sideText(step, sp, ut, max, "off", this.#abort?.signal,recoveryObservation);
		ev.onActivity?.("恢复上一拍未结算正文：先核对实际发生的内容，不重写半稿");
		const ledger = (checkpoint?.ledgerDone || branch.some(e => e.customType === STATE_ENTRY_TYPE && (e.data as Record<string, unknown> | undefined)?._diagnosticSourceEntryId === id)) ? { kind: "skipped" as const, reason: "already-settled" } : await runScribeTurn({ sideText: (sp, ut) => side("scribe", sp, ut, 2048), appendStateEntry: next => sm.appendCustomEntry(STATE_ENTRY_TYPE, { ...next, _diagnosticSourceEntryId: id }), getLeafId: () => sm.getLeafId(), isLeafStable: stable, stateFile: this.#deps.getStateFile?.(sm.getSessionId()), onActivity: ev.onActivity }, { state, userText, assistantText: narrative, charName: card.name, userName: config.userName });
		if (ledger.kind === "failed" || ledger.kind === "stale" || this.#abort?.signal.aborted) throw new Error("上一拍账本恢复尚未完成；本条输入未受理，不读取过期账本");
		sm.appendCustomEntry("rp-turn-settlement", { version: 1, narrativeEntryId: id, ...checkpoint, status: "settling", ledgerDone: true }); sm.flush();
		const postBranch = sm.getBranch() as BranchEntryLike[], anchor = sm.getLeafId();
		const manifest = worldManifestFromBranch(postBranch), world = modularWorldFromBranch(postBranch, manifest);
		const ecology = literaryEcologyFromBranch(postBranch), postState = stateFromBranch(postBranch);
		const history = rebuildHistory(postBranch, materials.promptRules).history;
		const degraded: string[] = (checkpoint?.degradedDomains ?? []).filter(x=>x!=="world"&&x!=="ecology"&&x!=="presentation");
		let nextWorld: ReturnType<typeof commitModularWorldTransition> | undefined;
		let auditEntry: ReturnType<typeof worldAuditEntry> | undefined;
		let approvedRecoveryAudit: import("./literary-world-transition.ts").WorldTransitionAudit | undefined;
		const recordedWorld = postBranch.some(e => (e.customType === LITERARY_WORLD_ENTRY_TYPE && (e.data as Record<string, unknown> | undefined)?._diagnosticSourceEntryId === id) || (e.customType === WORLD_AUDIT_ENTRY_TYPE && (e.data as Record<string, unknown> | undefined)?.narrativeEntryId === id && (e.data as Record<string,unknown> | undefined)?.status === "committed"));
		const recordedEcology = postBranch.some(e => e.customType === LITERARY_ECOLOGY_ENTRY_TYPE && (e.data as Record<string, unknown> | undefined)?._diagnosticSourceEntryId === id && !(e.data as Record<string,unknown> | undefined)?.degraded);
		if (!checkpoint?.worldDone && !recordedWorld && config.literaryWorldEnabled && manifest) {
			const facts = workflowSkill(materials.skillFiles, "world-facts"), rules = workflowSkill(materials.skillFiles, "world"), audit = workflowSkill(materials.skillFiles, "world-audit");
			if (facts && rules && audit) {
				const fp = buildBeatFactPrompt(facts.body, { userText, narrativeText: narrative, rpState: postState, world: projectLiteraryWorldV1(world), history, manifest });
				const f = await side("literaryWorldFacts", fp.systemPrompt, fp.userText);
				let parsed = typeof f === "string" ? normalizeBeatFactEnvelope(f, { userText, narrativeText: narrative }) : undefined;
				if(typeof f==="string"&&!parsed?.envelope){const fixed=await this.#repairStructured("literaryWorldFacts",fp,f,parsed?.errors??["事实信封无效"],8192,recoveryObservation);if(typeof fixed==="string")parsed=normalizeBeatFactEnvelope(fixed,{userText,narrativeText:narrative});}
				if (parsed?.envelope) {
					const env = parsed.envelope, due = dueWorldModules(manifest, env);
					if (due.length) {
						const pp = buildWorldProposalPrompt(rules.body, { envelope: env, world, rpState: postState, manifest, dueModuleIds: due.map(m => m.id), moduleSkillBodies: worldModuleSkillPacks(materials.skillFiles, due).map(x => ({ name: x.name, body: x.body })), ecologySignals: ecologySignalsForWorld(ecology) });
						const pt = await side("literaryWorld", pp.systemPrompt, pp.userText);
						let proposal = typeof pt === "string" ? normalizeModularWorldProposal(pt, world, env, manifest) : undefined;
						if(typeof pt==="string"&&!proposal?.proposal){const fixed=await this.#repairStructured("literaryWorld",pp,pt,proposal?.errors??["世界提案无效"],8192,recoveryObservation);if(typeof fixed==="string")proposal=normalizeModularWorldProposal(fixed,world,env,manifest);}
						if (proposal?.proposal) {
							const ap = buildWorldAuditPrompt(audit.body, { envelope: env, proposal: proposal.proposal, world, rpState: postState, manifest, preflightWarnings: proposal.warnings });
							const a = await side("literaryWorldAudit", ap.systemPrompt, ap.userText);
							let normalized = typeof a === "string" ? normalizeWorldTransitionAudit(a, env) : undefined;
							if(typeof a==="string"&&!normalized?.audit){const fixed=await this.#repairStructured("literaryWorldAudit",ap,a,normalized?.errors??["审计报告无效"],8192,recoveryObservation);if(typeof fixed==="string")normalized=normalizeWorldTransitionAudit(fixed,env);}
							if(normalized?.audit?.verdict!=="approve") {
								const errors=normalized?.audit?.issues.filter(x=>x.severity==="error").map(x=>x.message)??normalized?.errors??["世界审计未返回有效报告"];
								ev.onActivity?.(`世界恢复审计拒绝：${errors.join("；")}；修复原提案后再次独立审计。`);
								const fixed=await this.#repairStructured("literaryWorld",pp,JSON.stringify(proposal.proposal),errors,8192,recoveryObservation);
								if(typeof fixed==="string"){
									const revised=normalizeModularWorldProposal(fixed,world,env,manifest);
									if(revised.proposal){const retryAudit=buildWorldAuditPrompt(audit.body,{envelope:env,proposal:revised.proposal,world,rpState:postState,manifest,preflightWarnings:revised.warnings});const value=await side("literaryWorldAudit",retryAudit.systemPrompt,retryAudit.userText);const check=typeof value==="string"?normalizeWorldTransitionAudit(value,env):undefined;if(check?.audit?.verdict==="approve"){approvedRecoveryAudit=check.audit;nextWorld=commitModularWorldTransition(world,revised.proposal,worldTransitionHash(check.audit),manifest);}else ev.onActivity?.(`修复后审计仍拒绝：${check?.audit?.summary??check?.errors.join("；")??"请求失败"}`);}
								}
							}
							else { approvedRecoveryAudit=normalized.audit;nextWorld = commitModularWorldTransition(world, proposal.proposal, worldTransitionHash(normalized.audit), manifest); }
						}
						if (!nextWorld) degraded.push("world");
					}
				} else degraded.push("world");
			} else degraded.push("world");
			auditEntry = worldAuditEntry({ status: degraded.includes("world") ? "rejected" : "committed", narrativeEntryId: id, baseRound: world.round, baseStateHash: worldTransitionHash(world), cardKey: manifest.cardKey, manifestRevision: manifest.profileRevision, errors: degraded.includes("world") ? ["恢复结算未通过世界证据/审计，保留旧快照"] : [], ...(approvedRecoveryAudit ? {audit:approvedRecoveryAudit} : {}) });
		}
		let nextEcology: LiteraryEcologyState | undefined;
		if (!checkpoint?.ecologyDone && !recordedEcology && config.literaryEcologyEnabled) {
			const skill = workflowSkill(materials.skillFiles, "ecology-runtime"), pools = loadEcologyPools(this.#deps.cwd, config.card, card.name);
			if (skill) {
				const ep = buildEcologyRuntimePrompt(skill.body, { phase: "aftermath", ecology, global: pools.global, cardPool: pools.card, state: postState, history, userText, userEntryId: userEntry?.id, narrativeText: narrative, trustedNarrative, worldSignals: worldSignalsForEcology(world) });
				const r = await side("ecologyRuntime", ep.systemPrompt, ep.userText, 16384);
				let parsed = typeof r === "string" ? normalizeLiteraryEcologyState(r, ecology) : undefined;
				if(typeof r==="string"&&!parsed){const fixed=await this.#repairStructured("ecologyRuntime",ep,r,["生态JSON不可解析"],16384,recoveryObservation);if(typeof fixed==="string")parsed=normalizeLiteraryEcologyState(fixed,ecology);}
				if (parsed && !validateEcologyTransition(ecology, parsed, worldSignalsForEcology(world), { latestUserText: userText, latestUserEntryId: userEntry?.id, committedState: ecology, trustedNarrative }).length) nextEcology = commitLiteraryEcologyRound(parsed, ecology.round);
			}
			if (!nextEcology) { degraded.push("ecology"); nextEcology = degradedLiteraryEcologyRound(ecology, ecology.round, "aftermath", "恢复结算未通过，保留原有内容"); }
		}
		if (!stable(anchor) || this.#abort?.signal.aborted) throw new Error("恢复结果因分支变化或取消丢弃，本条输入未受理");
		if (recordedWorld && checkpoint?.worldDone === false && !auditEntry) {
			const snapshot=[...postBranch].reverse().find(e=>e.customType===LITERARY_WORLD_ENTRY_TYPE&&(e.data as Record<string,unknown>|undefined)?._diagnosticSourceEntryId===id);
			if(snapshot){ev.onActivity?.("世界已经按本拍来源提交；校正旧失败收据，不重复推进或伪造新的模型审阅。");auditEntry=worldAuditEntry({status:"committed",narrativeEntryId:id,baseRound:world.round,nextRound:world.round,baseStateHash:worldTransitionHash(world),nextStateHash:worldTransitionHash(world),errors:[]});}
		}
		if (auditEntry) sm.appendCustomEntry(WORLD_AUDIT_ENTRY_TYPE, auditEntry);
		if (nextWorld) sm.appendCustomEntry(LITERARY_WORLD_ENTRY_TYPE, { ...nextWorld, _diagnosticSourceEntryId: id });
		if (nextEcology && (!degraded.includes("ecology") || config.allowDegradedGeneration === true)) sm.appendCustomEntry(LITERARY_ECOLOGY_ENTRY_TYPE, { ...nextEcology, _diagnosticSourceEntryId: id });
		let presentationRestored = checkpoint?.presentationDone;
		if (checkpoint?.presentationDone === false || checkpoint?.degradedDomains?.includes("presentation")) {
			const delivered = await this.#deliverAgentPresentation(materials, sm, id, narrative,
				typeof details.rpAuthorDraft === "string" ? details.rpAuthorDraft : narrative, stable, recoveryObservation);
			presentationRestored = delivered.ok;
			if (!delivered.ok) degraded.push("presentation");
		}
		sm.appendCustomEntry("rp-turn-settlement", { version: 1, narrativeEntryId: id, presentationDone:presentationRestored, status: degraded.some(x=>x==="world"||x==="ecology"||x==="presentation") && config.allowDegradedGeneration !== true ? "pending" : degraded.length ? "degraded" : "complete", recovered:true,ledgerDone:true,worldDone:!degraded.includes("world"),ecologyDone:!degraded.includes("ecology"),degradedDomains:degraded });
		sm.flush();
		if (degraded.some(x=>x==="world"||x==="ecology"||x==="presentation") && config.allowDegradedGeneration !== true) throw new Error(`上一拍${degraded.join("/")}仍未恢复；已诊断，不接收新输入，不跳过失败。`);
	}

	/** 每剧情库 N 拍提取一次事件账本；失败不推进游标，下一拍自动扩大窗口重试。 */
	async #rollMemoryEvents(sourceEntryId: string): Promise<void> {
		const sm = this.#deps.getSessionManager();
		const book = this.#deps.eventBook?.(sm.getSessionId());
		if (!book || !this.#deps.upsertEventDigest) return;
		const every = Math.max(0, Math.floor(book.everyNTurns()));
		if (every <= 0) return;
		const materials = loadStageMaterials(this.#deps.cwd);
		const skill = workflowSkill(materials.skillFiles, "memory");
		if (!skill) return;
		const branch = sm.getBranch() as BranchEntryLike[];
		const sourceIndex = branch.findIndex((entry) => entry.id === sourceEntryId);
		if (sourceIndex < 0) return;
		const bounded = branch.slice(0, sourceIndex + 1);
		const cursor = book.getCursor();
		const cursorIndex = cursor ? bounded.findIndex((entry) => entry.id === cursor) : -1;
		const beatStarts = bounded.map((entry, index) => entry.type === "message" && entry.message?.role === "user" ? index : -1).filter((index) => index >= 0);
		if (beatStarts.length < every) return;
		let starts = cursorIndex >= 0 ? beatStarts.filter((index) => index > cursorIndex) : beatStarts.slice(-every);
		if (starts.length < every) return;
		starts = starts.slice(-Math.max(every, every * 4));
		const memoryWindow = narrativeMemoryWindow(bounded, sourceEntryId, starts.length);
		if (!memoryWindow) return;
		let remaining = 24_000;
		const sent: typeof memoryWindow.entries = [];
		const refs: Array<{ entryId: string; entryType: string; turn: number; textBasis: "rpNarrative" | "entryText"; charFrom: number; charTo: number }> = [];
		for (const entry of [...memoryWindow.entries].reverse()) {
			const take = Math.min(remaining, entry.text.length);
			if (take <= 0) break;
			sent.unshift({ ...entry, text: entry.text.slice(-take) });
			refs.unshift({ entryId: entry.entryId, entryType: entry.entryType, turn: entry.turn, textBasis: entry.textBasis,
				charFrom: entry.text.length - take, charTo: entry.text.length });
			remaining -= take;
		}
		const narrative = sent.map((entry) => `【sourceRef ${JSON.stringify(refs.find((ref) => ref.entryId === entry.entryId))}】\n${entry.role === "assistant" ? materials.card.name : materials.config.userName}：${entry.text}`).join("\n\n");
		if (narrative.length < 20 || !refs.length) return;
		const existingAll = book.listEvents();
		const preferred = existingAll.filter((event) => event.importance === "core" || event.importance === "major");
		const existing = [...preferred, ...existingAll.slice(-30)].filter((event, index, list) => list.findIndex((item) => item.id === event.id) === index).slice(0, 12);
		const arcs = [...new Set(existingAll.map((event) => event.arc).filter((arc): arc is string => !!arc))].slice(-10);
		const sys = `你是梨园的记忆整理旁路。遵守工作流 skill 的规则。\n\n# 工作流 skill：剧情记忆摘要\n${skill.body ?? ""}`;
		const user = `<narrative>\n${narrative}\n</narrative>\n\n<sourceRefs>\n${JSON.stringify(refs)}\n</sourceRefs>\n\n<existing-events>\n${JSON.stringify(existing)}\n</existing-events>\n\n<existing-arcs>\n${JSON.stringify(arcs)}\n</existing-arcs>\n\n请提取事件卡（仅 JSON）。`;
		const expectedLeaf = sm.getLeafId();
		const result = await this.#sideText("memoryEvents", sys, user, 4096);
		if (typeof result !== "string" || !turnLeafIsStable(sm, expectedLeaf)) return;
		const events = parseMemoryEventPayload(result, refs);
		if (!events) return;
		const knownIds = new Set(existingAll.map((event) => event.id));
		const finalIds = new Map<string, string>();
		let storedCount = 0;
		let failedCount = 0;
		for (const event of events) {
			const mergeTarget = event.op?.startsWith("merge:") ? event.op.slice("merge:".length) : undefined;
			const finalId = mergeTarget && knownIds.has(mergeTarget)
				? mergeTarget
				: canonicalEventId({ sessionId: sm.getSessionId(), card: materials.config.card }, { ...event, sourceRefs: event.sourceRefs.length ? event.sourceRefs : refs });
			for (const key of [event.id, event.sourceKey].filter((value): value is string => !!value)) finalIds.set(key, finalId);
		}
		for (const event of events) {
			if (event.op === "skip") continue;
			const sourceRefs = event.sourceRefs.length ? event.sourceRefs : refs;
			const normalized = {
				...event,
				sourceRefs,
				branchLeafId: expectedLeaf ?? undefined,
				links: event.links?.map((link) => ({ ...link, to: finalIds.get(link.to) ?? link.to })),
			};
			const result = await this.#deps.upsertEventDigest(sm.getSessionId(), normalized).catch(() => ({ stored: false }));
			if (result?.stored) {
				storedCount++;
			} else {
				failedCount++;
				this.#deps.events?.onActivity?.(`剧情记忆：事件「${event.title}」入库失败（${(result as { error?: string })?.error ?? "unknown"}）`);
			}
		}
		if (!turnLeafIsStable(sm, expectedLeaf)) return;
		// 游标只在「无事件」或「全部非 skip 事件保存成功」时推进；
		// 任一失败都不推进，下一拍窗口自动扩大重试（upsert 幂等，不会重复建卡）。
		if (failedCount === 0) {
			book.setCursor(sourceEntryId);
			this.#deps.events?.onActivity?.(events.length ? `剧情记忆：滚动登记/更新 ${storedCount} 条事件` : "剧情记忆：本窗口无高价值事件");
		} else {
			this.#deps.events?.onActivity?.(`剧情记忆：${failedCount} 条事件写入失败，游标未推进，下窗口将重试`);
		}
	}

	/**
	 * 手动压缩（/compact）：不等周期，立刻把早期剧情摘要成 rp-summary。
	 * everyNTurns=1 + 更低的字数地板 = 「只要真有可裁的早期剧情就压」
	 * （仍守最近 KEEP_RECENT_BEATS 拍原文，续演点不动）。
	 * 流式中拒绝——压缩要改上下文，不能与正在装配的一拍打架。
	 */
	async compactNow(): Promise<CompactOutcome> {
		if (this.#deps.databasePluginMemory?.enabled()) return {kind:"skipped",reason:"upstream-plugin-managed"};
		if (this.#busy) return { kind: "skipped", reason: "busy" };
		const model = this.#deps.getModel();
		if (!model) return { kind: "failed", error: "尚未配置剧情模型" };
		this.#busy = true;
		this.#abort = new AbortController();
		try {
			return await this.#compact(1, MANUAL_MIN_COMPACT_CHARS);
		} catch (err) {
			return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
		} finally {
			this.#abort = null;
			this.#busy = false;
		}
	}

	/** 压缩一次（自动/手动共用）。失败只记日志不抛——压缩从不影响正文。 */
	async #compact(
		everyNTurns: number,
		minChars?: number,
		sourceEntryId?: string,
		observation?: StageRequestObservation,
	): Promise<CompactOutcome> {
		const ev = this.#deps.events ?? {};
		const sm = this.#deps.getSessionManager();
		const materials = loadStageMaterials(this.#deps.cwd);
		const { config, card } = materials;
		try {
			const branch = sm.getBranch() as BranchEntryLike[];
			const memoryExpectedLeaf = sm.getLeafId();
			const c = await runCompaction(
				{
					// 4096：摘要要装下前情/人物/伏笔/事实账五节，且要合并上一份摘要
					sideText: (sp, ut) => this.#sideText("compaction", sp, ut, 4096, "off", this.#abort?.signal, observation),
					appendSummaryEntry: (data: RpSummaryData) => sm.appendCustomEntry(SUMMARY_ENTRY_TYPE, data),
					normalizeSummary: (summary, events, refs) => {
						// refs 来自被压缩区间（compact.ts 统一传入）：摘要别名与事件卡 canonical 种子保持一致。
						const candidateRefs: Array<{ entryId: string; entryType?: string }> = refs.map((ref) => ({ entryId: ref.entryId, entryType: ref.entryType }));
						let normalized = summary;
						for (const event of events) {
							const eventRefs = event.sourceRefs.filter((ref) => candidateRefs.some((candidate) => candidate.entryId === ref.entryId));
							const canonical = canonicalEventId(
								{ sessionId: sm.getSessionId(), card: config.card },
								{ ...event, sourceRefs: eventRefs.length ? eventRefs : candidateRefs },
							);
							for (const alias of [event.id, event.sourceKey].filter((value): value is string => !!value)) {
								const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
								normalized = normalized.replace(new RegExp(escaped, "g"), canonical);
							}
						}
						return normalized;
					},
					getLeafId: () => sm.getLeafId(),
					archive: this.#deps.archiveCompacted
						? (text, opts) =>
													turnLeafIsStable(sm, memoryExpectedLeaf)
										? this.#deps.archiveCompacted!(sm.getSessionId(), text, opts && { sourceRefs: opts.sourceRefs, perEntry: opts.perEntry })
										: Promise.resolve()
						: undefined,
					// PLAN-RP-MEMORY：事件候选提取（memory workflow skill + 旁路模型）
					extractEvents:
						this.#deps.upsertEventDigest
							? async (text, opts) => {
								if (!turnLeafIsStable(sm, memoryExpectedLeaf)) return;
									const materials = loadStageMaterials(this.#deps.cwd);
									const skill = workflowSkill(materials.skillFiles, "memory");
									if (!skill) return;
									const sys = `你是梨园的记忆整理旁路。遵守工作流 skill 的规则。

# 工作流 skill：剧情记忆摘要
${skill.body ?? ""}`;
									const user = `<narrative>\n${text}\n</narrative>` +
										(opts?.sourceRefs?.length
											? `\n\n<sourceRefs>\n${JSON.stringify(opts.sourceRefs)}\n</sourceRefs>`
											: "") +
										"\n\n请提取事件卡（仅 JSON）。";
									const resp = await this.#sideText("memoryEvents", sys, user, 4096, "off", this.#abort?.signal, observation);
									if (typeof resp !== "string") { ev.onActivity?.("剧情记忆：事件候选提取失败"); return; }
									const events = parseMemoryEventPayload(resp, opts?.sourceRefs ?? []);
									if (!events || events.length === 0) { ev.onActivity?.("剧情记忆：本段无高价值事件"); return; }
									let branchLeafId: string | undefined;
									try { branchLeafId = sm.getLeafId() ?? undefined; } catch { /* 无叶即无分支标记 */ }
									const srcs = (opts?.sourceRefs ?? []).map((s) => ({ entryId: s.entryId, entryType: s.entryType as string | undefined }));
									for (const e of events) {
										const withRefs: import("../memory/types.ts").RpEventDigest = {
											...e,
											sourceRefs: e.sourceRefs?.length ? e.sourceRefs : srcs,
											branchLeafId,
										};
										await this.#deps.upsertEventDigest!(sm.getSessionId(), withRefs).catch(() => {});
									}
									ev.onActivity?.(`剧情记忆：登记 ${events.length} 条事件候选`);
							  }
							: undefined,
					appendEventDigests:
						this.#deps.upsertEventDigest
							? async (events, opts) => {
								if (!turnLeafIsStable(sm, memoryExpectedLeaf)) return;
									const branchLeafId = sm.getLeafId() ?? undefined;
								const sourceRefs = (opts?.sourceRefs ?? []).map((s) => ({ entryId: s.entryId, entryType: s.entryType }));
									const allowed = new Set(sourceRefs.map((source) => source.entryId));
									for (const event of events) {
										await this.#deps.upsertEventDigest!(sm.getSessionId(), {
											...event,
											sourceRefs: event.sourceRefs?.filter((ref) => allowed.has(ref.entryId)).length ? event.sourceRefs.filter((ref) => allowed.has(ref.entryId)) : sourceRefs,
											branchLeafId,
										}).catch(() => {});
									}
								}
							: undefined,
					onActivity: (d) => ev.onActivity?.(d),
				},
				{
					branch,
					state: stateFromBranch(branch),
					language: config.language,
					userName: config.userName,
					charName: card.name,
					everyNTurns,
					memoryInstructions: workflowSkill(materials.skillFiles, "memory")?.body,
					...(minChars !== undefined ? { minChars } : {}),
				},
			);
			if (c.kind === "failed") console.error(`[stage-compact] 压缩跳过：${c.error}`);
			if (sourceEntryId) {
				sm.appendCustomEntry("rp-turn-diagnostic", {
					version: 1,
					sourceEntryId,
					stage: "memory",
					kind: c.kind,
					...(c.kind === "failed" ? { error: c.error.slice(0, 240) } : {}),
					...(c.kind === "compacted" ? { turns: c.turns, chars: c.chars } : {}),
				});
			}
			if (c.kind === "compacted") sm.flush();
			return c;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[stage-compact] 压缩异常：${msg}`);
			return { kind: "failed", error: msg };
		}
	}

	/**
	 * M-A agent 循环（开放式）。M-R1（PLAN-RECTIFY §2.3）起由五注入日程驱动：
	 * 规划卡随首轮末端注入送达；未封笔的轮次注进度行（每轮替换）/判定（一次性）；
	 * seal（含兜底封笔）之后依次给记账、谢幕席位；日程走完、模型停手即收束。
	 * 宽进严出（D2）：直出正文自动代收为 draft_write；无稿也无正文 → 逼稿一次；
	 * MAX_ROUNDS 只约束开放式工具循环；谢幕是封笔后的独立交付席位，不占该预算。
	 */
	async #agentLoop(o: {
		model: StageModelLike;
		events?: StageEvents;
		observation?: StageRequestObservation;
		options: Record<string, unknown>;
		systemPrompt: string;
		messages: unknown[];
		first: AssistantMsgLike;
		tools: StageTool[];
		ws: TurnWorkspace;
		wsDeps: WorkspaceDeps;
		/** 剧情语言（统一工具层按面装配描述/schema，M-D1） */
		language: string;
		/** 读侧工具依赖（装配清单与执行同源，M-D2） */
		readDeps: StageToolDeps;
		/** 首轮直出正文（调用方已流式外发） */
		directText: string;
		/** skill_read 可读名单投影（让模型知道有哪些 skill 可用） */
		skillNames: string[];
		/** 必定读取（每轮）skill 名单：落笔前受理门强制先读（制造停顿=死磕燃料） */
		forcedSkills: string[];
		/** 全流程文字留档 */
		_blog?: (event: string, data: string) => void;
		/** 有界的独立谢幕格式指令。 */
		curtain?: string;
	}): Promise<{ final: AssistantMsgLike | null; errored?: string; text: string; tailText?: string; curtainText?: string; pendingDraft?: string; stoppedByUser?: boolean }> {
		const rawEv2 = o.events ?? this.#deps.events ?? {};
		const blog = o._blog ?? (() => {});
		const ev: typeof rawEv2 = {
			...rawEv2,
			onDelta: (kind, delta, draft, reset) => {
				blog(draft ? "draft_delta" : kind === "thinking" ? "thinking" : "text", delta);
				rawEv2.onDelta?.(kind, delta, draft, reset);
			},
			onStreamClear: () => { blog("stream_clear", ""); rawEv2.onStreamClear?.(); },
			onDraftResync: (segs) => { blog("draft_resync", segs.join("\n---\n")); rawEv2.onDraftResync?.(segs); },
			onActivity: (d) => { blog("activity", d); rawEv2.onActivity?.(d); },
		};
		const readDeps = o.readDeps;
		// 走 tools.ts 派发的工具（统一层世界书族/向量库族 + 台上读侧两件）；其余归工作区执行器。
		// 统一层含写侧（lorebook_write/toggle、memory_add/delete），但它们写的是设定集/记忆库
		// 而不是本拍草稿，故仍走 tools.ts 而非 workspace——「读/写」在此不是路由依据，工件归属才是。
		const READ_TOOLS = new Set([
			...unifiedStageToolNames(readDeps),
			"world_state_get",
			"skill_read",
		]);
		// MCP 外设（8/06 重接）：只认**本会话已连接**的限定名——不能只看 mcp__ 前缀，
		// 否则模型幻觉出的服务器名会被当成 MCP 调用，错过「未知工具」的正常报错路径。
		const MCP_TOOLS = mcpStageToolNames(this.#deps.mcp);
		// 媒体交付（8/06 重接）：结果带 details.rp*，收尾时落成 toolResult 条目供 wire 出帧
		const MEDIA_TOOLS = this.#deps.media
			? mediaStageToolNames({ tts: this.#deps.ttsAvailable?.() === true })
			: new Set<string>();
		// 写账工具（记账轮的结构信号——§2.3：判据必须是结构信号，禁止文本识别）
		const LEDGER_TOOLS = new Set(["world_state_update", "panel_write", "panel_close"]);
		const writeTool = (name: string, args: Record<string, unknown>, internal = false) => {
			const result = runWriteTool(o.ws, o.wsDeps, name, args, internal);
			if (result.ok && ["draft_write", "draft_append", "draft_edit"].includes(name) && o.ws.draft.trim()) o.observation?.collector?.narrative();
			return result;
		};

		const convo = [...o.messages];
		let last: AssistantMsgLike = o.first;
		let text = "";
		let nudged = false; // 空手逼稿只给一轮机会，防空转
		let sealNudged = false; // 封笔催告（逐路标续写完但忘了 draft_seal），只给一轮
		let userStopped = false; // P7：用户在 ask 选择卡上点了停止——本拍收束
		let lastConsumed = 0; // 本轮开始时 text 长度——判定「本轮新产出文本」用
		// 五注入日程状态（D9：进度行替换语义；判定/记账/谢幕一次性）
		let verdictInjected = false;
		// 必定读取（每轮）受理门：每条路标落笔前必须先读完所有 forcedSkills
		// （8/16：重置点从「交段」搬到「勾路标」，与送模文案同步改口径。停顿本身是设计
		// ——工具调用是模型可靠执行的动作、思考指令不是——只是计价单位从段落改成路标：
		// 一条路标内接着演的段落不再重复强制读。）
		const readThisStep = new Set<string>(); // 本条路标已读的 forcedSkill 名
		let forcedNudgedForStep = false; // 本条路标已催过一次（防空转安全阀）
		const skillReadDone = new Set<string>(); // 重复读瘦身：本拍已读过全文的 skill 名
		let ledgerInjected = false;
		let ledgerDone = false;
		let curtainInjected = false;
		let curtainText = "";
		let loopExhausted = false;
		let interruptedPending = "";
		const inject = (text: string) => { blog("injection", text); return nowMsg(text); };
		// 稿首次落地时的 text 长度：之前的 text 是读题/计划旁白（工具轮的 text 通道产出），
		// 不算正文也不算尾巴；之后的 text 才是尾巴候选（状态栏等）。-1 = 稿未落地。
		let tailStart = -1;
		// 尾巴口径：稿落地后的 text 通道产出（未落地=全量，直出正文路径要整段保留）
		const tailOf = () => (tailStart >= 0 ? text.slice(tailStart) : text);
		// 稿外直出记账（8/10 实弹：规划轮直出的开头因同轮带工具调用不触发代收，
		// 前端当旁白清屏、引擎侧永不入稿——定稿凭空缺前半场）。这里只记事实：
		// 代收消费过的部分不算，稿落地后的尾巴不算；余下的就是「流出去但不在稿内」。
		let directConsumed = false; // o.directText 已被代收进稿
		let strayFrom = 0; // 代收已消费的 text 前缀长度

		let appendedThisRound = false;
		let draftMutatedThisRound = false;
		let planAcceptedThisRound = false;
		for (let round = 0; round < MAX_ROUNDS; round++) {
			o.ws.rounds = round + 1;
			lastConsumed = text.length; // 本轮之前的累计文本
			const calls = (last.content ?? []).filter(
				(c): c is { type: string; id?: string; name?: string; arguments?: Record<string, unknown> } =>
					c.type === "toolCall",
			);
			let ledgerCallThisRound = false;

			if (calls.length === 0) {
				// 模型停手：按五注入日程决定下一站，没有下一站才收束。
				if (o.ws.draft.trim()) {
					convo.push(last);
					if (!o.ws.sealed && o.ws.appends > 0 && !sealNudged) {
						// 催封笔（§2.4，只给一次）
						sealNudged = true;
						convo.push(inject(`已续写 ${o.ws.appends} 个路标未封笔。写完就 draft_seal，没写完接着写。`));
					} else {
						// 停手分支补判定（8/12）：模型勾完路标后直接停手（不调 seal、不调工具），
						// 工具轮判定分支只跑在模型还在调工具时，停手分支原先整个没有判定逻辑——
						// ask 裁决席位同样消失。兜底封笔前补一次（verdictInjected 守卫防循环）。
						if (!verdictInjected && o.ws.plan.length > 0 && draftBodyCharsOf(o.ws) > 0) {
							verdictInjected = true;
							convo.push(nowMsg(verdictInjection(o.wsDeps.userName)));
						} else {
							// 兜底封笔（催告已给过/全量稿天然封笔）→ 记账：停手不越站
							if (!o.ws.sealed) {
								const seal = writeTool("draft_seal", {});
								if (!seal.ok) {
									convo.push(nowMsg(seal.text));
									continue;
								}
							}
							if (!ledgerDone && !ledgerInjected && o.ws.patches.length === 0 && o.ws.panelWrites === 0) {
								ledgerInjected = true;
								convo.push(inject(LEDGER_INJECTION));
							} else if (o.curtain && !curtainInjected) {
								ledgerDone = true;
								curtainInjected = true;
								convo.push(inject(`${o.curtain}\n\n【最终投影状态】\n${JSON.stringify(projectedState(o.ws, o.wsDeps.baseState), null, 2)}`));
							} else {
								break; // 日程走完：本拍收束
							}
						}
					}
				} else {
					const direct = `${o.directText}${text}`.trim();
					if (direct) {
						const directBody = extractDraftBody(direct);
						const formatOnly = !directBody || /^```(?:css|html)?\s*[\s\S]*```$/i.test(directBody);
						if (formatOnly) {
							if (nudged) break;
							nudged = true;
							convo.push(last);
							convo.push(nowMsg("工作区仍无正文；请用 draft_append 演出，或 draft_write 一次交完正文。"));
							continue;
						}
						// 宽进严出：直出正文代收为 draft_write（已流式外发过，不重复上屏）。
						// internal=true 跳过门禁——代收是兜底，被拦下就等于把这拍正文丢了。
						const r = writeTool("draft_write", { content: direct }, true);
						directConsumed = r.ok;
						if (r.ok) {
							strayFrom = text.length;
							o.ws.strayText = "";
						}
						ev.onActivity?.(r.ok ? "直出正文已代收为 draft_write" : "直出正文代收失败");
						convo.push(last);
						convo.push(nowMsg(r.ok ? "正文已代收为 draft_write。需要改就重交，不需要就结束。" : r.text));
					} else {
						// 空手停笔：给一次恢复轮，第二次仍无稿才认栽。
						if (nudged) break;
						nudged = true;
						convo.push(last);
						convo.push(nowMsg("你还没有落笔。用 draft_append 演出，或 draft_write 一次交完，否则本拍无产出。"));
					}
				}
			} else {
				convo.push(last);
				appendedThisRound = false;
				draftMutatedThisRound = false;
				planAcceptedThisRound = false;
				for (const call of calls) {
					const name = call.name ?? "";
					let r: ToolRunResult | MediaStageResult;
					// 记账轮的结构信号（§2.3）：写账工具被调＝记账仍在进行；面板写入计数进工作区
					if (LEDGER_TOOLS.has(name)) ledgerCallThisRound = true;
					if (name === "panel_write" || name === "panel_close") o.ws.panelWrites++;
					// 必定读取（每轮）受理门（复现 8/11「强制调用」，泛化为认 `每轮` 标志不认名字）：
					// 一条路标落笔前必须先 skill_read 完所有 forcedSkills——没读全就交，本次首交不受理
					// （回执指路）；模型执意重交则放行（每条路标只拦一次，防空转，安全阀同封笔催告）。
					const skillReadName =
						name === "skill_read" ? (call.arguments as { name?: string } | undefined)?.name : undefined;
					if (skillReadName && o.forcedSkills.includes(skillReadName)) readThisStep.add(skillReadName);
					const unreadForced = o.forcedSkills.filter((n) => !readThisStep.has(n));
					if (["draft_append", "draft_write", "draft_edit"].includes(name) && planAcceptedThisRound) {
						r = {
							text: "本次写作操作未受理：计划刚刚建立，先读取计划回执并在下一轮构思第一个路标。",
							activity: "规划与落笔被强制分轮",
							ok: false,
						};
						ev.onDraftResync?.(splitDraftSegments(o.ws.draft));
					} else if (["draft_append", "draft_write", "draft_edit"].includes(name) && draftMutatedThisRound) {
						o.ws.appendRejects++;
						r = {
							text: "本次写作操作未受理：一次模型生成只接收一次正文写入或修改。先回看权威现稿，再在下一轮继续。",
							activity: "同轮第二次正文修改被拦下",
							ok: false,
						};
						// 工具参数已经流式上屏；拒收后用权威工作区重同步，撤掉未受理段。
						ev.onDraftResync?.(splitDraftSegments(o.ws.draft));
					} else if (name === "draft_append" && unreadForced.length > 0 && !forcedNudgedForStep) {
						forcedNudgedForStep = true;
						r = {
							text: `本次未受理：先 \`skill_read\`${unreadForced.map((n) => `「${n}」`).join("")}构思这个路标，再重交。`,
							activity: "交稿暂缓——先读必定 skill",
							ok: false,
						};
					} else if (
						// 抢跑 seal 时序保证：封笔前先读取本轮的稿纸回执，模型直接封笔会整个
						// 跳过它（8/11 实弹）。首次抢跑不受理，回执即判定文案（同一席位提前送达）；下一轮再调
						// seal 照常受理。8/12 放宽：不再要求路标全勾——模型没勾完就封笔同样会跳过判定
						// （实弹：勾 2/3 直接封笔，判定整个消失），判定送达不该依赖模型自觉勾选。
						// 无计划的分段拍与 harness 内部兜底封笔不走此分支。
						name === "draft_seal" &&
						!verdictInjected &&
						!o.ws.sealed &&
						o.ws.plan.length > 0 &&
						draftBodyCharsOf(o.ws) > 0
					) {
						verdictInjected = true;
						r = {
							text: verdictInjection(o.wsDeps.userName),
							activity: "封笔暂缓——先判定",
							ok: false,
						};
					} else {
					// 三态路由 +MCP：统一层/台上读侧 → tools.ts；MCP 外设 → hub；其余 → 工作区。
					// MCP 走网络/子进程，可能很慢——把本拍 abort 信号透传下去，用户点停止能立刻中断。
					r = name === "assistant_run"
						? ((await runAssistantStageTool(name, call.arguments ?? {}, this.#abort?.signal)) ?? {
								text: `未知工具「${name}」。`,
								isError: true,
							})
						: MCP_TOOLS.has(name)
							? ((await runMcpStageTool(
									this.#deps.mcp!,
									name,
									call.arguments ?? {},
									this.#abort?.signal,
								)) ?? { text: `未知工具「${name}」。`, isError: true })
							: MEDIA_TOOLS.has(name)
								? ((await runMediaStageTool(this.#deps.cwd, name, call.arguments ?? {})) ?? {
										text: `未知工具「${name}」。`,
										isError: true,
									})
								: READ_TOOLS.has(name)
									? await this.#runReadTool(o, readDeps, name, call.arguments ?? {})
									: writeTool(name, call.arguments ?? {});
						}
					if (name === "beat_plan" && r.ok !== false) planAcceptedThisRound = true;
					if (["draft_append", "draft_write", "draft_edit"].includes(name) && r.ok !== false) draftMutatedThisRound = true;
					if (name === "draft_append" && r.ok !== false) appendedThisRound = true;
					if (r.ok === false && !o.ws.draft.trim() && ["beat_plan", "draft_write", "draft_append"].includes(name)) {
						convo.push(nowMsg("刚才的写作操作未受理。收缩到用户最新输入的当前场景，不要预写后续；下一轮直接用 draft_append 交出一段眼前正文。"));
					}
					// 媒体交付要落成 toolResult 条目（wire 只认树上的 toolResult 出媒体帧）——
					// 台上引擎默认剥离工具轨迹，故在此单独收集，谢幕后随正文一起落树。
					const mediaDetails = (r as MediaStageResult).details;
					if (MEDIA_TOOLS.has(name) && mediaDetails && (r as MediaStageResult).isError !== true) {
						o.ws.mediaDeliveries = o.ws.mediaDeliveries ?? [];
						o.ws.mediaDeliveries.push({ toolName: name, details: mediaDetails, text: r.text });
					}
					// 必定读取受理门：本条路标勾掉了 → 清空已读、下一条路标重新计门
					// （8/16：原先挂在 draft_append 上＝按段计费；改挂 beat_step_done＝按路标计费。）
					if (name === "beat_step_done" && r.ok !== false) {
						readThisStep.clear();
						forcedNudgedForStep = false;
					}
					// 重复读瘦身：名单内 skill 首读成功后记名（未知名回落直写不记，避免把 miss 记成已读）
					if (skillReadName && o.skillNames.includes(skillReadName) && r.ok !== false) {
						skillReadDone.add(skillReadName);
						o.ws.skillReads++;
					}
					// 每轮修复可见性（8/09 输出形式定案）：draft_edit 修改后**分段重同步**——
					// 前端把全部稿段原位替换成修后分段，该段原地变新，无重复、不塌段。
					// （旧做法发「全稿 + reset」只替换末段，前面稿段还在屏上 → 正文重复。）
					if (name === "draft_edit" && r.ok !== false && o.ws.draft.trim()) {
						ev.onDraftResync?.(splitDraftSegments(o.ws.draft));
					}
					// 时间线：工具按调用位置入档（draft_write/edit 的正文另由 #recordDraft 记）
					recordSegment(o.ws, { kind: "tool", activity: { kind: "tool_start", name, detail: r.activity ?? "" } });
					if (r.activity) ev.onActivity?.(r.activity);
					convo.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: name,
						content: [{ type: "text", text: r.text }],
						// MCP 失败必须如实标记：模型据此改道或如实告知用户，而不是当成功往下演
						isError: (r as { isError?: boolean }).isError === true,
						timestamp: Date.now(),
					});
				}
			}

			// P7：用户停止（ask 卡上点了停止）——本拍收束，不再续轮
			if (userStopped) break;

			// 预算触顶后的第一轮仍给模型一次显式封笔机会；第二轮仍未封则由工作区
			// 兜底封笔。后续记账与谢幕照常走既有日程，不等 MAX_ROUNDS。
			// 中间轮旁白（8/09 实弹）：稿落地前、工具轮里流出的 text 是读题/计划旁白——
			// 通知前端清掉（收进过程条）；tailStart 一旦标记（稿已落地），之后的 text
			// 归尾巴候选，不再清（状态栏后调记账的场景，状态栏不能被当旁白删掉）。
			// round 0 的旁白在 performTurn 首轮流里（o.directText），不在本层 text 统计中。
			if (tailStart < 0) {
				const talked = text.length > lastConsumed || (round === 0 && o.directText.trim().length > 0);
				if (calls.length > 0 && talked) ev.onStreamClear?.();
				if (o.ws.draft.trim()) tailStart = text.length;
			}

			// 稿外直出 = 未被代收的首轮直出 + 稿落地前流出的 text（尾巴与已消费部分除外）。
			// 每轮更新，seal 回执（runCheck）把它作为事实补认。
			if (o.ws.draft.trim()) {
				o.ws.strayText = `${directConsumed ? "" : o.directText}${text.slice(
					strayFrom,
					tailStart >= 0 ? Math.max(strayFrom, tailStart) : text.length,
				)}`.trim();
			}

			// 每次成功落下一段后固定回看一次；回看是内部控制信号，不会进入正文稿纸。
			if (appendedThisRound && !o.ws.sealed) {
				convo.push(nowMsg(CREATIVE_REVIEW_INJECTION));
				ev.onActivity?.("主演分段回看：稿纸已更新");
			}

			// 五注入日程（工具轮后半程）：seal 之后记账→谢幕；未封笔注进度/判定（§2\.3）。
			// 停手轮的日程已在上方分支处理；这里只管模型还在干活的轮。
			if (calls.length > 0) {
				if (o.ws.sealed) {
					if (!ledgerDone) {
						if (!ledgerInjected) {
							// 本拍已有落账（结构信号：patch 队列/面板写入）→ 跳过记账注入
							if (o.ws.patches.length > 0 || o.ws.panelWrites > 0) ledgerDone = true;
							else {
								ledgerInjected = true;
								convo.push(nowMsg(LEDGER_INJECTION));
							}
						} else if (!ledgerCallThisRound) {
							ledgerDone = true; // 记账轮结束（模型停止调用写账工具）
						}
					}
					if (ledgerDone && o.curtain && !curtainInjected) {
						curtainInjected = true;
						convo.push(inject(`${o.curtain}\n\n【最终投影状态】\n${JSON.stringify(projectedState(o.ws, o.wsDeps.baseState), null, 2)}`));
					}
				} else if (o.ws.plan.length > 0 || o.ws.draft.trim()) {
					const allDone = o.ws.plan.length > 0 && o.ws.plan.every((s) => s.done);
					// 判定以稿非空为门（8/10 实弹：0 字连勾两条也触发了判定＝勾选表演）；
					// 勾完但没落笔 → 继续进度行，判定等正文真出现
					if (allDone && !verdictInjected && draftBodyCharsOf(o.ws) > 0) {
						verdictInjected = true;
						convo.push(nowMsg(verdictInjection(o.wsDeps.userName)));
					} else {
						replaceProgressLine(convo, progressLine(o.ws));
					}
				}
				// 工作区仍空（纯探索轮）：不注入——规划卡已随首轮末端注入送达
			}

			// 安全阀最后一轮撤掉工具：模型只能收笔（触阀后以现稿/直出定稿）
			const lastRound = round >= MAX_ROUNDS - 1;
			if (lastRound) loopExhausted = true;
			const ctx: Record<string, unknown> = { systemPrompt: o.systemPrompt, messages: convo };
			if (!lastRound) {
				ctx.tools = o.tools;
			}
			else {
				// 触阀收场（D16）：只收场，不点名任何格式块——输出格式归卡/预设作者的散文与正则
				convo.push(inject("【收场】本拍轮次已达上限，工具已收起，就此收场。"));
			}

			// 格式复杂的 ST 卡可能有多个状态栏/日历块。只在本轮刚注入谢幕卡时
			// 放宽容量，避免普通记账轮继承谢幕状态后也无谓使用大窗口。
			const lastConvo = convo[convo.length - 1] as
				| { role?: string; content?: Array<{ text?: string }> }
				| undefined;
			const curtainCall =
				curtainInjected &&
				lastConvo?.role === "user" &&
				lastConvo.content?.some((part) => part.text?.includes("【主演·格式收尾】"));
			const callOptions = curtainCall
				? {
						...o.options,
						// 谢幕保留用户为主演选择的推理强度；高推理模型可能先长考再交付。
						maxTokens: curtainMaxTokens(o.model),
					}
				: o.options;
			if (curtainCall) ev.onActivity?.("主演格式收尾：按本拍已读的角色卡与预设输出格式");
			const s = this.#observedStream(o.model, ctx as never, callOptions, o.observation);
			let final: AssistantMsgLike | null = null;
			const fwd = this.#draftForwarder(ev);
			// thinking_delta 入时间线（思考→工具→正文全链）
			try {
			for await (const e of streamWithTimeout(s, WRITER_STREAM_TIMEOUT_MS, this.#abort?.signal)) {
				if (e.type === "done") final = e.message ?? null;
				else if (e.type === "error") {
					return { final: e.error ?? null, errored: e.error?.errorMessage || "provider error", text, tailText: tailOf(), pendingDraft: fwd.pendingText() || textOfAssistant(e.error ?? null) || text.slice(lastConsumed) };
				} else if (e.type === "text_delta" && e.delta) {
					text += e.delta;
					if (curtainCall) curtainText += e.delta;
					// 稿已存在后的正文外产出（状态栏/catsay 等格式尾巴）入时间线按序记档；
					// 定稿时由 finalTimeline 吸收进稿段（内容以 mergeFinalText 为准）。
					if (o.ws.draft.trim()) recordSegment(o.ws, { kind: "text", text: e.delta });
					ev.onDelta?.("text", e.delta);
				} else if (e.type === "thinking_delta" && e.delta) {
					recordSegment(o.ws, { kind: "thinking", text: e.delta });
					ev.onDelta?.("thinking", e.delta);
				} else {
					fwd.forward(e);
				}
			}
			} catch (error) {
				return { final: last, errored: error instanceof Error ? error.message : String(error), text, tailText: tailOf(), pendingDraft: fwd.pendingText() || text.slice(lastConsumed) };
			}
			if (!final) return { final: last, text, tailText: tailOf() };
			last = final;
			if (final.stopReason === "aborted") {
				interruptedPending = fwd.pendingText() || textOfAssistant(final) || text.slice(lastConsumed);
				break;
			}
		}
		// 工具循环触阀时，模型可能已在 reasoning 中完成格式，却尚未产生 text。
		// 谢幕是正文之外的独立席位：额外给一次无工具交付机会，不受 MAX_ROUNDS 挤占。
		const imageRequired = Boolean(o.curtain?.includes("当前卡要求图片交付"));
		const imageDelivered = /<image(?:Tag)?\s*>[\s\S]*?<\/image(?:Tag)?\s*>/i.test(curtainText);
		if (loopExhausted && o.curtain && o.ws.draft.trim() && (!curtainText.trim() || (imageRequired && !imageDelivered)) && last.stopReason !== "aborted") {
			convo.push(last);
			convo.push(nowMsg(`${o.curtain}\n\n【补交交付】上一轮${curtainText.trim() ? "已生成格式但缺少必需的 NAI 图片块" : "没有产生可见格式"}。请完成思考后把缺失的非正文格式输出到正文通道；至少补交一份完整 <image>... </image> 图片块，不要调用工具。\n\n【最终投影状态】\n${JSON.stringify(projectedState(o.ws, o.wsDeps.baseState), null, 2)}`));
			ev.onActivity?.("主演格式收尾：独立交付席位");
			const s = this.#observedStream(
				o.model,
				{ systemPrompt: o.systemPrompt, messages: convo },
				{ ...o.options, maxTokens: curtainMaxTokens(o.model) },
				o.observation,
			);
			let final: AssistantMsgLike | null = null;
			try {
			for await (const e of streamWithTimeout(s, WRITER_STREAM_TIMEOUT_MS, this.#abort?.signal)) {
				if (e.type === "done") final = e.message ?? null;
				else if (e.type === "error") {
					return { final: e.error ?? last, errored: e.error?.errorMessage || "provider error", text, tailText: tailOf(), curtainText };
				} else if (e.type === "text_delta" && e.delta) {
					text += e.delta;
					curtainText += e.delta;
					recordSegment(o.ws, { kind: "text", text: e.delta });
					ev.onDelta?.("text", e.delta);
				} else if (e.type === "thinking_delta" && e.delta) {
					recordSegment(o.ws, { kind: "thinking", text: e.delta });
					ev.onDelta?.("thinking", e.delta);
				}
			}
			} catch (error) {
				return { final: last, errored: error instanceof Error ? error.message : String(error), text, tailText: tailOf(), curtainText };
			}
			if (final) last = final;
		}
		return { final: last, text, tailText: tailOf(), curtainText, ...(interruptedPending ? { pendingDraft: interruptedPending } : {}), ...(userStopped ? { stoppedByUser: true } : {}) };
	}

	/**
	 * 台上读侧工具，并把「查过世界」记进工作区。
	 *
	 * lookups 是 draft_write 门禁的判据（见 workspace.ts runWriteTool）：查过设定/旧账/
	 * 账本＝这一拍中途确实有要停下来处理的事＝有戏，本该一段一段演。
	 */
	async #runReadTool(
		o: { ws: TurnWorkspace; language: string },
		readDeps: StageToolDeps,
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolRunResult> {
		const countsAsLookup = name === "world_state_get" || name.startsWith("lorebook_") || name.startsWith("memory_") || name.startsWith("card_") || name.startsWith("worldline_");
		if (countsAsLookup && o.ws.lookups >= MAX_LOOKUPS) {
			return {
				text: `本拍检索已达 ${MAX_LOOKUPS} 次上限。请依据已有结果落笔；查不到的细节应模糊处理，不得臆造。`,
				activity: `检索达到上限（${MAX_LOOKUPS} 次）`,
			};
		}
		if (countsAsLookup) o.ws.lookups++;
		return runStageTool(readDeps, name, args, o.language);
	}

	/**
	 * D1：draft_write / draft_append 的正文参数流式转发——工件正文照常逐字上屏。
	 * toolcall_delta 用渐进解析的 arguments（openai-completions 每帧重解 partialArgs）；
	 * toolcall_end 兜底补齐后缀（faux 等不做渐进解析的 provider 在此整段上屏）。
	 * 每条流各建一个（sent 按 contentIndex 记已发长度，保证不重发）。
	 *
	 * M-E：draft_append 是**追加**语义，reset 必须为 false——已上屏的段落是
	 * 已经发生的事，续写不能把它擦掉重排（那正是分段续写要消除的体验）。
	 */
	#draftForwarder(ev = this.#deps.events ?? {}): { forward: (e: StageStreamEvent) => void; pendingText: () => string } {
		const sent = new Map<number, number>();
		const drafts = new Map<number, { text: string; append: boolean }>();
		const forward = (idx: number, content: unknown, append = false) => {
			if (typeof content !== "string") return;
			const prev = sent.get(idx) ?? 0;
			if (content.length <= prev) return;
			// draft=true：稿件流是替换语义（重交不叠加）——与 runWriteTool 的
			// replaceDraftSegment 同语义，wire 层透传给前端时间线。
			// reset=true：本次 draft_write 调用的首个分片——前端用它清掉旧稿。
			const isFirst = !append && !sent.has(idx);
			ev.onDelta?.("text", content.slice(prev), true, isFirst);
			sent.set(idx, content.length);
			drafts.set(idx, { text: content, append });
		};
		/** 取正文参数：draft_write 用 content，draft_append 用 segment */
		const pick = (name: string | undefined, args: Record<string, unknown> | undefined) => {
			if (name === "draft_write") return { text: args?.content, append: false };
			if (name === "draft_append") return { text: args?.segment, append: true };
			return undefined;
		};
		const forwardEvent = (e: StageStreamEvent) => {
			const idx = e.contentIndex;
			if (typeof idx !== "number") return;
			if (e.type === "toolcall_delta") {
				const block = e.partial?.content?.[idx];
				if (block?.type !== "toolCall") return;
				const p = pick(block.name, block.arguments);
				if (p) forward(idx, p.text, p.append);
			} else if (e.type === "toolcall_end") {
				const p = pick(e.toolCall?.name, e.toolCall?.arguments);
				if (p) forward(idx, p.text, p.append);
			}
		};
		return {
			forward: forwardEvent,
			pendingText: () => [...drafts.entries()].sort(([a], [b]) => a - b).map(([, row]) => row.text).filter(Boolean).join("\n\n"),
		};
	}

	/**
	 * 台上工具的执行依赖（每次取用现读素材/账本——工具看到的世界与装配同源）。
	 * lastUserText 供写入门禁判定（M-D2）：门禁问的是「用户本拍有没有要求记录」。
	 */
	#toolDeps(lastUserText = "", webResearchEnabled = false): StageToolDeps {
		const cwd = this.#deps.cwd;
		const sm = this.#deps.getSessionManager();
		/** 台上补充设定集路径（写侧落点；卡未装载时为空＝无 lorebook_write） */
		const overlayOf = (): string => {
			try {
				const m = loadStageMaterials(cwd);
				return overlayPathFor(cwd, m.card.name);
			} catch {
				return "";
			}
		};
		let remainingWebQueries = 3;
		return {
			searchLore: (query, limit) => {
				const m = loadStageMaterials(cwd);
				// 语料 = 世界书 + 补充设定集（materials 已剥离外部插件协议条目）+ 当前分支挂载的知识库。
				// 知识库此前只有扩展侧搜得到，台上描述却一直承诺「已挂载知识库」——M-D1 补齐（PLAN-RP-TOOLING）。
				const codex: LorebookEntry[] = [];
				for (const name of codexNamesFromBranch(sm.getBranch() as BranchEntryLike[])) {
					try {
						codex.push(...(loadCodexEntries(cwd, name) ?? []));
					} catch {
						// 单个库读不出不该拖垮整次检索
					}
				}
				return searchEntries(codex.length > 0 ? [...m.entries, ...codex] : m.entries, query, limit);
			},
			// ---- M-D2 世界书族 ----
			writeLore: (input) => {
				const overlay = overlayOf();
				if (!overlay) return null;
				return appendOverlayEntry(overlay, input);
			},
			listLore: () => loadStageMaterials(cwd).entries,
			fingerprint: loreFingerprint,
			...(this.#deps.setDisabledLore ? { toggleLore: this.#deps.setDisabledLore } : {}),
			gate: () => ({ lastUserText }),
			searchMemory: async (query) => {
				const search = this.#deps.searchMemory;
				if (!search) return [];
				return search(sm.getSessionId(), query);
			},
			// ---- M-D3 向量库写侧：scope 由宿主绑定，模型只给内容（作用域不经模型） ----
			...(this.#deps.addMemory
				? { addMemory: (input: { text: string; title?: string }) => this.#deps.addMemory!(sm.getSessionId(), input) }
				: {}),
			...(this.#deps.listMemory
				? { listMemory: (storeId: string) => this.#deps.listMemory!(sm.getSessionId(), storeId) }
				: {}),
			...(this.#deps.deleteMemory
				? { deleteMemory: (storeId: string, id: string) => this.#deps.deleteMemory!(sm.getSessionId(), storeId, id) }
				: {}),
			...(webResearchEnabled && this.#deps.webResearch ? {
				webResearch: async (queries: string[], maxResults: number) => {
					const accepted = queries.slice(0, remainingWebQueries);
					remainingWebQueries -= accepted.length;
					if (!accepted.length) return [{ query: "", rejected: "本拍最多执行三个联网查询，额度已用完" }];
					return this.#deps.webResearch!(accepted, maxResults, this.#abort?.signal);
				},
			} : {}),
			// ---- M-D4 角色库：只读卡面 ----
			readCard: () => {
				const m = loadStageMaterials(cwd);
				const c = m.card;
				if (!c) return null;
				return {
					name: c.name,
					description: c.description,
					personality: c.personality,
					scenario: c.scenario,
					firstMes: c.firstMes,
					mesExample: c.mesExample,
					systemPrompt: c.systemPrompt,
					creatorNotes: c.creatorNotes,
					tags: c.tags,
					alternateGreetings: c.alternateGreetings,
				};
			},
			// ---- M-D5 面板：读/写/关（依赖由宿主按 session 注入） ----
			...(this.#deps.loadPanels
				? {
						loadPanels: () => this.#deps.loadPanels!(sm.getSessionId()),
						writePanel: (input: { name: string; kind: string; content: string }) =>
							this.#deps.writePanel!(sm.getSessionId(), input),
						closePanel: (name: string) => this.#deps.closePanel!(sm.getSessionId(), name),
					}
				: {}),
			getState: () => stateFromBranch(sm.getBranch() as BranchEntryLike[]),
			formatState,
			getSkill: (name: string) => loadStageMaterials(cwd).skillFiles.find((skill) => skill.name === name)?.body,
		};
	}

	/** 装配报告写盘（.liyuan/preset-assembly.json）——每块预设去向可查；内容不变不写 */
	#writeAssemblyReport(cwd: string, materials: StageMaterials, phAfter: AssembledPiece[]): void {
		try {
			const chars = (a: AssembledPiece[]) => a.reduce((n, p) => n + p.text.length, 0);
			const report = {
				preset: materials.presetDoc?.name ?? null,
				kind: materials.presetDoc?.kind ?? null,
				/** 送模字数：历史前段 + 本拍历史后段（深度注入数据层保真，尚未消费） */
				chars: {
					before: chars(materials.presetBefore),
					after: chars(phAfter),
					depth: chars(materials.presetDepth),
				},
				declaredMarkers: [...materials.declaredMarkers],
				// M-C2：世界书/卡内嵌通道被判死的外部插件协议条目（判据可回溯）
				protocolDrops: materials.protocolDrops,
				blocks: materials.presetAssembly,
			};
			const json = JSON.stringify(report, null, "\t");
			if (json === this.#lastAssemblyJson) return;
			this.#lastAssemblyJson = json;
			const outDir = join(cwd, ".liyuan");
			mkdirSync(outDir, { recursive: true });
			writeFileSync(join(outDir, "preset-assembly.json"), json, "utf8");
		} catch {
			// 报告写失败不影响演出
		}
	}

	// M-A 起 #revise 精修旁路退役（8/10 验收整体退役，revise.ts 已删除）。

	/** 旁路文本调用（精修/场记用）：静默收集，不外发增量；失败返回 {error} */
	/** 显式传 observer，背景任务没有 collector，跨拍完成也不可能污染下一拍。 */
	#observedStream(
		model: StageModelLike,
		context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
		options: Record<string, unknown>,
		observation?: StageRequestObservation,
	): ReturnType<StageStreamFn> {
		observation?.preflight?.check(model, context, options.maxTokens, observation.notify);
		const attempt = observation?.collector?.beginCall(observation.phase);
		let source: ReturnType<StageStreamFn>;
		try { source = this.#deps.streamFn(model, context, options); }
		catch (error) {
			attempt?.end("failed");
			if (isConfirmedContextOverflow(error)) observation?.preflight?.confirmedOverflow(observation.notify);
			const failed: AssistantMsgLike = { role: "assistant", content: [], stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) };
			return { async *[Symbol.asyncIterator]() { yield { type: "error", error: failed }; }, result: async () => failed };
		}
		if (!observation) return source;
		return {
			async *[Symbol.asyncIterator]() {
				let status: PerformanceStatus = "degraded";
				try {
					for await (const event of source) {
						if (event.type === "done" || event.type === "error") {
							const final = event.type === "done" ? event.message : event.error;
							attempt?.usage(final?.usage);
							status = final?.stopReason === "aborted" ? "aborted" : event.type === "error" || final?.stopReason === "error" ? "failed" : "success";
							if (isConfirmedContextOverflow(final?.errorMessage)) observation.preflight?.confirmedOverflow(observation.notify);
						}
						yield event;
					}
				} catch (error) {
					status = (options.signal as AbortSignal | undefined)?.aborted ? "aborted" : "failed";
					if (isConfirmedContextOverflow(error)) observation.preflight?.confirmedOverflow(observation.notify);
					throw error;
				} finally { attempt?.end(status); }
			},
			result: () => source.result(),
		};
	}

	async #repairStructured(step:SideModelStep,prompt:{systemPrompt:string;userText:string},invalid:string,errors:string[],maxTokens=8192,observation?:StageRequestObservation):Promise<string|{error:string}> {
		const materials=loadStageMaterials(this.#deps.cwd),protocol=materials.skillFiles.find(x=>x.workflow==="structured-repair")?.body;
		if(!protocol)return {error:"缺少结构化校验修复Skill，未绕过校验"};
		this.#deps.events?.onActivity?.(`步骤${step}校验失败：${errors.slice(0,4).join("；")}；按回执修复同一工件并重新校验，不改正文。`);
		const previous=[...(observation?.diagnostics??[])].reverse().find(x=>x.step===step);
		observation?.diagnostics?.push({phase:observation.phase,step,provider:previous?.provider??"validation",model:previous?.model??"schema",attempt:(previous?.attempt??0)+1,status:"failed",kind:"format",reason:classifyModelFailure("JSON/schema："+errors.join("；")).reason,durationMs:0});
		return this.#sideText(step,prompt.systemPrompt+"\n\n"+protocol,prompt.userText+"\n\n"+JSON.stringify({invalid_report:invalid.slice(0,24000),validation_errors:errors.slice(0,16)}),maxTokens,"off",this.#abort?.signal,observation,!!materials.config.analysisRecoveryModel);
	}

	async #sideText(
		step: SideModelStep, systemPrompt: string, userText: string, maxTokens = 8192,
		reasoning: string | undefined = "off", signal: AbortSignal | undefined = this.#abort?.signal,
		observation?: StageRequestObservation, forceRecovery = false,
	): Promise<string | { error: string }> {
		const config = loadStageConfig(this.#deps.cwd);
		const resolved = resolveStepModel(step, config.stepModels, this.#deps.getModel(),
			(provider, id) => this.#deps.findModel?.(provider, id), id => this.#deps.findModelById?.(id));
		const recoveryRef = config.analysisRecoveryModel;
		const recovery = recoveryRef ? this.#deps.findModel?.(recoveryRef.provider, recoveryRef.id) : undefined;
		const primary = forceRecovery ? recovery : resolved.model;
		if (!primary) return { error: forceRecovery ? "未配置可用恢复模型，结构化报告未修复" : "尚未配置可用剧情模型" };
		if (resolved.fallback && resolved.requested && !forceRecovery) this.#deps.events?.onNotify?.("warning", `步骤 ${step} 的${resolved.requested.provider}/${resolved.requested.id}不在当前可用配置，已转当前剧情模型，未使用旧仓库渠道。`);
		const models = [primary, ...(!forceRecovery && recovery && (recovery.provider !== primary.provider || recovery.id !== primary.id) ? [recovery] : [])];
		let last = "模型调用失败";
		for (let index = 0; index < models.length; index++) {
			if (signal?.aborted) return { error: "本拍已取消，未启动恢复请求" };
			const model = models[index]!;
			const started = Date.now();
			const attempt: ModelAttemptDiagnostic = { phase: observation?.phase ?? "background", step, provider: String(model.provider ?? ""), model: model.id, attempt:index+1, status:"failed", durationMs:0 };
			let auth: {apiKey?:string;headers?:Record<string,string>} = {};
			try {
				auth = await this.#deps.getAuth(model);
				if (model.baseUrl?.includes("magicv4.ltd")) auth.headers = { ...auth.headers, "user-agent":"undici" };
				const timeoutMs = step === "writer" ? WRITER_STREAM_TIMEOUT_MS : Math.max(60_000, Math.min(1800_000, (config.analysisTimeoutMinutes ?? 10) * 60_000));
				const requestController = new AbortController();
				const requestSignal = signal ? AbortSignal.any([signal,requestController.signal]) : requestController.signal;
				const timer = setTimeout(() => requestController.abort(), timeoutMs);
				try {
					const source = this.#observedStream(model, {systemPrompt,messages:[{role:"user",content:[{type:"text",text:userText}],timestamp:Date.now()}]},
						{apiKey:auth.apiKey,headers:auth.headers,maxTokens,signal:requestSignal,maxRetries:0,...(reasoning !== undefined ? {reasoning} : {})},observation);
					let final: AssistantMsgLike | null = null;
					for await (const e of streamWithTimeout(source,timeoutMs,requestSignal)) {
						if (e.type === "done") final=e.message??null;
						else if (e.type === "error") throw new Error(e.error?.errorMessage || "供应商请求失败");
					}
					if (requestSignal.aborted) throw new Error(signal?.aborted ? "本拍已取消" : `步骤${step}超时(${timeoutMs}ms)`);
					if (!final) throw new Error("流未返回完成消息");
					if (final.stopReason === "error" || final.stopReason === "aborted") throw new Error(final.errorMessage || `请求${final.stopReason}`);
					const text=textOfAssistant(final);
					if (!text) throw new Error("完成消息无文本，结构化任务未执行成功");
					attempt.status="success";attempt.durationMs=Date.now()-started;if(index || forceRecovery) attempt.recovered=true;
					observation?.diagnostics?.push(attempt);
					if(index || forceRecovery) this.#deps.events?.onActivity?.(`步骤${step}已由${attempt.provider}/${attempt.model}恢复完成，重新执行原任务，未跳过。`);
					return text;
				} finally { clearTimeout(timer);requestController.abort(); }
			} catch (err) {
				const raw = err instanceof Error ? err.message : String(err);
				const clean = auth.apiKey ? raw.split(auth.apiKey).join("[redacted]") : raw;
				const failure=classifyModelFailure(clean);
				attempt.status=signal?.aborted ? "cancelled" : "failed";attempt.kind=failure.kind;attempt.reason=failure.reason;attempt.statusCode=failure.statusCode;attempt.durationMs=Date.now()-started;
				observation?.diagnostics?.push(attempt);last=`${attempt.provider}/${attempt.model} [${failure.kind}${failure.statusCode ? ":"+failure.statusCode : ""}] ${failure.reason}`;
				this.#deps.events?.onActivity?.(`步骤${step}失败：${last}${index+1<models.length&&!signal?.aborted ? "；诊断后使用已配置恢复模型重做同任务。" : "；没有隐藏为成功。"}`);
				if(signal?.aborted || isConfirmedContextOverflow(err)) break;
				// Authentication fails for the provider, not one model id. Same-provider retry cannot fix an expired key.
				if(failure.kind==="auth" && models[index+1]?.provider === model.provider) break;
			}
		}
		return {error:last};
	}

}
