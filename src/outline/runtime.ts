import type {
	ForeshadowingStatus, OutlineAlignment, OutlineAudit, OutlineAuditCode, OutlineAuditIssue,
	OutlineCollectionName, OutlineCollectionPatch, OutlineNode, OutlinePatch, OutlineProposal,
	OutlineProposalEntry, OutlineSource, OutlineState,
} from "./schema.ts";

const COLLECTIONS = ["constraints", "arcs", "characterArcs", "threads", "milestones", "foreshadowing", "settings"] as const;
const NODE_STATUSES = ["candidate", "active", "blocked", "fulfilled", "bypassed", "abandoned", "contradicted"] as const;
const RIGIDITIES = ["hard", "soft", "open"] as const;
const VISIBILITIES = ["public", "spoiler", "secret"] as const;
const ACTUALITIES = ["plan", "guidance", "established"] as const;
const FORESHADOWING_STATUSES = ["conceived", "prepared", "planted", "reinforced", "activated", "partially-revealed", "resolved", "abandoned", "invalidated"] as const;
const SOURCE_KINDS = ["research", "user", "narrative", "rp-state", "world", "lore"] as const;
const AUDIT_CODES: OutlineAuditCode[] = ["revision-conflict", "hash-conflict", "leaf-conflict", "invalid-patch", "id-mutation", "source-forgery", "hard-constraint-deletion", "hard-constraint-downgrade", "plan-promoted-to-fact", "foreshadowing-evidence", "invalid-status-transition", "confirmation-required", "automatic-high-risk"];
const HASH = /^[a-f0-9]{64}$/;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const exact = (value: ObjectValue, required: string[], optional: string[] = []): boolean => required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value: unknown, max: number, empty = true): string | null => typeof value === "string" && value.length <= max && (empty || !!value.trim()) ? value.trim() : null;
const integer = (value: unknown, min = 0): number | null => Number.isInteger(value) && Number(value) >= min ? Number(value) : null;
const enumValue = <T extends string>(value: unknown, values: readonly T[]): T | null => typeof value === "string" && values.includes(value as T) ? value as T : null;
const stringArray = (value: unknown, maxItems: number, maxChars: number): string[] | null => {
	if (!Array.isArray(value) || value.length > maxItems) return null;
	const parsed = value.map((item) => text(item, maxChars, false));
	return parsed.some((item) => item === null) || new Set(parsed).size !== parsed.length ? null : parsed as string[];
};

export function parseOutlineSource(value: unknown, allowedKinds: readonly OutlineSource["kind"][] = SOURCE_KINDS): OutlineSource | null {
	const raw = object(value);
	if (!raw || !exact(raw, ["id", "kind", "title", "locator", "note"])) return null;
	const id = text(raw.id, 100, false), kind = enumValue(raw.kind, allowedKinds), title = text(raw.title, 200), locator = text(raw.locator, 500), note = text(raw.note, 800);
	return id && kind && title !== null && locator !== null && note !== null ? { id, kind, title, locator, note } : null;
}

function parseAlignment(value: unknown): OutlineAlignment | null {
	const raw = object(value);
	if (!raw || !exact(raw, ["summary", "confidence", "conflicts", "updatedFromRefs"])) return null;
	const summary = text(raw.summary, 1000), conflicts = stringArray(raw.conflicts, 30, 300), updatedFromRefs = stringArray(raw.updatedFromRefs, 30, 100);
	return summary !== null && typeof raw.confidence === "number" && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1 && conflicts && updatedFromRefs
		? { summary, confidence: raw.confidence, conflicts, updatedFromRefs } : null;
}

export function parseOutlineNode(collection: OutlineCollectionName, value: unknown): OutlineNode | null {
	const raw = object(value);
	const extras: Record<OutlineCollectionName, string[]> = { constraints: [], arcs: ["beats"], characterArcs: ["character", "from", "toward"], threads: ["question", "nextPressure"], milestones: ["criteria"], foreshadowing: ["foreshadowingStatus", "setup", "payoff", "evidenceRefs"], settings: ["key", "value"] };
	const base = ["id", "title", "summary", "status", "rigidity", "visibility", "actuality", "sourceRefs", "dependsOn"];
	if (!raw || !exact(raw, [...base, ...extras[collection]])) return null;
	const id = text(raw.id, 100, false), title = text(raw.title, 160), summary = text(raw.summary, 1200), status = enumValue(raw.status, NODE_STATUSES), rigidity = enumValue(raw.rigidity, RIGIDITIES), visibility = enumValue(raw.visibility, VISIBILITIES), actuality = enumValue(raw.actuality, ACTUALITIES), sourceRefs = stringArray(raw.sourceRefs, 20, 100), dependsOn = stringArray(raw.dependsOn, 20, 100);
	if (!id || title === null || summary === null || !status || !rigidity || !visibility || !actuality || !sourceRefs || !dependsOn) return null;
	const node: OutlineNode = { id, title, summary, status, rigidity, visibility, actuality, sourceRefs, dependsOn };
	if (collection === "arcs") { const beats = stringArray(raw.beats, 40, 500); return beats ? { ...node, beats } : null; }
	if (collection === "characterArcs") { const character = text(raw.character, 160), from = text(raw.from, 600), toward = text(raw.toward, 600); return character !== null && from !== null && toward !== null ? { ...node, character, from, toward } : null; }
	if (collection === "threads") { const question = text(raw.question, 600), nextPressure = text(raw.nextPressure, 600); return question !== null && nextPressure !== null ? { ...node, question, nextPressure } : null; }
	if (collection === "milestones") { const criteria = stringArray(raw.criteria, 30, 400); return criteria ? { ...node, criteria } : null; }
	if (collection === "foreshadowing") {
		const foreshadowingStatus = enumValue<ForeshadowingStatus>(raw.foreshadowingStatus, FORESHADOWING_STATUSES), setup = text(raw.setup, 800), payoff = text(raw.payoff, 800), evidenceRefs = stringArray(raw.evidenceRefs, 30, 100);
		return foreshadowingStatus && setup !== null && payoff !== null && evidenceRefs ? { ...node, foreshadowingStatus, setup, payoff, evidenceRefs } : null;
	}
	if (collection === "settings") { const key = text(raw.key, 160), settingValue = text(raw.value, 1200); return key !== null && settingValue !== null ? { ...node, key, value: settingValue } : null; }
	return node;
}

export function parseOutlinePatch(value: unknown, options: { modelInput?: boolean } = {}): OutlinePatch | null {
	const raw = object(value);
	if (!raw || !exact(raw, [], ["premise", "currentFocus", "alignment", "collections", "addSources"])) return null;
	const patch: OutlinePatch = {};
	if ("premise" in raw) { const premise = text(raw.premise, 3000); if (premise === null) return null; patch.premise = premise; }
	if ("currentFocus" in raw) { const currentFocus = stringArray(raw.currentFocus, 30, 100); if (!currentFocus) return null; patch.currentFocus = currentFocus; }
	if ("alignment" in raw) { const alignment = parseAlignment(raw.alignment); if (!alignment) return null; patch.alignment = alignment; }
	if ("addSources" in raw) {
		if (!Array.isArray(raw.addSources) || raw.addSources.length > 100) return null;
		const sources = raw.addSources.map((source) => parseOutlineSource(source, options.modelInput ? ["research"] : SOURCE_KINDS));
		if (sources.some((source) => !source) || new Set(sources.map((source) => source!.id)).size !== sources.length) return null;
		patch.addSources = sources as OutlineSource[];
	}
	if ("collections" in raw) {
		if (!Array.isArray(raw.collections) || raw.collections.length > COLLECTIONS.length) return null;
		const seen = new Set<string>(), collections: OutlineCollectionPatch[] = [];
		for (const value of raw.collections) {
			const row = object(value);
			if (!row || !exact(row, ["collection"], ["upsert", "deleteIds"])) return null;
			const collection = enumValue<OutlineCollectionName>(row.collection, COLLECTIONS);
			if (!collection || seen.has(collection)) return null;
			seen.add(collection);
			const parsed: OutlineCollectionPatch = { collection };
			if ("upsert" in row) {
				if (!Array.isArray(row.upsert) || row.upsert.length > 200) return null;
				const nodes = row.upsert.map((node) => parseOutlineNode(collection, node));
				if (nodes.some((node) => !node) || new Set(nodes.map((node) => node!.id)).size !== nodes.length) return null;
				parsed.upsert = nodes as OutlineNode[];
			}
			if ("deleteIds" in row) { const ids = stringArray(row.deleteIds, 200, 100); if (!ids) return null; parsed.deleteIds = ids; }
			collections.push(parsed);
		}
		patch.collections = collections;
	}
	return patch;
}

export function parseOutlineProposal(value: unknown, options: { modelInput?: boolean } = {}): OutlineProposal | null {
	const raw = object(value), required = ["version", "id", "mode", "baseRevision", "baseHash", "baseLeafId", "kind", "rationale", "researchInspirationIds", "patch"];
	if (!raw || !exact(raw, required, ["createdAt", "proposalHash"]) || raw.version !== 1) return null;
	const id = text(raw.id, 100, false), mode = enumValue(raw.mode, ["manual", "automatic"]), baseRevision = integer(raw.baseRevision), baseHash = text(raw.baseHash, 64, false), baseLeafId = text(raw.baseLeafId, 200, false), kind = enumValue(raw.kind, ["chat", "bootstrap", "reconcile", "foreshadowing"]), rationale = text(raw.rationale, 2000), researchInspirationIds = stringArray(raw.researchInspirationIds, 100, 100), patch = parseOutlinePatch(raw.patch, options);
	if (!id || !mode || baseRevision === null || !baseHash || !HASH.test(baseHash) || !baseLeafId || !kind || rationale === null || !researchInspirationIds || !patch) return null;
	const proposal: OutlineProposal = { version: 1, id, mode, baseRevision, baseHash, baseLeafId, kind, rationale, researchInspirationIds, patch };
	if ("createdAt" in raw) { const createdAt = text(raw.createdAt, 100, false); if (!createdAt) return null; proposal.createdAt = createdAt; }
	if ("proposalHash" in raw) { const hash = text(raw.proposalHash, 64, false); if (!hash || !HASH.test(hash)) return null; proposal.proposalHash = hash; }
	return proposal;
}

function parseAuditIssue(value: unknown): OutlineAuditIssue | null {
	const raw = object(value);
	if (!raw || !exact(raw, ["code", "severity", "message"], ["path"])) return null;
	const code = enumValue(raw.code, AUDIT_CODES), severity = enumValue(raw.severity, ["warning", "error"]), message = text(raw.message, 1000, false);
	if (!code || !severity || !message) return null;
	const result: OutlineAuditIssue = { code, severity, message };
	if ("path" in raw) { const path = text(raw.path, 500, false); if (!path) return null; result.path = path; }
	return result;
}

export function parseOutlineAudit(value: unknown): OutlineAudit | null {
	const raw = object(value);
	if (!raw || !exact(raw, ["version", "verdict", "issues", "summary"]) || raw.version !== 1 || !Array.isArray(raw.issues) || raw.issues.length > 100) return null;
	const verdict = enumValue(raw.verdict, ["approve", "reject"]), summary = text(raw.summary, 2000), issues = raw.issues.map(parseAuditIssue);
	return verdict && summary !== null && !issues.some((entry) => !entry) ? { version: 1, verdict, issues: issues as OutlineAuditIssue[], summary } : null;
}

export function parseOutlineProposalEntry(value: unknown): OutlineProposalEntry | null {
	const raw = object(value);
	if (!raw || !exact(raw, ["version", "proposal", "status", "createdAt"], ["audit", "proposalHash", "reason", "committedRevision", "committedHash"]) || raw.version !== 1) return null;
	const proposal = parseOutlineProposal(raw.proposal), status = enumValue(raw.status, ["pending", "approved", "rejected"]), createdAt = text(raw.createdAt, 100, false);
	if (!proposal || !status || !createdAt) return null;
	const entry: OutlineProposalEntry = { version: 1, proposal, status, createdAt };
	if ("audit" in raw) { const audit = parseOutlineAudit(raw.audit); if (!audit) return null; entry.audit = audit; }
	if ("proposalHash" in raw) { const hash = text(raw.proposalHash, 64, false); if (!hash || !HASH.test(hash)) return null; entry.proposalHash = hash; }
	if ("reason" in raw) { const reason = text(raw.reason, 2000); if (reason === null) return null; entry.reason = reason; }
	if ("committedRevision" in raw) { const revision = integer(raw.committedRevision, 1); if (revision === null) return null; entry.committedRevision = revision; }
	if ("committedHash" in raw) { const hash = text(raw.committedHash, 64, false); if (!hash || !HASH.test(hash)) return null; entry.committedHash = hash; }
	if (status === "pending" && (entry.audit || entry.committedHash || entry.committedRevision)) return null;
	if (status === "approved" && (!entry.audit || entry.audit.verdict !== "approve" || !entry.committedHash || !entry.committedRevision)) return null;
	return entry;
}

export function parseOutlineStateShape(value: unknown): Omit<OutlineState, "hash"> & { hash: string } | null {
	const raw = object(value), required = ["version", "revision", "parentHash", "hash", "premise", ...COLLECTIONS, "currentFocus", "alignment", "sources"];
	if (!raw || !exact(raw, required) || raw.version !== 1) return null;
	const revision = integer(raw.revision), parentHash = text(raw.parentHash, 64), hash = text(raw.hash, 64, false), premise = text(raw.premise, 3000), currentFocus = stringArray(raw.currentFocus, 30, 100), alignment = parseAlignment(raw.alignment);
	if (revision === null || parentHash === null || (parentHash && !HASH.test(parentHash)) || !hash || !HASH.test(hash) || premise === null || !currentFocus || !alignment) return null;
	const result = { version: 1 as const, revision, parentHash, hash, premise, currentFocus, alignment, sources: [] as OutlineSource[] } as OutlineState;
	for (const collection of COLLECTIONS) {
		if (!Array.isArray(raw[collection]) || raw[collection].length > 200) return null;
		const rows = (raw[collection] as unknown[]).map((node) => parseOutlineNode(collection, node));
		if (rows.some((node) => !node) || new Set(rows.map((node) => node!.id)).size !== rows.length) return null;
		(result[collection] as OutlineNode[]) = rows as OutlineNode[];
	}
	if (!Array.isArray(raw.sources) || raw.sources.length > 300) return null;
	const sources = raw.sources.map((source) => parseOutlineSource(source));
	if (sources.some((source) => !source) || new Set(sources.map((source) => source!.id)).size !== sources.length) return null;
	result.sources = sources as OutlineSource[];
	return result;
}
