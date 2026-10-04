import { createHash } from "node:crypto";

import type { ArcShapeRole, ForeshadowingStatus, OutlineCollectionName, OutlineNode, OutlineState } from "./schema.ts";
import type { CorpusDailyPattern, NarrativeAsset } from "./corpus.ts";
import type { OutlineResearchView } from "./research.ts";
import type { OutlineDiscussionFocus } from "./schema.ts";

export type OutlineConsumer = "continuity" | "director" | "writer" | "world" | "ecology" | "public";
export interface SafeOutlineNode { id: string; title: string; summary: string; status: OutlineNode["status"]; rigidity: OutlineNode["rigidity"]; visibility: OutlineNode["visibility"]; actuality: OutlineNode["actuality"]; dependsOn: string[]; foreshadowingStatus?: ForeshadowingStatus }
export interface OutlineProjection { revision: number; hash: string; premise: string; currentFocus: string[]; alignment?: { summary: string; confidence: number; conflicts: string[] }; collections: Partial<Record<OutlineCollectionName, SafeOutlineNode[]>>; nonFactGuidance?: true }
const COLLECTIONS: OutlineCollectionName[] = ["constraints", "arcs", "characterArcs", "threads", "milestones", "foreshadowing", "settings"];
const safe = (node: OutlineNode, collection: OutlineCollectionName): SafeOutlineNode => ({ id: node.id, title: node.title, summary: node.summary, status: node.status, rigidity: node.rigidity, visibility: node.visibility, actuality: node.actuality, dependsOn: [...node.dependsOn], ...(collection === "foreshadowing" ? { foreshadowingStatus: (node as { foreshadowingStatus: ForeshadowingStatus }).foreshadowingStatus } : {}) });

export function projectOutline(state: OutlineState, consumer: OutlineConsumer): OutlineProjection {
	const guidance = consumer === "world" || consumer === "ecology", collections: OutlineProjection["collections"] = {};
	let remaining = consumer === "director" ? 16 : Number.POSITIVE_INFINITY;
	if (!guidance) for (const collection of COLLECTIONS) {
		let rows = (state[collection] as OutlineNode[]).filter((node) => node.visibility !== "secret");
		if (consumer === "public") rows = rows.filter((node) => node.visibility === "public");
		if (consumer === "writer") rows = rows.filter((node) => node.visibility === "public" && (node.rigidity === "hard" || state.currentFocus.includes(node.id) || ["active", "blocked"].includes(node.status)));
		if (consumer === "director") {
			rows = rows
				.filter((node) => node.rigidity === "hard" || state.currentFocus.includes(node.id) || ["active", "blocked"].includes(node.status))
				.sort((a, b) => Number(b.rigidity === "hard") - Number(a.rigidity === "hard") || Number(state.currentFocus.includes(b.id)) - Number(state.currentFocus.includes(a.id)))
				.slice(0, remaining);
			remaining -= rows.length;
		}
		if (consumer === "continuity") rows = rows.filter((node) => node.actuality === "established" || node.status === "fulfilled" || (collection === "foreshadowing" && !["conceived", "prepared"].includes(String((node as { foreshadowingStatus?: string }).foreshadowingStatus))));
		collections[collection] = rows.map((node) => safe(node, collection));
	}
	const visibleIds = new Set(Object.values(collections).flatMap((rows) => rows ?? []).map((node) => node.id));
	return { revision: state.revision, hash: state.hash, premise: consumer === "public" || consumer === "writer" || guidance ? "" : state.premise, currentFocus: state.currentFocus.filter((id) => visibleIds.has(id)), ...(consumer === "continuity" || consumer === "director" ? { alignment: { summary: state.alignment.summary, confidence: state.alignment.confidence, conflicts: [...state.alignment.conflicts] } } : {}), collections, ...(guidance ? { nonFactGuidance: true as const } : {}) };
}

export interface ArcShapePosition { role: ArcShapeRole; index: number; total: number }

export function computeArcShapeRole(liveWaypoints: Array<{ id: string; status?: string }>, currentWaypointId: string): ArcShapePosition {
	if (!liveWaypoints.length) return { role: "climax", index: 0, total: 0 };
	const total = liveWaypoints.length;
	const index = liveWaypoints.findIndex((wp) => wp.id === currentWaypointId);
	if (index < 0) return { role: "rising", index: -1, total };  // ID not in live set
	const pos = index + 1;
	let role: ArcShapeRole;
	if (total <= 1 || pos >= total) role = "climax";
	else if (pos === total - 1) role = "hardest";
	else if (pos > 0 && pos <= Math.ceil(total / 4)) role = "setup";
	else role = "rising";
	return { role, index: pos, total };
}

export function arcShapeRolesByStatus(waypoints: Array<{ id: string; status: string }>, currentIndex: number): ArcShapePosition {
	const live = waypoints.filter((wp) => wp.status !== "skipped");
	const current = waypoints[currentIndex];
	if (!current) return { role: "climax", index: -1, total: live.length };
	return computeArcShapeRole(live, current.id);
}

export interface CorpusWorkspaceProjection {
	documents: Array<{ title: string; chars: number; synopsis: string; tropeCount: number }>;
	mechanisms: Array<{ id: string; sourceIds: string[]; mechanism: string; appliesWhen: string; failureWarning: string; confidence?: string }>;
	assets: Array<NarrativeAsset & { id: string; docId: string }>;
	dailyPatterns: Array<CorpusDailyPattern & { id: string; docId: string }>;
}

export type CorpusResearchKind = "document" | "mechanism" | "asset" | "dailyPattern";
export interface CorpusResearchIndexItem {
	id: string;
	kind: CorpusResearchKind;
	docId?: string;
	title: string;
	text: string;
}

const corpusAssetId = (kind: "asset" | "dailyPattern", docId: string, locator: string, title: string): string => {
	const digest = createHash("sha256").update(`${kind}\n${docId}\n${locator}\n${title}`).digest("hex").slice(0, 16);
	return `corpus-${kind}-${digest}`;
};

/**
 * 大纲模型检索用的研究索引（导演室讨论的子 agent 候选池）。
 * view 已是跨卡全量，这里做确定性限量——只给子 agent 足够挑选的候选，
 * 避免全量小说资产撑爆 outlineCorpusResearch 的旁路体积；最终注入仍由
 * projectSelectedCorpusWorkspace 按选中 id 收敛。
 */
export function projectCorpusResearchIndex(view: OutlineResearchView): { documents: CorpusResearchIndexItem[]; items: CorpusResearchIndexItem[] } {
	const documents = view.documents
		.filter((doc) => doc.status === "ready")
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, 8)
		.map((doc) => ({ id: doc.id, kind: "document" as const, title: doc.title.slice(0, 160), text: `字数 ${doc.chars}；梗概：${(doc.synopsisPreview ?? "").slice(0, 500)}` }));
	const items: CorpusResearchIndexItem[] = [
		...view.mechanisms.filter((row) => row.enabled !== false).slice(0, 40).map((row) => ({ id: row.id, kind: "mechanism" as const, title: row.mechanism.slice(0, 180), text: `机制：${row.mechanism.slice(0, 360)}\n适用：${row.appliesWhen.slice(0, 220)}\n警告：${row.failureWarning.slice(0, 220)}\n可信度：${row.confidence}` })),
		...view.assets.slice(0, 24).map((asset) => ({ id: corpusAssetId("asset", asset.docId, asset.locator, asset.title), kind: "asset" as const, docId: asset.docId, title: asset.title.slice(0, 160), text: `机制：${asset.mechanism.slice(0, 360)}\n适用：${asset.appliesWhen.slice(0, 220)}\n起手：${asset.opening.slice(0, 180)}\n转折：${asset.turn.slice(0, 180)}\n停点：${asset.stopPoint.slice(0, 180)}` })),
		...view.dailyPatterns.slice(0, 16).map((pattern) => ({ id: corpusAssetId("dailyPattern", pattern.docId, pattern.locator, pattern.title), kind: "dailyPattern" as const, docId: pattern.docId, title: pattern.title.slice(0, 160), text: `场景：${pattern.setting.slice(0, 180)}\n活动：${pattern.surfaceActivity.slice(0, 240)}\n发起：${pattern.initiative.slice(0, 180)}\n甜点：${pattern.sweetBeat.slice(0, 180)}\n摩擦：${pattern.friction.slice(0, 180)}\n关系微变：${pattern.microChange.slice(0, 180)}\n停点：${pattern.naturalStop.slice(0, 180)}` })),
	];
	return { documents, items };
}

export function projectSelectedCorpusWorkspace(view: OutlineResearchView, selectedIds: ReadonlySet<string>, options: { maxItems?: number } = {}): CorpusWorkspaceProjection {
	const maxItems = Math.max(1, Math.min(24, options.maxItems ?? 12));
	const selectedMechanisms = view.mechanisms.filter((row) => selectedIds.has(row.id)).slice(0, maxItems);
	const selectedAssets = view.assets.filter((asset) => selectedIds.has(corpusAssetId("asset", asset.docId, asset.locator, asset.title))).slice(0, maxItems);
	const selectedDaily = view.dailyPatterns.filter((pattern) => selectedIds.has(corpusAssetId("dailyPattern", pattern.docId, pattern.locator, pattern.title))).slice(0, maxItems);
	const selectedDocs = view.documents.filter((doc) => selectedIds.has(doc.id) && doc.status === "ready").slice(0, 10);
	return {
		documents: selectedDocs.map((doc) => ({ title: doc.title, chars: doc.chars, synopsis: (doc.synopsisPreview ?? "").slice(0, 800), tropeCount: doc.tropeCount ?? 0 })),
		mechanisms: selectedMechanisms.map((row) => ({ id: row.id, sourceIds: row.sourceIds.slice(0, 4), mechanism: row.mechanism.slice(0, 600), appliesWhen: row.appliesWhen.slice(0, 500), failureWarning: row.failureWarning.slice(0, 500), confidence: row.confidence })),
		assets: selectedAssets.map((asset) => ({ ...asset, id: corpusAssetId("asset", asset.docId, asset.locator, asset.title) })),
		dailyPatterns: selectedDaily.map((pattern) => ({ ...pattern, id: corpusAssetId("dailyPattern", pattern.docId, pattern.locator, pattern.title) })),
	};
}

/**
 * 大纲模型看到的「小说资产」安全投影：只注入 ready 的文档（跨卡共享，素材抽象可复用），
 * 每条只给 title / chars / synopsis 前 400 字 / tropeCount，绝不整包注入 block 与弧线摘要。
 */
export function projectCorpusWorkspace(view: OutlineResearchView, options: { maxDocs?: number; maxAssets?: number; focus?: OutlineDiscussionFocus; query?: string } = {}): CorpusWorkspaceProjection {
	const maxDocs = Math.max(1, Math.min(10, options.maxDocs ?? 3));
	const documents = view.documents
		.filter((doc) => doc.status === "ready")
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, maxDocs)
		.map((doc) => ({
			title: doc.title,
			chars: doc.chars,
			synopsis: (doc.synopsisPreview ?? "").slice(0, 400),
			tropeCount: doc.tropeCount ?? 0,
		}));
	// 研究库可持续增长；大纲上下文只带有限、裁剪后的方法论，页面仍保留完整条目。
	const query = `${options.focus ?? "open"} ${options.query ?? ""}`.toLowerCase();
	const focusKinds: Record<string, NarrativeAsset["kind"][]> = {
		daily: ["scene-pattern", "relationship-beat"],
		"next-beat": ["scene-pattern", "relationship-beat"],
		dialogue: ["dialogue-move", "relationship-beat"],
		character: ["relationship-beat", "dialogue-move"],
		diagnose: ["scene-pattern", "dialogue-move"],
	};
	const score = (text: string, kind?: NarrativeAsset["kind"]): number => {
		const terms = query.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2);
		for (const phrase of terms.filter((term) => /[\p{Script=Han}]/u.test(term))) {
			for (let index = 0; index < phrase.length - 1; index++) terms.push(phrase.slice(index, index + 2));
		}
		const matches = terms.reduce((total, term) => total + (text.toLowerCase().includes(term) ? 1 : 0), 0);
		return matches * 5 + (kind && focusKinds[options.focus ?? "open"]?.includes(kind) ? 8 : 0);
	};
	const mechanisms = view.mechanisms.filter((row) => row.enabled !== false)
		.map((row, index) => ({ row, rank: score(`${row.mechanism} ${row.appliesWhen} ${row.failureWarning}`) + (row.confidence === "audited" ? 4 : row.confidence === "system-grounded" ? 2 : 0) + Math.min(row.usage?.adopted ?? 0, 5) - Math.min(row.usage?.dismissed ?? 0, 5) + index / 1000 }))
		.sort((a, b) => b.rank - a.rank)
		.slice(0, 24)
		.map((row) => ({
			id: row.row.id,
			sourceIds: row.row.sourceIds.slice(0, 4),
			mechanism: row.row.mechanism.slice(0, 420),
			appliesWhen: row.row.appliesWhen.slice(0, 320),
			failureWarning: row.row.failureWarning.slice(0, 320),
			confidence: row.row.confidence,
		}));
	const assets = view.assets
		.map((asset, index) => ({ asset, rank: score(`${asset.title} ${asset.mechanism} ${asset.appliesWhen} ${asset.pressure} ${asset.desiredExperience}`, asset.kind) + index / 1000 }))
		.sort((a, b) => b.rank - a.rank)
		.slice(0, Math.max(1, Math.min(20, options.maxAssets ?? 8)))
		.map(({ asset }, index) => ({ ...asset, id: `asset-${asset.docId}-${index + 1}-${asset.locator || asset.title.slice(0, 16)}` }));
	const dailyPatterns = view.dailyPatterns
		.map((pattern, index) => ({ pattern, rank: score(`${pattern.title} ${pattern.setting} ${pattern.surfaceActivity} ${pattern.initiative} ${pattern.sweetBeat} ${pattern.friction} ${pattern.microChange}`, "scene-pattern") + (options.focus === "daily" ? 10 : 0) + index / 1000 }))
		.sort((a, b) => b.rank - a.rank)
		.slice(0, options.focus === "daily" ? 6 : 2)
		.map(({ pattern }, index) => ({ ...pattern, id: `daily-${pattern.docId}-${index + 1}-${pattern.locator || pattern.title.slice(0, 16)}` }));
	return { documents, mechanisms, assets, dailyPatterns };
}
