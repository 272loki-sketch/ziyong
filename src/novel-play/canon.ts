/** Canon data only. This module does not write rp-state or Session Tree facts. */
import { createHash } from "node:crypto";
import { assertNovelEvidence, novelNodeId } from "./source.ts";
import type { NovelEvidence, NovelSource } from "./source.ts";

export interface NovelStage {
	id: string;
	order: number;
	title: string;
}
export interface NovelNode {
	id: string;
	key: string;
	stageId: string;
	order: number;
	title: string;
	summary: string;
	visibility: "public" | "secret";
	/** Explicit causal dependencies, not chronological adjacency. */
	dependsOn: string[];
	sourceRefs: NovelEvidence[];
}
export interface NovelSceneRecallItem { nodeId: string; title: string; summary: string; quote: string; actuality: "candidate"; }
export interface NovelPackage {
	version: 1;
	docId: string;
	sourceFingerprint: string;
	sourceChunkChars: number;
	revision: string;
	stages: NovelStage[];
	nodes: NovelNode[];
	/** Present only on an immutable append-only successor package. */
	lineage?: {
		parentDocId: string;
		parentRevision: string;
		relation: "append-only";
		inheritedNodeIds: string[];
		newNodeIds: string[];
	};
}

/** Typed extraction boundary. Raw model JSON must be parsed before calling this. */
export function buildNovelPackage(source: NovelSource, stages: NovelStage[], nodes: NovelNode[], lineage?: NovelPackage["lineage"]): NovelPackage {
	if (!stages.length || !nodes.length) throw new Error("作品包必须包含阶段和节点");
	const stageIds = new Set<string>();
	const stageOrders = new Set<number>();
	for (const stage of stages) {
		if (!stage.id.trim() || !stage.title.trim() || stageIds.has(stage.id)
			|| !Number.isSafeInteger(stage.order) || stage.order < 0 || stageOrders.has(stage.order)) {
			throw new Error("阶段标识或顺序无效");
		}
		stageIds.add(stage.id); stageOrders.add(stage.order);
	}
	const byId = new Map<string, NovelNode>();
	const orders = new Set<number>();
	for (const node of nodes) {
		if (!stageIds.has(node.stageId) || byId.has(node.id) || !node.title.trim() || !node.summary.trim()
			|| !Number.isSafeInteger(node.order) || node.order < 0 || orders.has(node.order)
			|| !["public", "secret"].includes(node.visibility) || !node.sourceRefs.length) {
			throw new Error("节点结构无效");
		}
		for (const ref of node.sourceRefs) assertNovelEvidence(source, ref);
		if (node.id !== novelNodeId(source, node.sourceRefs[0], node.key) && !lineage?.inheritedNodeIds.includes(node.id)) throw new Error("节点标识与原文不匹配");
		byId.set(node.id, node); orders.add(node.order);
	}
	const stageOrder = new Map(stages.map(stage => [stage.id, stage.order]));
	let previousStageOrder = -1;
	for (const node of [...nodes].sort((a, b) => a.order - b.order)) {
		const order = stageOrder.get(node.stageId)!;
		if (order < previousStageOrder) throw new Error("阶段与节点顺序冲突");
		previousStageOrder = order;
		for (const id of node.dependsOn) {
			const parent = byId.get(id);
			if (!parent || parent.order >= node.order) throw new Error("节点因果依赖必须指向更早的有效节点");
		}
	}
	for (const id of stageIds) if (!nodes.some(node => node.stageId === id)) throw new Error("阶段没有可用节点");
	const data = {
		version: 1 as const, docId: source.docId, sourceFingerprint: source.fingerprint,
		sourceChunkChars: source.chunkChars,
		...(lineage ? { lineage: { ...lineage, inheritedNodeIds: [...lineage.inheritedNodeIds].sort(), newNodeIds: [...lineage.newNodeIds].sort() } } : {}),
		stages: [...stages].sort((a, b) => a.order - b.order).map(stage => ({ id: stage.id, order: stage.order, title: stage.title })),
		nodes: [...nodes].sort((a, b) => a.order - b.order).map(node => ({
			id: node.id, key: node.key, stageId: node.stageId, order: node.order,
			title: node.title, summary: node.summary, visibility: node.visibility,
			dependsOn: [...new Set(node.dependsOn)].sort(),
			sourceRefs: node.sourceRefs.map(ref => ({ chunkIndex: ref.chunkIndex, start: ref.start, end: ref.end, quote: ref.quote })),
		})),
	};
	const revision = createHash("sha256").update(JSON.stringify(data)).digest("hex");
	return { ...data, revision };
}

export type NovelAnchor =
	| { kind?: "node"; packageRevision: string; nodeId: string; position: "before" | "after" }
	| { kind: "source-end"; packageRevision: string };
export type NovelNodeAnchor = Extract<NovelAnchor, { nodeId: string }>;

export function novelAnchorKind(anchor: NovelAnchor): "node" | "source-end" {
	return anchor.kind === "source-end" ? "source-end" : "node";
}
/** Caller must derive this set from the actual Session Tree ancestor chain. */
export interface NovelConflict {
	packageRevision: string;
	nodeId: string;
	/** Authoritative branch entries supporting the conflict, never director proposals. */
	sourceEntryIds: string[];
}

/**
 * Bounded DIRECTOR candidates. Not a writer prompt, initial fact snapshot, or spoiler guarantee.
 * Conflict propagation follows explicit causal edges. Chronology alone never invalidates a node.
 */
export function projectNovelCandidates(pkg: NovelPackage, anchor: NovelNodeAnchor, options: {
	ancestorEntryIds: ReadonlySet<string>;
	conflicts: NovelConflict[];
	conflictsReady: boolean;
	maxChars: number;
}): { candidates: Array<{ nodeId: string; title: string; summary: string; actuality: "candidate" }>; blockedNodeIds: string[]; omittedNodeIds: string[]; usedChars: number } {
	if (anchor.packageRevision !== pkg.revision) throw new Error("存档绑定的作品包版本不匹配");
	if (!["before", "after"].includes(anchor.position)) throw new Error("无效开演位置");
	const current = pkg.nodes.find(node => node.id === anchor.nodeId);
	if (!current) throw new Error("原著锚点不存在");
	if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0) throw new Error("无效资料预算");
	const blocked = new Set(options.conflicts.filter(conflict =>
		conflict.packageRevision === pkg.revision && conflict.sourceEntryIds.length > 0
		&& conflict.sourceEntryIds.every(id => options.ancestorEntryIds.has(id)),
	).map(conflict => conflict.nodeId).filter(id => pkg.nodes.some(node => node.id === id)));
	const ordered = [...pkg.nodes].sort((a, b) => a.order - b.order);
	for (const node of ordered) if (node.dependsOn.some(id => blocked.has(id))) blocked.add(node.id);
	const result: ReturnType<typeof projectNovelCandidates> = {
		candidates: [], blockedNodeIds: [...blocked], omittedNodeIds: [], usedChars: 0,
	};
	// Fail closed until the caller has reconciled conflicts for the current branch.
	if (!options.conflictsReady) return result;
	const eligible = ordered.filter(node => node.stageId === current.stageId && node.visibility === "public"
		&& (anchor.position === "before" ? node.order >= current.order : node.order > current.order)
		&& !blocked.has(node.id));
	for (const node of eligible) {
		const candidate = { nodeId: node.id, title: node.title, summary: node.summary, actuality: "candidate" as const };
		// Count the complete serialized payload, including identifiers and punctuation.
		const chars = JSON.stringify([...result.candidates, candidate]).length;
		if (chars > options.maxChars) { result.omittedNodeIds.push(node.id); continue; }
		result.candidates.push(candidate); result.usedChars = chars;
	}
	return result;
}

/** Same-stage event group for director context; candidates, never committed facts. */
export function projectNovelSceneRecall(pkg: NovelPackage, anchor: NovelNodeAnchor, maxChars = 9000): NovelSceneRecallItem[] {
	if (anchor.packageRevision !== pkg.revision) return [];
	const current = pkg.nodes.find(node => node.id === anchor.nodeId);
	if (!current) return [];
	const nodes = pkg.nodes.filter(node => node.stageId === current.stageId && node.visibility === "public").sort((a, b) => a.order - b.order);
	const result: NovelSceneRecallItem[] = [];
	for (const node of nodes) {
		const quote = node.sourceRefs[0]?.quote?.slice(0, 900) ?? "";
		const item = { nodeId: node.id, title: node.title, summary: node.summary, quote, actuality: "candidate" as const };
		if (JSON.stringify([...result, item]).length > maxChars) break;
		result.push(item);
	}
	return result;
}
