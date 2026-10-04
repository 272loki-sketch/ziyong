import { parseOutlinePatch, parseOutlineProposal } from "./runtime.ts";
import { normalizeOutlineState, outlineHash } from "./state.ts";
import type { OutlineAudit, OutlineAuditIssue, OutlineCollectionName, OutlineForeshadowing, OutlineNode, OutlinePatch, OutlineProposal, OutlineSource, OutlineState } from "./schema.ts";

const COLLECTIONS: OutlineCollectionName[] = ["constraints", "arcs", "characterArcs", "threads", "milestones", "foreshadowing", "settings"];
const EVIDENCE_KINDS = new Set<OutlineSource["kind"]>(["user", "narrative", "rp-state", "world", "lore"]);
const EVIDENCED_FORESHADOWING = new Set(["planted", "reinforced", "activated", "partially-revealed", "resolved"]);
const NODE_TERMINAL = new Set(["fulfilled", "bypassed", "abandoned", "contradicted"]);
const FORESHADOWING_TERMINAL = new Set(["resolved", "abandoned", "invalidated"]);
const FORESHADOWING_NEXT: Record<string, Set<string>> = {
	conceived: new Set(["conceived", "prepared", "abandoned", "invalidated"]),
	prepared: new Set(["prepared", "planted", "abandoned", "invalidated"]),
	planted: new Set(["planted", "reinforced", "activated", "partially-revealed", "abandoned", "invalidated"]),
	reinforced: new Set(["reinforced", "activated", "partially-revealed", "abandoned", "invalidated"]),
	activated: new Set(["activated", "partially-revealed", "resolved", "abandoned", "invalidated"]),
	"partially-revealed": new Set(["partially-revealed", "resolved", "abandoned", "invalidated"]),
	resolved: new Set(["resolved"]), abandoned: new Set(["abandoned"]), invalidated: new Set(["invalidated"]),
};
const clone = <T>(value: T): T => structuredClone(value);

function semanticState(value: OutlineState): unknown {
	const { revision: _revision, parentHash: _parentHash, hash: _hash, ...state } = value;
	return state;
}

function issue(code: OutlineAuditIssue["code"], message: string, path?: string): OutlineAuditIssue {
	return { code, severity: "error", ...(path ? { path } : {}), message };
}

function nodeMap(state: OutlineState): Map<string, { collection: OutlineCollectionName; node: OutlineNode }> {
	return new Map(COLLECTIONS.flatMap((collection) => state[collection].map((node) => [node.id, { collection, node }] as const)));
}

const sourceEqual = (a: OutlineSource, b: OutlineSource): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface OutlineValidationOptions {
	/** IDs independently derived from the current committed branch/context, never from model claims. */
	trustedSourceIds?: ReadonlySet<string>;
	/** Confirmation identity independently matched by the caller against the pending marker. */
	confirmation?: { proposalHash: string; baseLeafId: string };
}

export function applyOutlinePatch(previous: OutlineState, unknownPatch: unknown, options: OutlineValidationOptions = {}): { state?: OutlineState; errors: OutlineAuditIssue[]; highRisk: string[] } {
	const patch = parseOutlinePatch(unknownPatch);
	if (!patch) return { errors: [issue("invalid-patch", "patch 不符合 collection patch runtime schema")], highRisk: [] };
	const next = clone(previous), errors: OutlineAuditIssue[] = [], highRisk: string[] = [];
	const trusted = options.trustedSourceIds ?? new Set<string>();
	const oldNodes = nodeMap(previous), oldSources = new Map(previous.sources.map((source) => [source.id, source])), addedSources = new Map<string, OutlineSource>();
	for (const source of patch.addSources ?? []) {
		const old = oldSources.get(source.id);
		if (old && !sourceEqual(old, source)) errors.push(issue("source-forgery", `既有 source ${source.id} 不可修改`, `sources.${source.id}`));
		else if (!old && source.kind !== "research" && !trusted.has(source.id)) errors.push(issue("source-forgery", `source ${source.id} 的 ${source.kind} 证据未经引擎注册`, `sources.${source.id}`));
		else if (!old) addedSources.set(source.id, clone(source));
	}
	next.sources = [...next.sources, ...addedSources.values()];
	if (patch.premise !== undefined) { if (patch.premise !== previous.premise) highRisk.push("premise-edit"); next.premise = patch.premise; }
	if (patch.currentFocus !== undefined) next.currentFocus = [...patch.currentFocus];
	if (patch.alignment !== undefined) next.alignment = clone(patch.alignment);
	for (const operation of patch.collections ?? []) {
		const rows = next[operation.collection] as OutlineNode[];
		for (const id of operation.deleteIds ?? []) {
			const at = rows.findIndex((row) => row.id === id);
			if (at < 0) { errors.push(issue("invalid-patch", `不能删除不存在的节点 ${id}`, `${operation.collection}.${id}`)); continue; }
			if (oldNodes.get(id)?.node.rigidity === "hard") { errors.push(issue("hard-constraint-deletion", `hard 节点 ${id} 不可删除`, `${operation.collection}.${id}`)); continue; }
			highRisk.push(`delete:${operation.collection}.${id}`); rows.splice(at, 1);
		}
		for (const raw of operation.upsert ?? []) {
			const candidate = clone(raw) as OutlineNode, elsewhere = oldNodes.get(candidate.id);
			if (elsewhere && elsewhere.collection !== operation.collection) { errors.push(issue("id-mutation", `节点 ${candidate.id} 不可跨集合迁移`, `${operation.collection}.${candidate.id}`)); continue; }
			const at = rows.findIndex((row) => row.id === candidate.id), old = at >= 0 ? rows[at] : undefined;
			if (old?.rigidity === "hard" && candidate.rigidity !== "hard") errors.push(issue("hard-constraint-downgrade", `hard 节点 ${candidate.id} 不可降级`, `${operation.collection}.${candidate.id}.rigidity`));
			if (old && old.sourceRefs.some((ref) => !candidate.sourceRefs.includes(ref))) errors.push(issue("source-forgery", `节点 ${candidate.id} 不可移除既有 source 引用`, `${operation.collection}.${candidate.id}.sourceRefs`));
			const validSources = new Set(next.sources.map((source) => source.id));
			if (candidate.sourceRefs.some((ref) => !validSources.has(ref))) errors.push(issue("source-forgery", `节点 ${candidate.id} 引用了不存在的 source`, `${operation.collection}.${candidate.id}.sourceRefs`));
			if (candidate.actuality === "established" && (!candidate.sourceRefs.length || candidate.sourceRefs.some((ref) => { const source = next.sources.find((entry) => entry.id === ref); return !source || !trusted.has(ref) || !EVIDENCE_KINDS.has(source.kind); }))) errors.push(issue("plan-promoted-to-fact", `节点 ${candidate.id} 的 established 必须引用可信已提交证据`, `${operation.collection}.${candidate.id}.actuality`));
			if (candidate.status === "fulfilled" && (!candidate.sourceRefs.length || candidate.sourceRefs.some((ref) => !trusted.has(ref)))) errors.push(issue("plan-promoted-to-fact", `节点 ${candidate.id} 的 fulfilled 必须引用可信已提交证据`, `${operation.collection}.${candidate.id}.status`));
			if (old && NODE_TERMINAL.has(old.status) && candidate.status !== old.status) errors.push(issue("invalid-status-transition", `终态节点 ${candidate.id} 不可从 ${old.status} 重开`, `${operation.collection}.${candidate.id}.status`));
			if (old && old.actuality !== "established" && candidate.actuality === "established") highRisk.push(`establish:${operation.collection}.${candidate.id}`);
			if (old && !NODE_TERMINAL.has(old.status) && NODE_TERMINAL.has(candidate.status)) highRisk.push(`terminal:${operation.collection}.${candidate.id}`);
			if ((!old || old.rigidity !== "hard") && candidate.rigidity === "hard") highRisk.push(`make-hard:${operation.collection}.${candidate.id}`);
			if (!old && candidate.actuality === "established") highRisk.push(`establish:${operation.collection}.${candidate.id}`);
			if (!old && NODE_TERMINAL.has(candidate.status)) highRisk.push(`terminal:${operation.collection}.${candidate.id}`);
			if (old?.visibility === "secret" && candidate.visibility !== "secret") highRisk.push(`reveal:${operation.collection}.${candidate.id}`);
			if (old?.rigidity === "hard" && JSON.stringify(old) !== JSON.stringify(candidate)) highRisk.push(`hard-edit:${operation.collection}.${candidate.id}`);
			if (operation.collection === "foreshadowing" && old) {
				const before = (old as OutlineForeshadowing).foreshadowingStatus, after = (candidate as OutlineForeshadowing).foreshadowingStatus;
				if (!FORESHADOWING_NEXT[before]?.has(after) || (FORESHADOWING_TERMINAL.has(before) && before !== after)) errors.push(issue("invalid-status-transition", `伏笔 ${candidate.id} 不可从 ${before} 转为 ${after}`, `foreshadowing.${candidate.id}.foreshadowingStatus`));
			}
			if (at >= 0) rows[at] = candidate; else rows.push(candidate);
		}
	}
	for (const collection of COLLECTIONS) for (const old of previous[collection].filter((node) => node.rigidity === "hard")) {
		const current = (next[collection] as OutlineNode[]).find((node) => node.id === old.id);
		if (!current) errors.push(issue("hard-constraint-deletion", `hard 节点 ${old.id} 不可删除`, `${collection}.${old.id}`));
		else if (current.rigidity !== "hard") errors.push(issue("hard-constraint-downgrade", `hard 节点 ${old.id} 不可降级`, `${collection}.${old.id}.rigidity`));
	}
	const ids = new Map<string, OutlineCollectionName>();
	for (const collection of COLLECTIONS) for (const node of next[collection]) {
		const first = ids.get(node.id); if (first && first !== collection) errors.push(issue("id-mutation", `节点 ID ${node.id} 同时出现在 ${first} 与 ${collection}`, `${collection}.${node.id}`)); else ids.set(node.id, collection);
	}
	const allNodes = nodeMap(next);
	for (const [id, { collection, node }] of allNodes) if (node.dependsOn.some((ref) => !allNodes.has(ref))) errors.push(issue("invalid-patch", `节点 ${id} 依赖不存在的节点`, `${collection}.${id}.dependsOn`));
	for (const foreshadowing of next.foreshadowing) if (EVIDENCED_FORESHADOWING.has(foreshadowing.foreshadowingStatus)) {
		if (!foreshadowing.evidenceRefs.length || foreshadowing.evidenceRefs.some((ref) => !trusted.has(ref) || !next.sources.some((source) => source.id === ref && EVIDENCE_KINDS.has(source.kind)))) errors.push(issue("foreshadowing-evidence", `伏笔 ${foreshadowing.id} 在 ${foreshadowing.foreshadowingStatus} 必须引用可信已提交证据`, `foreshadowing.${foreshadowing.id}.evidenceRefs`));
	}
	next.currentFocus = next.currentFocus.filter((id) => allNodes.has(id));
	if (!errors.length && JSON.stringify(semanticState(next)) === JSON.stringify(semanticState(previous))) return { state: previous, errors: [], highRisk: [] };
	next.revision = previous.revision + 1; next.parentHash = previous.hash; next.hash = outlineHash(next);
	const normalized = normalizeOutlineState(next, { verifyHash: true });
	if (!normalized || normalized.hash !== next.hash || outlineHash(normalized) !== outlineHash(next)) errors.push(issue("invalid-patch", "应用后的快照未通过严格 normalize/hash roundtrip"));
	return errors.length ? { errors, highRisk: [...new Set(highRisk)] } : { state: normalized!, errors: [], highRisk: [...new Set(highRisk)] };
}

export function validateOutlineProposal(previous: OutlineState, unknownProposal: unknown, options: OutlineValidationOptions = {}): { audit: OutlineAudit; nextState?: OutlineState; highRisk: string[] } {
	const proposal = parseOutlineProposal(unknownProposal);
	if (!proposal) { const audit: OutlineAudit = { version: 1, verdict: "reject", issues: [issue("invalid-patch", "proposal 不符合 runtime schema")], summary: "提案被确定性门禁拒绝（1 项）" }; return { audit, highRisk: [] }; }
	const issues: OutlineAuditIssue[] = [];
	if (proposal.baseRevision !== previous.revision) issues.push(issue("revision-conflict", `revision 冲突：期望 ${previous.revision}，收到 ${proposal.baseRevision}`));
	if (proposal.baseHash !== previous.hash) issues.push(issue("hash-conflict", "大纲基线 hash 不匹配"));
	const applied = applyOutlinePatch(previous, proposal.patch, options); issues.push(...applied.errors);
	if (proposal.mode === "automatic" && applied.highRisk.length) issues.push(issue("automatic-high-risk", `自动模式拒绝高风险变更：${applied.highRisk.join(", ")}`));
	else if (applied.highRisk.length && (!proposal.proposalHash || !proposal.baseLeafId || options.confirmation?.proposalHash !== proposal.proposalHash || options.confirmation.baseLeafId !== proposal.baseLeafId)) issues.push(issue("confirmation-required", `高风险变更必须绑定 proposalHash 与 baseLeafId 确认：${applied.highRisk.join(", ")}`));
	const audit: OutlineAudit = { version: 1, verdict: issues.length ? "reject" : "approve", issues, summary: issues.length ? `提案被确定性门禁拒绝（${issues.length} 项）` : "提案通过确定性门禁。" };
	return { audit, ...(issues.length ? {} : { nextState: applied.state }), highRisk: applied.highRisk };
}

export function commitOutlineProposal(previous: OutlineState, proposal: unknown, options: OutlineValidationOptions = {}): { state?: OutlineState; audit: OutlineAudit } {
	const result = validateOutlineProposal(previous, proposal, options);
	return { audit: result.audit, ...(result.nextState ? { state: result.nextState } : {}) };
}
