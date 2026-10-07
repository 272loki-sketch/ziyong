/** Pure projection of the committed narrative window; never reads reasoning or delivery artifacts. */
export interface NarrativeMemoryEntry {
	id?: string;
	type?: string;
	message?: { role?: string; content?: unknown; stopReason?: string; details?: unknown };
}
export interface NarrativeMemoryWindow {
	narrativeText: string;
	entries: Array<{ entryId: string; role: "user" | "assistant"; entryType: "message"; turn: number; text: string; textBasis: "rpNarrative" | "entryText" }>;
}
function textOnly(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part && typeof part === "object" && part.type === "text")
		.map((part) => typeof part.text === "string" ? part.text : "").join("");
}
/** New author modes require rpNarrative; the old SDK path may use plain assistant text. */
export function committedNarrativeText(entry: NarrativeMemoryEntry): string {
	if (entry.type !== "message" || entry.message?.role !== "assistant") return "";
	const message = entry.message;
	const details = message.details && typeof message.details === "object" && !Array.isArray(message.details)
		? message.details as Record<string, unknown> : {};
	if (message.stopReason === "aborted" || message.stopReason === "error" || details.rpGreeting || details.rpIncomplete === true) return "";
	if (typeof details.rpNarrative === "string") return details.rpNarrative;
	if (details.rpGenerationMode) return "";
	return textOnly(message.content);
}
/** Bound by the saved source id, not whichever branch/session happens to be active after an await. */
export function narrativeMemoryWindow(branch: NarrativeMemoryEntry[], sourceEntryId: string, everyNTurns: number): NarrativeMemoryWindow | undefined {
	const end = branch.findIndex((entry) => entry.id === sourceEntryId);
	if (end < 0) return undefined;
	const narrativeText = committedNarrativeText(branch[end]!);
	if (!narrativeText.trim()) return undefined;
	const authorIndices = branch.slice(0, end + 1).map((entry, index) => committedNarrativeText(entry).trim() ? index : -1)
		.filter((index) => index >= 0).slice(-Math.max(1, Math.floor(everyNTurns) || 1));
	const selected = new Set(authorIndices);
	for (const authorIndex of authorIndices) {
		for (let index = authorIndex - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (entry.type === "message" && entry.message?.role === "user") { selected.add(index); break; }
			if (committedNarrativeText(entry).trim()) break;
		}
	}
	const entries: NarrativeMemoryWindow["entries"] = [];
	let turn = 0;
	for (let index = 0; index <= end; index++) {
		const entry = branch[index]!;
		if (entry.type === "message" && entry.message?.role === "user") turn++;
		if (!selected.has(index) || !entry.id) continue;
		const text = entry.message?.role === "assistant" ? committedNarrativeText(entry) : textOnly(entry.message?.content);
		if (text.trim()) entries.push({ entryId: entry.id, role: entry.message?.role === "assistant" ? "assistant" : "user", entryType: "message", turn: Math.max(1, turn), text,
			textBasis: entry.message?.role === "assistant" && typeof (entry.message?.details as Record<string, unknown> | undefined)?.rpNarrative === "string" ? "rpNarrative" : "entryText" });
	}
	return { narrativeText, entries };
}
