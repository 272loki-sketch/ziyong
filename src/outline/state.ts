import { createHash } from "node:crypto";

import type { BranchEntryLike } from "../stage/assemble.ts";
import {
	OUTLINE_ENTRY_TYPE,
	type OutlineAlignment,
	type OutlineArc,
	type OutlineCharacterArc,
	type OutlineForeshadowing,
	type OutlineMilestone,
	type OutlineNode,
	type OutlineSetting,
	type OutlineSource,
	type OutlineState,
	type OutlineThread,
} from "./schema.ts";
import { parseOutlineStateShape } from "./runtime.ts";

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

export function outlineHash(value: Omit<OutlineState, "hash"> | OutlineState): string {
	const source = { ...value } as Partial<OutlineState>;
	delete source.hash;
	return createHash("sha256").update(JSON.stringify(canonical(source))).digest("hex");
}

export function defaultOutlineState(): OutlineState {
	const state: OutlineState = {
		version: 1, revision: 0, parentHash: "", hash: "", premise: "", constraints: [], arcs: [], characterArcs: [], threads: [], milestones: [], foreshadowing: [], currentFocus: [],
		alignment: { summary: "", confidence: 0, conflicts: [], updatedFromRefs: [] }, settings: [], sources: [],
	};
	state.hash = outlineHash(state);
	return state;
}

export function normalizeOutlineState(value: unknown, options: { verifyHash?: boolean } = {}): OutlineState | null {
	const state = parseOutlineStateShape(value);
	if (!state) return null;
	const expected = outlineHash(state);
	if (options.verifyHash && (!state.hash || state.hash !== expected)) return null;
	return { ...state, hash: expected };
}

export interface OutlineBranchHistory { current: OutlineState; history: OutlineState[]; invalidEntries: number }

export function outlineHistoryFromBranch(branch: BranchEntryLike[]): OutlineBranchHistory {
	const history: OutlineState[] = [];
	let invalidEntries = 0, broken = false;
	const initial = defaultOutlineState();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== OUTLINE_ENTRY_TYPE) continue;
		if (broken) { invalidEntries++; continue; }
		const state = normalizeOutlineState(entry.data, { verifyHash: true });
		if (!state) { invalidEntries++; broken = true; continue; }
		const previous = history.at(-1);
		const parent = previous ?? initial;
		if (state.revision !== parent.revision + 1 || state.parentHash !== parent.hash) { invalidEntries++; broken = true; continue; }
		history.push(state);
	}
	return { current: history.at(-1) ?? defaultOutlineState(), history, invalidEntries };
}

export const outlineFromBranch = (branch: BranchEntryLike[]): OutlineState => outlineHistoryFromBranch(branch).current;
