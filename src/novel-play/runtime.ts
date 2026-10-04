import type { BranchEntryLike } from "../stage/assemble.ts";
import type { NovelAnchor, NovelConflict, NovelNode, NovelNodeAnchor, NovelPackage, NovelSceneRecallItem } from "./canon.ts";
import { projectNovelCandidates, projectNovelSceneRecall } from "./canon.ts";
import { loadNovelPackage } from "./store.ts";

export const NOVEL_PLAY_STATE_ENTRY_TYPE = "rp-novel-play";
export const NOVEL_PLAY_UPGRADE_ENTRY_TYPE = "rp-novel-play-upgrade";
export const MAX_NOVEL_BRANCH_FACT_CHARS = 40_000;
export const MAX_NOVEL_CALIBRATION_CANDIDATE_CHARS = 12_000;
const MAX_DIRECTOR_CANDIDATE_CHARS = 6_000;

export interface NovelPlayCardBinding { docId: string; revision: string; startNodeId?: string; position?: "before" | "after"; anchorKind: "node" | "source-end"; }
export interface NovelPlayRuntimeState { version: 1; card: NovelPlayCardBinding; progress: NovelNodeAnchor; conflicts: NovelConflict[]; preparedFromLeafId: string; }
export interface NovelPlayUpgradeEntry { version: 1; from: NovelPlayCardBinding; to: NovelPlayCardBinding; sourceLeafId: string; confirmedAt: string; }
export interface NovelPlayProjection { version: 1; packageRevision: string; anchor: NovelAnchor; candidates: Array<{ nodeId: string; title: string; summary: string; actuality: "candidate" }>; sceneRecall: NovelSceneRecallItem[]; blockedNodeIds: string[]; omittedNodeIds: string[]; usedChars: number; }
export interface PreparedNovelPlayTurn { projection: NovelPlayProjection; state: NovelPlayRuntimeState; }
export interface NovelPlayContext { chapter: string; stage: string; nodeTitle: string; nodeSummary: string; position: "before" | "after"; kind?: "node" | "source-end"; }
export interface PrepareNovelPlayTurnInput {
	cwd: string; rawCard: unknown; branch: BranchEntryLike[]; expectedLeafId: string | null; skillBody: string;
	modelCall: (systemPrompt: string, userText: string) => Promise<string | undefined>;
	getLeafId: () => string | null; loadPackage?: typeof loadNovelPackage;
}

type CalibrationCandidate = { nodeId: string; stageId: string; stageOrder: number; order: number; title: string; summary: string; dependsOn: string[] };
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

export function novelPlayCardBinding(rawCard: unknown): NovelPlayCardBinding | undefined {
	const root = record(rawCard), data = record(root?.data) ?? root, extension = record(record(data?.extensions)?.liyuanNovelPlay);
	if (!extension) return undefined;
	const docId = text(extension.docId), revision = text(extension.revision), startNodeId = text(extension.startNodeId), position = extension.position;
	if (!docId || !revision) return undefined;
	if (extension.anchorKind === "source-end") return { docId, revision, anchorKind: "source-end" };
	if (!startNodeId || (position !== "before" && position !== "after")) return undefined;
	return { docId, revision, startNodeId, position, anchorKind: "node" };
}

function bindingEqual(a: NovelPlayCardBinding, b: NovelPlayCardBinding): boolean {
	return a.docId === b.docId && a.revision === b.revision && a.startNodeId === b.startNodeId && a.position === b.position && a.anchorKind === b.anchorKind;
}

function bindingFrom(value: unknown): NovelPlayCardBinding | undefined {
	const raw = record(value), docId = text(raw?.docId), revision = text(raw?.revision), startNodeId = text(raw?.startNodeId), position = raw?.position;
	if (!docId || !revision) return undefined;
	if (raw?.anchorKind === "source-end") return { docId, revision, anchorKind: "source-end" };
	if (!startNodeId || (position !== "before" && position !== "after")) return undefined;
	return { docId, revision, startNodeId, position, anchorKind: "node" };
}

export function effectiveNovelPlayBinding(cwd: string, rawCard: unknown, branch: BranchEntryLike[], loader: typeof loadNovelPackage = loadNovelPackage): NovelPlayCardBinding | undefined {
	let binding = novelPlayCardBinding(rawCard);
	if (!binding) return undefined;
	const ids = new Set(branch.map(entry => text(entry.id)).filter(Boolean));
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== NOVEL_PLAY_UPGRADE_ENTRY_TYPE) continue;
		const value = record(entry.data), from = bindingFrom(value?.from), to = bindingFrom(value?.to), sourceLeafId = text(value?.sourceLeafId);
		if (value?.version !== 1 || !from || !to || !sourceLeafId || !ids.has(sourceLeafId) || !bindingEqual(from, binding)) continue;
		try {
			const pkg = loader(cwd, to.docId, to.revision).package;
			if (pkg.docId !== to.docId || pkg.revision !== to.revision) continue;
			if (to.anchorKind === "node" && !pkg.nodes.some(node => node.id === to.startNodeId && node.visibility === "public")) continue;
			binding = to;
		} catch { /* Ignore a malformed or missing upgrade and retain the prior binding. */ }
	}
	return binding;
}

/** Deterministic current-node context for the writer; never calls a model. */
export function novelPlayContextForCard(cwd: string, rawCard: unknown): NovelPlayContext | undefined {
	return novelPlayContextForBranch(cwd, rawCard, []);
}

/** Uses the latest validated progress on the current branch when available. */
export function novelPlayContextForBranch(cwd: string, rawCard: unknown, branch: BranchEntryLike[]): NovelPlayContext | undefined {
	const binding = effectiveNovelPlayBinding(cwd, rawCard, branch);
	if (!binding) return undefined;
	try {
		const stored = loadNovelPackage(cwd, binding.docId, binding.revision);
		const state = novelPlayStateFromBranch(branch, binding, stored.package);
		if (binding.anchorKind === "source-end") return { chapter: stored.source.chunks.at(-1)?.chapters.join(" / ") || "原文终点", stage: "导入文本终点", nodeTitle: "", nodeSummary: "", position: "after", kind: "source-end" };
		const anchor = state?.progress ?? { packageRevision: stored.package.revision, nodeId: binding.startNodeId!, position: binding.position! };
		const node = stored.package.nodes.find(item => item.id === anchor.nodeId && item.visibility === "public");
		if (!node) return undefined;
		const stage = stored.package.stages.find(item => item.id === node.stageId);
		const chapter = stored.source.chunks.find(item => item.index === node.sourceRefs[0]?.chunkIndex)?.chapters ?? [];
		return {
			chapter: chapter.join(" / ") || `分块 ${(node.sourceRefs[0]?.chunkIndex ?? 0) + 1}`,
			stage: stage?.title || `阶段 ${stage?.order ?? 0}`,
			nodeTitle: node.title,
			nodeSummary: node.summary,
			position: anchor.position,
		};
	} catch { return undefined; }
}
function sameCard(a: NovelPlayCardBinding, b: NovelPlayCardBinding): boolean { return a.docId === b.docId && a.revision === b.revision && a.startNodeId === b.startNodeId && a.position === b.position && a.anchorKind === b.anchorKind; }
function nodeById(pkg: NovelPackage, nodeId: string): NovelNode | undefined { return pkg.nodes.find(node => node.id === nodeId); }
function validAnchor(pkg: NovelPackage, value: unknown): NovelNodeAnchor | undefined {
	const raw = record(value), nodeId = text(raw?.nodeId), packageRevision = text(raw?.packageRevision), position = raw?.position;
	if (packageRevision !== pkg.revision || !nodeById(pkg, nodeId) || (position !== "before" && position !== "after")) return undefined;
	return { packageRevision, nodeId, position };
}
function conflictsOf(pkg: NovelPackage, value: unknown, ancestorIds: ReadonlySet<string>, allowedNodeIds?: ReadonlySet<string>): NovelConflict[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const conflicts: NovelConflict[] = [];
	for (const item of value) {
		const raw = record(item), nodeId = text(raw?.nodeId), node = nodeById(pkg, nodeId);
		if (text(raw?.packageRevision) !== pkg.revision || !node || node.visibility !== "public" || (allowedNodeIds && !allowedNodeIds.has(nodeId)) || !Array.isArray(raw?.sourceEntryIds)) return undefined;
		const sourceEntryIds = [...new Set(raw.sourceEntryIds.map(text).filter(Boolean))];
		if (!sourceEntryIds.length || sourceEntryIds.some(id => !ancestorIds.has(id))) return undefined;
		conflicts.push({ packageRevision: pkg.revision, nodeId, sourceEntryIds });
	}
	return conflicts;
}
function mergeConflicts(pkg: NovelPackage, prior: NovelConflict[], current: NovelConflict[]): NovelConflict[] {
	const byNode = new Map<string, Set<string>>();
	for (const conflict of [...prior, ...current]) {
		const ids = byNode.get(conflict.nodeId) ?? new Set<string>();
		for (const id of conflict.sourceEntryIds) ids.add(id);
		byNode.set(conflict.nodeId, ids);
	}
	return [...byNode.entries()]
		.map(([nodeId, ids]) => ({ packageRevision: pkg.revision, nodeId, sourceEntryIds: [...ids].sort() }))
		.sort((a, b) => (nodeById(pkg, a.nodeId)?.order ?? 0) - (nodeById(pkg, b.nodeId)?.order ?? 0) || a.nodeId.localeCompare(b.nodeId));
}

export function novelPlayStateFromBranch(branch: BranchEntryLike[], binding: NovelPlayCardBinding, pkg: NovelPackage): NovelPlayRuntimeState | undefined {
	const ids = new Set(branch.map(entry => text(entry.id)).filter(Boolean));
	// An upgrade keeps the old progress/conflicts valid because append-only
	// packages inherit every old node ID. Project that state into the child
	// revision before looking for a native child-state entry.
	for (let index = branch.length - 1; index >= 0; index--) {
		const upgrade = branch[index];
		if (upgrade.type !== "custom" || upgrade.customType !== NOVEL_PLAY_UPGRADE_ENTRY_TYPE) continue;
		const value = record(upgrade.data), to = bindingFrom(value?.to), from = bindingFrom(value?.from);
		if (!to || !from || !bindingEqual(to, binding) || !ids.has(text(value?.sourceLeafId))) continue;
		for (let stateIndex = index - 1; stateIndex >= 0; stateIndex--) {
			const stateEntry = branch[stateIndex];
			if (stateEntry.type !== "custom" || stateEntry.customType !== NOVEL_PLAY_STATE_ENTRY_TYPE) continue;
			const raw = record(stateEntry.data), card = bindingFrom(raw?.card), progress = record(raw?.progress), nodeId = text(progress?.nodeId), conflicts = Array.isArray(raw?.conflicts) ? raw.conflicts : [];
			if (!card || !bindingEqual(card, from) || !nodeId || !pkg.lineage?.inheritedNodeIds.includes(nodeId)) continue;
			const mappedConflicts = conflicts.flatMap(item => {
				const row = record(item), conflictNodeId = text(row?.nodeId), refs = Array.isArray(row?.sourceEntryIds) ? row.sourceEntryIds.map(text).filter(Boolean) : [];
				return conflictNodeId && pkg.lineage?.inheritedNodeIds.includes(conflictNodeId) && refs.length && refs.every(id => ids.has(id)) ? [{ packageRevision: pkg.revision, nodeId: conflictNodeId, sourceEntryIds: refs }] : [];
			});
			return { version: 1, card: binding, progress: { packageRevision: pkg.revision, nodeId, position: progress?.position === "after" ? "after" : "before" }, conflicts: mappedConflicts, preparedFromLeafId: text(stateEntry.id) };
		}
	}
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== NOVEL_PLAY_STATE_ENTRY_TYPE) continue;
		const raw = record(entry.data), card = record(raw?.card) as NovelPlayCardBinding | undefined;
		const progress = validAnchor(pkg, raw?.progress), conflicts = conflictsOf(pkg, raw?.conflicts, ids), preparedFromLeafId = text(raw?.preparedFromLeafId);
		if (raw?.version === 1 && card && sameCard(card, binding) && progress && conflicts && preparedFromLeafId && ids.has(preparedFromLeafId)) return { version: 1, card: binding, progress, conflicts, preparedFromLeafId };
	}
	return undefined;
}

function branchFacts(branch: BranchEntryLike[]): Array<{ entryId: string; kind: string; text?: string; data?: unknown }> {
	const rows: Array<{ entryId: string; kind: string; text?: string; data?: unknown }> = [];
	let used = 0;
	for (const entry of branch) {
		const entryId = text(entry.id); if (!entryId) continue;
		let row: (typeof rows)[number] | undefined;
		const message = record(entry.message), role = text(message?.role) || text(entry.type);
		if (role === "user" || role === "assistant") {
			const parts = Array.isArray(message?.content) ? message.content : [], details = record(message?.details);
			const body = parts.map(part => record(part)?.type === "text" ? text(record(part)?.text) : "").filter(Boolean).join("");
			row = { entryId, kind: role, text: text(details?.rpNarrative) || body };
		} else if (entry.type === "custom" && ["rp-state", "rp-world-state", "rp-ecology-state", "rp-summary"].includes(text(entry.customType))) row = { entryId, kind: text(entry.customType), data: entry.data };
		else if (entry.type === "custom_message" && ["rp-greeting", "rp-edited-reply", "rp-import"].includes(text(entry.customType))) row = { entryId, kind: text(entry.customType), text: text(entry.content) };
		if (!row) continue;
		const chars = JSON.stringify(row).length;
		while (rows.length && used + chars > MAX_NOVEL_BRANCH_FACT_CHARS) used -= JSON.stringify(rows.shift()).length;
		if (chars <= MAX_NOVEL_BRANCH_FACT_CHARS) { rows.push(row); used += chars; }
	}
	return rows;
}
function parseModelResult(value: string): Record<string, unknown> | undefined { try { return record(JSON.parse(value)); } catch { return undefined; } }
function anchorRank(pkg: NovelPackage, anchor: NovelNodeAnchor): [number, number] {
	const node = nodeById(pkg, anchor.nodeId)!;
	return [node.order, anchor.position === "after" ? 1 : 0];
}
function isMonotonic(pkg: NovelPackage, from: NovelNodeAnchor, to: NovelNodeAnchor): boolean {
	const a = anchorRank(pkg, from), b = anchorRank(pkg, to);
	return b[0] > a[0] || (b[0] === a[0] && b[1] >= a[1]);
}
function calibrationCandidates(pkg: NovelPackage, anchor: NovelNodeAnchor): CalibrationCandidate[] {
	const current = nodeById(pkg, anchor.nodeId);
	if (!current) return [];
	const stageOrder = new Map(pkg.stages.map(stage => [stage.id, stage.order]));
	const currentStageOrder = stageOrder.get(current.stageId);
	if (currentStageOrder === undefined) return [];
	const nextStageOrder = [...pkg.stages].filter(stage => stage.order > currentStageOrder).sort((a, b) => a.order - b.order)[0]?.order;
	const eligible = [...pkg.nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).filter(node =>
		node.visibility === "public" && node.order >= current.order
		&& (stageOrder.get(node.stageId) === currentStageOrder || stageOrder.get(node.stageId) === nextStageOrder));
	const result: CalibrationCandidate[] = [];
	for (const node of eligible) {
		const candidate = { nodeId: node.id, stageId: node.stageId, stageOrder: stageOrder.get(node.stageId)!, order: node.order, title: node.title, summary: node.summary, dependsOn: [...node.dependsOn] };
		if (JSON.stringify([...result, candidate]).length > MAX_NOVEL_CALIBRATION_CANDIDATE_CHARS) break;
		result.push(candidate);
	}
	return result;
}

/** Read-only per-turn projection. Canon summaries are candidates, never facts. Source chunks and card books are never model input. */
export async function prepareNovelPlayTurn(input: PrepareNovelPlayTurnInput): Promise<PreparedNovelPlayTurn | undefined> {
	const binding = effectiveNovelPlayBinding(input.cwd, input.rawCard, input.branch, input.loadPackage ?? loadNovelPackage);
	if (!binding || !input.expectedLeafId || input.getLeafId() !== input.expectedLeafId || !input.skillBody.trim()) return undefined;
	if (binding.anchorKind === "source-end") return undefined;
	let pkg: NovelPackage;
	try { pkg = (input.loadPackage ?? loadNovelPackage)(input.cwd, binding.docId, binding.revision).package; }
	catch { return undefined; }
	if (pkg.docId !== binding.docId || pkg.revision !== binding.revision) return undefined;
	const ids = new Set(input.branch.map(entry => text(entry.id)).filter(Boolean));
	if (!ids.has(input.expectedLeafId)) return undefined;
	const prior = novelPlayStateFromBranch(input.branch, binding, pkg);
		const startingAnchor: NovelNodeAnchor = prior?.progress ?? { packageRevision: pkg.revision, nodeId: binding.startNodeId!, position: binding.position! };
	const startNode = nodeById(pkg, startingAnchor.nodeId);
	if (!validAnchor(pkg, startingAnchor) || !startNode || startNode.visibility !== "public") return undefined;
	const canonical = calibrationCandidates(pkg, startingAnchor);
	const offeredIds = new Set(canonical.map(candidate => candidate.nodeId));
	if (!offeredIds.has(startingAnchor.nodeId)) return undefined;
	let modelText: string | undefined;
	try {
		modelText = await input.modelCall(input.skillBody, JSON.stringify({
			binding, startingAnchor,
			canonical_candidates_not_facts: canonical,
			prior_conflicts_permanent_until_resolution_protocol: prior?.conflicts ?? [],
			current_authoritative_branch: branchFacts(input.branch),
		}));
	} catch { return undefined; }
	if (!modelText || input.getLeafId() !== input.expectedLeafId) return undefined;
	const parsed = parseModelResult(modelText);
	const progress = parsed?.version === 1 ? validAnchor(pkg, parsed.progress) : undefined;
	const currentConflicts = parsed?.version === 1 ? conflictsOf(pkg, parsed.conflicts, ids, offeredIds) : undefined;
	const progressNode = progress ? nodeById(pkg, progress.nodeId) : undefined;
	if (!progress || !progressNode || !currentConflicts || !offeredIds.has(progress.nodeId) || progressNode.visibility !== "public" || !isMonotonic(pkg, startingAnchor, progress)) return undefined;
	const conflicts = mergeConflicts(pkg, prior?.conflicts ?? [], currentConflicts);
	const projected = projectNovelCandidates(pkg, progress, { ancestorEntryIds: ids, conflicts, conflictsReady: true, maxChars: MAX_DIRECTOR_CANDIDATE_CHARS });
	const sceneRecall = projectNovelSceneRecall(pkg, progress);
	return { projection: { version: 1, packageRevision: pkg.revision, anchor: progress, sceneRecall, ...projected }, state: { version: 1, card: binding, progress, conflicts, preparedFromLeafId: input.expectedLeafId } };
}

/** Persist validated metadata only. It never stores canon text or a second fact set. */
export function commitNovelPlayState(input: { prepared: PreparedNovelPlayTurn | undefined; expectedLeafId: string | null; getLeafId: () => string | null; appendCustomEntry: (customType: string, data?: unknown) => string; }): string | undefined {
	if (!input.prepared || !input.expectedLeafId || input.getLeafId() !== input.expectedLeafId) return undefined;
	return input.appendCustomEntry(NOVEL_PLAY_STATE_ENTRY_TYPE, input.prepared.state);
}
