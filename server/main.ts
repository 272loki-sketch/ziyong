/**
 * 梨园 Web 宿主（PLAN-PHASE3 §2）：进程内嵌 pi SDK，向浏览器暴露 wire 协议。
 *
 * D3 扩展条款：本文件是接线层之外唯一允许接触 pi API 的地方，且只许碰
 * 会话托管面（runtime 创建 / 事件订阅 / prompt / abort / bindExtensions / 树导航桥接）；
 * 领域逻辑在 .liyuan/extensions/roleplay.ts；本文件只碰会话托管面。
 * 前端只见 wire 协议（server/wire.ts）。
 *
 * 用法：node server/main.ts [--new]        （cwd 必须是 Liyuan/ 产品根）
 *   HOST=0.0.0.0 PORT=7620 可经环境变量覆盖。默认绑 0.0.0.0：手机可连，勿暴露公网。
 *   --new 开新会话；默认续接最近会话。同一会话勿同时开 TUI（无文件锁）。
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { presentationFactText } from "../src/stage/agent-presentation.ts";
import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
} from "@liyuan/agent-runtime";

import {
	ACCESS_COOKIE,
	clearPassword,
	issueToken,
	loadAccess,
	parseCookies,
	revokeToken,
	setPassword,
	verifyPassword,
	verifyToken,
	type AccessData,
} from "../src/access.ts";
import { loadAgentConfig, normalizeAgentConfig, syncAgentConfigToRuntime } from "../src/agent-config.ts";
import { streamSimple } from "@liyuan/ai/compat";
import { loadCardFile, readCardRawJson } from "../src/card.ts";
import { buildGreeting } from "../src/greeting.ts";
import { effectiveGenerationMode, isGenerationMode } from "../src/stage/generation-mode.ts";
import { loadStageConfig } from "../src/stage/materials.ts";
import { configuredModels } from "../src/configured-models.ts";
import { StageEngine, type AssistantMsgLike, type StageModelLike, type StageRerollPrep, type StageStreamFn, type StageSubmission } from "../src/stage/engine.ts";
import { stateFromBranch, type BranchEntryLike } from "../src/stage/assemble.ts";
import { worldAuditFromBranch } from "../src/stage/literary-world-transition.ts";
import { modularWorldFromBranch, modularWorldWireView, projectLiteraryWorldV1 } from "../src/stage/literary-world-modular.ts";
import { worldManifestFromBranch } from "../src/stage/literary-world-profile.ts";
import { parseLegacyCalendarSource, projectPresentation, projectTavernVariables } from "../src/presentation.ts";
import { ecologyWireView, literaryEcologyFromBranch, normalizeLiteraryEcologyState } from "../src/stage/literary-ecology.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import { requestText, webResearchBatch } from "./web-research.ts";
import { resolveStepModel } from "../src/model-routing.ts";
import { OutlineEngine } from "../src/outline/engine.ts";
import { CorpusEngine } from "../src/outline/corpus.ts";
import { CorpusScheduler } from "../src/outline/corpus-scheduler.ts";
import { ResearchSearchScheduler } from "../src/outline/research-scheduler.ts";
import { workflowSkill } from "../src/stage/skill-store.ts";
import { literaryProfileFromBranch } from "../src/stage/literary-profile.ts";
import {
	activePanels,
	closePanel as closePanelInMap,
	loadPanels,
	savePanels,
	writePanel,
} from "../src/panels.ts";
import {
	DIRS,
	dir,
	migrateLegacyLayout,
	preferLiyuanAgentHome,
	resolveConfigPath,
	takeAgentMergeLog,
} from "../src/paths.ts";
import { applyPatch, loadState, saveState } from "../src/state.ts";
import { DEFAULT_CONFIG, type RpConfig, type WorldState } from "../src/types.ts";
import {
	loadTtsConfig,
	saveAudioBuffer,
	synthesizeSpeech,
	ttsConfigHint,
} from "../src/tts.ts";
import {
	buildAncestryIndex,
	buildWorldlineView,
	extractSaves,
	loadWorldlineMeta,
	metaPath,
	renameWorldline as renameWorldlineMeta,
	saveWorldlineMeta,
	softDeleteSave,
	type TreeEntryLite,
} from "../src/worldline.ts";
import {
	lastStoryUserEntryId,
	listReplyVariants,
	swipeMetaForUser,
	type SwipeEntry,
} from "../src/swipe.ts";
import {
	memoryArchiveCompacted,
	memoryArcRecallForTurn,
	memoryDeleteChunk,
	memoryEvidenceForEvent,
	memoryListEventDigests,
	memoryManualAdd,
	memoryRecallForTurn,
	memorySearch,
	memoryVisibleChunks,
	memoryUpsertEventDigest,
	loadMemoryConfig,
	memoryScopeId,
	saveMemoryConfig,
	onNarrativeTurnEnd,
	narrativeMemoryWindow,
	committedNarrativeText,
} from "../src/memory/index.ts";
import { handleApiRequest, loadCardFrontSnapshot, type CurrentModelInfo, type RestHost } from "./rest.ts";
import { diagnosticsFromBranch } from "../src/stage/diagnostics.ts";

// 用户级 agent 目录 → ~/.liyuan/agent（须在 getAgentDir / 建会话之前）
// 并合并 fork 改名后遗留的 ~/.pi/agent（会话/配置，不覆盖更新的新树）
const agentHome = preferLiyuanAgentHome();
import {
	assistantMediaOfToolResult,
	isBackstageText,
	parseCardFromSessionHead,
	skinAtDepth,
	summarizeToolResult,
	toAssistantHistory,
	toWireHistory,
	toWireMsg,
	type ClientFrame,
	type ServerFrame,
	type WireNames,
	type WireStats,
} from "./wire.ts";
import { createAssistantHost, type AssistantHost, type StoryBridge } from "./assistant.ts";
import { AuthorizedSockets } from "./ws-authorization.ts";
import { performanceByNarrative } from "./performance-projection.ts";
import { PromptDeliveryLedger, findPersistedSubmission, readSubmissionIdentity, type DeliveryChannel } from "./prompt-delivery.ts";
import { registerAssistantRunner } from "../src/assistant-gateway.ts";
import { sameCardPath } from "../src/paths.ts";
import { toggleDisabledLore } from "../src/lorebook.ts";
import { syncStoryPanelsFromDisk, syncStoryStateFromDisk } from "../src/story-sync.ts";
import { toolStartDetail } from "../src/activity-format.ts";
import {
	checkLatestRelease,
	downloadAndStage,
	discardPendingUpdate,
	readPendingUpdate,
	type UpdateCheckResult,
} from "../src/update.ts";
import type { UpdateWire } from "./wire.ts";
import {
	defaultSessionEnabledIds,
	getMcpHub,
	RP_MCP_TYPE,
} from "../src/mcp.ts";
import { mcpEnabledFromBranch } from "../src/stage/mcp-stage.ts";
import { loadNovelPackage } from "../src/novel-play/store.ts";
import { effectiveNovelPlayBinding, novelPlayCardBinding, novelPlayStateFromBranch, NOVEL_PLAY_UPGRADE_ENTRY_TYPE, type NovelPlayUpgradeEntry } from "../src/novel-play/runtime.ts";
import { ensureNovelPlayLorebook } from "../src/novel-play/application.ts";

const cwd = process.cwd();
ensureNovelPlayLorebook(cwd);
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 7620);
const newSessionFlag = process.argv.includes("--new");

// 数据目录/配置文件：.rp-* → .liyuan-*，rp.config.json → liyuan.config.json
for (const line of migrateLegacyLayout(cwd)) {
	console.log(`[liyuan] 迁移 ${line}`);
}

// 自操作接口（LIYUAN_HTTP → 剧情 system prompt）已退役（2026-07-14）：
// 系统自操作整体移交右栏「助手」的工具面（server/assistant.ts），剧情模型不再 curl 自家 API。

// Windows 环境修补（F3 实测缺陷，2026-07-10）：pi 以非登录模式启动 bash，PATH 里没有
// Git 的 usr/bin，agent 的 bash 工具找不到 cat/sed/grep 等 coreutils（python3 还会撞上
// 微软商店 stub）。从 .liyuan/settings.json 的 shellPath 推导 usr/bin 前置进 PATH，子进程继承。
try {
	const settings = JSON.parse(readFileSync(join(cwd, ".liyuan", "settings.json"), "utf8")) as { shellPath?: string };
	if (settings.shellPath) {
		const usrBin = dirname(settings.shellPath);
		if (existsSync(usrBin) && !(process.env.PATH ?? "").split(";").includes(usrBin)) {
			process.env.PATH = `${usrBin};${process.env.PATH ?? ""}`;
		}
	}
} catch {
	// 无 settings.json 或不可读：跳过（非 Windows/标准安装不需要修补）
}

// ---------- 显示名（角色/用户）：直接读配置与卡（领域层，合法） ----------

const names: WireNames = { charName: "角色", userName: "用户" };
/** 当前卡标识（liyuan.config.json 的 card 路径原文，会话过滤用） */
let cardPath = "";

/** 从项目配置刷新显示名与当前卡（启动时与每次配置写入/会话重载后调用） */
const refreshNamesFromConfig = () => {
	names.charName = "角色";
	names.userName = "用户";
	cardPath = "";
	try {
		const config = JSON.parse(readFileSync(resolveConfigPath(cwd), "utf8")) as {
			card?: string;
			userName?: string;
			displayName?: string;
		};
		if (config.userName) names.userName = config.userName;
		if (config.card) {
			cardPath = config.card;
			const abs = isAbsolute(config.card) ? config.card : join(cwd, config.card);
			names.charName = loadCardFile(abs).name;
		}
		// 显示名覆盖（仅显示层；{{char}} 宏与提示词仍用卡名）
		if (config.displayName) names.charName = config.displayName;
	} catch (err) {
		console.error(`[liyuan] 读取角色显示名失败（用占位名继续）：${err instanceof Error ? err.message : String(err)}`);
	}
};
refreshNamesFromConfig();

// ---------- pi 会话宿主 ----------

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd });
	return {
		...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
		services,
		diagnostics: services.diagnostics,
	};
};

const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd,
	agentDir: getAgentDir(),
	sessionManager: newSessionFlag ? SessionManager.create(cwd) : SessionManager.continueRecent(cwd),
});

let session: AgentSession = runtime.session;
let unsubscribe: (() => void) | undefined;
let outline: OutlineEngine | undefined;
let corpus: CorpusEngine | undefined;
let corpusScheduler: CorpusScheduler | undefined;
let researchSearchScheduler: ResearchSearchScheduler | undefined;
const turnRuntimeDiagnostics = new Map<string, import("../src/stage/diagnostics.ts").TurnRuntimeDiagnostic>();

// ---------- WS 广播 ----------

const deliveryLedger = new PromptDeliveryLedger();
let readStoryStreaming = () => session.isStreaming;
const clients = new AuthorizedSockets<WebSocket>(
	(token) => !accessData || verifyToken(accessData, token),
	(ws) => { try { ws.close(4401, "unauthorized"); } catch { /* 已关闭 */ } },
);
const sendFrame = (ws: WebSocket, frame: ServerFrame): void => {
	if (!clients.allows(ws) || ws.readyState !== ws.OPEN) return;
	try { ws.send(JSON.stringify(frame)); } catch { clients.delete(ws); }
};
const broadcast = (frame: ServerFrame) => {
	const data = JSON.stringify(frame);
	for (const ws of clients) {
		if (clients.allows(ws) && ws.readyState === ws.OPEN) { try { ws.send(data); } catch { clients.delete(ws); } }
	}
};

// ---------- 在线更新（主页 chip → 弹窗 → toast 进度；替换由启动脚本完成） ----------

const APP_VERSION: string = (() => {
	try {
		return (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

let updateState: UpdateWire = { phase: "none", currentVersion: APP_VERSION };
let updateCheck: UpdateCheckResult | null = null;
let updateBusy = false;

const UPDATE_SUPERVISED = process.env.LIYUAN_SUPERVISED === "1";
const pushUpdate = () => broadcast({ type: "update", update: { ...updateState, supervised: UPDATE_SUPERVISED } });

/** 启动后静默检查一次；失败不提示（manual 时才把 error 带给 UI） */
const runUpdateCheck = async (manual: boolean): Promise<void> => {
	// 已有暂存包：直接就绪态（跨重启持久；旧暂存版本低于当前版则丢弃）
	const pending = readPendingUpdate(cwd);
	if (pending) {
		if (pending.version === APP_VERSION || pending.version < APP_VERSION) {
			discardPendingUpdate(cwd);
		} else {
			updateState = {
				phase: "ready",
				currentVersion: APP_VERSION,
				latestVersion: pending.version,
				verified: pending.verified,
			};
			pushUpdate();
			return;
		}
	}
	const r = await checkLatestRelease(APP_VERSION);
	updateCheck = r;
	if (r.error) {
		if (manual) {
			updateState = { ...updateState, phase: updateState.phase === "ready" ? "ready" : "none", error: r.error };
			pushUpdate();
		}
		return; // 静默降级：启动检查失败不打扰
	}
	if (r.hasUpdate && r.asset) {
		updateState = {
			phase: "available",
			currentVersion: APP_VERSION,
			latestVersion: r.latestVersion ?? undefined,
			releaseName: r.releaseName,
			releaseNotes: r.releaseNotes,
			releaseUrl: r.releaseUrl,
			publishedAt: r.publishedAt,
			assetSize: r.asset.size,
		};
	} else {
		updateState = { phase: "none", currentVersion: APP_VERSION, latestVersion: r.latestVersion ?? undefined };
	}
	pushUpdate();
};

/** 下载并暂存（进度限流 500ms 一帧）；完成后 ready，失败回 available 带 error */
const startUpdateDownload = async (mirror?: string): Promise<void> => {
	if (updateBusy) throw new Error("已在下载中");
	if (!updateCheck?.hasUpdate || !updateCheck.asset) throw new Error("没有可下载的更新");
	updateBusy = true;
	const base = updateState;
	updateState = { ...base, phase: "downloading", received: 0, total: updateCheck.asset.size, error: undefined };
	pushUpdate();
	let lastPush = 0;
	try {
		const pending = await downloadAndStage({
			cwd,
			check: updateCheck,
			mirror,
			onProgress: (p) => {
				const now = Date.now();
				if (now - lastPush < 500) return;
				lastPush = now;
				updateState = { ...updateState, received: p.received, total: p.total || updateCheck?.asset?.size || 0 };
				pushUpdate();
			},
		});
		updateState = {
			phase: "ready",
			currentVersion: APP_VERSION,
			latestVersion: pending.version,
			releaseUrl: base.releaseUrl,
			verified: pending.verified,
		};
		pushUpdate();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		updateState = { ...base, phase: "available", error: msg };
		pushUpdate();
		throw new Error(`下载更新失败：${msg}`);
	} finally {
		updateBusy = false;
	}
};

// 启动 3s 后后台静默检查（不卡启动、不打扰；失败无声）
setTimeout(() => void runUpdateCheck(false).catch(() => {}), 3000);

// ---------- 会话统计与世界状态（右栏信息面板的数据源） ----------

const safeStats = (): WireStats | null => {
	try {
		const s = session.getSessionStats();
		const cu = s.contextUsage;
		return {
			userMessages: s.userMessages,
			assistantMessages: s.assistantMessages,
			totalTokens: s.tokens.total,
			cost: s.cost,
			contextPercent: cu?.percent ?? null,
			contextTokens: cu?.tokens ?? null,
			contextWindow: cu?.contextWindow ?? session.model?.contextWindow ?? null,
		};
	} catch {
		return null;
	}
};

const stateDir = dir(cwd, "state");
mkdirSync(stateDir, { recursive: true });
/**
 * 展示用账本。权威是会话树（R4：世界 = f(分支)）——swipe/rewind/切世界线后
 * 磁盘缓存仍是旧分支的账本，只有树快照能给出当前分支的正确值。
 * 树上无快照（未记账的新会话）时回落磁盘缓存：旧会话与导入建账都只有文件。
 */
const currentState = (): WorldState => {
	try {
		const branch = session.sessionManager.getBranch() as BranchEntryLike[];
		if (branch.some((e) => e.type === "custom" && e.customType === "rp-state")) {
			return stateFromBranch(branch);
		}
	} catch {
		// 树不可读（极早期生命周期）→ 磁盘缓存
	}
	return loadState(join(stateDir, `${session.sessionId}.json`));
};

// 场记记账落盘即推送（PLAN-PHASE3 §4：fs.watch 目录级监听，零扩展改动；
// Windows 下同一次写可能触发多次事件，200ms 去抖）
let stateDebounce: ReturnType<typeof setTimeout> | undefined;
watch(stateDir, (_evt, filename) => {
	if (filename !== `${session.sessionId}.json`) return;
	clearTimeout(stateDebounce);
	stateDebounce = setTimeout(() => {
		try {
			broadcast({ type: "state", state: currentState() });
		} catch {
			// 读取竞态（写入未完成）：下次事件再推
		}
	}, 200);
});

// agent 自建面板（柱 2）：与 state 同款——扩展落盘 .rp-artifacts/<sessionId>.json，
// 这里 fs.watch 监听并推送活跃面板全量（panel_write/close 与 rewind 回退同一条路径）
const artifactsDir = dir(cwd, "artifacts");
mkdirSync(artifactsDir, { recursive: true });
const currentPanels = () => activePanels(loadPanels(join(artifactsDir, `${session.sessionId}.json`)));

let panelsDebounce: ReturnType<typeof setTimeout> | undefined;
watch(artifactsDir, (_evt, filename) => {
	if (filename !== `${session.sessionId}.json`) return;
	clearTimeout(panelsDebounce);
	panelsDebounce = setTimeout(() => {
		try {
			broadcast({ type: "panels", panels: currentPanels() });
		} catch {
			// 读取竞态（写入未完成）：下次事件再推
		}
	}, 200);
});

/** 会话树条目 → swipe 纯函数输入 */
const swipeEntriesFromSession = (): SwipeEntry[] => {
	const raw = session.sessionManager.getEntries() as Array<Record<string, unknown>>;
	return raw.map((e) => {
		const id = String(e.id);
		const parentId = (e.parentId as string | null) ?? null;
		const type = String(e.type);
		const timestamp = typeof e.timestamp === "string" ? e.timestamp : undefined;
		if (type === "message" && e.message && typeof e.message === "object") {
			const m = e.message as { role?: unknown; customType?: unknown };
			return {
				id,
				parentId,
				type: "message",
				role: typeof m.role === "string" ? m.role : undefined,
				customType: typeof m.customType === "string" ? m.customType : undefined,
				timestamp,
			};
		}
		return {
			id,
			parentId,
			type,
			customType: typeof e.customType === "string" ? e.customType : undefined,
			timestamp,
		};
	});
};

const extractEntryText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: unknown }).type === "text"
				? String((p as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
};

/**
 * reroll/编辑输入的「回退叶」：branch 前记录旧叶；生成失败或停止无产出时
 * 回退到它（8/05：reroll 链上停止，当前分支只剩 user、旧回复全部消失）。
 * onTurnEnd 消费后清空。
 */
let rerollFallbackLeaf: string | null = null;

/** 当前分支上最后一条剧情用户消息 entry id（戏外轮不计） */
const lastStoryUserId = (): string | null => {
	const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
	const lite = branch.map((e) => {
		const type = String(e.type);
		if (type === "message" && e.message && typeof e.message === "object") {
			const m = e.message as { role?: unknown; content?: unknown };
			return {
				id: String(e.id),
				type: "message",
				role: typeof m.role === "string" ? m.role : undefined,
				text: extractEntryText(m.content),
			};
		}
		return { id: String(e.id), type };
	});
	return lastStoryUserEntryId(lite, isBackstageText);
};

/**
 * 给历史 wire 消息挂上 ST swipe 元数据：仅「当前分支最后一轮剧情角色回复」一条。
 * total=0 时不挂（尚无回复，箭头由前端在空状态决定是否展示——目前只在有 narrative 时显示）。
 */
const annotateSwipes = (messages: import("./wire.ts").WireMsg[]): import("./wire.ts").WireMsg[] => {
	const userId = lastStoryUserId();
	if (!userId) return messages;
	const leafId = session.sessionManager.getLeafId();
	const meta = swipeMetaForUser(swipeEntriesFromSession(), userId, leafId);
	// total=0 也挂上（仅 user 尚无回复时 UI 可点右生成；有 narrative 时至少 1）
	// 找最后一条 narrative（非 backstage 流里的角色回复）
	let lastNar = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].channel === "narrative") {
			lastNar = i;
			break;
		}
	}
	if (lastNar < 0) return messages;
	const total = Math.max(1, meta?.total ?? 1);
	const index = meta && meta.total > 0 ? meta.index : 0;
	return messages.map((m, i) => (i === lastNar ? { ...m, swipe: { index, total } } : m));
};

/** 当前卡显示向皮肤（wire 上屏：先正则再 unwrap） */
const currentDisplaySkin = () => {
	try {
		const snap = loadCardFrontSnapshot(cwd);
		if (!snap.enabled || !snap.hasSkin || !snap.rules.length) return null;
		return {
			rules: snap.rules,
			charName: snap.charName || names.charName,
			userName: snap.userName || names.userName,
		};
	} catch {
		return null;
	}
};

/**
 * 会话树当前分支 → 显示层消息列表。
 * 台上引擎直接写树（R1 循环自持），AgentSession 的内存副本不再是权威——
 * 显示层一律以 SessionManager 分支为准（含 rp-greeting/rp-draft-op 等 custom_message）。
 */
const branchMessages = (): unknown[] => {
	try {
		const out: unknown[] = [];
		const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
		const performances = performanceByNarrative(branch);
		const diagnostics = new Map<string,unknown>();
		for (const e of branch) if (e.customType === "rp-model-diagnostics" && e.data && typeof e.data === "object") {
			const d=e.data as {narrativeEntryId?:string;calls?:unknown}; if (d.narrativeEntryId) diagnostics.set(d.narrativeEntryId,d.calls);
		}
		const presentationPending = new Set<string>();
		for (const entry of branch) if(entry.customType==="rp-turn-settlement" && entry.data && typeof entry.data==="object"){const data=entry.data as {narrativeEntryId?:string;presentationDone?:boolean};if(data.narrativeEntryId){if(data.presentationDone===false)presentationPending.add(data.narrativeEntryId);else if(data.presentationDone===true)presentationPending.delete(data.narrativeEntryId);}}
		const performanceMessage = (entry: Record<string, unknown>) => {
			const message = { ...(entry.message as Record<string, unknown>) };
			const performance = performances.get(String(entry.id));
			const calls = diagnostics.get(String(entry.id));
			if(presentationPending.has(String(entry.id)))message.details={...(message.details as Record<string,unknown>??{}),rpPresentationDelivery:{status:"pending"}};
			if (calls) message.details = { ...(message.details as Record<string,unknown> ?? {}),rpModelDiagnostics:calls };
			return performance ? { ...message, details: { ...(message.details as Record<string, unknown> ?? {}), rpPerformance: performance, rpPerformanceOwner: String(entry.id) } } : message;
		};
		const deliveries = new Map<string, {body:string;formats:string;display:string;requirements:unknown;inputSourceCount?:number;inputChars?:number;retryCount?:number}>();
		for (const entry of branch) if (entry.customType === "rp-presentation-delivery" && entry.data && typeof entry.data === "object") {
			const data = entry.data as {version?:number;targetEntryId?:string;body?:string;formats?:string;requirements?:unknown;display?:string;inputSourceCount?:number;inputChars?:number;retryCount?:number};
			if(data.version===1 && typeof data.targetEntryId==="string" && typeof data.body==="string" && typeof data.formats==="string") deliveries.set(data.targetEntryId,{body:data.body,formats:data.formats,display:typeof data.display==="string"?data.display:[data.body,data.formats].join("\n\n"),requirements:data.requirements,inputSourceCount:data.inputSourceCount,inputChars:data.inputChars,retryCount:data.retryCount});
		}
		const overrides = new Map<string, string>();
		const usableCurtain = (text: string): boolean => {
			const value = text.trim();
			if (value.length < 8 || value === "<") return false;
			const stack: string[] = [];
			for (const match of value.matchAll(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g)) {
				const full = match[0];
				const name = match[1].toLowerCase();
				if (/^<\//.test(full)) {
					if (stack[stack.length - 1] === name) stack.pop();
				} else if (!/\/>$/.test(full) && !["br", "hr", "img", "input", "meta", "link"].includes(name)) stack.push(name);
			}
			return stack.length === 0;
		};
		for (const e of branch) {
			if (e.type !== "custom" || e.customType !== "rp-curtain-override" || !e.data || typeof e.data !== "object") continue;
			const data = e.data as { targetEntryId?: unknown; curtain?: unknown };
			if (typeof data.targetEntryId === "string" && typeof data.curtain === "string" && usableCurtain(data.curtain)) overrides.set(data.targetEntryId, data.curtain);
		}
		for (const e of branch) {
			if (e.type === "message" && e.message) {
				const delivery = deliveries.get(String(e.id));
				if (delivery) {
					const message = performanceMessage(e), details = message.details as Record<string,unknown> | undefined;
					const canonical = typeof details?.rpNarrative === "string" ? details.rpNarrative : "";
					if (canonical && presentationFactText(delivery.body) === presentationFactText(canonical)) {
						const thinking = Array.isArray(message.content) ? message.content.filter(part => part?.type === "thinking") : [];
						const display = delivery.display;
						out.push({...message,content:[...thinking,{type:"text",text:display}],details:{...details,rpCurtain:delivery.formats,rpPresentationBody:delivery.body,rpPresentationRequirements:delivery.requirements,rpPresentationDelivery:{status:"complete",inputSourceCount:delivery.inputSourceCount,inputChars:delivery.inputChars,retryCount:delivery.retryCount,formatNames:Array.isArray(delivery.requirements)?delivery.requirements.map(x=>x.name):[]},rpTimeline:[{kind:"text",text:display}]}});
						continue;
					}
				}
				const override = overrides.get(String(e.id));
				if (!override || typeof e.message !== "object") {
					out.push(performanceMessage(e));
					continue;
				}
				const message = performanceMessage(e);
				const details = message.details && typeof message.details === "object" && !Array.isArray(message.details)
					? message.details as Record<string, unknown> : {};
				const narrative = typeof details.rpNarrative === "string" ? details.rpNarrative : extractEntryText(message.content);
				const oldCurtain = typeof details.rpCurtain === "string" ? details.rpCurtain : "";
				const oldTimeline = Array.isArray(details.rpTimeline) ? details.rpTimeline as Array<Record<string, unknown>> : [];
				let replaced = false;
				const timeline = oldTimeline.map((segment) => {
					if (!replaced && oldCurtain && segment.kind === "text" && segment.text === oldCurtain) {
						replaced = true;
						return { ...segment, text: override };
					}
					return segment;
				});
				if (!replaced) timeline.push({ kind: "text", text: override });
				const thinking = Array.isArray(message.content)
					? message.content.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "thinking")
					: [];
				out.push({
					...message,
					content: [...thinking, { type: "text", text: `${narrative}\n\n${override}` }],
					details: { ...details, rpCurtain: override, rpTimeline: timeline },
				});
			} else if (e.type === "custom_message") {
				// details 必须透传：开场白序号（rpGreeting）等元数据只存在于树条目上，
				// 丢了就让 resyncAll 后的角标退回 /api/card 轮询（切换开场白时角标卡住不动）
				out.push({
					role: "custom",
					customType: e.customType,
					content: e.content,
					display: e.display,
					details: e.details,
				});
			}
		}
		return out;
	} catch {
		return session.messages;
	}
};

const helloFrame = (): ServerFrame => {
	const cardfront = loadCardFrontSnapshot(cwd);
	const skin =
		cardfront.enabled && cardfront.hasSkin && cardfront.rules.length
			? {
					rules: cardfront.rules,
					charName: cardfront.charName || names.charName,
					userName: cardfront.userName || names.userName,
				}
			: null;
	return {
		type: "hello",
		appVersion: APP_VERSION,
		sessionId: session.sessionId,
		deliveryProtocol: 1,
		generationMode: effectiveGenerationMode(loadStageConfig(cwd).generationMode),
		streaming: readStoryStreaming(),
		charName: names.charName,
		userName: names.userName,
		messages: (() => {
			const messages = annotateSwipes(toWireHistory(branchMessages(), names, { skin }));
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].channel === "narrative") {
					const branch = session.sessionManager.getBranch() as BranchEntryLike[];
					const manifest = worldManifestFromBranch(branch);
					const modular = modularWorldFromBranch(branch, manifest);
					const state = stateFromBranch(branch);
					let ecology = literaryEcologyFromBranch(branch);
					if (ecology.round === 0) {
						for (let index = branch.length - 1; index >= 0; index--) {
							const prep = branch[index].message?.details && typeof branch[index].message?.details === "object"
								? (branch[index].message!.details as Record<string, unknown>).rpPrep
								: undefined;
							const candidate = prep && typeof prep === "object" ? (prep as Record<string, unknown>).literaryEcology : undefined;
							const parsed = candidate ? normalizeLiteraryEcologyState(candidate, ecology) : null;
							if (parsed && (parsed.actors.length || parsed.occurrences.length || parsed.locationStates.length)) { ecology = parsed; break; }
						}
					}
					const presentation = projectPresentation(state, modular, ecology, names.userName);
					let rawCurtain = "";
					for (let index = branch.length - 1; index >= 0; index--) {
						const details = branch[index].message?.details as Record<string, unknown> | undefined;
						if (branch[index].message?.role === "assistant" && typeof details?.rpCurtain === "string") { rawCurtain = details.rpCurtain; break; }
					}
					// 新回复一律使用 rp-state + 世界/生态的权威日历。仅无原生日期可投影的旧历史回退 rpCurtain。
					const legacyCalendar = presentation.calendar ? undefined : parseLegacyCalendarSource(rawCurtain);
					if (legacyCalendar) presentation.calendar = legacyCalendar;
					// Adaptive delivery already contains the card-authored calendar; native data was reference only.
					if (typeof details.rpPresentationBody === "string") delete presentation.calendar;
					const optionMatch = rawCurtain.match(/<options>\s*([\s\S]*?)\s*<\/options>/i);
					// 当前卡若已有 options 美化正则，HTML 会在正文中展示；不要再叠加
					// 原生 presentation 卡，避免同一组选项出现一份美化、一份裸卡。
					const optionsHandledBySkin = cardfront.rules.some((rule) => {
						if (!/options/i.test(rule.source) && !/options/i.test(rule.replace)) return false;
						try { return new RegExp(rule.source, rule.flags).test(rawCurtain); } catch { return false; }
					});
					if (optionMatch && !optionsHandledBySkin) presentation.options = optionMatch[1].split(/\r?\n/).map((line) => line.trim().replace(/^(?:>|[-*]|\d+[.)、])\s*/, "")).filter(Boolean).slice(0, 9);
					messages[i] = { ...messages[i], world: projectLiteraryWorldV1(modular), worldModules: modularWorldWireView(modular, manifest), worldAudit: worldAuditFromBranch(branch), ecology: ecologyWireView(ecology), presentation, tavernVariables: projectTavernVariables(state, names.userName) };
					break;
				}
			}
			return messages;
		})(),
		state: currentState(),
		world: (() => { const branch = session.sessionManager.getBranch() as BranchEntryLike[]; return projectLiteraryWorldV1(modularWorldFromBranch(branch, worldManifestFromBranch(branch))); })(),
		worldAudit: worldAuditFromBranch(session.sessionManager.getBranch() as BranchEntryLike[]),
		worldModules: (() => { const branch = session.sessionManager.getBranch() as BranchEntryLike[]; const manifest = worldManifestFromBranch(branch); return modularWorldWireView(modularWorldFromBranch(branch, manifest), manifest); })(),
		ecology: ecologyWireView(literaryEcologyFromBranch(session.sessionManager.getBranch() as BranchEntryLike[])),
		stats: safeStats(),
		panels: currentPanels(),
		// 一档皮肤与消息同帧:首屏不得依赖二次 REST(缓存/竞态会让 StatusBlock 回落统一面板)
		cardfront,
		novelGuide: novelGuideForHello(),
	};
};

/** 全量重放（斜杠命令 / 树导航 / 压缩后：让所有端与会话文件对齐） */
const resyncAll = () => broadcast(helloFrame());

function novelGuideForHello(): NonNullable<Extract<ServerFrame, { type: "hello" }>["novelGuide"]> | undefined {
	try {
		if (!cardPath) return undefined;
		const raw = readCardRawJson(isAbsolute(cardPath) ? cardPath : join(cwd, cardPath)).raw;
		const branch = session.sessionManager.getBranch() as BranchEntryLike[];
		const binding = effectiveNovelPlayBinding(cwd, raw, branch);
		if (!binding) return undefined;
		const mode = ((raw.data as Record<string, unknown>)?.extensions as Record<string, unknown> | undefined)?.liyuanNovelPlay as Record<string, unknown> | undefined;
		const stored = loadNovelPackage(cwd, binding.docId, binding.revision);
		if (binding.anchorKind === "source-end") return { mode: binding.anchorKind === "source-end" ? "new-character" : "new-character", startKind: "source-end", visible: false, positionLabel: "导入原文终点之后", candidates: [], note: "这是导入文本终点之后的原创续写，没有原著后续走向可提示。" };
		const state = novelPlayStateFromBranch(branch, binding, stored.package);
		const anchor = state?.progress ?? { packageRevision: stored.package.revision, nodeId: binding.startNodeId!, position: binding.position! };
		const current = stored.package.nodes.find(node => node.id === anchor.nodeId && node.visibility === "public");
		if (!current) return undefined;
		const conflicts = new Set((state?.conflicts ?? []).map(item => item.nodeId));
		const candidates = stored.package.nodes.filter(node => node.visibility === "public" && node.order >= current.order && !conflicts.has(node.id)).sort((a, b) => a.order - b.order).slice(0, 3).map(node => ({ title: node.title, summary: node.summary }));
		const playerMode = mode?.playerMode === "existing-character" ? "existing-character" : "new-character";
		return { mode: playerMode, startKind: "node", visible: playerMode === "existing-character", positionLabel: anchor.position === "before" ? "当前事件发生前" : "当前事件发生后", candidates, note: playerMode === "existing-character" ? "原著走向提示仅供玩家参考，不等于角色已知事实；你可以随时改写当前节点。" : "当前为新角色模式，原著后续提示默认关闭；可在面板中手动打开。" };
	} catch { return undefined; }
}

/** 会话树条目是否为开场白 */
const isGreetingTreeEntry = (e: Record<string, unknown>): boolean => {
	const t = String(e.type ?? "");
	if (t === "custom_message" && e.customType === "rp-greeting") return true;
	const msg = e.message as { role?: unknown; customType?: unknown } | undefined;
	if (t === "message" && msg?.role === "custom" && msg?.customType === "rp-greeting") return true;
	return false;
};

/**
 * 宿主层切换开场白：await 导航 + 注入 + resync，避免叠楼。
 * （扩展里 pi.sendMessage 是 fire-and-forget，resync 会抢跑；且 custom_message 识别曾漏检）
 */
const hostSwitchGreeting = async (rawArg: string): Promise<void> => {
	const configPath = resolveConfigPath(cwd);
	let cfg: RpConfig = { ...DEFAULT_CONFIG };
	try {
		if (existsSync(configPath)) {
			cfg = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, "utf8")) as Partial<RpConfig>) };
		}
	} catch {
		/* default */
	}
	if (!cfg.card) {
		broadcast({ type: "notify", level: "error", text: "未配置角色卡" });
		return;
	}
	let card;
	try {
		const cardPath = isAbsolute(cfg.card) ? cfg.card : join(cwd, cfg.card);
		card = loadCardFile(cardPath);
	} catch (err) {
		broadcast({
			type: "notify",
			level: "error",
			text: `角色卡装载失败：${err instanceof Error ? err.message : String(err)}`,
		});
		return;
	}
	// 全量下标（与 buildGreeting / 配置 greetingIndex 一致）+ 非空槽位（切换时跳过空开场白）
	const fullPool = [card.firstMes, ...card.alternateGreetings].map((t, i) => ({
		i,
		t: typeof t === "string" ? t : "",
	}));
	const nonempty = fullPool.filter((x) => x.t.trim());
	if (nonempty.length === 0) {
		broadcast({ type: "notify", level: "error", text: "本卡没有开场白" });
		return;
	}
	const raw = rawArg.trim().toLowerCase();
	const curFull = cfg.greetingIndex ?? 0;
	let pos = nonempty.findIndex((x) => x.i === curFull);
	if (pos < 0) pos = 0;
	if (!raw || raw === "next") pos = (pos + 1) % nonempty.length;
	else if (raw === "prev") pos = (pos - 1 + nonempty.length) % nonempty.length;
	else {
		const n = Number.parseInt(raw, 10);
		if (!Number.isFinite(n)) {
			broadcast({ type: "notify", level: "error", text: "用法：/greeting [序号|next|prev]" });
			return;
		}
		// 数字按「全量下标」理解（与配置 / 卡面板一致）
		const hit = nonempty.findIndex((x) => x.i === n);
		pos = hit >= 0 ? hit : Math.max(0, Math.min(nonempty.length - 1, n));
	}
	const idx = nonempty[pos].i; // 写入配置与 buildGreeting 的全量下标
	const displayOrdinal = pos + 1; // 角标用非空序位 1..N
	const displayTotal = nonempty.length;
	try {
		const disk = existsSync(configPath)
			? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
			: {};
		disk.greetingIndex = idx;
		writeFileSync(configPath, `${JSON.stringify(disk, null, "\t")}\n`, "utf8");
	} catch (err) {
		broadcast({
			type: "notify",
			level: "error",
			text: `写入配置失败：${err instanceof Error ? err.message : String(err)}`,
		});
		return;
	}
	cfg = { ...cfg, greetingIndex: idx };

	const sm = session.sessionManager;
	const branch = sm.getBranch() as Array<Record<string, unknown>>;
	const hasUser = branch.some((e) => {
		if (e.type !== "message") return false;
		const msg = e.message as { role?: string; content?: unknown } | undefined;
		if (msg?.role !== "user") return false;
		return !isBackstageText(extractEntryText(msg.content));
	});
	if (hasUser) {
		broadcast({
			type: "notify",
			level: "info",
			text: `已选定开场白 ${displayOrdinal}/${displayTotal}，当前会话已开聊，下次新会话生效。`,
		});
		return;
	}

	const greets = branch.filter(isGreetingTreeEntry);
	if (greets.length > 0) {
		const first = greets[0];
		const parentId = (first.parentId as string | null) ?? null;
		if (parentId) {
			const result = await session.navigateTree(parentId, { summarize: false });
			if (result.cancelled) return;
		} else {
			// 树根开场白：resetLeaf，新开场白与旧的并列 sibling，当前只显示新的
			sm.resetLeaf();
			const ctx = sm.buildSessionContext();
			session.agent.state.messages = ctx.messages;
		}
	}

	const text = buildGreeting(card, cfg);
	// details 带序号 → wire greetingPick，前端角标与正文同源
	await session.sendCustomMessage({
		customType: "rp-greeting",
		content: text,
		display: true,
		details: { rpGreeting: { index: pos, total: displayTotal, fullIndex: idx } },
	});
	resyncAll();
	broadcast({ type: "notify", level: "info", text: `已切换开场白 ${displayOrdinal}/${displayTotal}` });
};

/**
 * ST 式再生成：叶指针落在「最后一条剧情 user」上，再 agent.continue()。
 * 新 assistant 作为该 user 的 sibling 子树；旧变体保留在旁支。
 *
 * 注意：session.navigateTree(userId) 对 user 会退到 parent 并把文案放进 editor，
 * 不适合 swipe（会拆成多条 user）。这里用 branch(userId) 固定挂在同一 user 下。
 * 不写 /store → 不产生世界线分叉。
 */
const regenerateSwipe = async (): Promise<void> => {
	const userId = lastStoryUserId();
	if (!userId) {
		broadcast({ type: "notify", level: "error", text: "没有可重新生成的剧情轮（需要先有一条用户输入）" });
		return;
	}
	const sm = session.sessionManager;
	const branchBefore = sm.getBranch() as BranchEntryLike[];
	let prep: StageRerollPrep | undefined;
	for (let i = branchBefore.length - 1; i >= 0; i--) {
		const details = branchBefore[i].message?.details;
		if (!details || typeof details !== "object") continue;
		const raw = (details as Record<string, unknown>).rpPrep;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const source = raw as Record<string, unknown>;
		prep = {
			...(isGenerationMode((details as Record<string, unknown>).rpGenerationMode) ? { generationMode: (details as Record<string, unknown>).rpGenerationMode as "direct" | "director" } : {}),
			...(source.literaryContinuity && typeof source.literaryContinuity === "object"
				? { literaryContinuity: source.literaryContinuity as NonNullable<StageRerollPrep["literaryContinuity"]> }
				: {}),
			...(typeof source.literaryDirection === "string" ? { literaryDirection: source.literaryDirection } : {}),
			...(source.literaryDirectionData && typeof source.literaryDirectionData === "object" && !Array.isArray(source.literaryDirectionData)
				? { literaryDirectionData: source.literaryDirectionData as NonNullable<StageRerollPrep["literaryDirectionData"]> }
				: {}),
			...(source.literaryEcology && typeof source.literaryEcology === "object" && !Array.isArray(source.literaryEcology)
				? { literaryEcology: source.literaryEcology as NonNullable<StageRerollPrep["literaryEcology"]> }
				: {}),
			...(source.plotAdaptation && typeof source.plotAdaptation === "object" && !Array.isArray(source.plotAdaptation)
				? { plotAdaptation: source.plotAdaptation as NonNullable<StageRerollPrep["plotAdaptation"]> }
				: {}),
			...(source.sceneConductor && typeof source.sceneConductor === "object" && !Array.isArray(source.sceneConductor)
				? { sceneConductor: source.sceneConductor as NonNullable<StageRerollPrep["sceneConductor"]> }
				: {}),
		};
		if (!prep.generationMode && !prep.literaryContinuity && !prep.literaryDirection && !prep.literaryDirectionData && !prep.literaryEcology && !prep.plotAdaptation && !prep.sceneConductor) prep = undefined;
		break;
	}
	broadcast({ type: "notify", level: "info", text: prep?.generationMode ? `正文重Roll：沿用${prep.generationMode === "direct" ? "直出" : "导演"}模式重新生成` : prep ? "正文重Roll：复用上一版拍前分析，从 writer 阶段重新生成" : "正文重Roll：旧回复没有可复用工件，将重新执行完整一拍" });
	// 记录 reroll 前的叶：生成失败/停止无产出时回退到旧回复（8/05：reroll 链上停止，前版本全消失）
	rerollFallbackLeaf = sm.getLeafId();
	// 叶钉回 user：引擎在 user 下挂新的 assistant sibling（swipe 语义）。
	// 世界状态/历史均为 f(分支)（R3/R4），无需旧的 navigateTree 恢复舞蹈——
	// 废弃分支上的场记快照天然不在新分支上，账本不会泄漏（8/02 A 雷的结构性解法）。
	if (sm.getLeafId() !== userId) {
		sm.branch(userId);
	}
	// 展示层立刻去掉旧回复（只显示到 user）
	resyncAll();
	await stage.regenerate(prep);
};

/**
 * ST 式变体切换 / 再生成。
 * - prev：上一条 sibling（到头则提示）
 * - next：下一条；已在末条则再生成
 * - new：强制再生成
 */
const handleSwipe = async (dir: "prev" | "next" | "new"): Promise<void> => {
	if (dir === "new") {
		await regenerateSwipe();
		return;
	}
	const userId = lastStoryUserId();
	if (!userId) {
		broadcast({ type: "notify", level: "error", text: "没有可切换的回复变体" });
		return;
	}
	const entries = swipeEntriesFromSession();
	const leafId = session.sessionManager.getLeafId();
	const variants = listReplyVariants(entries, userId, leafId);
	if (variants.length === 0) {
		// 尚无回复：next/new 等价生成
		if (dir === "next") await regenerateSwipe();
		else broadcast({ type: "notify", level: "info", text: "还没有角色回复可切换" });
		return;
	}
	const meta = swipeMetaForUser(entries, userId, leafId);
	const idx = meta?.index ?? 0;
	if (dir === "prev") {
		if (idx <= 0) {
			broadcast({ type: "notify", level: "info", text: "已经是第一条变体" });
			return;
		}
		const target = variants[idx - 1].leafId;
		const result = await session.navigateTree(target, { summarize: false });
		if (!result.cancelled) resyncAll();
		return;
	}
	// next
	if (idx >= variants.length - 1) {
		await regenerateSwipe();
		return;
	}
	const target = variants[idx + 1].leafId;
	const result = await session.navigateTree(target, { summarize: false });
	if (!result.cancelled) resyncAll();
};

// ---------- 扩展绑定：headless UI 上下文 + 命令动作桥（参考 dist/modes/rpc/rpc-mode.js） ----------

const noop = () => {};

// ---------- 剧情决策门禁通道（Phase 4 柱 1）：uiContext.select/input ↔ 前端选择卡 ----------
//
// 扩展的 ask_director 工具调用 ctx.ui.select(question, options) 停笔询问；这里把它翻成
// choice 帧广播给所有端，挂起等待应答。语义（用户定调 2026-07-10）：
//   - 应答（选项原文 / 自由输入）→ resolve 该字符串，模型据此续写；
//   - 停止 → resolve undefined + abort 本回合（笔还给用户）；
//   - 无限等待（RP 本是回合制，不设超时）；
//   - 断线重连：hello 补发未决卡；多端先答先得，其余端收 choice_resolved 收敛留痕。

interface PendingChoice {
	question: string;
	options: string[];
	placeholder?: string;
	/** value=字符串应答；undefined=停止本回合 */
	resolve: (value: string | undefined) => void;
	settled: boolean;
}
const pendingChoices = new Map<string, PendingChoice>();
let choiceSeq = 0;

/** 未决卡帧（hello 补发 / 首次广播共用） */
const choiceFrame = (id: string, p: PendingChoice): ServerFrame => ({
	type: "choice",
	id,
	question: p.question,
	options: p.options,
	...(p.placeholder ? { placeholder: p.placeholder } : {}),
});

/** 收敛一张未决卡：resolve 扩展侧的挂起 Promise，并广播留痕态给所有端 */
const settleChoice = (id: string, outcome: { value?: string; stop?: boolean }) => {
	const p = pendingChoices.get(id);
	if (!p || p.settled) return;
	p.settled = true;
	pendingChoices.delete(id);
	broadcast({ type: "choice_resolved", id, ...(outcome.stop ? { stopped: true } : { answer: outcome.value }) });
	p.resolve(outcome.stop ? undefined : outcome.value);
};

/** 挂起一次询问，等前端应答（signal 触发或主动 abort 时按停止处理） */
const askChoice = (question: string, options: string[], placeholder: string | undefined, signal?: AbortSignal) =>
	new Promise<string | undefined>((resolve) => {
		const id = `c${Date.now().toString(36)}-${++choiceSeq}`;
		const pending: PendingChoice = { question, options, placeholder, resolve, settled: false };
		pendingChoices.set(id, pending);
		broadcast(choiceFrame(id, pending));
		// 回合被外部中止（主 Stop 按钮 / 压缩等）：未决卡按停止收敛，避免悬挂
		signal?.addEventListener("abort", () => settleChoice(id, { stop: true }), { once: true });
	});

const uiContext = {
	// 有实义的部分：通知直达 Web（审计告警零改动上屏）
	notify(message: string, type?: "info" | "warning" | "error") {
		broadcast({ type: "notify", level: type ?? "info", text: message });
	},
	// 决策门禁：选择卡（有选项）/ 自由输入卡（无选项）——均带自由输入框与停止按钮（前端渲染）
	select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) =>
		askChoice(title, Array.isArray(options) ? options : [], undefined, opts?.signal),
	confirm: async () => false,
	input: async (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) =>
		askChoice(title, [], placeholder, opts?.signal),
	editor: async () => undefined,
	custom: async () => undefined,
	// 其余 TUI 专属能力：no-op stub
	onTerminalInput: () => noop,
	setStatus: noop,
	setWorkingMessage: noop,
	setWorkingVisible: noop,
	setWorkingIndicator: noop,
	setHiddenThinkingLabel: noop,
	setWidget: noop,
	setFooter: noop,
	setHeader: noop,
	setTitle: noop,
	pasteToEditor: noop,
	setEditorText: noop,
	getEditorText: () => "",
	addAutocompleteProvider: noop,
	setEditorComponent: noop,
	getEditorComponent: () => undefined,
	get theme() {
		return undefined;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: () => ({ success: false, error: "Web 模式不支持主题切换" }),
	getToolsExpanded: () => false,
	setToolsExpanded: noop,
};

const bindSession = async () => {
	outline?.cancel();
	turnRuntimeDiagnostics.clear();
	session = runtime.session;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- headless stub 集合，形状对齐 rpc-mode 的实现
	await session.bindExtensions({
		uiContext: uiContext as any,
		mode: "rpc",
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: (options: unknown) => runtime.newSession(options as never),
			fork: async (entryId: string, options: unknown) => {
				const result = await runtime.fork(entryId, options as never);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId: string, options: unknown) => {
				const result = await session.navigateTree(targetId, options as never);
				return { cancelled: result.cancelled };
			},
			switchSession: (sessionPath: string, options: unknown) => runtime.switchSession(sessionPath, options as never),
			reload: () => session.reload(),
		} as never,
		onError: (err: { extensionPath: string; event: string; error: string }) => {
			broadcast({ type: "error", text: `扩展错误（${err.event}）：${err.error}` });
		},
	});

	unsubscribe?.();
	unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "agent_start":
				broadcast({ type: "agent", state: "start" });
				break;
			case "agent_end":
				if (!event.willRetry) {
					broadcast({ type: "agent", state: "end" });
					const stats = safeStats();
					if (stats) broadcast({ type: "stats", stats });
					// 挂上 swipe 序号（流式 message 帧无树元数据）
					resyncAll();
					// 内置向量记忆：按策略把本轮助手正文入库（异步，失败不影响叙事）
					void (async () => {
						try {
							const memoryConfig = loadMemoryConfig(cwd);
							const every = memoryConfig.stores.find((store) => store.id === "narrative" && store.enabled)?.everyNTurns ?? 0;
							const branch = session.sessionManager.getBranch() as unknown as Array<{ id?: string; type?: string; message?: { role?: string; content?: unknown } }>;
							const assistantEntries = branch.flatMap((entry) => {
								if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.id) return [];
								const content = entry.message.content;
								const text = typeof content === "string" ? content : Array.isArray(content)
									? content.map((part) => part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "").join("")
									: "";
								return text.trim() ? [{ entryId: entry.id, entryType: "message" as const, text }] : [];
							});
							const msgs = branchMessages() as Array<{ role?: string; content?: unknown }>;
							let lastText = "";
							for (let i = msgs.length - 1; i >= 0; i--) {
								const m = msgs[i];
								if (m?.role !== "assistant") continue;
								const c = m.content;
								if (typeof c === "string") lastText = c;
								else if (Array.isArray(c)) {
									lastText = c
										.map((p) =>
											p && typeof p === "object" && (p as { type?: string }).type === "text"
												? String((p as { text?: string }).text ?? "")
												: "",
										)
										.join("");
								}
								if (lastText.trim()) break;
							}
							const mem = await onNarrativeTurnEnd(
								cwd,
								{ sessionId: session.sessionId, card: cardPath || undefined },
								lastText,
								{
									entries: every > 0 ? assistantEntries.slice(-every).map((entry, index) => ({ ...entry, turn: Math.max(1, assistantEntries.length - every + index + 1) })) : [],
									branchLeafId: session.sessionManager.getLeafId() ?? undefined,
								},
							);
							if (mem.error) {
								broadcast({
									type: "notify",
									level: "warning",
									text: `向量记忆：入库失败 · ${mem.error}`,
								});
							} else if (mem.stored) {
								const how = mem.merged ? "合并入已有条目" : "新开条目";
								broadcast({
									type: "notify",
									level: "info",
									text: `向量记忆：剧情库${how}（第 ${mem.counter} 轮 · 当前对话）`,
								});
							}
						} catch (e) {
							console.warn("[memory] auto ingest failed", e);
						}
					})();
				}
				break;
			case "message_update": {
				const e = event.assistantMessageEvent;
				if (e.type === "text_delta") broadcast({ type: "delta", kind: "text", delta: e.delta });
				else if (e.type === "thinking_delta") broadcast({ type: "delta", kind: "thinking", delta: e.delta });
				break;
			}
			case "message_end": {
				// 刚生成的这条就是最新消息（depth 0）——作者的深度限定按此筛，
				// 否则「N 楼外删掉」这类规则会当场把本拍的状态栏删了
				const wire = toWireMsg(event.message, names, { skin: skinAtDepth(currentDisplaySkin(), 0) });
				// user 消息在 prompt 受理时已回显，这里跳过防重
				if (wire && wire.channel !== "user") {
					broadcast({ type: "message", message: wire });
				} else if ((event.message as { role?: string } | undefined)?.role === "assistant") {
					// 中间 tool 轮 / 纯工具轮被过滤：清掉前端流式半成品，整轮只保留一个角色气泡
					broadcast({ type: "stream", state: "clear" });
				}
				break;
			}
			case "tool_execution_start": {
				// RP 人话摘要（非 JSON）；模型台侧旁白另由 stream→note 捕获
				const detail = toolStartDetail(event.toolName, event.args);
				broadcast({ type: "activity", activity: { kind: "tool_start", name: event.toolName, detail } });
				break;
			}
			case "tool_execution_end":
				broadcast({
					type: "activity",
					activity: {
						kind: "tool_end",
						name: event.toolName,
						detail: summarizeToolResult(event.result),
						isError: event.isError === true,
					},
				});
				break;
			case "compaction_start":
				broadcast({ type: "compaction", state: "start" });
				break;
			case "compaction_end":
				broadcast({ type: "compaction", state: "end", ok: !event.aborted && !event.errorMessage });
				resyncAll();
				break;
			case "auto_retry_start":
				broadcast({ type: "notify", level: "warning", text: `模型请求失败，自动重试 ${event.attempt}/${event.maxAttempts}…` });
				break;
			default:
				break;
		}
	});
};

runtime.setRebindSession(async () => {
	await bindSession();
	resyncAll(); // /branch 等替换会话后，所有端对齐新会话
});
await bindSession();

// ---------- REST 宿主接口（rest.ts 经此触碰 pi；pi 类型不出本文件） ----------

const currentModelInfo = (): CurrentModelInfo | null => {
	const m = session.model;
	if (!m) return null;
	return {
		provider: m.provider,
		id: m.id,
		name: m.name || m.id,
		thinkingLevel: session.thinkingLevel,
		availableLevels: session.getAvailableThinkingLevels(),
		contextWindow: m.contextWindow ?? 0,
		maxTokens: typeof m.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : undefined,
	};
};

const currentlyConfiguredModels = () => configuredModels(session.modelRegistry.getAvailable(), loadAgentConfig(cwd).config);

const restHost: RestHost = {
	cwd,
	isStreaming: () => session.isStreaming || stage.isStreaming,
	retrySettlement: async () => { const result=await stage.retryPendingSettlement(); resyncAll(); return result; },
	listModels: () => ({
		current: currentModelInfo(),
		models: currentlyConfiguredModels().map((m) => ({
			provider: m.provider,
			providerName: session.modelRegistry.getProviderDisplayName(m.provider),
			id: m.id,
			name: m.name || m.id,
			reasoning: m.reasoning === true,
			vision: Array.isArray(m.input) && m.input.includes("image"),
			contextWindow: m.contextWindow ?? 0,
			maxTokens: typeof m.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : undefined,
		})),
	}),
	async selectModel(provider, id) {
		const m = currentlyConfiguredModels().find(m => m.provider === provider && m.id === id);
		if (!m) throw new Error(`模型不在当前启用API配置：${provider}/${id}。请先在连接设置中明确启用，旧仓库配置不会自动恢复。`);
		await session.setModel(m);
		const current = currentModelInfo();
		if (!current) throw new Error("模型切换后状态异常");
		return current;
	},
	setThinkingLevel(level) {
		// 各模型档位名不同（off/low/high/xhigh/max…），由用户按模型文档自填英文，不做固定白名单
		const lv = level.trim();
		if (!lv) throw new Error("思考档位不能为空");
		session.setThinkingLevel(lv as never);
		const current = currentModelInfo();
		if (!current) throw new Error("会话未就绪");
		return current;
	},
	authProviders() {
		const counts = new Map<string, number>();
		for (const m of session.modelRegistry.getAll()) {
			counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
		}
		// 当前会话模型所属 provider 置顶，便于在「现有渠道」里看见
		const currentProvider = session.model?.provider;
		return [...counts.entries()]
			.map(([provider, modelCount]) => {
				const status = session.modelRegistry.getProviderAuthStatus(provider);
				// pi：环境变量渠道 configured 恒 false，但 hasAuth 为真且模型可用
				const ready = session.modelRegistry.authStorage.hasAuth(provider);
				return {
					provider,
					displayName: session.modelRegistry.getProviderDisplayName(provider),
					configured: status.configured,
					ready,
					...(ready || status.configured
						? {
								source: status.configured ? status.source : "environment",
								...(status.label ? { label: status.label } : {}),
							}
						: status.source === "environment" && status.label
							? { label: status.label } // 未就绪也提示可配哪个环境变量
							: {}),
					modelCount,
				};
			})
			.sort((a, b) => {
				if (currentProvider) {
					if (a.provider === currentProvider && b.provider !== currentProvider) return -1;
					if (b.provider === currentProvider && a.provider !== currentProvider) return 1;
				}
				return Number(b.ready) - Number(a.ready) || Number(b.configured) - Number(a.configured) || a.displayName.localeCompare(b.displayName);
			});
	},
	setAuthKey(provider, key) {
		session.modelRegistry.authStorage.set(provider, { type: "api_key", key });
	},
	removeAuth(provider) {
		session.modelRegistry.authStorage.remove(provider);
	},
	agentDir: () => getAgentDir(),
	providerSnapshot(provider) {
		const all = session.modelRegistry.getAll().filter((m) => m.provider === provider);
		if (all.length === 0) return null;
		const sample = all[0] as { baseUrl?: string; api?: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number };
		const status = session.modelRegistry.getProviderAuthStatus(provider);
		const envKey =
			status.source === "environment" && status.label
				? status.label
				: provider === "deepseek"
					? "DEEPSEEK_API_KEY"
					: undefined;
		return {
			provider,
			baseUrl: typeof sample.baseUrl === "string" ? sample.baseUrl : undefined,
			api: typeof sample.api === "string" ? sample.api : undefined,
			envKey,
			models: all.map((m) => ({
				id: m.id,
				name: m.name || m.id,
				reasoning: m.reasoning === true,
				contextWindow: m.contextWindow ?? undefined,
				maxTokens: (m as { maxTokens?: number }).maxTokens,
			})),
		};
	},
	refreshModels: () => session.modelRegistry.refresh(),
	async reloadSession() {
		await session.reload();
		refreshNamesFromConfig();
		resyncAll();
	},
	/** 身份/配置/世界书挂载等：走扩展 /rprefresh，不整会话 reload */
	async softRefreshConfig() {
		if (session.isStreaming) {
			// 流式中改设定：排队到本轮结束，避免与 prompt 抢通道
			void session
				.prompt("/rprefresh", { streamingBehavior: "followUp" })
				.then(() => {
					refreshNamesFromConfig();
					resyncAll();
				})
				.catch((err) => {
					broadcast({
						type: "notify",
						level: "error",
						text: err instanceof Error ? err.message : String(err),
					});
				});
			return;
		}
		await session.prompt("/rprefresh");
		refreshNamesFromConfig();
		resyncAll();
	},
	async switchToCard() {
		refreshNamesFromConfig(); // rest.ts 已写盘新 card，先让会话过滤对准新卡
		// 清卡缓存：换卡后列表必须按新 cardPath 重读 rp-card
		cardCache.clear();
		const frame = await listSessions();
		const list = (frame as { type: "sessions"; list: Array<{ path: string; current: boolean; card?: string }> }).list;
		// 只在本卡会话里挑「最近非当前」；没有则新建（不把其它卡的 current 误当目标）
		const target = list.find((s) => !s.current && (!s.card || sameCardPath(s.card, cardPath, cwd)));
		let result: "switched" | "created";
		if (target) {
			await runtime.switchSession(target.path);
			result = "switched";
		} else {
			await runtime.newSession();
			result = "created";
		}
		broadcast(await listSessions());
		// 助手：换卡后按新剧情会话对齐（新建绑定，不误接旧卡/旧聊助手上下文）
		if (assistantHost) {
			try {
				await assistantHost.switchToStory(session.sessionId);
				broadcast(assistantHelloFrame());
			} catch (err) {
				console.error(`[liyuan] 换卡同步助手会话失败：${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return result;
	},
	promptCommand: (text) => handlePrompt(text),
	queueCommand(text) {
		const queued = storyStreaming();
		// 不等待执行完成（流式中排队到本轮结束；/import 等长操作进度经 notify 推送）
		void handlePrompt(text).catch((err) => {
			broadcast({ type: "error", text: err instanceof Error ? err.message : String(err) });
		});
		return queued;
	},
	// 面板导入：写盘 + 进程内直达收编（不经 /panelsync prompt，避免 assistant_run 内死锁）
	async importPanels(list) {
		const file = join(artifactsDir, `${session.sessionId}.json`);
		let panels = loadPanels(file);
		let imported = 0;
		const names: string[] = [];
		const errors: string[] = [];
		for (const item of list) {
			const name = String(item?.name ?? "");
			const r = writePanel(panels, {
				name,
				kind: String(item?.kind ?? ""),
				content: String(item?.content ?? ""),
			});
			if (r.ok) {
				panels = r.panels;
				imported++;
				names.push(name.trim());
			} else {
				errors.push(`「${name || "?"}」：${r.error}`);
			}
		}
		if (imported > 0) {
			savePanels(file, panels);
			syncStoryPanelsFromDisk();
		}
		return { imported, names, errors };
	},
	// 用户删除面板：写盘 + 进程内收编
	async closePanel(name) {
		const file = join(artifactsDir, `${session.sessionId}.json`);
		const panels = loadPanels(file);
		const r = closePanelInMap(panels, name);
		if (!r.ok) throw new Error(r.error);
		savePanels(file, r.panels);
		syncStoryPanelsFromDisk();
	},
	// 用户手改面板源码：同 import 写路径，但要求面板已存在且未归档
	async savePanel(input) {
		const name = String(input?.name ?? "").trim();
		if (!name) throw new Error("面板名不能为空");
		const file = join(artifactsDir, `${session.sessionId}.json`);
		const panels = loadPanels(file);
		const prev = panels[name];
		if (!prev) throw new Error(`没有名为「${name}」的面板`);
		if (prev.archived) throw new Error(`面板「${name}」已归档，请先由 agent 同名写入重开`);
		const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : prev.kind;
		const r = writePanel(panels, { name, kind, content: String(input.content ?? "") });
		if (!r.ok) throw new Error(r.error);
		savePanels(file, r.panels);
		syncStoryPanelsFromDisk();
		const saved = r.panels[name];
		return { name: saved.name, kind: saved.kind, updatedAt: saved.updatedAt };
	},
	// 挂载知识库：与扩展 restoreCodexFromBranch 同规则——当前分支上最近的 rp-codex 快照
	mountedCodexes() {
		try {
			const branch = session.sessionManager.getBranch() as Array<{
				type: string;
				customType?: string;
				data?: { mounted?: unknown };
			}>;
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e.type === "custom" && e.customType === "rp-codex") {
					const mounted = e.data?.mounted;
					return Array.isArray(mounted) ? mounted.filter((n): n is string => typeof n === "string") : [];
				}
			}
		} catch {
			// 树读取失败按无挂载处理
		}
		return [];
	},
	// ---- 世界状态编辑（PLAN-PANELS §2.11）：用户主权 applyPatch，落盘即广播，命令桥收编进树 ----
	async applyStatePatch(patch) {
		const file = join(stateDir, `${session.sessionId}.json`);
		const r = applyPatch(loadState(file), patch);
		saveState(file, r.state); // fs.watch 自动广播 state 帧
		syncStoryStateFromDisk();
		return { applied: r.applied, warnings: r.warnings };
	},
	// ---- 世界线视图 / 软删除 / 线名 ----
	worldlineView() {
		const sm = session.sessionManager;
		const sid = session.sessionId;
		const meta = loadWorldlineMeta(metaPath(cwd, sid));
		const entries: TreeEntryLite[] = sm.getEntries().map((e) => ({
			id: e.id,
			parentId: e.parentId,
			type: e.type,
			...("customType" in e && typeof (e as { customType?: string }).customType === "string"
				? { customType: (e as { customType: string }).customType }
				: {}),
			...("data" in e ? { data: (e as { data?: unknown }).data } : {}),
			...(typeof e.timestamp === "string" ? { timestamp: e.timestamp } : {}),
		}));
		const saves = extractSaves(entries, meta);
		const leafId = sm.getLeafId();
		const { branchIdsFromLeaf } = buildAncestryIndex(entries);
		return buildWorldlineView(saves, meta, branchIdsFromLeaf(leafId), leafId);
	},
	deleteWorldlineSave(saveId) {
		const file = metaPath(cwd, session.sessionId);
		const meta = softDeleteSave(loadWorldlineMeta(file), saveId);
		saveWorldlineMeta(file, meta);
		broadcast({ type: "notify", level: "info", text: "已删除存档节点（软删除，会话树原文保留）" });
	},
	renameWorldline(worldlineId, name) {
		const file = metaPath(cwd, session.sessionId);
		const meta = renameWorldlineMeta(loadWorldlineMeta(file), worldlineId, name);
		saveWorldlineMeta(file, meta);
		broadcast({ type: "notify", level: "info", text: `世界线已改名「${name.trim()}」` });
	},
	// ---- 会话管理（PLAN-PANELS §2.1）：面板的重命名/删除/导出/全文搜索 ----
	sessions: () => sessionInfos(),
	async renameSession(path, name) {
		await assertListedSession(path);
		const clean = name.replace(/[\r\n]+/g, " ").trim();
		if (!clean) throw new Error("名字不能为空");
		if (session.sessionFile === path) {
			session.sessionManager.appendSessionInfo(clean);
			return;
		}
		// 离线会话：按 pi session_info 条目格式追加一行（parentId=文件最后一条的 id，等效 leaf）
		const lines = readFileSync(path, "utf8").split(/\r?\n/);
		let parentId: string | null = null;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const e = JSON.parse(line) as { id?: unknown };
				if (typeof e.id === "string") {
					parentId = e.id;
					break;
				}
			} catch {
				// 半行跳过
			}
		}
		const entry = {
			type: "session_info",
			id: randomBytes(4).toString("hex"),
			parentId,
			timestamp: new Date().toISOString(),
			name: clean,
		};
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
	},
	async deleteSession(path) {
		await assertListedSession(path);
		if (session.sessionFile === path) throw new Error("不能删除当前打开的会话（先切到其他会话再删）");
		unlinkSync(path);
		cardCache.delete(path);
		previewCache.delete(path);
	},
	// 删卡「相关数据」用：删除绑定某张卡的全部会话文件（rp-card 标记匹配）。
	// 调用方须保证当前打开的会话已不属于该卡（删当前卡先切走再调本方法）。
	async deleteCardSessions(cardRel) {
		const all = await SessionManager.list(cwd);
		let n = 0;
		for (const s of all) {
			if (isSameSessionPath(s.path, session.sessionFile)) continue;
			const mtime = s.modified instanceof Date ? s.modified.getTime() : Number(s.modified) || 0;
			const info = readSessionCard(s.path, mtime);
			if (!info || !sameCardPath(info.card, cardRel, cwd)) continue;
			try {
				unlinkSync(s.path);
				cardCache.delete(s.path);
				previewCache.delete(s.path);
				n += 1;
			} catch {
				// 单个文件删不掉（占用等）不挡整体
			}
		}
		if (n > 0) broadcast(await listSessions());
		return n;
	},
	async readSessionFile(path) {
		await assertListedSession(path);
		return readFileSync(path, "utf8");
	},
	// 全文搜索（借鉴 ST：搜会话内容而非只搜标题）；只搜 user/assistant 正文，注入素材不算命中
	async searchSessions(q) {
		const needle = q.trim().toLowerCase();
		if (!needle) return [];
		const out: Array<{
			path: string;
			name?: string;
			firstMessage: string;
			modified: number;
			messageCount: number;
			snippet: string;
			current: boolean;
		}> = [];
		for (const s of await sessionInfos()) {
			try {
				if (statSync(s.path).size > 20 * 1024 * 1024) continue; // 异常大文件跳过
				let snippet = "";
				for (const line of readFileSync(s.path, "utf8").split(/\r?\n/)) {
					if (!line.toLowerCase().includes(needle)) continue;
					try {
						const t = entryMsgText(JSON.parse(line));
						if (!t) continue;
						const flat = t.replace(/\s+/g, " ");
						const idx = flat.toLowerCase().indexOf(needle);
						if (idx < 0) continue;
						const start = Math.max(0, idx - 40);
						snippet = `${start > 0 ? "…" : ""}${flat.slice(start, idx + needle.length + 60)}…`;
						break;
					} catch {
						// 非 JSON 行跳过
					}
				}
				if (snippet) {
					out.push({
						path: s.path,
						...(s.name ? { name: s.name } : {}),
						firstMessage: s.firstMessage,
						modified: s.modified,
						messageCount: s.messageCount,
						snippet,
						current: s.current,
					});
				}
				if (out.length >= 20) break;
			} catch {
				// 单个会话读取失败不影响其余
			}
		}
		return out;
	},
	notify: (level, text) => broadcast({ type: "notify", level, text }),
	async ttsSpeak(text, caption) {
		const cfg = loadTtsConfig();
		if (!cfg) throw new Error(ttsConfigHint());
		const { buffer, ext } = await synthesizeSpeech(cfg, text);
		const saved = saveAudioBuffer(cwd, buffer, ext);
		const cap = (caption ?? text).trim().slice(0, 80);
		// 写入会话树为可展示 custom（刷新可回放）；短标记进 LLM 上下文可接受
		session.sessionManager.appendMessage({
			role: "custom",
			customType: "rp-audio",
			content: cap ? `〔配音〕${cap}` : "〔配音〕",
			display: true,
			details: { rpAudio: { src: saved.src, ...(cap ? { caption: cap } : {}) } },
			timestamp: Date.now(),
		} as never);
		const wireMsg = {
			channel: "audio" as const,
			text: cap,
			src: saved.src,
		};
		broadcast({ type: "message", message: wireMsg });
		return { src: saved.src, bytes: saved.bytes };
	},
	updateCheckNow: () => runUpdateCheck(true),
	updateDownload: (mirror) => startUpdateDownload(mirror),
	updateDiscard: () => {
		discardPendingUpdate(cwd);
		updateState = { phase: "none", currentVersion: APP_VERSION };
		pushUpdate();
	},
	updateRestart: () => {
		// 启动脚本循环重拉（LIYUAN_SUPERVISED=1 时 exit 87 = 请求重启）；
		// 直跑 node 的开发场景没有监护，退了就是退了（下次手动启动时应用）。
		console.log("[liyuan] 收到重启应用更新请求，退出进程…");
		setTimeout(() => process.exit(87), 300);
	},
	/** 向量记忆：绑定当前角色卡 + 当前对话会话 */
	memoryScope: () => ({
		sessionId: session.sessionId,
		card: cardPath || undefined,
	}),
	latestNarrativeText: () => {
		const msgs = branchMessages() as Array<{ role?: string; content?: unknown }>;
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i]?.role !== "assistant") continue;
			const text = extractEntryText(msgs[i].content);
			if (text.trim()) return text;
		}
		return "";
	},
	// 预设 AI 分拣等旁路声明：调当前会话模型做一次性判断（复用 streamSimple，同 StageEngine.#sideText）
	runSideText: async (step, systemPrompt, userText, opts) => {
		const config = loadStageMaterials(cwd).config;
		const availableModels = currentlyConfiguredModels();
		const resolved = resolveStepModel(
			step,
			config.stepModels,
			session.model as unknown as StageModelLike | undefined,
			(provider, id) => availableModels.find((item) => item.provider === provider && item.id === id) as unknown as StageModelLike | undefined,
			undefined,
			// 研究旁路共用模型家族：全文消化和导演检索都可回退到 outlineResearch。
			step === "novelDigest" || step === "outlineCorpusResearch" ? ["outlineResearch"] : undefined,
		);
		const model = resolved.model;
		if (!model) return { error: "无可用模型" };
		if (resolved.fallback && resolved.requested) {
			console.error(`[side-model] ${step} 的 ${resolved.requested.provider}/${resolved.requested.id} 不可用，回退剧情总插头`);
		}
		let auth: { apiKey?: string; headers?: Record<string, string> } = {};
		try {
			auth = (await session.modelRegistry.getApiKeyAndHeaders(model as never)) as typeof auth;
			// 该 OpenAI 兼容中转会拦截 SDK 默认的 OpenAI/JS User-Agent。
			if ((model as unknown as { baseUrl?: string }).baseUrl?.includes("fuzhan.magicv4.ltd")) auth.headers = { ...(auth.headers ?? {}), "user-agent": "undici" };
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
			const streamFn = streamSimple as unknown as StageStreamFn;
			try {
				const selectedModel = opts?.forceNonStreaming
					? { ...(model as unknown as Record<string, unknown>), headers: { ...(((model as unknown as { headers?: Record<string, string> }).headers) ?? {}), "user-agent": "undici" }, compat: { ...(((model as unknown as { compat?: Record<string, unknown> }).compat) ?? {}), streaming: false } } as unknown as StageModelLike
					: model as unknown as StageModelLike;
				const s = streamFn(
					selectedModel,
				{ systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] },
				{
					apiKey: auth.apiKey, headers: auth.headers, maxTokens: opts?.maxTokens ?? 4096,
					reasoning: opts?.reasoning ?? "off", signal: opts?.signal,
					// CorpusEngine 已负责有限重试；避免 SDK 再隐式重试 9 次。
					maxRetries: opts?.forceNonStreaming ? 0 : 9,
					timeoutMs: opts?.forceNonStreaming ? 180_000 : undefined,
				},
			);
			let final: AssistantMsgLike | null = null;
			if (opts?.forceNonStreaming) {
				// 非流式响应直接走 result()，避免事件迭代器等待/丢失 done 消息。
				final = await (s as unknown as { result: () => Promise<AssistantMsgLike> }).result.call(s);
			} else {
				for await (const e of s) {
					if (e.type === "done") final = e.message ?? null;
					else if (e.type === "error") {
						const msg = e.error?.errorMessage || `stopReason=${e.error?.stopReason ?? "?"}`;
						opts?.onDelta?.({ kind: "error", text: msg });
						return { error: msg };
					}
					else if (e.type === "delta" && e.kind === "text" && e.delta) opts?.onDelta?.({ kind: "text", delta: e.delta });
				}
			}
			// 非流式分支已经直接取得 result；流式分支使用 done 事件。
			if (!final) return { error: "流未产出最终消息" };
			const readAssistantText = (message: AssistantMsgLike | null): string => {
				if (!message) return "";
				const raw = message as unknown as Record<string, unknown>;
				if (typeof raw.text === "string") return raw.text.trim();
				if (typeof raw.content === "string") return raw.content.trim();
				if (!Array.isArray(raw.content)) return "";
				return raw.content.map((part: unknown) => {
					if (typeof part === "string") return part;
					if (!part || typeof part !== "object") return "";
					const item = part as Record<string, unknown>;
					if (typeof item.text === "string") return item.text;
					if (typeof item.content === "string") return item.content;
					if (typeof item.value === "string") return item.value;
					return "";
				}).join("").trim();
			};
			const text = readAssistantText(final);
			if (text.length <= 1 && (text === "{" || text === "<")) {
				// 部分兼容中转的 SSE 会在结构化旁路首字符后断流；与 StageEngine.#sideText
				// 同语义做一次非流式降级，避免画像/预设声明只落一个“{”。
				const callModel = { ...(model as unknown as Record<string, unknown>), compat: { ...(((model as unknown as { compat?: Record<string, unknown> }).compat) ?? {}), streaming: false } } as unknown as StageModelLike;
				const retry = streamFn(callModel, { systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }] }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: opts?.maxTokens ?? 4096, reasoning: opts?.reasoning ?? "off", signal: opts?.signal, maxRetries: 9 });
				let retryFinal: AssistantMsgLike | null = null;
				for await (const event of retry) {
					if (event.type === "done") retryFinal = event.message ?? null;
					else if (event.type === "error") return { error: event.error?.errorMessage || `stopReason=${event.error?.stopReason ?? "?"}` };
				}
				const retryText = readAssistantText(retryFinal);
				return retryText || { error: "非流式降级仍无文本" };
			}
			return text || { error: "最终消息无文本" };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	},
	appendWorldManifest(data) {
		session.sessionManager.appendCustomEntry("rp-world-manifest", data);
		session.sessionManager.flush();
		resyncAll();
	},
	worldProfileContext: () => {
		const branch = session.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: { card?: unknown } }>;
		const bound = [...branch].reverse().find((entry) => entry.type === "custom" && entry.customType === "rp-card" && typeof entry.data?.card === "string");
		return { leafId: session.sessionManager.getLeafId(), card: typeof bound?.data?.card === "string" ? bound.data.card : cardPath };
	},
	worldStateView() {
		const branch = session.sessionManager.getBranch() as BranchEntryLike[];
		const manifest = worldManifestFromBranch(branch);
		const modular = modularWorldFromBranch(branch, manifest);
		return { state: modular, view: modularWorldWireView(modular, manifest), legacy: projectLiteraryWorldV1(modular), audit: worldAuditFromBranch(branch), manifest };
	},
	turnDiagnostics(limit) {
		return diagnosticsFromBranch(session.sessionManager.getBranch() as BranchEntryLike[], limit, Object.fromEntries(turnRuntimeDiagnostics));
	},
	clearWorldModule(moduleId) {
		const branch = session.sessionManager.getBranch() as BranchEntryLike[];
		const manifest = worldManifestFromBranch(branch);
		const modular = modularWorldFromBranch(branch, manifest);
		if (!modular.modules[moduleId]) throw new Error(`世界模块不存在：${moduleId}`);
		const modules = { ...modular.modules };
		delete modules[moduleId];
		session.sessionManager.appendCustomEntry("rp-world-state", { ...modular, round: modular.round + 1, digest: `已清空模块 ${moduleId}；其他世界状态保持不变。`, modules, kernel: { ...modular.kernel, links: modular.kernel.links.filter((link) => link.from.moduleId !== moduleId && link.to.moduleId !== moduleId) } });
		session.sessionManager.flush();
		resyncAll();
	},
	outline: {
		getView: () => outline!.getView(),
		history: () => outline!.history(),
		chat: (message, options) => outline!.chat(message, options),
		bootstrap: (wish) => outline!.bootstrap(wish),
		reconcile: (leafId) => outline!.reconcile(leafId),
		confirm: (id, hash) => outline!.confirm(id, hash),
		reject: (id, reason) => outline!.reject(id, reason),
		researchView: () => outline!.researchView(),
		research: (topic) => outline!.research(topic),
		researchSearch: (topic) => outline!.researchSearch(topic),
		researchSearchLogs: () => outline!.researchSearchLogs(),
		researchRetrySearchExtraction: (logId) => outline!.researchRetrySearchExtraction(logId),
		researchSearchScheduleStatus: () => researchSearchScheduler?.status() ?? { enabled: false, running: false },
		researchSearchScheduleRunNow: () => researchSearchScheduler!.runNow(),
		settings: (value) => outline!.settings(value),
		clearChats: () => outline!.clearChats(),
	},
	corpus: {
		create: (file) => corpus!.create(file),
		createVersion: (baseDocId, file) => corpus!.createVersion(baseDocId, file),
		createUrl: (url) => corpus!.createUrl(url),
		discover: () => corpusScheduler!.runNow(new Date(), 3),
		view: () => corpus!.view(),
		detail: (id) => corpus!.getDetail(id),
		pause: (id) => (corpus!.pause(id), corpus!.view()),
		resume: (id) => (corpus!.resume(id), corpus!.view()),
		remove: async (id) => ({ removedMechanisms: await corpus!.remove(id) }),
	},
		novelPlayUpgradePreview(targetDocId, targetRevision) {
		const branch = session.sessionManager.getBranch() as BranchEntryLike[];
		const raw = loadStageMaterials(cwd).rawCard;
		const from = effectiveNovelPlayBinding(cwd, raw, branch);
		if (!from) throw new Error("当前会话不是小说开演");
		const target = loadNovelPackage(cwd, targetDocId, targetRevision);
		if (!target.package.lineage || target.package.lineage.parentRevision !== from.revision) throw new Error("目标作品包不是当前作品包的安全追加版本");
		const currentPackage = loadNovelPackage(cwd, from.docId, from.revision).package;
		const state = from.anchorKind === "source-end" ? undefined : novelPlayStateFromBranch(branch, from, currentPackage);
		const anchor = state?.progress ?? (from.anchorKind === "source-end" ? undefined : { packageRevision: from.revision, nodeId: from.startNodeId!, position: from.position! });
		const firstNew = target.package.nodes.filter(node => target.package.lineage!.newNodeIds.includes(node.id) && node.visibility === "public").sort((a, b) => a.order - b.order)[0];
		if (!firstNew) throw new Error("追加版本没有可公开采用的新原著节点");
		if (anchor && !target.package.lineage.inheritedNodeIds.includes(anchor.nodeId)) throw new Error("当前进度不在追加作品包的继承节点中");
		const to = from.anchorKind === "source-end" ? { docId: targetDocId, revision: targetRevision, anchorKind: "node" as const, startNodeId: firstNew.id, position: "before" as const } : { ...from, docId: targetDocId, revision: targetRevision };
		return { from, to, progress: anchor, newNodes: target.package.lineage.newNodeIds.length, leafId: session.sessionManager.getLeafId() };
	},
	novelPlayUpgradeCommit(targetDocId, targetRevision, expectedLeafId, expectedFromRevision) {
		const branch = session.sessionManager.getBranch() as BranchEntryLike[];
		if (expectedLeafId && session.sessionManager.getLeafId() !== expectedLeafId) throw new Error("当前分支已变化，请重新预览升级");
		const raw = loadStageMaterials(cwd).rawCard;
		const from = effectiveNovelPlayBinding(cwd, raw, branch);
		if (!from) throw new Error("当前会话不是小说开演");
		if (expectedFromRevision && from.revision !== expectedFromRevision) throw new Error("当前作品包已变化，请重新预览升级");
		const target = loadNovelPackage(cwd, targetDocId, targetRevision);
		const current = loadNovelPackage(cwd, from.docId, from.revision);
		if (!target.package.lineage || target.package.lineage.parentRevision !== from.revision) throw new Error("目标作品包不是当前作品包的安全追加版本");
		const state = from.anchorKind === "source-end" ? undefined : novelPlayStateFromBranch(branch, from, current.package);
		const anchor = state?.progress ?? (from.anchorKind === "source-end" ? undefined : { packageRevision: from.revision, nodeId: from.startNodeId!, position: from.position! });
		const firstNew = target.package.nodes.filter(node => target.package.lineage!.newNodeIds.includes(node.id) && node.visibility === "public").sort((a, b) => a.order - b.order)[0];
		if (!firstNew) throw new Error("追加版本没有可公开采用的新原著节点");
		if (anchor && !target.package.lineage.inheritedNodeIds.includes(anchor.nodeId)) throw new Error("当前进度不在追加作品包的继承节点中");
		const to = from.anchorKind === "source-end" ? { docId: targetDocId, revision: targetRevision, anchorKind: "node" as const, startNodeId: firstNew.id, position: "before" as const } : { ...from, docId: targetDocId, revision: targetRevision };
		const entry: NovelPlayUpgradeEntry = { version: 1, from, to, sourceLeafId: session.sessionManager.getLeafId() ?? "", confirmedAt: new Date().toISOString() };
		session.sessionManager.appendCustomEntry(NOVEL_PLAY_UPGRADE_ENTRY_TYPE, entry);
		session.sessionManager.flush();
		resyncAll();
		return { ok: true, entry };
	},
};

outline = new OutlineEngine({
	cwd,
	getSessionManager: () => session.sessionManager as never,
	loadMaterials: () => loadStageMaterials(cwd),
	runSideModel: (step, systemPrompt, userText, options) => restHost.runSideText(step, systemPrompt, userText, options),
	webResearch: async (queries, maxResults, signal) => {
		const { card, config } = loadStageMaterials(cwd);
		return webResearchBatch(queries, maxResults, { card, userName: config.userName, signal });
	},
	getContext: () => {
		const materials = loadStageMaterials(cwd);
		const branch = session.sessionManager.getBranch() as BranchEntryLike[];
		const manifest = worldManifestFromBranch(branch);
		const narrativeHistory = branch.slice(-80).flatMap((entry) => {
			const role = entry.message?.role;
			if (role !== "user" && role !== "assistant") return [];
			const content = entry.message?.content;
			const text = typeof content === "string" ? content : Array.isArray(content)
				? content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "text" ? [String((part as { text?: string }).text ?? "")] : []).join("\n")
				: "";
			return text.trim() ? [{ id: entry.id, role, text: text.slice(0, 6000) }] : [];
		}).slice(-24);
		return {
			cardKey: materials.config.card,
			card: materials.card,
			history: narrativeHistory,
			rpState: stateFromBranch(branch),
			world: modularWorldFromBranch(branch, manifest),
			ecology: ecologyWireView(literaryEcologyFromBranch(branch)),
			literaryProfiles: literaryProfileFromBranch(branch),
			directorArtifacts: branch.slice(-20).flatMap((entry) => {
				const details = entry.message?.details;
				return details && typeof details === "object" && (details as Record<string, unknown>).rpPrep ? [(details as Record<string, unknown>).rpPrep] : [];
			}),
		};
	},
	onState: () => resyncAll(),
});

const researchSchedule = loadStageMaterials(cwd).config.researchSearchSchedule
	?? { enabled: false, hour: 6, minute: 0, maxPerRun: 3, topics: ["校园恋爱中的慢热互信", "日常剧情中的关系推进", "悬疑故事的信息分配"] };
researchSearchScheduler = new ResearchSearchScheduler(cwd, researchSchedule, (topic) => outline!.researchSearch(topic));
researchSearchScheduler.start();
if (researchSchedule.enabled) console.log(`[research-search-scheduler] 已启用：每天 ${String(researchSchedule.hour).padStart(2, "0")}:${String(researchSchedule.minute).padStart(2, "0")}，最多 ${researchSchedule.maxPerRun} 个主题`);

corpus = new CorpusEngine({
	cwd,
	runSideModel: (step, systemPrompt, userText, options) => restHost.runSideText(step, systemPrompt, userText, options),
	loadSkill: () => workflowSkill(loadStageMaterials(cwd).skillFiles, "novel-digest")?.body,
	cardKey: () => loadStageMaterials(cwd).config.card,
	onReady: (document, digest, extracted) => outline!.digestReady(document, digest, extracted).then(() => undefined),
	onRemoved: (docId) => outline!.removeCorpus(docId),
	fetchText: requestText,
}, loadStageMaterials(cwd).config.novelDigest?.maxCallsPerDoc ?? 800);
// 服务重启后：恢复未完成的消化任务（断点续跑）
corpus.restore();
const autoSchedule = loadStageMaterials(cwd).config.novelDigest?.autoSchedule
	?? { enabled: false, hour: 5, minute: 0, maxPerRun: 3, queries: ["学園 日常", "現代 日常 社会人", "青春 日常"] };
corpusScheduler = new CorpusScheduler({
	engine: corpus,
	fetchText: requestText,
	schedule: autoSchedule,
	log: (message) => console.log(message),
});
if (autoSchedule.enabled) {
	corpusScheduler.start();
	console.log(`[corpus-scheduler] 已启用：每天 ${String(autoSchedule.hour).padStart(2, "0")}:${String(autoSchedule.minute).padStart(2, "0")}，最多 ${autoSchedule.maxPerRun} 部`);
}

// 启动时：liyuan.agent.json → models.json，重绑模型 + 应用思考档（配置 → 当前生效）
try {
	const loaded = loadAgentConfig(cwd);
	if (loaded.exists && Object.keys(loaded.config.providers).length > 0) {
		const cfg = normalizeAgentConfig(loaded.config);
		syncAgentConfigToRuntime(cwd, getAgentDir(), cfg);
		session.modelRegistry.refresh();
		const cur = session.model;
		if (cur) {
			const next = session.modelRegistry.find(cur.provider, cur.id);
			if (next) await session.setModel(next);
			const p = cfg.providers[cur.provider];
			const entry = Array.isArray(p?.models) ? p.models.find((m) => String(m.id) === cur.id) : undefined;
			const per =
				typeof entry?.thinkingLevel === "string" && entry.thinkingLevel.trim()
					? entry.thinkingLevel.trim()
					: "";
			const def =
				typeof cfg.defaultThinkingLevel === "string" && cfg.defaultThinkingLevel.trim()
					? cfg.defaultThinkingLevel.trim()
					: "";
			const think = per || def;
			if (think) {
				try {
					session.setThinkingLevel(think as never);
				} catch {
					/* 档位名不支持时忽略 */
				}
			}
		}
		console.log("[liyuan] 已从 liyuan.agent.json 同步 models.json 与思考档");
	}
} catch (err) {
	console.error(`[liyuan] 启动同步 agent 配置失败：${err instanceof Error ? err.message : String(err)}`);
}

// ---------- 助手会话（右栏）：同进程第二 pi 会话（server/assistant.ts 托管） ----------
//
// 剧情会话与助手会话彻底分治：独立会话树（.liyuan-assistant/）、独立扩展集、独立模型。
// 这里只做三件事：提供剧情桥（只读面 + 白名单写）、把助手事件翻成 assistant_* 帧、
// 托管生命周期。启动失败不挡剧情（面板显示不可用）。

const storyBridge: StoryBridge = {
	storyMessages: () => session.messages as unknown[],
	snapshot: () => ({
		sessionId: session.sessionId,
		cardName: names.charName,
		userName: names.userName,
		model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
		thinkingLevel: typeof session.thinkingLevel === "string" ? session.thinkingLevel : undefined,
		contextPercent: safeStats()?.contextPercent ?? null,
		messageCount: session.messages.length,
		streaming: session.isStreaming,
	}),
	queueStoryCommand: (text) => restHost.queueCommand(text),
	worldState: () => currentState(),
	applyStatePatch: (patch) => restHost.applyStatePatch(patch),
	softRefreshConfig: () => restHost.softRefreshConfig(),
	listModels: () => {
		const r = restHost.listModels();
		return {
			current: r.current ? { provider: r.current.provider, id: r.current.id, name: r.current.name } : null,
			models: r.models.map((m) => ({
				provider: m.provider,
				providerName: m.providerName,
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
			})),
		};
	},
	cardName: () => names.charName,
	// 向量记忆作用域（M-D3 助手侧工具用）：与 restHost.memoryScope / 台上注入同一口径——
	// 当前剧情会话 + 当前卡**路径**（scopeId 按路径 hash，只给卡名会落到另一个空作用域）。
	memoryScope: () => ({ sessionId: session.sessionId, card: cardPath || undefined }),
	memoryVisibleEntryIds: () => new Set(
		session.sessionManager.getBranch().map((entry) => entry.id).filter((id): id is string => typeof id === "string"),
	),
	// 世界线视图（M-D5 助手侧 worldline_list 工具用）：从剧情会话树拉存档点
	worldlineView: () => restHost.worldlineView(),
	// 面板（M-D5 助手侧 panel_* 工具用）：当前剧情会话的面板读写
	storyPanels: () => ({
		load() {
			const p = loadPanels(join(artifactsDir, `${session.sessionId}.json`));
			const out: Record<string, { name: string; kind: "markdown" | "svg" | "html"; content: string; archived?: boolean }> = {};
			for (const [k, v] of Object.entries(p)) out[k] = { name: v.name, kind: v.kind, content: v.content, archived: v.archived };
			return out;
		},
		write(input) {
			const file = join(artifactsDir, `${session.sessionId}.json`);
			const panels = loadPanels(file);
			const r = writePanel(panels, input);
			if (r.ok) { savePanels(file, r.panels); syncStoryPanelsFromDisk(); }
			return r;
		},
		close(name) {
			const file = join(artifactsDir, `${session.sessionId}.json`);
			const panels = loadPanels(file);
			const r = closePanelInMap(panels, name);
			if (r.ok) { savePanels(file, r.panels); syncStoryPanelsFromDisk(); }
			return r;
		},
	}),
	writePanels: (list) => restHost.importPanels(list),
	deliverMedia: (absPath) => {
		try {
			if (!existsSync(absPath)) return { ok: false as const, error: `文件不存在：${absPath}` };
			const ext = extname(absPath).toLowerCase();
			const imageExt = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"];
			const audioExt = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"];
			const videoExt = [".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv"];
			const kind = imageExt.includes(ext) ? "image" : audioExt.includes(ext) ? "audio" : videoExt.includes(ext) ? "video" : null;
			if (!kind) return { ok: false as const, error: `不支持的媒体格式：${ext || "（无扩展名）"}` };
			const mediaDir = dir(cwd, "media");
			mkdirSync(mediaDir, { recursive: true });
			const name = `${createHash("md5").update(readFileSync(absPath)).digest("hex").slice(0, 16)}${ext}`;
			writeFileSync(join(mediaDir, name), readFileSync(absPath));
			return { ok: true as const, src: `/media/${name}`, kind };
		} catch (err) {
			return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
		}
	},
	/** 委托模式：媒体同步进中间剧情流（与 show_image 同源 wire 通道） */
	emitStoryMedia: (media) => {
		const channel = media.kind === "audio" ? "audio" : media.kind === "video" ? "video" : "image";
		broadcast({
			type: "message",
			message: {
				channel,
				text: media.caption ?? "",
				src: media.src,
			},
		});
	},
	refreshStoryMaterials: () => restHost.softRefreshConfig(),
	mountCodex: (name, on) => {
		restHost.queueCommand(`/codexmount ${on ? "mount" : "unmount"} ${name}`);
	},
};

let assistantHost: AssistantHost | null = null;

// 不在 wire 暴露宿主绝对路径；助手投递目标随实际助手会话切换。
const assistantDeliveryTarget = (): string | undefined => {
	const path = assistantHost?.sessionPath();
	return path ? `assistant:${createHash("sha256").update(path).digest("hex")}` : undefined;
};
const assistantHelloFrame = (): ServerFrame => ({
	type: "assistant_hello",
	appVersion: APP_VERSION,
	sessionId: assistantDeliveryTarget(),
	deliveryProtocol: 1,
	messages: assistantHost ? toAssistantHistory(assistantHost.messages()) : [],
	busy: assistantHost?.isStreaming() ?? false,
	model: assistantHost?.modelInfo() ?? null,
	follow: assistantHost?.follows() ?? true,
	...(assistantHost?.sessionPath() ? { sessionPath: assistantHost.sessionPath() } : {}),
});

/** 助手会话事件 → assistant_* wire 帧（与剧情订阅同构，无 swipe/面板等剧情专属面） */
const onAssistantEvent = (event: unknown) => {
	const ev = event as {
		type?: string;
		willRetry?: boolean;
		assistantMessageEvent?: { type?: string; delta?: string };
		message?: { role?: string };
		toolName?: string;
		args?: unknown;
		result?: unknown;
		isError?: boolean;
		attempt?: number;
		maxAttempts?: number;
	};
	switch (ev.type) {
		case "agent_start":
			broadcast({ type: "assistant_state", state: "start" });
			break;
		case "agent_end":
			if (!ev.willRetry) broadcast({ type: "assistant_state", state: "end" });
			break;
		case "message_update": {
			const e = ev.assistantMessageEvent;
			if (e?.type === "text_delta") broadcast({ type: "assistant_delta", kind: "text", delta: e.delta ?? "" });
			else if (e?.type === "thinking_delta")
				broadcast({ type: "assistant_delta", kind: "thinking", delta: e.delta ?? "" });
			break;
		}
		case "message_end": {
			// user 消息在受理时已回显；这里翻助手侧消息 + show_media 的媒体交付
			if (ev.message?.role === "assistant") {
				const list = toAssistantHistory([ev.message]);
				if (list.length) broadcast({ type: "assistant_message", message: list[0] });
			} else if (ev.message?.role === "toolResult") {
				const media = assistantMediaOfToolResult(ev.message as never);
				if (media) broadcast({ type: "assistant_message", message: media });
			}
			break;
		}
		case "tool_execution_start": {
			const detail = toolStartDetail(ev.toolName ?? "", ev.args);
			broadcast({ type: "assistant_activity", activity: { kind: "tool_start", name: ev.toolName ?? "", detail } });
			break;
		}
		case "tool_execution_end":
			broadcast({
				type: "assistant_activity",
				activity: {
					kind: "tool_end",
					name: ev.toolName ?? "",
					detail: summarizeToolResult(ev.result),
					isError: ev.isError === true,
				},
			});
			break;
		case "auto_retry_start":
			broadcast({
				type: "notify",
				level: "warning",
				text: `助手模型请求失败，自动重试 ${ev.attempt}/${ev.maxAttempts}…`,
			});
			break;
		default:
			break;
	}
};

/** 用户对助手发话（面板输入框 / 主输入框场外标记改道共用） */
const promptAssistant = async (text: string) => {
	if (!assistantHost) {
		broadcast({ type: "notify", level: "warning", text: "助手不可用（启动失败或没有可用模型），剧情不受影响" });
		return;
	}
	broadcast({ type: "assistant_message", message: { role: "user", text } });
	await assistantHost.prompt(text);
};

try {
	assistantHost = await createAssistantHost({
		cwd,
		bridge: storyBridge,
		uiContext,
		onEvent: onAssistantEvent,
		onError: (text) => broadcast({ type: "error", text }),
	});
	// 剧情侧 assistant_run → 本 Host（过程进右栏，结果可双写剧情流）
	registerAssistantRunner(async (req) => {
		if (!assistantHost) {
			return {
				ok: false,
				summary: "助手不可用。",
				media: [],
				panelsWritten: [],
				error: "no_host",
			};
		}
		const task = req.task.trim();
		if (!task) {
			return { ok: false, summary: "任务为空。", media: [], panelsWritten: [], error: "empty" };
		}
		const modeHint =
			req.mode && req.mode !== "auto"
				? `【任务类型：${req.mode === "ops" ? "系统/API/办事" : req.mode === "author" ? "作者维护（面板/设定/账本）" : "诊断调优"}】\n`
				: "";
		const body = `${modeHint}${task}`;
		// 右栏可见：用户委托条
		broadcast({ type: "assistant_message", message: { role: "user", text: `〔剧情委托〕${task}` } });
		try {
			if (req.signal?.aborted) {
				return {
					ok: false,
					summary: "已取消。",
					media: [],
					panelsWritten: [],
					abandoned: true,
					error: "aborted",
				};
			}
			const onAbort = () => {
				void assistantHost?.abort();
			};
			req.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				// 等到 return_answer / 放弃 / 兜底交回（非仅等 agent_end 摘最后一句）
				const ret = await assistantHost.runTask(body);
				return {
					ok: ret.ok !== false && !ret.abandoned,
					summary: ret.summary,
					media: [],
					panelsWritten: [],
					abandoned: ret.abandoned,
					viaReturnTool: ret.viaReturnTool,
					...(ret.ok === false || ret.abandoned ? { error: ret.abandoned ? "abandoned" : "failed" } : {}),
				};
			} finally {
				req.signal?.removeEventListener("abort", onAbort);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				summary: `助手执行失败：${msg}`,
				media: [],
				panelsWritten: [],
				error: msg,
			};
		}
	});
	console.log(`[liyuan] 助手会话已就位（${assistantHost.modelInfo() ? `${assistantHost.modelInfo()!.provider}/${assistantHost.modelInfo()!.id}` : "暂无模型"}${assistantHost.follows() ? "，跟随剧情模型" : ""}）`);
} catch (err) {
	registerAssistantRunner(null);
	console.error(`[liyuan] 助手会话启动失败（面板不可用，剧情不受影响）：${err instanceof Error ? err.message : String(err)}`);
}

// ---------- HTTP：REST /api/* + 托管 web/dist（存在时）+ 健康检查 ----------

const distDir = join(cwd, "web", "dist");
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".manifest": "application/manifest+json",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".webm": "video/webm",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".ogv": "video/ogg",
	".woff2": "font/woff2",
	".map": "application/json",
};

// ---------- 访问密码闸门（src/access.ts；设置面板「访问密码」区管理） ----------

let accessData: AccessData | null = loadAccess(cwd);
let accessFails = 0; // 连续失败计数：≥5 次后每次登录尝试强制延迟

function requestAuthed(req: IncomingMessage): boolean {
	if (!accessData) return true;
	return verifyToken(accessData, parseCookies(req.headers.cookie)[ACCESS_COOKIE]);
}

/** 需过闸的路径：业务 API 与用户数据托管；静态前端壳放行（登录页就在壳里） */
function accessGuarded(url: string): boolean {
	if (url.startsWith("/api/")) return !url.startsWith("/api/access/");
	return url.startsWith("/media/") || url.startsWith("/audio/") || url.startsWith("/uploads/");
}

function setAccessCookie(res: ServerResponse, token: string | null): void {
	const base = `${ACCESS_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Strict`;
	res.setHeader("set-cookie", token ? `${base}; Max-Age=31536000` : `${base}; Max-Age=0`);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > 65536) {
				reject(new Error("body 过大"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {});
			} catch (e) {
				reject(e as Error);
			}
		});
		req.on("error", reject);
	});
}

async function handleAccessApi(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
	const json = (code: number, body: unknown, token?: string | null) => {
		if (token !== undefined) setAccessCookie(res, token);
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	try {
		if (req.method === "GET" && url === "/api/access/status") {
			json(200, { required: !!accessData, ok: requestAuthed(req) });
			return;
		}
		if (req.method === "POST" && url === "/api/access/login") {
			if (!accessData) {
				json(400, { error: "未设置访问密码" });
				return;
			}
			if (accessFails >= 5) await new Promise((r) => setTimeout(r, 1500)); // 暴力尝试限速
			const body = await readJsonBody(req);
			if (typeof body.password === "string" && verifyPassword(accessData, body.password)) {
				accessFails = 0;
				json(200, { ok: true }, issueToken(cwd, accessData));
			} else {
				accessFails++;
				json(401, { error: "密码不正确" });
			}
			return;
		}
		if (req.method === "POST" && url === "/api/access/set") {
			const body = await readJsonBody(req);
			// 已有密码时，任何变更（改/关）都必须先验旧密码
			if (accessData && (typeof body.oldPassword !== "string" || !verifyPassword(accessData, body.oldPassword))) {
				json(403, { error: "当前密码不正确" });
				return;
			}
			const next = typeof body.newPassword === "string" ? body.newPassword : "";
			if (!next) {
				clearPassword(cwd);
				accessData = null;
				json(200, { required: false }, null);
				return;
			}
			if (next.length < 4) {
				json(400, { error: "密码至少 4 位" });
				return;
			}
			const r = setPassword(cwd, next);
			accessData = r.data;
			accessFails = 0;
			json(200, { required: true }, r.token); // 旧 token 全部失效；当前设备用新 token 续座
			clients.revokeInvalid();
			return;
		}
		if (req.method === "POST" && url === "/api/access/logout") {
			if (accessData) revokeToken(cwd, accessData, parseCookies(req.headers.cookie)[ACCESS_COOKIE]);
			clients.revokeInvalid();
			json(200, { ok: true }, null);
			return;
		}
		json(404, { error: "unknown access endpoint" });
	} catch (e) {
		json(400, { error: (e as Error).message });
	}
}

const httpServer = createServer((req, res) => {
	void (async () => {
		const urlPath = (req.url ?? "/").split("?")[0];
		if (urlPath.startsWith("/api/access/")) {
			await handleAccessApi(req, res, urlPath);
			return;
		}
		if (accessGuarded(urlPath) && !requestAuthed(req)) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "需要登录" }));
			return;
		}
		if (await handleApiRequest(req, res, restHost)) return;
		const url = (req.url ?? "/").split("?")[0];
		if (url === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, version: APP_VERSION, sessionId: session.sessionId, char: names.charName }));
			return;
		}
		// 图片通道媒体托管（show_image → .liyuan-media/）
		if (url.startsWith("/media/")) {
			const mediaDir = dir(cwd, "media");
			const rel = normalize(url.slice("/media/".length)).replace(/^([/\\.])+/, "");
			const file = join(mediaDir, rel);
			if (file.startsWith(mediaDir) && existsSync(file)) {
				res.writeHead(200, {
					"content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
					"cache-control": "public, max-age=31536000, immutable", // 内容寻址文件名，可永久缓存
				});
				res.end(readFileSync(file));
			} else {
				res.writeHead(404);
				res.end();
			}
			return;
		}
		// 音频通道（show_audio / tts → .liyuan-audio/）
		if (url.startsWith("/audio/")) {
			const audioDir = dir(cwd, "audio");
			const rel = normalize(url.slice("/audio/".length)).replace(/^([/\\.])+/, "");
			const file = join(audioDir, rel);
			if (file.startsWith(audioDir) && existsSync(file)) {
				res.writeHead(200, {
					"content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
					"cache-control": "public, max-age=31536000, immutable",
				});
				res.end(readFileSync(file));
			} else {
				res.writeHead(404);
				res.end();
			}
			return;
		}
		// 上传区托管（.liyuan-uploads/）
		if (url.startsWith("/uploads/")) {
			const upDir = dir(cwd, "uploads");
			let rel = "";
			try {
				rel = normalize(decodeURIComponent(url.slice("/uploads/".length))).replace(/^([/\\.])+/, "");
			} catch {
				// 畸形百分号编码：按 404 处理
			}
			const file = rel ? join(upDir, rel) : "";
			if (file.startsWith(upDir) && existsSync(file)) {
				res.writeHead(200, {
					"content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
					"cache-control": "public, max-age=86400",
					"content-security-policy": "default-src 'none'",
					"x-content-type-options": "nosniff",
				});
				res.end(readFileSync(file));
			} else {
				res.writeHead(404);
				res.end();
			}
			return;
		}
		if (!existsSync(distDir)) {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end("梨园 server 运行中。前端尚未构建：开发用 `npm --prefix web run dev`，或 `npm --prefix web run build` 后刷新本页。WS 端点：/ws");
			return;
		}
		// 静态文件（含 SPA 回退），normalize 防目录穿越
		const rel = normalize(url === "/" ? "/index.html" : url).replace(/^([/\\])+/, "");
		let file = join(distDir, rel);
		if (!file.startsWith(distDir) || !existsSync(file)) file = join(distDir, "index.html");
		try {
			const body = readFileSync(file);
			const ext = extname(file).toLowerCase();
			const headers: Record<string, string> = {
				"content-type": MIME[ext] ?? "application/octet-stream",
			};
			// 品牌图 / 壳资源：可缓存（SW 会再管一层）
			if (
				ext === ".png" ||
				ext === ".webmanifest" ||
				ext === ".js" ||
				ext === ".css" ||
				ext === ".woff2" ||
				file.endsWith(`${"sw.js"}`) ||
				file.endsWith("site.webmanifest")
			) {
				const name = file.replace(/\\/g, "/");
				if (name.includes("/assets/")) {
					headers["cache-control"] = "public, max-age=31536000, immutable";
				} else if (name.endsWith("/sw.js")) {
					headers["cache-control"] = "no-cache";
				} else {
					headers["cache-control"] = "public, max-age=86400";
				}
			}
			// HTML 必须每次向服务器验证：无此头时手机浏览器启发式缓存旧壳，
			// 旧壳引用已删除的 hashed 资源 → 更新「刷新也不生效」甚至白屏
			if (ext === ".html") {
				headers["cache-control"] = "no-cache";
			}
			res.writeHead(200, headers);
			res.end(body);
		} catch {
			res.writeHead(404);
			res.end();
		}
	})().catch((err) => {
		if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
	});
});

// ---------- WS 端点 ----------

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// 同一 WS 客户端请求会话列表的最短间隔。旧缓存前端曾形成 sessions 请求闭环；
// 即使浏览器尚未刷新到修复版，也不能让它反复扫描会话文件、解析 7MB PNG 卡吃满单核。
const sessionsRequestAt = new WeakMap<WebSocket, number>();

// ---------- 台上引擎（PLAN-RP-HARNESS R1：叙事回合走自建循环，pi 只留幕后） ----------

const stage = new StageEngine({
	cwd,
	getSessionManager: () => session.sessionManager as never,
	getModel: () => session.model as never,
	findModel: (provider, id) => currentlyConfiguredModels().find((item) => item.provider === provider && item.id === id) as never,
	findModelById: (id) => {
		const available = currentlyConfiguredModels().filter((item) => item.id === id);
		// 同 id 多渠道时优先当前剧情渠道；否则只有唯一候选才可自动迁移。
		const currentProvider = session.model?.provider;
		return (available.find((item) => item.provider === currentProvider) ?? (available.length === 1 ? available[0] : undefined)) as never;
	},
	getAuth: async (m) => {
		// 部分中转/网关会拦截 openai SDK 的默认 User-Agent（返回 403「request was blocked」），
		// 导致旁路模型（生态/导演等）静默失败。默认补一个普通浏览器 UA，已显式配置的 UA 优先。
		const a = await session.modelRegistry.getApiKeyAndHeaders(m as never);
		if (a.ok === false) throw new Error(a.error ?? "当前模型鉴权配置不可用");
		const headers = { ...(a.headers ?? {}) };
		if (!headers["user-agent"] && !headers["User-Agent"]) headers["user-agent"] = "Mozilla/5.0";
		return { apiKey: a.apiKey, headers };
	},
	getThinking: () => session.thinkingLevel,
	// 场记落盘 → fs.watch 自动广播 state 帧（与扩展/REST 写路径同一条）
	getStateFile: (sessionId) => join(stateDir, `${sessionId}.json`),
	// memory_search 工具：剧情库 + 外部资料库合并取前 6（与扩展侧同一套语义）
	searchMemory: async (sessionId, query) => {
		const scope = { sessionId, card: cardPath || undefined };
		const visibleEntryIds = new Set(
			session.sessionManager.getBranch().map((entry) => entry.id).filter((id): id is string => typeof id === "string"),
		);
		const [narrative, external] = await Promise.all([
			memorySearch(cwd, scope, "narrative", query, undefined, visibleEntryIds).catch(() => []),
			memorySearch(cwd, scope, "external", query, undefined, visibleEntryIds).catch(() => []),
		]);
		return [...narrative, ...external].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 6);
	},
	// PLAN-RP-MEMORY：拍前自动召回（两阶段）。
	// 第一阶段 recallForTurn：合并剧情库（纪要/事件/证据）+ 额外库，按记忆策略注入【剧情记忆】。
	recallForTurn: async (sessionId, query) => {
		const scope = { sessionId, card: cardPath || undefined };
		const visibleEntryIds = new Set(
			session.sessionManager.getBranch().map((entry) => entry.id).filter((id): id is string => typeof id === "string"),
		);
		const hits = await memoryRecallForTurn(cwd, scope, query, visibleEntryIds).catch(() => []);
		return hits
			.map((h) => ({
				text: h.text,
				score: h.score,
				meta: {
					title: h.meta?.title,
					fileName: h.meta?.fileName,
					source: h.meta?.source,
					kind: h.meta?.kind,
					eventId: h.meta?.eventId,
					evidenceLevel: h.meta?.evidenceLevel,
				},
			}))
			.filter((h) => !!h.text);
	},
	recallArcsForTurn: async (sessionId) => {
		const scope = { sessionId, card: cardPath || undefined };
		const visibleEntryIds = new Set(
			session.sessionManager.getBranch().map((entry) => entry.id).filter((id): id is string => typeof id === "string"),
		);
		return memoryArcRecallForTurn(cwd, scope, visibleEntryIds);
	},
	// 第二阶段 recallEvidence：事件卡 → 原文证据块。
	recallEvidence: async (sessionId, eventId) => {
		const scope = { sessionId, card: cardPath || undefined };
		const visibleEntryIds = new Set(
			session.sessionManager.getBranch().map((entry) => entry.id).filter((id): id is string => typeof id === "string"),
		);
		const event = memoryListEventDigests(cwd, scope).find((item) => item.id === eventId);
		if (event?.sourceRefs?.length) {
			const branchEntries = session.sessionManager.getBranch() as unknown as Array<{
				id: string;
				type?: string;
				message?: { role?: string; content?: unknown; details?: unknown; stopReason?: string };
			}>;
			const byId = new Map(branchEntries.map((entry) => [entry.id, entry]));
			const sourceTexts = event.sourceRefs
				.filter((ref) => visibleEntryIds.has(ref.entryId))
				.map((ref) => ({ ref, entry: byId.get(ref.entryId) }))
				.map(({ ref, entry }) => {
					const content = entry?.message?.content;
					const canonical = entry?.message?.role === "assistant" && (ref.textBasis === "rpNarrative" || (ref.charFrom === undefined && ref.charTo === undefined));
					const text = canonical ? committedNarrativeText(entry!) : extractEntryText(content);
					if (!text) return "";
					return typeof ref.charFrom === "number" || typeof ref.charTo === "number"
						? text.slice(Math.max(0, ref.charFrom ?? 0), Math.max(0, ref.charTo ?? text.length))
						: text;
				})
				.filter(Boolean);
			if (sourceTexts.length) {
				return sourceTexts.slice(0, 2).map((text, index) => ({
					text,
					score: 1 - index * 0.001,
					meta: { title: "Session Tree 原文证据", source: "session-tree", kind: "evidence" as const, eventId, evidenceLevel: "source-backed" as const },
				}));
			}
		}
		const evd = await memoryEvidenceForEvent(cwd, scope, eventId, 2, visibleEntryIds).catch(() => []);
		return evd.map((h) => ({
			text: h.text,
			score: h.score,
			meta: {
				title: h.meta?.title,
				source: h.meta?.source,
				kind: "evidence" as const,
				eventId,
				evidenceLevel: (h.meta?.evidenceLevel ?? "source-backed") as "source-backed",
			},
		}));
	},
	// 拍前召回开关（对齐记忆配置 injectOnTurn）：宿主每次现查。
	shouldRecallForTurn: async () => {
		const {
			loadMemoryConfig,
		} = await import("../src/memory/index.ts");
		const cfg = loadMemoryConfig(cwd);
		return cfg.enabled === true && cfg.injectOnTurn !== false;
	},
	eventBook: (sessionId) => {
		const scope = { sessionId, card: cardPath || undefined };
		const scopeId = memoryScopeId(scope);
		const visibleEntryIds = new Set(
			session.sessionManager.getBranch().map((entry) => entry.id).filter((id): id is string => typeof id === "string"),
		);
		return {
			everyNTurns: () => { const cfg = loadMemoryConfig(cwd); return cfg.enabled ? cfg.stores.find((store) => store.id === "narrative" && store.enabled)?.everyNTurns ?? 0 : 0; },
			getCursor: () => loadMemoryConfig(cwd).eventCursors?.[scopeId],
			setCursor: (entryId: string) => {
				// 游标与配置同锁：避免并发 overwrite eventCursors/turnCounters。
				const cfg = loadMemoryConfig(cwd);
				saveMemoryConfig(cwd, { ...cfg, eventCursors: { ...(cfg.eventCursors ?? {}), [scopeId]: entryId } });
			},
			listEvents: () => memoryListEventDigests(cwd, scope, visibleEntryIds).map((event) => ({
				id: event.id,
				title: event.title,
				arc: event.arc,
				status: event.status,
				importance: event.importance,
				summary: event.summary,
			})),
		};
	},
	// 向量库写侧三件（M-D3）：MemoryScope 一律在此绑定（当前对话 + 当前卡），**不经模型**。
	// 写侧恒落 external——服务层 assertExtraStore 禁止手写剧情库，故工具不给 store 参数。
	addMemory: (sessionId, input) =>
		memoryManualAdd(cwd, { sessionId, card: cardPath || undefined }, input.text, {
			...(input.title ? { title: input.title } : {}),
		}),
	listMemory: (sessionId, storeId) => {
		const visibleEntryIds = new Set(session.sessionManager.getBranch().map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
		return memoryVisibleChunks(cwd, { sessionId, card: cardPath || undefined }, storeId, visibleEntryIds)
			.map((chunk) => ({ id: chunk.id, text: chunk.text, textLen: chunk.text.length, meta: chunk.meta, createdAt: chunk.createdAt }));
	},
	deleteMemory: async (sessionId, storeId, id) =>
		await memoryDeleteChunk(cwd, { sessionId, card: cardPath || undefined }, storeId, id),
	webResearch: async (queries, maxResults, signal) => {
		const { card, config } = loadStageMaterials(cwd);
		return webResearchBatch(queries, maxResults, { card, userName: config.userName, signal });
	},
	// 面板读写（M-D5）：按 session 绑定 artifacts 文件，注入后台上可通过 panel_write/read/close 操控面板
	loadPanels: (sessionId) => {
		const panels = loadPanels(join(artifactsDir, `${sessionId}.json`));
		const result: Record<string, { name: string; kind: "markdown" | "svg" | "html"; content: string; archived?: boolean }> = {};
		for (const [k, v] of Object.entries(panels)) result[k] = { name: v.name, kind: v.kind, content: v.content, archived: v.archived };
		return result;
	},
	writePanel: (sessionId, input) => {
		const file = join(artifactsDir, `${sessionId}.json`);
		const panels = loadPanels(file);
		const r = writePanel(panels, input);
		if (r.ok) { savePanels(file, r.panels); syncStoryPanelsFromDisk(); }
		return r;
	},
	closePanel: (sessionId, name) => {
		const file = join(artifactsDir, `${sessionId}.json`);
		const panels = loadPanels(file);
		const r = closePanelInMap(panels, name);
		if (r.ok) { savePanels(file, r.panels); syncStoryPanelsFromDisk(); }
		return r;
	},
	// MCP 外设（8/06 重接）：009e22e 换引擎时 MCP 只留在扩展路径（pi.registerTool）+
	// 已删除的 director.ts，台上从此看不见——hub 连得上，模型无工具可用。此处补上注入。
	//
	// 启用集**自己从会话树读**，不问扩展要（jiti 二象性：扩展的 sessionMcpEnabled 闭包
	// 变量在 server 侧不可见）。树上的 rp-mcp 快照是唯一可靠信源，且天然随 rewind/fork 走。
	// 无快照（新会话尚未 /mcpsync，或扩展未装载）→ 回落项目 defaults，自愈不依赖扩展。
	mcp: {
		listTools: () => {
			const hub = getMcpHub(cwd);
			const fromTree = mcpEnabledFromBranch(session.sessionManager.getBranch() as unknown[], RP_MCP_TYPE);
			const want = fromTree ?? defaultSessionEnabledIds(cwd);
			// hub 的启用集与树不一致时对账一次（后台连接，本拍用当前已连上的）。
			// 不 await：装配不能被 MCP 握手拖慢；连上后的下一拍即可见。
			const current = hub.getSessionEnabled();
			if (want.join("|") !== current.join("|")) {
				void hub.sync(want).catch(() => {
					// 连不上不该拖垮叙事：本拍就当没有 MCP 工具
				});
			}
			return hub.listActiveTools();
		},
		callTool: (serverId, toolName, args, signal) => getMcpHub(cwd).callTool(serverId, toolName, args, signal),
	},
	// P7 剧情决策门禁（ask 工具）：复用 Phase 4 柱 1 的选择卡通道——
	// 弹卡 → 用户作答（选项原文/自由输入）回喂模型重拟计划；停止 → 本拍收束，笔还给用户。
	askUser: (question, options, signal) => askChoice(question, options, undefined, signal),
	// 媒体交付（8/06 重接）：show_image/audio/video/html + tts。
	// 与 MCP 同源的断链——wire.ts 的消费端一直健在，缺的只是台上生产端。
	media: true,
	// TTS 需要服务端环境（LIYUAN_TTS_API_KEY / OPENAI_API_KEY）：每拍现查，
	// 用户中途配好 env 重启即生效；没配就不上清单（模型不会去试一个必然失败的工具）。
	ttsAvailable: () => loadTtsConfig() !== null,
	// M4 压缩归档：被摘要覆盖的早期正文完整入剧情库——摘要管连续性，归档管细节召回
	// PLAN-RP-MEMORY：归档块携带 entry 级 sourceRefs（含 charFrom/charTo），供事件→证据两阶段召回定位。
	archiveCompacted: async (sessionId, text, opts) => {
		const r = await memoryArchiveCompacted(
			cwd,
			{ sessionId, card: cardPath || undefined },
			text,
			{ sourceRefs: opts?.sourceRefs, perEntry: opts?.perEntry },
		);
		if (r.archived) {
			broadcast({ type: "notify", level: "info", text: `向量记忆：早期剧情已归档（${r.chunks} 段，可 memory_search 召回）` });
		}
	},
	// PLAN-RP-MEMORY：事件卡入库（memory workflow skill 旁路产物）。
	upsertEventDigest: async (sessionId, event) => {
		const scope = { sessionId, card: cardPath || undefined };
		const mergeInto = event.op?.startsWith("merge:") ? event.op.slice("merge:".length) : undefined;
		return memoryUpsertEventDigest(cwd, scope, event as import("../src/memory/types.ts").RpEventDigest, mergeInto ? { mergeInto, reason: "llm-merge" } : undefined);
	},
	// lorebook_toggle 工具（M-D2）：写 config.disabledLore 并软刷新素材。
	// 复用 M-C2 协议禁用的同一条指纹通道（PLAN-RP-TOOLING M-D2 明示不得另起一套）。
	setDisabledLore: (fingerprints, enabled) => {
		const path = resolveConfigPath(cwd);
		const disk = existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
			: {};
		const prev = Array.isArray(disk.disabledLore)
			? disk.disabledLore.filter((f): f is string => typeof f === "string")
			: [];
		const next = toggleDisabledLore(prev, fingerprints, enabled);
		if (disk.loreEntryOverrides && typeof disk.loreEntryOverrides === "object") {
			const overrides = { ...disk.loreEntryOverrides as Record<string, boolean> };
			for (const key of Object.keys(overrides)) {
				try { if (fingerprints.includes(JSON.parse(key)[2])) delete overrides[key]; } catch { /* unknown legacy key: preserve */ }
			}
			if (Object.keys(overrides).length) disk.loreEntryOverrides = overrides;
			else delete disk.loreEntryOverrides;
		}
		if (next.length > 0) disk.disabledLore = next;
		else delete disk.disabledLore;
		writeFileSync(path, `${JSON.stringify(disk, null, "\t")}\n`, "utf8");
		// constant 条目影响 system prompt，素材需重装（与 REST /api/lorebook/toggle 同）
		void restHost.softRefreshConfig();
		return fingerprints.length;
	},
	streamFn: streamSimple as unknown as StageStreamFn,
	events: {
		onTurnStart: () => broadcast({ type: "agent", state: "start" }),
		onDelta: (kind, delta, draft, reset) =>
			broadcast({ type: "delta", kind, delta, ...(draft ? { draft: true } : {}), ...(reset ? { reset: true } : {}) }),
		onDraftResync: (segments) => broadcast({ type: "draft_resync", segments }),
		onStreamClear: () => broadcast({ type: "stream", state: "clear" }),
		onNotify: (level, text) => broadcast({ type: "notify", level, text }),
		onActivity: (detail) => broadcast({ type: "activity", activity: { kind: "note", name: "stage", detail } }),
		onTurnEnd: (info) => {
			broadcast({ type: "agent", state: "end" });
			// reroll/编辑输入后无产出（aborted 无落树 / error）：回退到 reroll 前的旧叶——
			// 不许留下「只有 user 没有回复」的空拍（8/05：reroll 链上停止，前版本全消失）。
			if (rerollFallbackLeaf && (!info.entryId || info.error)) {
				const sm = session.sessionManager;
				if (sm.getLeafId() !== rerollFallbackLeaf) {
					try {
						sm.branch(rerollFallbackLeaf);
					} catch {
						// 回退失败不致命：保持当前状态
					}
				}
			}
			rerollFallbackLeaf = null;
			// 传统命令路径（/compact /rewind 等）仍读 AgentSession 内存副本：引擎写树后对齐一次
			try {
				session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
			} catch {
				// 对齐失败不影响本拍；下次树导航会重建
			}
			resyncAll();
			// 向量记忆入库：只在真落了新正文时（中断/错误拍不入）
			if (!info.entryId || info.error || info.aborted) return;
			const outlineMode = outline?.getView().settings.mode;
			if (outlineMode && outlineMode !== "manual") {
				const sourceSessionId = session.sessionId;
				turnRuntimeDiagnostics.set(info.entryId, { outline: { status: "pending", summary: "大纲校准正在后台运行" } });
				while (turnRuntimeDiagnostics.size > 100) turnRuntimeDiagnostics.delete(turnRuntimeDiagnostics.keys().next().value!);
				const leafId = session.sessionManager.getLeafId();
				void outline!.reconcile(leafId ?? undefined).then((result) => {
					if (session.sessionId !== sourceSessionId) return;
					turnRuntimeDiagnostics.set(info.entryId!, { outline: result.stable
						? { status: "stable", summary: "校准完成：当前大纲无需调整" }
						: result.committed ? { status: "committed", summary: "低风险校准已自动写入动态大纲" }
							: result.proposal ? { status: "pending", summary: "校准提案等待用户确认" }
								: { status: "stable", summary: "校准完成：没有产生修改" } });
				}).catch((error) => {
					if (session.sessionId !== sourceSessionId) return;
					turnRuntimeDiagnostics.set(info.entryId!, { outline: { status: "failed", summary: `大纲校准失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 240) } });
					console.warn("[outline] asynchronous reconcile failed", error);
				});
			}
			// Capture the source session/card/branch synchronously. An embedding await may overlap navigation.
			const memoryScope = { sessionId: session.sessionId, card: cardPath || undefined };
			const memoryBranch = session.sessionManager.getBranch();
			const memoryLeaf = session.sessionManager.getLeafId() ?? undefined;
			const memoryEvery = loadMemoryConfig(cwd).stores.find((store) => store.id === "narrative")?.everyNTurns ?? 3;
			const memoryWindow = narrativeMemoryWindow(memoryBranch, info.entryId, memoryEvery);
			if (!memoryWindow) return;
			void (async () => {
				try {
					const mem = await onNarrativeTurnEnd(cwd, memoryScope, memoryWindow.narrativeText, {
						entries: memoryWindow.entries, branchLeafId: memoryLeaf,
					});
					if (session.sessionId !== memoryScope.sessionId || cardPath !== memoryScope.card) return;
					if (mem.error) {
						broadcast({ type: "notify", level: "warning", text: `向量记忆：入库失败 · ${mem.error}` });
					} else if (mem.stored) {
						const how = mem.merged ? "合并入已有条目" : "新开条目";
						broadcast({ type: "notify", level: "info", text: `向量记忆：剧情库${how}（第 ${mem.counter} 轮 · 当前对话）` });
					}
				} catch (e) {
					console.warn("[memory] auto ingest failed", e);
				}
			})();
		},
	},
});

/** 台上或旧循环任一在流式中（守卫共用） */
const storyStreaming = (): boolean => session.isStreaming || stage.isStreaming;
readStoryStreaming = storyStreaming;

/**
 * 手动压缩（/compact 与 WS compact 帧共用）：走台上引擎自管压缩（M4）。
 * 摘要落 rp-summary 后 resyncAll——重放时被覆盖的楼层照旧全在（树只追加），
 * 变的只是**送模上下文**：装配时那段改由【前情提要】代替。
 */
const hostCompact = async (): Promise<void> => {
	broadcast({ type: "compaction", state: "start" });
	const r = await stage.compactNow();
	broadcast({ type: "compaction", state: "end", ok: r.kind === "compacted" });
	if (r.kind === "compacted") {
		broadcast({
			type: "notify",
			level: "info",
			text: `前情已压缩：${r.turns} 拍 ${r.chars} 字 → 摘要 ${r.summary.length} 字`,
		});
		resyncAll();
	} else if (r.kind === "failed") {
		broadcast({ type: "notify", level: "error", text: `压缩失败：${r.error}` });
	} else if (r.kind === "stale") {
		broadcast({ type: "notify", level: "warning", text: "压缩已丢弃（期间切换了分支）" });
	} else {
		broadcast({
			type: "notify",
			level: "info",
			text: r.reason === "busy" ? "正在演出中，稍后再压缩" : "早期剧情还不够长，暂不需要压缩",
		});
	}
};

/** 发送用户输入（含斜杠命令；命令后全量对齐所有端） */
const handlePrompt = async (text: string, submission?: StageSubmission) => {
	submission = { ...submission, generationMode: effectiveGenerationMode(submission?.generationMode ?? loadStageConfig(cwd).generationMode) };
	const trimmed = text.trim();
	// ST 式变体：无参 /reroll 与 /swipe 由宿主处理（需重开一拍，扩展命令上下文无此能力）
	if (/^\/reroll\s*$/i.test(trimmed)) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再重新生成" });
			return;
		}
		await regenerateSwipe();
		return;
	}
	// M-D6 R1：有参 /reroll（前端编辑用户消息）同样在宿主拦截，走 StageEngine——
	// 之前漏到 pi 跑无台上装配的裸 LLM 回合（无预设拆层/无工作区/无验收器）。
	const rerollArgMatch = /^\/reroll\s+(.+)/i.exec(trimmed);
	if (rerollArgMatch) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再重新生成" });
			return;
		}
		const userId = lastStoryUserId();
		if (!userId) {
			broadcast({ type: "notify", level: "error", text: "没有可重新生成的剧情轮（需要先有一条用户输入）" });
			return;
		}
		const sm = session.sessionManager;
		// 记录编辑前的叶：生成失败/停止无产出时回退到旧输入+旧回复
		rerollFallbackLeaf = sm.getLeafId();
		// 编辑输入 = **替换**该输入：钉到它的 parent，旧输入连同旧回复进旁支——
		// 树上不再有「旧输入 + 新输入」两条 user（8/05 实弹：编辑后 reroll，屏上两条输入都在）。
		// 与无参 reroll（regenerateSwipe，branch(userId) 保留输入重roll回复）语义不同。
		const branch = sm.getBranch() as Array<{ id?: string; parentId?: string }>;
		const userEntry = branch.find((e) => e.id === userId);
		const parentId = userEntry?.parentId;
		if (parentId && parentId !== userId) {
			if (sm.getLeafId() !== parentId) sm.branch(parentId);
		} else if (sm.getLeafId() !== userId) {
			// 旧输入是根（无 parent）：无法替换，退而保留输入本身
			sm.branch(userId);
		}
		// 追加编辑后的用户消息
		sm.appendMessage({ role: "user", content: [{ type: "text", text: rerollArgMatch[1].trim() }], timestamp: Date.now() });
		sm.flush();
		resyncAll();
		await stage.regenerate();
		return;
	}
	// 开场白切换：宿主层处理，保证「同一条替换」而非叠楼
	const greetingMatch = /^\/greeting(?:\s+(.*))?$/i.exec(trimmed);
	if (greetingMatch) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再切换开场白" });
			return;
		}
		await hostSwitchGreeting(greetingMatch[1] ?? "");
		return;
	}
	const swipeMatch = /^\/swipe(?:\s+(prev|next|new))?\s*$/i.exec(trimmed);
	if (swipeMatch) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再切换变体" });
			return;
		}
		const dir = (swipeMatch[1]?.toLowerCase() ?? "next") as "prev" | "next" | "new";
		await handleSwipe(dir);
		return;
	}
	// /compact：台上引擎自管压缩（PLAN-RP-HARNESS M4）。
	// 旧路径 session.compact() 压的是 pi 的消息副本，看不全引擎写进树的东西
	// （rp-draft-op 补丁 / rp-state 快照 / 引擎直落的 assistant）——长局压不动，故整体让位。
	const compactMatch = /^\/compact(?:\s+(.*))?$/i.exec(trimmed);
	if (compactMatch) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再压缩上下文" });
			return;
		}
		await hostCompact();
		return;
	}

	// 2026-07-18 合流：主框一律进剧情侧；// 与整段括号不再硬改道。
	// 2026-08-02 起叙事回合走台上引擎（PLAN-RP-HARNESS R1）；斜杠命令仍经 pi 会话执行。

	const isCommand = trimmed.startsWith("/");
	if (!isCommand) {
		const echo = () => broadcast({ type: "message", message: { channel: "user", name: names.userName, text: trimmed, ...(submission?.clientMessageId ? { messageId: submission.clientMessageId } : {}) } });
		if (!submission) echo();
		// 新协议的回显/ACK 均在 user flush 后，排队输入不能冒充已落树。
		await stage.performTurn(trimmed, submission ? { ...submission, onAccepted: (entryId) => { echo(); submission.onAccepted?.(entryId); } } : undefined);
		return;
	}
	await session.prompt(trimmed, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
	// 斜杠命令可能改写历史（/rewind /reroll /import）或注入消息：全量对齐
	{
		// /import：前情块是 custom 消息，SessionManager 在「尚无 assistant 回复」的
		// 新会话里默认不落盘（防空会话刷屏）——导入的会话没有回复也必须持久化，
		// 否则重启/切会话后整段前情蒸发、会话列表里也找不到（用户实测踩中）。
		if (/^\/import\b/i.test(trimmed)) {
			session.sessionManager.flush();
		}
		resyncAll();
	}
};

/** 流式中禁止的操作统一挡下 */
const refuseWhileStreaming = (ws: WebSocket, what: string): boolean => {
	if (!storyStreaming()) return false;
	sendFrame(ws, { type: "notify", level: "warning", text: `请等当前回复完成（或先停止），再${what}` } satisfies ServerFrame);
	return true;
};

// ---------- 会话-卡绑定（PLAN-PHASE3 §2.1）：读文件头解析 rp-card，mtime 缓存 ----------

const cardCache = new Map<string, { mtimeMs: number; info: { card: string; name: string } | null }>();

const readSessionCard = (path: string, mtimeMs: number): { card: string; name: string } | null => {
	const cached = cardCache.get(path);
	if (cached && cached.mtimeMs === mtimeMs) return cached.info;
	let info: { card: string; name: string } | null = null;
	try {
		// 取最后一条 rp-card：头 64KB + 尾 64KB（换卡后新标记 append 在文件末尾）
		const size = statSync(path).size;
		const fd = openSync(path, "r");
		try {
			const headLen = Math.min(size, 65536);
			const headBuf = Buffer.alloc(headLen);
			readSync(fd, headBuf, 0, headLen, 0);
			let text = headBuf.toString("utf8");
			if (size > 65536) {
				const tailLen = Math.min(size - headLen, 65536);
				const tailBuf = Buffer.alloc(tailLen);
				readSync(fd, tailBuf, 0, tailLen, size - tailLen);
				text += "\n" + tailBuf.toString("utf8");
			}
			info = parseCardFromSessionHead(text);
		} finally {
			closeSync(fd);
		}
	} catch {
		info = null;
	}
	cardCache.set(path, { mtimeMs, info });
	return info;
};

/** 会话路径是否为当前打开（Windows 路径大小写/斜杠差异时 path=== 会失败） */
const isSameSessionPath = (a: string | undefined, b: string | undefined): boolean => {
	if (!a || !b) return false;
	const n = (p: string) => normalize(p).replace(/\\/g, "/").toLowerCase();
	return n(a) === n(b);
};

/**
 * 仅列**当前角色卡**下的会话（全部对话按卡绑定，不再有「未标记」分组）。
 * - 有 rp-card 且路径=当前卡 → 列出
 * - 其他卡 → 隐藏（即使是「当前打开」也不把同卡以外的旁支拉进列表）
 * - 无标记：不列入（session_start 会补写）
 * - 当前打开且绑定当前卡：标 current；当前打开却属其它卡：不列入（应已被 switchToCard 切走）
 * - 列表为空且进程有打开会话 → 兜底补一条「当前会话」
 */
const sessionInfos = async () => {
	// 每次列表前刷新卡路径，避免换卡后仍用旧 cardPath 滤错
	refreshNamesFromConfig();
	const all = await SessionManager.list(cwd);
	const curFile = session.sessionFile;
	const curId = session.sessionId;
	const list: Array<{
		path: string;
		id: string;
		name?: string;
		firstMessage: string;
		modified: number;
		messageCount: number;
		current: boolean;
		preview?: string;
		cardName: string;
		card?: string;
	}> = [];
	const belongsHere = (card: string | undefined) => {
		if (!cardPath) return false; // 未配置卡：不铺开历史
		return sameCardPath(card, cardPath, cwd);
	};
	for (const s of all) {
		const mtime = s.modified instanceof Date ? s.modified.getTime() : Number(s.modified) || 0;
		// 新建后 mtime 刚变：清掉可能过期的卡缓存再读
		if (cardCache.has(s.path)) {
			const c = cardCache.get(s.path)!;
			if (c.mtimeMs !== mtime) cardCache.delete(s.path);
		}
		const info = readSessionCard(s.path, mtime);
		const isCurrent = s.id === curId || isSameSessionPath(s.path, curFile);
		// 严格按卡过滤：其它卡一律不出现（含「当前打开却属其它卡」——由换卡流程切会话）
		if (!info || !belongsHere(info.card)) {
			// 仅当「当前会话尚未打上标记」时保留入口，避免新建后列表空白
			if (!(isCurrent && !info && cardPath)) continue;
		}
		const preview = readSessionPreview(s.path, mtime);
		list.push({
			path: s.path,
			id: s.id,
			...(s.name ? { name: s.name } : {}),
			firstMessage: s.firstMessage,
			modified: mtime,
			messageCount: s.messageCount,
			current: isCurrent,
			...(preview ? { preview } : {}),
			cardName: info?.name || names.charName,
			...(info?.card ? { card: info.card } : cardPath ? { card: cardPath } : {}),
		});
	}
	// 兜底：列表里没有任何 current，但进程确有打开会话 → 按 id/路径补一条（须属当前卡或无标记）
	if (curId && !list.some((x) => x.current)) {
		const mine = all.find((s) => s.id === curId || isSameSessionPath(s.path, curFile));
		if (mine) {
			const mtime = mine.modified instanceof Date ? mine.modified.getTime() : Number(mine.modified) || 0;
			const info = readSessionCard(mine.path, mtime);
			// 打开中的会话若明确属于其它卡：不塞进本卡列表（避免「切卡后仍见旧卡」）
			if (info && !belongsHere(info.card)) {
				// skip foreign current
			} else {
				const preview = readSessionPreview(mine.path, mtime);
				const existing = list.find((x) => x.id === mine.id || isSameSessionPath(x.path, mine.path));
				if (existing) {
					existing.current = true;
				} else {
					list.push({
						path: mine.path,
						id: mine.id,
						...(mine.name ? { name: mine.name } : {}),
						firstMessage: mine.firstMessage,
						modified: mtime,
						messageCount: mine.messageCount,
						current: true,
						...(preview ? { preview } : {}),
						cardName: info?.name || names.charName,
						...(info?.card ? { card: info.card } : cardPath ? { card: cardPath } : {}),
					});
				}
			}
		} else {
			// 惰性落盘：首条 assistant 前会话文件可能尚未出现在 SessionManager.list
			let cardName = names.charName;
			let boundCard = cardPath;
			try {
				const entries = session.sessionManager.getEntries() as Array<{
					type?: string;
					customType?: string;
					data?: { name?: string; card?: string };
				}>;
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e?.type === "custom" && e.customType === "rp-card") {
						if (typeof e.data?.name === "string" && e.data.name) cardName = e.data.name;
						if (typeof e.data?.card === "string" && e.data.card) boundCard = e.data.card;
						break;
					}
				}
			} catch {
				// 极早期生命周期：回落显示名
			}
			if (!boundCard || belongsHere(boundCard)) {
				let messageCount = 0;
				try {
					messageCount = session.messages?.length ?? 0;
				} catch {
					messageCount = 0;
				}
				list.push({
					path: curFile || "",
					id: curId,
					firstMessage: "",
					modified: Date.now(),
					messageCount,
					current: true,
					cardName,
					...(boundCard ? { card: boundCard } : {}),
				});
			}
		}
	}
	list.sort((a, b) => b.modified - a.modified);
	return list;
};

const listSessions = async (): Promise<ServerFrame> => ({ type: "sessions", list: await sessionInfos() });

// 防御旧前端的 sessions 请求风暴：同一连接若上一份列表仍在计算，后续请求复用它；
// 150ms 内重复请求直接回缓存。会话列表会扫描会话文件并读取卡 PNG，失控时可吃满单核。
let sessionsFrameCache: { at: number; frame: ServerFrame } | undefined;
let sessionsFramePending: Promise<ServerFrame> | undefined;
const listSessionsCoalesced = async (): Promise<ServerFrame> => {
	const now = Date.now();
	if (sessionsFrameCache && now - sessionsFrameCache.at < 150) return sessionsFrameCache.frame;
	if (sessionsFramePending) return sessionsFramePending;
	sessionsFramePending = listSessions().then((frame) => {
		sessionsFrameCache = { at: Date.now(), frame };
		return frame;
	}).finally(() => { sessionsFramePending = undefined; });
	return sessionsFramePending;
};

// ---------- 会话文件辅助（预览/重命名/删除/搜索——面板重做 PLAN-PANELS §2.1） ----------

/** 读文件尾部若干字节（末条消息预览用；大会话不整读） */
const readFileTail = (path: string, bytes = 65536): string => {
	const fd = openSync(path, "r");
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		const n = readSync(fd, buf, 0, buf.length, start);
		return buf.toString("utf8", 0, n);
	} finally {
		closeSync(fd);
	}
};

/** 从会话条目提取正文文本（user/assistant 消息；其余条目返回 null） */
const entryMsgText = (entry: unknown): string | null => {
	const e = entry as { message?: unknown; role?: unknown; content?: unknown } | null;
	const m = (e?.message ?? e) as { role?: unknown; content?: unknown } | null;
	if (!m || (m.role !== "assistant" && m.role !== "user")) return null;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		const t = m.content
			.map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
			.filter(Boolean)
			.join(" ");
		return t || null;
	}
	return null;
};

const previewCache = new Map<string, { mtimeMs: number; text: string }>();

/** 末条消息预览（ST 过去聊天信息密度，借鉴项）：尾部扫描最后一条 user/assistant 正文 */
const readSessionPreview = (path: string, mtimeMs: number): string => {
	const cached = previewCache.get(path);
	if (cached && cached.mtimeMs === mtimeMs) return cached.text;
	let text = "";
	try {
		const lines = readFileTail(path).split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const t = entryMsgText(JSON.parse(line));
				if (t?.trim()) {
					text = t.replace(/\s+/g, " ").trim().slice(0, 80);
					break;
				}
			} catch {
				// 尾部截断的半行：跳过
			}
		}
	} catch {
		// 文件读取失败：无预览
	}
	previewCache.set(path, { mtimeMs, text });
	return text;
};

/** 校验路径确属本项目会话清单（所有会话文件操作的门），返回清单项 */
const assertListedSession = async (path: string) => {
	const all = await SessionManager.list(cwd);
	const found = all.find((s) => s.path === path);
	if (!found) throw new Error("不是本项目的会话文件");
	return found;
};

const deliveryWaiters = new Map<string, Set<WebSocket>>();
const receivePrompt = async (ws: WebSocket, frame: Extract<ClientFrame, { type: "prompt" | "assistant_prompt" }>): Promise<void> => {
	if (frame.type === "prompt" && frame.generationMode !== undefined && !isGenerationMode(frame.generationMode)) { sendFrame(ws, { type: "prompt_ack", messageId: String(frame.messageId ?? ""), sessionId: String(frame.sessionId ?? ""), status: "rejected", reason: "生成模式无效，草稿保留" }); return; }
	const text = String(frame.text ?? "").trim();
	const identity = readSubmissionIdentity(frame);
	if (identity === "legacy") { if (text) await (frame.type === "prompt" ? handlePrompt(text) : promptAssistant(text)); return; }
	const reply = (status: "accepted" | "rejected", reason?: string) => sendFrame(ws, { type: "prompt_ack", sessionId: String(frame.sessionId ?? "").slice(0, 256), messageId: String(frame.messageId ?? "").slice(0, 128), status, ...(reason ? { reason } : {}) });
	if (identity === "invalid" || !text || text.length > 256_000) { reply("rejected", "缺少明确的会话目标、合法消息 ID 或正文，草稿未发送"); return; }
	const assistant = frame.type === "assistant_prompt";
	const command = text.startsWith("/");
	const channel: DeliveryChannel = command ? "command" : assistant ? "assistant" : "story";
	const target = assistant ? assistantDeliveryTarget() : session.sessionId;
	if (!target || identity.sessionId !== target) { reply("rejected", "会话已改变，草稿未发送；请确认目标后重新提交"); return; }
	if (!assistant && command && (storyStreaming() || deliveryLedger.hasPendingSessionPrefix("assistant:")) && /^\/(?:new|back|rewind|drop|reroll|swipe|greeting|compact|editreply)(?:\s|$)/i.test(text)) { reply("rejected", "生成中不能执行此状态命令，输入保留，请停止或结束后重试"); return; }
	if (!assistant && !command) {
		const persisted = findPersistedSubmission(session.sessionManager.getEntries(), identity.messageId);
		if (persisted) { reply(persisted.text === text ? "accepted" : "rejected", persisted.text === text ? undefined : "该消息 ID 已用于其他正文"); return; }
	}
	const disposition = deliveryLedger.begin(channel, identity, text);
	if (disposition === "conflict" || disposition === "full") { reply("rejected", disposition === "conflict" ? "该消息 ID 已用于其他正文" : "待确认消息过多，请稍后再试"); return; }
	if (disposition === "accepted") { reply("accepted"); return; }
	const key = deliveryLedger.key(channel, identity);
	const waiters = deliveryWaiters.get(key) ?? new Set<WebSocket>();
	if (waiters.size < 16) waiters.add(ws);
	deliveryWaiters.set(key, waiters);
	if (disposition === "pending") return;
	let accepted = false;
	const finish = (status: "accepted" | "rejected", reason?: string) => {
		if (accepted) return;
		if (status === "accepted") { accepted = true; deliveryLedger.accept(channel, identity); }
		else deliveryLedger.reject(channel, identity);
		for (const client of deliveryWaiters.get(key) ?? []) sendFrame(client, { type: "prompt_ack", ...identity, status, ...(reason ? { reason } : {}) });
		deliveryWaiters.delete(key);
	};
	const asst = assistantHost;
	if (assistant && asst?.isStreaming()) { finish("rejected", "助手正在生成，草稿保留，请结束后重试"); return; }
	const previousAssistantMessages = assistant ? asst?.messages().length ?? 0 : 0;
	try {
		if (assistant) {
			if (!asst) throw new Error("助手不可用，草稿未发送");
			await promptAssistant(text);
			// 助手暂无 user-id 落树钩子；只承诺本进程防重入，等待 prompt 返回后确认。
			finish("accepted", "助手已受理（本进程去重，不承诺宿主重启后恰一次）");
		} else if (command) {
			await handlePrompt(text);
			finish("accepted", "命令已处理；这是执行返回确认，不是持久用户消息 ACK");
		} else {
			await handlePrompt(text, { clientMessageId: identity.messageId, expectedSessionId: identity.sessionId, generationMode: isGenerationMode(frame.generationMode) ? frame.generationMode : effectiveGenerationMode(loadStageConfig(cwd).generationMode), onAccepted: () => finish("accepted") });
			if (!accepted) finish("rejected", "输入尚未落树，草稿保留，请重试");
		}
	} catch (error) {
		if (accepted) return; // 已接受输入后的生成失败不能诱发重复提交。
		const persisted = !assistant && !command && session.sessionId === identity.sessionId
			? findPersistedSubmission(session.sessionManager.getEntries(), identity.messageId) : undefined;
		const assistantRecorded = assistant && asst?.messages().slice(previousAssistantMessages).some((m: unknown) => {
			const message = m as { role?: string; content?: unknown };
			return message.role === "user" && extractEntryText(message.content) === text;
		});
		if (persisted || assistantRecorded) finish("accepted", "输入已进入历史，生成失败不代表投递失败");
		else finish("rejected", "输入未受理，草稿保留，请重试");
	}
};

wss.on("connection", (ws, req) => {
	// 访问密码闸门：WS 与 REST 同一套 Cookie 凭据
	if (!requestAuthed(req)) {
		ws.close(4401, "unauthorized");
		return;
	}
	if (!clients.add(ws, parseCookies(req.headers.cookie)[ACCESS_COOKIE])) return;
	sendFrame(ws, helloFrame());
	if (storyStreaming()) sendFrame(ws, { type: "agent", state: "start" } satisfies ServerFrame);
	// 助手面板：连接即对齐（busy 随帧携带，断线重连恢复生成中状态）
	sendFrame(ws, assistantHelloFrame());
	// 在线更新状态：新连接即对齐（有新版/就绪时主页 chip 才能亮）
	if (updateState.phase !== "none")
		sendFrame(ws, { type: "update", update: { ...updateState, supervised: UPDATE_SUPERVISED } } satisfies ServerFrame);
	// 断线重连 / 新端接入：补发当前挂起的决策询问（未决卡不随 hello 历史走）
	for (const [id, p] of pendingChoices) sendFrame(ws, choiceFrame(id, p));

	ws.on("message", (data) => {
		if (!clients.allows(ws)) return;
		void (async () => {
			let frame: ClientFrame;
			try {
				frame = JSON.parse(String(data)) as ClientFrame;
			} catch {
				return;
			}
			try {
				switch (frame.type) {
					case "prompt": {
						await receivePrompt(ws, frame);
						break;
					}
					case "abort": {
						// 强制停止：按下即收敛 UI/选择卡，再撕掉本拍（台上引擎 + 旧循环 + 委托中的助手）
						for (const id of [...pendingChoices.keys()]) settleChoice(id, { stop: true });
						const wasStreaming = storyStreaming() || (assistantHost?.isStreaming() ?? false);
						// 不在这里乐观广播 end；等待各自 onTurnEnd，避免 UI 显示已停止而后台仍在产出。
						stage.abort(); // 引擎自会以 aborted 谢幕（半拍正文保留）
						void session.abort().catch((err) => {
							console.error(`[liyuan] abort 失败：${err instanceof Error ? err.message : String(err)}`);
						});
						void assistantHost?.abort().catch((err) => {
							console.error(`[liyuan] assistant abort(on story stop) 失败：${err instanceof Error ? err.message : String(err)}`);
						});
						if (!wasStreaming) {
							// 无流时仍可点停：无事发生
						}
						break;
					}
					case "reroll": {
						if (refuseWhileStreaming(ws, "重新生成")) return;
						const t = String(frame.text ?? "").trim();
						// 无参 = ST sibling 变体；有参 = 改用户文案后整轮重来（扩展 /reroll）
						await handlePrompt(t ? `/reroll ${t}` : "/reroll");
						break;
					}
					case "curtain_reroll": {
						if (refuseWhileStreaming(ws, "重Roll状态栏")) return;
						await stage.regenerateCurtain();
						break;
					}
					case "swipe": {
						if (refuseWhileStreaming(ws, "切换回复变体")) return;
						const dir = frame.dir === "prev" || frame.dir === "next" || frame.dir === "new" ? frame.dir : "next";
						await handleSwipe(dir);
						break;
					}
					case "compact":
						if (refuseWhileStreaming(ws, "压缩上下文")) return;
						await hostCompact();
						break;
					case "sessions":
						if (Date.now() - (sessionsRequestAt.get(ws) ?? 0) < 1000) break;
						sessionsRequestAt.set(ws, Date.now());
						{ const target = session.sessionId; const list = await listSessionsCoalesced(); sendFrame(ws, { ...list, sessionId:target } as ServerFrame); }
						break;
					case "open": {
						if (deliveryLedger.hasPendingSessionPrefix("assistant:")) { sendFrame(ws, { type: "notify", level: "warning", text: "助手输入尚在处理，请结束/停止后切换会话" }); return; }
						if (refuseWhileStreaming(ws, "切换会话")) return;
						const path = String(frame.path ?? "");
						if (!path || path === session.sessionFile) return;
						await runtime.switchSession(path);
						// 助手对齐该剧情会话（有绑定则打开，无则新建，避免接着旧助手上下文）
						if (assistantHost) {
							try {
								await assistantHost.switchToStory(session.sessionId);
								broadcast(assistantHelloFrame());
							} catch (err) {
								console.error(
									`[liyuan] 助手对齐剧情会话失败：${err instanceof Error ? err.message : String(err)}`,
								);
							}
						}
						broadcast({ type: "notify", level: "info", text: "已切换会话" });
						break;
					}
					case "new":
						if (deliveryLedger.hasPendingSessionPrefix("assistant:")) { sendFrame(ws, { type: "notify", level: "warning", text: "助手输入尚在处理，请结束/停止后新建会话" }); return; }
						if (refuseWhileStreaming(ws, "新建会话")) return;
						await runtime.newSession();
						if (assistantHost) {
							try {
								await assistantHost.switchToStory(session.sessionId);
								broadcast(assistantHelloFrame());
							} catch (err) {
								console.error(
									`[liyuan] 助手对齐剧情会话失败：${err instanceof Error ? err.message : String(err)}`,
								);
							}
						}
						broadcast({ type: "notify", level: "info", text: "已新建会话" });
						break;
					case "choice_reply": {
						const id = String(frame.id ?? "");
						if (!pendingChoices.has(id)) return; // 已被他端应答/超时收敛
						if (frame.stop) {
							// 停止本回合：先收敛留痕（防重入），再中止当前生成，笔还给用户
							settleChoice(id, { stop: true });
							await session.abort();
						} else {
							const value = String(frame.value ?? "").trim();
							if (!value) return; // 空应答忽略，卡片保持未决
							settleChoice(id, { value });
						}
						break;
					}
					case "assistant_prompt": {
						await receivePrompt(ws, frame);
						break;
					}
					case "assistant_abort": {
						if (assistantHost?.isStreaming()) {
							// 助手侧同样：先解锁前端 busy，再后台撕流
							broadcast({ type: "assistant_state", state: "end" });
						}
						void assistantHost?.abort().catch((err) => {
							console.error(`[liyuan] assistant abort 失败：${err instanceof Error ? err.message : String(err)}`);
						});
						break;
					}
					case "assistant_sessions": {
						if (!assistantHost) {
							sendFrame(ws, { type: "assistant_sessions", list: [] } satisfies ServerFrame);
							return;
						}
						const target = assistantDeliveryTarget();
						const list = await assistantHost.listSessions();
						sendFrame(ws, { type: "assistant_sessions", list, sessionId:target } as ServerFrame);
						break;
					}
					case "assistant_open": {
						if (deliveryLedger.hasPendingSessionPrefix("assistant:")) { sendFrame(ws, { type: "notify", level: "warning", text: "助手输入尚在处理，暂不能切换助手会话" }); return; }
						if (!assistantHost) return;
						const path = String(frame.path ?? "");
						if (!path) return;
						try {
							await assistantHost.openSession(path);
							broadcast(assistantHelloFrame());
							broadcast({ type: "notify", level: "info", text: "已切换助手历史" });
						} catch (err) {
							sendFrame(ws, {
									type: "notify",
									level: "warning",
									text: err instanceof Error ? err.message : String(err),
								} satisfies ServerFrame);
						}
						break;
					}
					case "assistant_delete": {
						if (!assistantHost) return;
						const path = String(frame.path ?? "");
						if (!path) return;
						try {
							await assistantHost.deleteSession(path);
							const list = await assistantHost.listSessions();
							broadcast({ type: "assistant_sessions", list });
							broadcast({ type: "notify", level: "info", text: "已删除助手历史" });
						} catch (err) {
							sendFrame(ws, {
									type: "notify",
									level: "warning",
									text: err instanceof Error ? err.message : String(err),
								} satisfies ServerFrame);
						}
						break;
					}
					case "assistant_new":
						if (deliveryLedger.hasPendingSessionPrefix("assistant:")) { sendFrame(ws, { type: "notify", level: "warning", text: "助手输入尚在处理，暂不能新建助手会话" }); return; }
						if (!assistantHost) return;
						if (assistantHost.isStreaming()) {
							sendFrame(ws, { type: "notify", level: "warning", text: "请等助手当前回复完成（或先停止），再开新对话" } satisfies ServerFrame);
							return;
						}
						await assistantHost.newConversation();
						broadcast(assistantHelloFrame());
						broadcast({ type: "assistant_sessions", list: await assistantHost.listSessions() });
						break;
					case "assistant_sync":
						sendFrame(ws, assistantHelloFrame());
						break;
					case "assistant_model": {
						if (!assistantHost) return;
						const provider = typeof frame.provider === "string" ? frame.provider.trim() : "";
						const id = typeof frame.id === "string" ? frame.id.trim() : "";
						try {
							await assistantHost.setModel(provider && id ? { provider, id } : null);
							broadcast(assistantHelloFrame());
						} catch (err) {
							sendFrame(ws, {
									type: "notify",
									level: "error",
									text: err instanceof Error ? err.message : String(err),
								} satisfies ServerFrame);
						}
						break;
					}
				}
			} catch (err) {
				broadcast({ type: "error", text: err instanceof Error ? err.message : String(err) });
			}
		})();
	});

	const forgetConnection = () => { clients.delete(ws); for (const waiters of deliveryWaiters.values()) waiters.delete(ws); };
	ws.on("close", forgetConnection);
	ws.on("error", forgetConnection);
});

// ---------- 启动 ----------

httpServer.listen(PORT, HOST, () => {
	const urls = [`http://localhost:${PORT}`];
	if (HOST === "0.0.0.0") {
		for (const list of Object.values(networkInterfaces())) {
			for (const ni of list ?? []) {
				if (ni.family === "IPv4" && !ni.internal) urls.push(`http://${ni.address}:${PORT}`);
			}
		}
	}
	console.log(`[liyuan] ${names.charName} 已就位（会话 ${session.sessionId.slice(0, 8)}…）`);
	console.log(`[liyuan] agent 目录 ${agentHome}`);
	for (const line of takeAgentMergeLog()) {
		console.log(`[liyuan] 迁移 ${line}`);
	}
	console.log(`[liyuan] ${urls.join("  |  ")}（手机连同一 Wi-Fi 访问后者；勿暴露公网）`);
});

const shutdown = async () => {
	try {
		unsubscribe?.();
		for (const ws of clients) ws.close();
		wss.close();
		httpServer.close();
		await assistantHost?.dispose();
		await runtime.dispose();
	} finally {
		process.exit(0);
	}
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
