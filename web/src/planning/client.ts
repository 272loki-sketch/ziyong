import { apiGet, apiPost, apiPut, apiDelete } from "../api.ts";
import type {
	CorpusCreateResponse, CorpusDetailResponse, CorpusDiscoveryResponse, CorpusWorkbenchResponse,
	MemoryDiffResponse, MemoryEventsResponse,
	OutlineChatHistory, OutlineChatResponse, OutlineDiscussionFocus, OutlineHistoryResponse, OutlineProposal, OutlineReconcileResponse,
	OutlineDailyPlan, OutlineResearchSearchResponse, OutlineResearchView, ResearchSearchScheduleRun, ResearchSearchScheduleStatus, OutlineSceneAdvice, OutlineSettings, OutlineSettingsResponse, OutlineViewResponse, ResearchSearchLogsResponse, TurnDiagnosticsResponse,
} from "./types.ts";

export const getOutline = () => apiGet<OutlineViewResponse>("/api/outline", { bypassCache: true });
export const getOutlineVersions = () => apiGet<OutlineHistoryResponse>("/api/outline/versions", { bypassCache: true });
export const chatOutline = (message: string, researchMode?: OutlineSettings["researchMode"], focus: OutlineDiscussionFocus = "open") =>
	apiPost<OutlineChatResponse>("/api/outline/chat", { message, researchMode, focus });
export const bootstrapOutline = (experienceWish?: string) =>
	apiPost<OutlineProposal>("/api/outline/bootstrap", { experienceWish });
export const reconcileOutline = () => apiPost<OutlineReconcileResponse>("/api/outline/reconcile", {});
export const confirmOutlineProposal = (id: string, proposalHash: string) =>
	apiPost(`/api/outline/proposals/${encodeURIComponent(id)}/confirm`, { proposalHash });
export const rejectOutlineProposal = (id: string, reason?: string) =>
	apiPost(`/api/outline/proposals/${encodeURIComponent(id)}/reject`, { reason });
export const getOutlineResearch = () => apiGet<OutlineResearchView>("/api/outline/research", { bypassCache: true });
export const refreshOutlineResearch = (topic?: string) =>
	apiPost<OutlineResearchView>("/api/outline/research/refresh", { topic });
export const searchOutlineResearch = (topic?: string) =>
	apiPost<OutlineResearchSearchResponse>("/api/outline/research/search", { topic });
export const searchResearchLogs = () => apiGet<ResearchSearchLogsResponse>("/api/outline/research/search/logs", { bypassCache: true });
export const getResearchSearchSchedule = () => apiGet<ResearchSearchScheduleStatus>("/api/outline/research/search/schedule", { bypassCache: true });
export const runResearchSearchSchedule = () => apiPost<ResearchSearchScheduleRun>("/api/outline/research/search/schedule/run", {});
export const retrySearchExtraction = (id: string) =>
	apiPost<OutlineResearchSearchResponse>(`/api/outline/research/search/logs/${encodeURIComponent(id)}/retry`, {});
export const putOutlineSettings = (settings: Required<OutlineSettings>) =>
	apiPut<OutlineSettingsResponse>("/api/outline/settings", settings);
export const getTurnDiagnostics = (limit = 12) => apiGet<TurnDiagnosticsResponse>(`/api/turn-diagnostics?limit=${limit}`, { bypassCache: true });
export const listCorpus = () => apiGet<CorpusWorkbenchResponse>("/api/outline/corpus", { bypassCache: true });
export const createCorpus = (file: string) => apiPost<CorpusCreateResponse>("/api/outline/corpus", { file });
export const createCorpusVersion = (baseDocId: string, file: string) => apiPost<CorpusCreateResponse & { reusedChunks: number; newChunks: number }>("/api/outline/corpus/version", { baseDocId, file });
export const createCorpusUrl = (url: string) => apiPost<CorpusCreateResponse>("/api/outline/corpus/url", { url });
export const discoverCorpus = () => apiPost<CorpusDiscoveryResponse>("/api/outline/corpus/discover", {});
export const getCorpusDetail = (id: string) => apiGet<CorpusDetailResponse>(`/api/outline/corpus/${encodeURIComponent(id)}`, { bypassCache: true });
export const pauseCorpus = (id: string) => apiPost<CorpusWorkbenchResponse>(`/api/outline/corpus/${encodeURIComponent(id)}/pause`, {});
export const resumeCorpus = (id: string) => apiPost<CorpusWorkbenchResponse>(`/api/outline/corpus/${encodeURIComponent(id)}/resume`, {});
export const deleteCorpus = (id: string) => apiDelete<{ ok: true; removedMechanisms: number }>(`/api/outline/corpus/${encodeURIComponent(id)}`);
export const clearChats = () => apiDelete<{ ok: true; chats: OutlineChatHistory[] }>("/api/outline/chats");

export const getMemoryEvents = () => apiGet<MemoryEventsResponse>("/api/memory/events", { bypassCache: true });
export const getMemoryDiff = (limit = 50) => apiGet<MemoryDiffResponse>(`/api/memory/diff?limit=${limit}`, { bypassCache: true });

export async function streamOutlineChat(message: string, researchMode?: OutlineSettings["researchMode"], focus: OutlineDiscussionFocus = "open", onDelta?: (text: string) => void): Promise<{ reply: string; options?: Array<string | { id?: string; title?: string; experience?: string; mechanism?: string; tradeoffs?: string | string[]; label?: string; text?: string; value?: string }>; proposal?: OutlineProposal; proposalHash?: string; warnings: string[]; focus?: OutlineDiscussionFocus; sceneAdvice?: OutlineSceneAdvice; dailyPlan?: OutlineDailyPlan; dailyPlans?: OutlineDailyPlan[] }> {
	const res = await fetch("/api/outline/chat/stream", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message, researchMode, focus }),
	});
	if (!res.ok) {
		let errText = `stream 请求失败（HTTP ${res.status}）`;
		try { const body = await res.json(); if (body?.error) errText = body.error; } catch { /* not JSON */ }
		throw new Error(errText);
	}
	const reader = res.body?.getReader();
	if (!reader) throw new Error("stream 响应没有 body");
	const decoder = new TextDecoder();
	let buffer = "";
	let error = "";
	let currentEvent = "";
	const resultDeltas: string[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.startsWith("event: ")) { currentEvent = line.slice(7).trim(); continue; }
			if (!line.startsWith("data: ")) { currentEvent = ""; continue; }
			const data = line.slice(6);
			if (currentEvent === "delta") { onDelta?.(data); resultDeltas.push(data); }
			else if (currentEvent === "error") error = data;
			else if (currentEvent === "done") {
				try { return JSON.parse(data); }
				catch { throw new Error("stream 最终结果不可解析"); }
			}
			currentEvent = "";
		}
	}
	if (error) throw new Error(error);
	if (resultDeltas.length > 0) {
		const combined = resultDeltas.join("");
		const match = combined.match(/\{[\s\S]*\}/);
		if (match) {
			try { return JSON.parse(match[0]); }
			catch { throw new Error(`导演回复不可解析（${combined.length} 字）`); }
		}
		throw new Error(`导演回复中没有 JSON（${combined.length} 字）：${combined.slice(0, 400)}`);
	}
	throw new Error("stream 未产出任何内容");
}
