import { api, apiDelete, apiGet, apiPost } from "../api.ts";

export type NovelPlayJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface NovelPlayPackage { docId: string; title: string; revision: string; stageCount: number; nodeCount: number; builtAt: string }
export interface NovelPlayJob { id: string; docId: string; status: NovelPlayJobStatus; createdAt: string; updatedAt: string; progress?: { completed: number; total: number }; kind?: "package" | "profiles" | "extension"; parentDocId?: string; parentRevision?: string; result?: NovelPlayPackage & { parentRevision?: string; inheritedNodes?: number; newNodes?: number }; error?: string }
export interface NovelPlayStartOptions { docId: string; revision: string; title: string; capabilities: { playerModes: Array<"new-character" | "existing-character">; startKinds: Array<"node" | "source-end"> }; sourceEnd: { kind: "source-end"; chapterLabel: string; sourceChars: number }; nodes: Array<{ nodeId: string; title: string; summary: string; stageTitle: string; stageOrder: number; nodeOrder: number; source: { chunkIndex: number; chapters: string[] } }> }
export interface NovelPlayDraft {
	user: { name: string; identity: string; mode?: "new-character" | "existing-character" };
	time: string;
	place: string;
	sceneText: string;
	openingNarration: string;
	publicCharacterProfiles: Array<{ name: string; profile: string }>;
	publicWorldFacts: string[];
	characterProfiles?: Array<{ name: string; keys: string[]; content: string; evidenceQuotes: string[] }>;
}
export interface NovelPlayPreview {
	token: string;
	expiresAt: string;
	package: { docId: string; revision: string };
	anchor: { packageRevision: string; kind?: "node"; nodeId: string; position: "before" | "after" } | { packageRevision: string; kind: "source-end" };
	draft: NovelPlayDraft;
}
export type NovelPlayStartResult =
	| { card: string; session: "created" }
	| { card?: string; session: "recovery-required"; recovery: string };

export const buildNovelPlay = (docId: string) => apiPost<{ job: NovelPlayJob }>("/api/novel-play/build", { docId });
export const listNovelPlayJobs = () => apiGet<{ jobs: NovelPlayJob[] }>("/api/novel-play/status", { bypassCache: true });
export const getNovelPlayJob = (jobId: string, signal?: AbortSignal) => api<{ job: NovelPlayJob }>(`/api/novel-play/status/${encodeURIComponent(jobId)}`, { signal });
export const cancelNovelPlayJob = (jobId: string) => apiDelete<{ job: NovelPlayJob }>(`/api/novel-play/status/${encodeURIComponent(jobId)}`);
export const getNovelPlayStartOptions = (docId: string, revision: string, signal?: AbortSignal) => api<{ package: NovelPlayStartOptions }>(`/api/novel-play/start?docId=${encodeURIComponent(docId)}&revision=${encodeURIComponent(revision)}`, { signal });
export const previewNovelPlay = (input: { docId: string; revision: string; startKind?: "node" | "source-end"; continuationAcknowledged?: boolean; nodeId?: string; position?: "before" | "after"; player: { mode: "new-character" | "existing-character"; name: string; identity: string } }, signal?: AbortSignal) => api<{ preview: NovelPlayPreview }>("/api/novel-play/preview", { method: "POST", body: JSON.stringify(input), signal });
export const startNovelPlay = (previewToken: string, signal?: AbortSignal) => api<{ started: NovelPlayStartResult }>("/api/novel-play/start", { method: "POST", body: JSON.stringify({ previewToken }), signal });
export const buildNovelPlayExtension = (baseDocId: string, baseRevision: string, targetDocId: string) => apiPost<{ job: NovelPlayJob }>("/api/novel-play/extend", { baseDocId, baseRevision, targetDocId });
export interface NovelPlayUpgradePreview { token: string; expiresAt: string; from: unknown; to: unknown; progress?: unknown; newNodes: number; leafId: string; }
export const previewNovelPlayUpgrade = (targetDocId: string, targetRevision: string) => apiPost<{ preview: NovelPlayUpgradePreview }>("/api/novel-play/upgrade/preview", { targetDocId, targetRevision });
export const commitNovelPlayUpgrade = (previewToken: string) => apiPost<{ committed: unknown }>("/api/novel-play/upgrade/commit", { previewToken });
