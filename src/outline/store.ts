import type { BranchEntryLike } from "../stage/assemble.ts";
import { OUTLINE_PROPOSAL_ENTRY_TYPE, type OutlineProposalEntry } from "./schema.ts";
import { parseOutlineProposalEntry } from "./runtime.ts";

export interface PendingOutlineProposal {
	entryId: string;
	entry: OutlineProposalEntry;
}

export function pendingOutlineProposalsFromBranch(branch: BranchEntryLike[]): PendingOutlineProposal[] {
	const settled = new Set<string>();
	const pending: PendingOutlineProposal[] = [];
	for (let index = branch.length - 1; index >= 0; index--) {
		const row = branch[index];
		if (row.type !== "custom" || row.customType !== OUTLINE_PROPOSAL_ENTRY_TYPE) continue;
		const entry = parseOutlineProposalEntry(row.data);
		if (!entry) continue;
		const id = entry.proposal.id;
		if (settled.has(id)) continue;
		settled.add(id);
		if (entry.status === "pending") {
			const baseIndex = branch.findIndex((candidate) => candidate.id === entry.proposal.baseLeafId);
			const markerIndex = branch.findIndex((candidate) => candidate.id === row.id);
			const storyAdvanced = baseIndex < 0 || branch.slice(markerIndex + 1).some((candidate) => candidate.type === "user" || candidate.type === "assistant" || candidate.message?.role === "user" || candidate.message?.role === "assistant");
			if (!storyAdvanced) pending.push({ entryId: String(row.id ?? ""), entry });
		}
	}
	return pending.reverse();
}
