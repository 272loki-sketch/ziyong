/** 对真实 Session Tree 条目做只读关联；不从位置/最后一条正文猜 owner。 */
import { projectTurnPerformance, type TurnPerformance } from "../src/stage/performance.ts";
export function performanceByNarrative(entries: unknown[]): Map<string, TurnPerformance> {
	const owners = new Set<string>();
	for (const item of entries) {
		const entry = item as { id?: unknown; type?: unknown; message?: { role?: unknown } } | null;
		if (entry?.type === "message" && entry.message?.role === "assistant" && typeof entry.id === "string") owners.add(entry.id);
	}
	const out = new Map<string, TurnPerformance>();
	for (const item of entries) {
		const entry = item as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (entry?.type !== "custom" || entry.customType !== "rp-turn-performance") continue;
		const id = (entry.data as { narrativeEntryId?: unknown } | null)?.narrativeEntryId;
		if (typeof id !== "string" || !owners.has(id)) continue;
		const safe = projectTurnPerformance(entry.data, id);
		if (safe) out.set(id, safe);
	}
	return out;
}
