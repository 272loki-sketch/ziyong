import { useEffect, useMemo, useRef, useState } from "react";
import { IconClose, IconRefresh } from "../components/icons.tsx";
import {
	bootstrapOutline, confirmOutlineProposal, getOutline, getOutlineResearch, createCorpus, createCorpusVersion, createCorpusUrl, deleteCorpus, discoverCorpus, getCorpusDetail, listCorpus, pauseCorpus, resumeCorpus,
	getOutlineVersions, getTurnDiagnostics, getResearchSearchSchedule, putOutlineSettings, reconcileOutline, refreshOutlineResearch, rejectOutlineProposal, runResearchSearchSchedule, searchOutlineResearch, searchResearchLogs, retrySearchExtraction, streamOutlineChat,
	clearChats, getMemoryEvents, getMemoryDiff,
} from "./client.ts";
import { uploadFile } from "../api.ts";
import { listNovelPlayJobs, type NovelPlayJob } from "./novel-play-client.ts";
import type {
	CorpusDetailResponse, CorpusDocument, CorpusWorkbenchResponse,
	OutlineChatResponse, OutlineDiscussionFocus, OutlineHistoryResponse, OutlineMode, OutlineNode,
	OutlineProposalView, OutlineResearchMode, OutlineResearchSearchResponse, OutlineResearchView, OutlineSceneAdvice, OutlineViewResponse,
	ResearchSearchLog, ResearchSearchScheduleStatus, TurnDiagnosticsResponse, OutlineDailyPlan,
	MemoryEventCard, MemoryDiffRecord,
} from "./types.ts";

type Tab = DirectorTab;
type Toast = (level: "info" | "warning" | "error", text: string) => void;
type ChatLine = { role: "user" | "assistant"; text: string; options?: string[]; warnings?: string[]; focus?: OutlineDiscussionFocus; sceneAdvice?: OutlineSceneAdvice; dailyPlan?: OutlineDailyPlan; dailyPlans?: OutlineDailyPlan[] };
type ResearchDisplayItem = {
	id: string;
	title: string;
	url?: string;
	note?: string;
	excerpt?: string;
	mechanism?: string;
	appliesWhen?: string;
	sourceIds?: string[];
	warnings?: string[];
	failureWarnings?: string[];
	sources?: Array<{ id: string; title: string; url?: string }>;
	locator?: string;
	evidenceSummary?: string;
	confidence?: string;
	usage?: { selected: number; usedByDirector: number; adopted: number; dismissed: number };
	origin: "web" | "corpus";
};

import { DIRECTOR_MODULE_BY_ID, DIRECTOR_MODULE_GROUPS, type DirectorTab } from "./modules/registry.ts";
import { DiagnosticsModule } from "./modules/DiagnosticsModule.tsx";
import { ResearchSearchModule } from "./modules/ResearchSearchModule.tsx";
import { CorpusModule } from "./modules/CorpusModule.tsx";
import { NovelPlayModule } from "./modules/NovelPlayModule.tsx";
import { ResearchLibraryModule } from "./modules/ResearchLibraryModule.tsx";
import { MemoryModule } from "./modules/MemoryModule.tsx";
import { StoryMapModule } from "./modules/StoryMapModule.tsx";
import { CharactersModule } from "./modules/CharactersModule.tsx";
import { ForeshadowingModule } from "./modules/ForeshadowingModule.tsx";
import { ProposalsModule } from "./modules/ProposalsModule.tsx";
import { VersionsModule } from "./modules/VersionsModule.tsx";
import { WorldModule } from "./modules/WorldModule.tsx";
import { SystemModule } from "./modules/SystemModule.tsx";


const DISCUSSION_MODES: Array<{ id: OutlineDiscussionFocus; label: string; note: string; prompt: string }> = [
	{ id: "open", label: "综合编剧", note: "长期路线与当前场景一起讨论", prompt: "结合当前剧情，判断接下来最值得发展的方向，并给出几种体验不同的方案。" },
	{ id: "next-beat", label: "下一拍", note: "下一段从哪里起、停在哪里", prompt: "分析当前场景的下一拍应该怎么走：从什么动作起手，角色会主动做什么，压力从哪里来，最后停在哪里把选择交给我。" },
	{ id: "dialogue", label: "下一段对白", note: "意图、潜台词与信息交换", prompt: "设计下一段对话的走法：双方各自想得到什么、哪些话不会直说、怎样交换信息，并给少量可参考的对白语气。" },
	{ id: "character", label: "角色反应", note: "人物此刻会怎么主动行动", prompt: "结合角色卡和最近剧情，分析当前关键人物此刻最自然的反应、主动动作、顾虑和绝不会做的事。" },
	{ id: "diagnose", label: "节奏诊断", note: "检查拖沓、跳跃、重复和失焦", prompt: "诊断当前剧情的节奏与角色主动性：哪里拖沓、跳跃、重复或推进过快，下一拍怎样修正最自然。" },
	{ id: "daily", label: "日常剧情", note: "活动、发糖、小冲突与关系变化", prompt: "策划三张可以直接拿来演的日常剧情卡：每张都有活动、发起者、发糖点、小冲突或误会、关系变化和自然停点。" },
];
const FOCUS_LABEL: Record<OutlineDiscussionFocus, string> = Object.fromEntries(DISCUSSION_MODES.map((item) => [item.id, item.label])) as Record<OutlineDiscussionFocus, string>;
function list<T>(value: T[] | undefined | null): T[] { return Array.isArray(value) ? value : []; }
function textOptions(value: OutlineChatResponse["options"]): string[] {
	return list(value).map((item) => {
		if (typeof item === "string") return item;
		const title = item.title || item.label || item.text || item.value || item.experience || item.mechanism || "";
		const detail = [item.experience, item.mechanism, ...(Array.isArray(item.tradeoffs) ? item.tradeoffs : item.tradeoffs ? [item.tradeoffs] : [])]
			.filter((part) => part && part !== title).join(" · ");
		return detail ? `${title}：${detail}` : title;
	}).filter(Boolean);
}
function pendingProposals(outline: OutlineViewResponse): OutlineProposalView[] {
	if (outline.pending?.length) return outline.pending.map(({ entry }) => ({
		...entry.proposal,
		proposalHash: entry.proposalHash || entry.proposal.proposalHash || "",
		audit: entry.audit,
		status: entry.status,
		risk: outline.proposalRisks?.[entry.proposal.id]?.requiresConfirmation ? "high" : undefined,
	}));
	return list(outline.proposals);
}
function researchItems(view: OutlineResearchView): ResearchDisplayItem[] {
	const sources = new Map([
		...list(view.sources).map((source) => [source.id, { id: source.id, title: source.title, url: source.url }] as const),
		...list(view.documents).map((doc) => [doc.id, { id: doc.id, title: doc.title, url: doc.sourceKind === "url" ? doc.originName : undefined }] as const),
	]);
	return [
		...list(view.sources).map((source) => ({ id: source.id, title: source.title, url: source.url, note: `访问时间：${new Date(source.accessedAt).toLocaleString()}`, origin: "web" as const })),
		...list(view.mechanisms).map((item) => {
			const linked = item.sourceIds.flatMap((id) => sources.get(id) ?? []);
			const origin = item.sourceIds.some((id) => id.startsWith("doc-")) ? "corpus" as const : "web" as const;
			return { id: item.id, title: item.mechanism, url: linked[0]?.url, note: `来源：${linked.map((source) => source.title).join("、") || "未关联"}${item.locator ? `\n定位：${item.locator}` : ""}`, excerpt: item.evidenceSummary, appliesWhen: item.appliesWhen, sourceIds: item.sourceIds, sources: linked, locator: item.locator, evidenceSummary: item.evidenceSummary, failureWarnings: [item.failureWarning], confidence: item.confidence, usage: item.usage, origin };
		}),
	];
}
function SceneAdviceCard({ advice }: { advice: OutlineSceneAdvice }) {
	const rows: Array<[string, string | string[]]> = [
		["推荐下一拍", advice.recommendedBeat], ["起手", advice.openingMove],
		["你可以做什么", advice.playerObjective], ["为什么现在做", advice.naturalReason], ["希望推动什么", advice.intendedConsequence],
		["角色主动动作", advice.characterMoves],
		["对白线索", advice.dialogueCues], ["压力", advice.pressure], ["玩家空间", advice.playerSpace],
		["自然停点", advice.stopPoint], ["备选走法", advice.alternatives], ["混合路线", advice.mixedRoute],
	];
	return <div className="planning-advice"><strong>即时导演建议</strong>{advice.conversationTargets.length > 0 && <div className="planning-targets"><span>建议聊天对象</span>{advice.conversationTargets.map((target) => <article key={target.character}><b>{target.character}</b><p>{target.reason}</p><small>切入：{target.openingTopic}{target.risk ? ` · 风险：${target.risk}` : ""}</small></article>)}</div>}{rows.map(([label, value]) => {
		const values = Array.isArray(value) ? value : value ? [value] : [];
		return values.length > 0 && <div className="planning-advice-row" key={label}><span>{label}</span><div>{values.map((item) => <p key={item}>{item}</p>)}</div></div>;
	})}<small>这是当前场景建议，不是已发生正文；长期修改仍需在提案审阅中确认。</small></div>;
}
function DailyPlanCard({ plan }: { plan: OutlineDailyPlan }) {
	const rows: Array<[string, string | string[]]> = [["为什么是现在", plan.whyNow], ["承接当前剧情", plan.continuityHook], ["进入条件", plan.entryCondition], ["活动", plan.surfaceActivity], ["发起者/目的", `${plan.initiator} · ${plan.privateIntent}`], ["发糖点", plan.sweetBeats], ["小冲突", plan.friction], ["误会", plan.misunderstanding], ["关系变化", plan.relationshipChange], ["角色边界", plan.characterBoundaries], ["用户分叉", plan.playerChoices], ["停点", plan.stopPoint], ["后续", plan.followUpSeeds]];
	return <div className="planning-advice planning-daily-plan"><strong>{plan.title}</strong><small>{plan.intensity} · {plan.genre} · {plan.duration} · {plan.location} · {plan.participants.join("、")}</small>{rows.map(([label, value]) => { const values = Array.isArray(value) ? value : [value]; return <div className="planning-advice-row" key={label}><span>{label}</span><div>{values.filter(Boolean).map((item) => <p key={item}>{item}</p>)}</div></div>; })}<small>这是可偏航的日常剧情候选，不是已发生事实；采用后仍需用户决定是否进入长期大纲。</small></div>;
}

export function StoryPlanningWorkbench({ onClose, toast }: { onClose: () => void; toast: Toast }) {
	const [tab, setTab] = useState<Tab>("room");
	const [full, setFull] = useState(false);
	const [data, setData] = useState<OutlineViewResponse | null>(null);
	const [history, setHistory] = useState<OutlineHistoryResponse["history"]>([]);
	const [research, setResearch] = useState<ResearchDisplayItem[]>([]);
	const [diagnostics, setDiagnostics] = useState<TurnDiagnosticsResponse | null>(null);
	const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
	const [diagnosticsError, setDiagnosticsError] = useState("");
		const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [action, setAction] = useState("");
	const [liveText, setLiveText] = useState("");
	const [messages, setMessages] = useState<ChatLine[]>([]);
	const [input, setInput] = useState("");
	const [wish, setWish] = useState("");
	const [researchQuestion] = useState("");
	const [researchFilter, setResearchFilter] = useState("");
	const [researchConfidence, setResearchConfidence] = useState("all");
	const [searchTopic, setSearchTopic] = useState("");
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState("");
	const [searchResult, setSearchResult] = useState<OutlineResearchSearchResponse | null>(null);
	const [searchLogs, setSearchLogs] = useState<ResearchSearchLog[]>([]);
	const [searchSchedule, setSearchSchedule] = useState<ResearchSearchScheduleStatus | null>(null);
	const [expandedLog, setExpandedLog] = useState<Set<string>>(() => new Set());
	const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
	const [mode, setMode] = useState<OutlineMode>("manual");
	const [researchMode, setResearchMode] = useState<OutlineResearchMode>("off");
	const [discussionFocus, setDiscussionFocus] = useState<OutlineDiscussionFocus>("open");
	const transcriptRef = useRef<HTMLDivElement>(null);
	const diagnosticsRequest = useRef(0);
	const [corpus, setCorpus] = useState<CorpusWorkbenchResponse | null>(null);
	const [corpusLoading, setCorpusLoading] = useState(false);
	const [corpusError, setCorpusError] = useState("");
	const [corpusDetail, setCorpusDetail] = useState<Record<string, CorpusDetailResponse>>({});
	const [novelJobs, setNovelJobs] = useState<NovelPlayJob[]>([]);
	const [corpusUploading, setCorpusUploading] = useState(false);
	const [corpusUrl, setCorpusUrl] = useState("");
	const corpusRequest = useRef(0);
	const memoryRequest = useRef(0);
	const [memoryEvents, setMemoryEvents] = useState<MemoryEventCard[]>([]);
	const [memoryDiff, setMemoryDiff] = useState<MemoryDiffRecord[]>([]);
	const [memoryLoading, setMemoryLoading] = useState(false);
	const [memoryError, setMemoryError] = useState("");
	const corpusFileRef = useRef<HTMLInputElement>(null);

	const load = async () => {
		setError("");
		try {
			const [outline, versions, researchRaw] = await Promise.all([getOutline(), getOutlineVersions(), getOutlineResearch()]);
			setData(outline);
			setHistory(list(versions.history));
			setResearch(researchItems(researchRaw));
			setMode(outline.settings?.mode ?? "manual");
			setResearchMode(outline.settings?.researchMode ?? "off");
			setMessages(list(outline.chats).flatMap((chat): ChatLine[] => [
				{ role: "user", text: chat.user, focus: chat.focus },
				{ role: "assistant", text: chat.answer, focus: chat.focus, options: textOptions(chat.options), warnings: list(chat.warnings), sceneAdvice: chat.sceneAdvice, dailyPlan: chat.dailyPlan, dailyPlans: chat.dailyPlans },
			]));
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setLoading(false); }
	};
	const loadDiagnostics = async () => {
		const request = ++diagnosticsRequest.current;
		setDiagnosticsLoading(true); setDiagnosticsError("");
		try { const result = await getTurnDiagnostics(20); if (request === diagnosticsRequest.current) setDiagnostics(result); }
		catch (cause) { if (request === diagnosticsRequest.current) setDiagnosticsError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (request === diagnosticsRequest.current) setDiagnosticsLoading(false); }
	};
	const loadCorpus = async () => {
		const request = ++corpusRequest.current;
		setCorpusLoading(true); setCorpusError("");
		try { const result = await listCorpus(); if (request === corpusRequest.current) setCorpus(result); }
		catch (cause) { if (request === corpusRequest.current) setCorpusError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (request === corpusRequest.current) setCorpusLoading(false); }
	};
	const loadNovelJobs = async () => { try { const result = await listNovelPlayJobs(); setNovelJobs(result.jobs); } catch { setNovelJobs([]); } };
	const loadMemory = async () => {
		const request = ++memoryRequest.current;
		setMemoryLoading(true); setMemoryError("");
		try {
			const [events, diff] = await Promise.all([getMemoryEvents(), getMemoryDiff(50)]);
			if (request === memoryRequest.current) { setMemoryEvents(events.events); setMemoryDiff(diff.diff); }
		} catch (cause) { if (request === memoryRequest.current) setMemoryError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (request === memoryRequest.current) setMemoryLoading(false); }
	};
	const uploadCorpusFile = async (file: File) => {
		setCorpusUploading(true);
		try {
			const uploaded = await uploadFile(file);
			const created = await createCorpus(uploaded.file);
			if (created.estimatedCalls > 200) {
				const ok = window.confirm(`「${created.doc.title}」需要约 ${created.estimatedCalls} 次旁路模型调用，继续吗？`);
				if (!ok) { toast("info", "已取消建档（可在上传区删除该文件）"); return; }
			}
			toast("info", `已创建文档：${created.doc.title}（预计 ${created.estimatedCalls} 次辅助调用）`);
			await loadCorpus();
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
		finally { setCorpusUploading(false); if (corpusFileRef.current) corpusFileRef.current.value = ""; }
	};
	const uploadCorpusVersion = async (base: CorpusDocument, file: File) => {
		setCorpusUploading(true);
		try {
			const uploaded = await uploadFile(file);
			const result = await createCorpusVersion(base.id, uploaded.file);
			toast("info", `已创建《${result.doc.title}》追加版本：复用 ${result.reusedChunks} 块，新增 ${result.newChunks} 块`);
			await loadCorpus();
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
		finally { setCorpusUploading(false); if (corpusFileRef.current) corpusFileRef.current.value = ""; }
	};
	const importCorpusUrl = async () => {
		if (!corpusUrl.trim()) return;
		setCorpusUploading(true); setCorpusError("");
		try { await createCorpusUrl(corpusUrl.trim()); setCorpusUrl(""); await loadCorpus(); }
		catch (cause) { setCorpusError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setCorpusUploading(false); }
	};
	const discoverCorpusWorks = async () => {
		setCorpusUploading(true); setCorpusError("");
		try {
			const result = await discoverCorpus();
			if (result.status === "busy") toast("warning", "选书任务正在运行，请稍后再试");
			else if (result.queued.length) toast("info", `已找到 ${result.candidateCount} 部候选，${result.queued.length} 部已进入消化队列`);
			else {
				const reason = result.errors[0]?.message || "没有找到新的作品；已入库作品会自动跳过";
				setCorpusError(reason);
				toast("warning", reason);
			}
			await loadCorpus();
		} catch (cause) { setCorpusError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setCorpusUploading(false); }
	};
	const toggleCorpusDetail = async (doc: CorpusDocument) => {
		if (corpusDetail[doc.id]) { setCorpusDetail((c) => { const next = { ...c }; delete next[doc.id]; return next; }); return; }
		try {
			const detail = await getCorpusDetail(doc.id);
			setCorpusDetail((c) => ({ ...c, [doc.id]: detail }));
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
	};
	const corpusAction = async (doc: CorpusDocument, kind: "pause" | "resume" | "delete") => {
		try {
			if (kind === "pause") { await pauseCorpus(doc.id); toast("info", "已暂停：当前块完成后停止"); }
			else if (kind === "resume") { await resumeCorpus(doc.id); toast("info", "已恢复消化"); }
			else {
				if (!window.confirm(`删除「${doc.title}」？将同时清除其独立套路条目与研究文件。`)) return;
				const result = await deleteCorpus(doc.id);
				setCorpusDetail((c) => { const next = { ...c }; delete next[doc.id]; return next; });
				toast("info", `已删除（清理 ${result.removedMechanisms} 条独占套路）`);
			}
			await loadCorpus();
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
	};

	useEffect(() => { void load(); }, []);
	useEffect(() => {
		if (tab !== "diagnostics") return;
		void loadDiagnostics();
		const timer = window.setInterval(() => void loadDiagnostics(), 5_000);
		return () => { window.clearInterval(timer); diagnosticsRequest.current++; };
	}, [tab]);
	useEffect(() => {
		if (tab !== "corpus" && tab !== "novel-play") return;
		void loadCorpus();
		void loadNovelJobs();
		const timer = window.setInterval(() => { void loadCorpus(); void loadNovelJobs(); }, 1_500);
		return () => { window.clearInterval(timer); corpusRequest.current++; };
	}, [tab]);
	useEffect(() => {
		if (tab !== "memory") return;
		void loadMemory();
		const timer = window.setInterval(() => void loadMemory(), 5_000);
		return () => { window.clearInterval(timer); memoryRequest.current++; };
	}, [tab]);
	useEffect(() => {
		if (tab !== "search") return;
		void loadSearchLogs(); void loadSearchSchedule();
		const timer = window.setInterval(() => { void loadSearchSchedule(); }, 5_000);
		return () => window.clearInterval(timer);
	}, [tab]);
	useEffect(() => {
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
		window.addEventListener("keydown", key);
		document.body.classList.add("planning-open");
		return () => { window.removeEventListener("keydown", key); document.body.classList.remove("planning-open"); };
	}, [onClose]);
	useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }); }, [messages, action]);

	const state = data?.state ?? data?.publicView ?? null;
	const proposals = data ? pendingProposals(data) : [];
	const busy = !!action;
	const activeTab = DIRECTOR_MODULE_BY_ID.get(tab)!;
	const runChat = async (kind: "chat" | "bootstrap" | "reconcile", message?: string) => {
		const userText = message?.trim();
		if (kind === "chat" && !userText) return;
		if (userText) setMessages((current) => [...current, { role: "user", text: userText }]);
		setAction(kind);
		setLiveText("");
		try {
			let answer = "";
			let proposalCreated = false;
			if (kind === "chat") {
				let streaming = "";
				const result = await streamOutlineChat(userText!, researchMode, discussionFocus, (delta) => {
					streaming += delta;
					setLiveText(streaming);
				});
				setLiveText("");
				answer = result.reply || "讨论已完成。";
				proposalCreated = !!result.proposal;
				setMessages((current) => [...current, { role: "assistant", text: answer, focus: result.focus ?? discussionFocus, options: textOptions(result.options), warnings: list(result.warnings), sceneAdvice: result.sceneAdvice, dailyPlan: result.dailyPlan, dailyPlans: result.dailyPlans } as ChatLine]);
			} else if (kind === "bootstrap") {
				await bootstrapOutline(wish.trim() || undefined);
				answer = "首次规划提案已生成，请在提案审阅中确认。";
				proposalCreated = true;
				setMessages((current) => [...current, { role: "assistant", text: answer }]);
			} else {
				const result = await reconcileOutline();
				proposalCreated = !!result.proposal && !result.committed;
				answer = result.stable ? "校准完成：当前大纲无需调整。"
					: result.committed ? "校准提案已通过审计并自动提交。"
					: result.proposal ? "校准提案已生成，请在提案审阅中确认。" : "校准已完成。";
				setMessages((current) => [...current, { role: "assistant", text: answer }]);
			}
			setInput("");
			await load();
			if (proposalCreated) { setTab("proposals"); toast("info", "新提案已进入提案审阅"); }
			else if (kind === "reconcile") toast("info", answer);
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
		finally { setAction(""); }
	};
	const clearDiscussion = async () => {
		if (!window.confirm("清空当前讨论记录？提案、大纲和方案不会被影响，只清空讨论记录。")) return;
		try {
			const result = await clearChats();
			setMessages(list(result.chats).flatMap((chat): ChatLine[] => [
				{ role: "user", text: chat.user, focus: chat.focus },
				{ role: "assistant", text: chat.answer, focus: chat.focus, options: textOptions(chat.options), warnings: list(chat.warnings), sceneAdvice: chat.sceneAdvice, dailyPlan: chat.dailyPlan, dailyPlans: chat.dailyPlans },
			]));
			toast("info", "讨论记录已清空");
		}
		catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
	};
	const refreshResearch = async () => {
		setAction("research");
		try {
			const result = await refreshOutlineResearch(researchQuestion.trim() || undefined);
			setResearch(researchItems(result));
			toast("info", "研究灵感已刷新"); setTab("research");
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
		finally { setAction(""); }
	};
	const runSearch = async () => {
		setSearchBusy(true); setSearchError("");
		try {
			const result = await searchOutlineResearch(searchTopic.trim() || undefined);
			setSearchResult(result);
			setResearch(researchItems(result.view));
			const count = result.search.extracted.length;
			toast("info", count ? `提炼出 ${count} 条机制，已存入创作素材库` : "本次没有提炼出可复用机制（可换个说法再试）");
			await loadSearchLogs();
		} catch (cause) { setSearchError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setSearchBusy(false); }
	};
	const loadSearchLogs = async () => {
		try { const result = await searchResearchLogs(); setSearchLogs(list(result.logs)); }
		catch { /* 历史非关键，静默 */ }
	};
	const loadSearchSchedule = async () => { try { setSearchSchedule(await getResearchSearchSchedule()); } catch { /* 状态非关键 */ } };
	const runAutoSearch = async () => {
		setSearchBusy(true); setSearchError("");
		try { const result = await runResearchSearchSchedule(); await loadSearchLogs(); await loadSearchSchedule(); toast("info", result.status === "busy" ? "自动研究任务正在运行" : `自动研究已启动：${result.topics.length} 个主题`); }
		catch (cause) { setSearchError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setSearchBusy(false); }
	};
	const runRetryExtraction = async (log: ResearchSearchLog) => {
		setSearchBusy(true); setSearchError("");
		try {
			const result = await retrySearchExtraction(log.id);
			setSearchResult(result);
			setResearch(researchItems(result.view));
			const count = result.search.extracted.length;
			toast("info", count ? `再次提炼出 ${count} 条机制，已入库` : "再次提炼没有产出（来源已在历史中保留，可换措辞再试）");
			await loadSearchLogs();
		} catch (cause) { setSearchError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setSearchBusy(false); }
	};
	const toggleLog = (id: string) => setExpandedLog((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
	const saveSettings = async (nextMode: OutlineMode, nextResearch: OutlineResearchMode) => {
		setMode(nextMode); setResearchMode(nextResearch); setAction("settings");
		try { const result = await putOutlineSettings({ mode: nextMode, researchMode: nextResearch }); setMode(result.settings.mode); setResearchMode(result.settings.researchMode); toast("info", "规划模式已保存"); }
		catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); await load(); }
		finally { setAction(""); }
	};
	const proposalAction = async (proposal: OutlineProposalView, accept: boolean) => {
		setAction(proposal.id);
		try {
			if (accept) {
				if (!proposal.proposalHash) throw new Error("提案缺少 proposalHash，请刷新后重试");
				await confirmOutlineProposal(proposal.id, proposal.proposalHash);
			}
			else await rejectOutlineProposal(proposal.id, "用户在提案审阅中拒绝");
			toast("info", accept ? "提案已接受并写入大纲" : "提案已拒绝"); await load();
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
		finally { setAction(""); }
	};

	const foreshadowGroups = useMemo(() => {
		const groups = new Map<string, OutlineNode[]>();
		for (const node of list(state?.foreshadowing)) {
			const status = node.foreshadowingStatus || "conceived";
			groups.set(status, [...(groups.get(status) || []), node]);
		}
		return groups;
	}, [state?.foreshadowing]);

	const eventsById = useMemo(() => new Map(memoryEvents.map((event) => [event.id, event] as const)), [memoryEvents]);

	return <div className="planning-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
		<section className={`planning-workbench ${full ? "is-full" : ""}`} role="dialog" aria-modal="true" aria-label="故事规划导演室">
			<header className="planning-head">
				<div className="planning-brand"><span className="planning-brand-mark">导</span><div><span className="planning-kicker">LIYUAN STORY STUDIO</span><h2>梨园导演室</h2></div></div>
				<div className="planning-head-actions"><span className="planning-revision">大纲版本 {state?.revision ?? "—"}</span><button className="icon-btn planning-full-btn" onClick={() => setFull((value) => !value)}>{full ? "退出全屏" : "全屏工作"}</button><button className="icon-btn" title="关闭 (Esc)" aria-label="关闭导演室" onClick={onClose}><IconClose size={18} /></button></div>
			</header>
			<div className="planning-shell">
				<nav className="planning-tabs" aria-label="导演室功能">
					{DIRECTOR_MODULE_GROUPS.map((group) => <div className="planning-tab-group" key={group.label}><span className="planning-tab-group-label">{group.label}</span>{group.tabs.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}><span><b>{item.label}</b><small>{item.note}</small></span>{item.id === "proposals" && proposals.length > 0 && <em>{proposals.length}</em>}</button>)}</div>)}
				</nav>
				<main className="planning-main">
					<div className="planning-page-head"><div><span>DIRECTOR'S DESK</span><h3>{activeTab.label}</h3><p>{activeTab.note}</p></div>{tab === "proposals" && proposals.length > 0 && <strong>{proposals.length} 项待处理</strong>}</div>
					<div className="planning-body">
				{tab === "diagnostics" && <DiagnosticsModule diagnostics={diagnostics} loading={diagnosticsLoading} error={diagnosticsError} onReload={() => void loadDiagnostics()} />}
				{tab === "memory" && <MemoryModule memoryError={memoryError} loadMemory={() => void loadMemory()} memoryLoading={memoryLoading} memoryEvents={memoryEvents} memoryDiff={memoryDiff} eventsById={eventsById} />}
				{tab !== "diagnostics" && tab !== "memory" && loading && !data && <div className="planning-empty">正在摊开剧本和索引卡…</div>}
				{tab !== "diagnostics" && tab !== "memory" && error && <div className="panel-error planning-error">{error}<button className="drawer-btn" onClick={() => { setLoading(true); void load(); }}>重试</button></div>}
				{tab !== "diagnostics" && tab !== "memory" && !loading && !error && !state && <div className="planning-empty"><strong>导演室还没有故事方案</strong><span>填写体验愿望后点击“首次规划”，建立第一版故事脉络。</span></div>}

				{tab === "room" && <div className="planning-room">
					<div className="planning-transcript" ref={transcriptRef}>
						{messages.length === 0 && <div className="planning-room-intro"><span>从你的体验出发</span><h3>直接讨论你想经历什么，不必写成命令。</h3><p>导演室会读取当前剧情、人物状态、世界与生态工件。可以讨论关系路线、下一阶段节奏、伏笔或你不想出现的走向；方案只有在提案审阅中接受后才写入权威大纲。</p></div>}
						{messages.map((message, index) => <article key={index} className={`planning-chat ${message.role}`}><small>{message.role === "user" ? "你" : "导演"}{message.focus && ` · ${FOCUS_LABEL[message.focus]}`}</small><p>{message.text}</p>{list(message.dailyPlans).length > 0 ? <div className="planning-daily-candidates">{message.dailyPlans!.map((plan, planIndex) => <div key={`${plan.title}-${planIndex}`}><span className="planning-candidate-label">{planIndex === 0 ? "推荐方案" : `备选方案 ${planIndex + 1}`}</span><DailyPlanCard plan={plan} /></div>)}</div> : message.dailyPlan && <DailyPlanCard plan={message.dailyPlan} />}{message.sceneAdvice && <SceneAdviceCard advice={message.sceneAdvice} />}{list(message.warnings).map((warning) => <div className="planning-warning" key={warning}>{warning}</div>)}{list(message.options).length > 0 && <div className="planning-options">{message.options!.map((option) => <button key={option} onClick={() => setInput(option)}>{option}</button>)}</div>}</article>)}
						{action && (liveText ? <article className="planning-chat assistant planning-live"><small>导演 · {FOCUS_LABEL[discussionFocus]}</small><p>{liveText}</p></article> : <div className="planning-typing">导演正在翻阅剧情、人物和故事卡…</div>)}
					</div>
					<div className="planning-mode-strip">{DISCUSSION_MODES.map((modeItem) => <button type="button" key={modeItem.id} className={discussionFocus === modeItem.id ? "active" : ""} title={modeItem.note} onClick={() => { setDiscussionFocus(modeItem.id); if (!input.trim()) setInput(modeItem.prompt); }}><b>{modeItem.label}</b><span>{modeItem.note}</span></button>)}</div>
					<div className="planning-compose"><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={`${FOCUS_LABEL[discussionFocus]}：${DISCUSSION_MODES.find((item) => item.id === discussionFocus)?.note ?? "讨论当前剧情"}…`} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void runChat("chat", input); } }} /><button className="drawer-btn primary" disabled={busy || !input.trim()} onClick={() => void runChat("chat", input)}>问导演</button></div>
					<div className="planning-tools"><input value={wish} onChange={(event) => setWish(event.target.value)} placeholder="首次规划的用户体验愿望（可选）" /><button disabled={busy} onClick={() => void runChat("bootstrap")}>首次规划</button><button disabled={busy || !state} onClick={() => void runChat("reconcile")}>校准</button><button disabled={busy} onClick={() => void refreshResearch()}><IconRefresh size={13} />研究灵感</button><button className="drawer-btn" disabled={busy} onClick={() => void clearDiscussion()}>清空讨论</button></div>
				</div>}

				{tab === "map" && <StoryMapModule state={state!} />}
				{tab === "characters" && <CharactersModule state={state!} />}
				{tab === "foreshadowing" && <ForeshadowingModule state={state!} groups={foreshadowGroups} revealed={revealed} setRevealed={setRevealed} />}
				{tab === "world" && <WorldModule />}
				{tab === "proposals" && <ProposalsModule proposals={proposals} busy={busy} proposalAction={(proposal, accept) => void proposalAction(proposal, accept)} />}
				{tab === "corpus" && <CorpusModule corpusUploading={corpusUploading} busy={busy} discoverCorpusWorks={() => void discoverCorpusWorks()} corpusFileRef={corpusFileRef} uploadCorpusFile={(file) => void uploadCorpusFile(file)} uploadCorpusVersion={(doc, file) => void uploadCorpusVersion(doc, file)} corpusUrl={corpusUrl} setCorpusUrl={setCorpusUrl} importCorpusUrl={() => void importCorpusUrl()} corpusLoading={corpusLoading} corpusError={corpusError} corpus={corpus} novelJobs={novelJobs} corpusDetail={corpusDetail} toggleCorpusDetail={(doc) => void toggleCorpusDetail(doc)} corpusAction={(doc, kind) => void corpusAction(doc, kind)} />}
				{tab === "novel-play" && <NovelPlayModule documents={list(corpus?.documents)} />}
			{tab === "search" && <ResearchSearchModule searchTopic={searchTopic} setSearchTopic={setSearchTopic} searchBusy={searchBusy} searchSchedule={searchSchedule} runSearch={() => void runSearch()} runAutoSearch={() => void runAutoSearch()} searchError={searchError} searchResult={searchResult} searchLogs={searchLogs} busy={busy} expandedLog={expandedLog} toggleLog={toggleLog} runRetryExtraction={(log) => void runRetryExtraction(log)} setTab={setTab} />}
			{tab === "research" && <ResearchLibraryModule items={research} filter={researchFilter} setFilter={setResearchFilter} confidence={researchConfidence} setConfidence={setResearchConfidence} />}
			{tab === "versions" && <VersionsModule mode={mode} researchMode={researchMode} busy={busy} saveSettings={saveSettings} history={history} state={state} />}
				{tab === "system" && <SystemModule />}

					</div>
				</main>
			</div>
		</section>
	</div>;
}
