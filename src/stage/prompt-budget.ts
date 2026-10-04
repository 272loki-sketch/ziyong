import type { LorebookEntry } from "../types.ts";
import type { BeatMsg } from "./assemble.ts";

export function clipPromptText(text: string | undefined, max: number): string {
	const value = text ?? "";
	if (value.length <= max) return value;
	if (max <= 0) return "";
	const suffix = `\n……（输入已裁剪 ${value.length - max} 字）`;
	return max <= suffix.length ? suffix.slice(0, max) : `${value.slice(0, max - suffix.length)}${suffix}`;
}

export function boundedHistory(history: BeatMsg[], maxMessages: number, maxTotal = 60_000): BeatMsg[] {
	const selected = history.slice(-maxMessages);
	const out: BeatMsg[] = [];
	let used = 0;
	for (let index = selected.length - 1; index >= 0; index--) {
		const item = selected[index]!;
		const text = clipPromptText(item.text, Math.min(6_000, Math.max(0, maxTotal - used)));
		if (!text || used >= maxTotal) break;
		out.unshift({ ...item, text });
		used += text.length;
	}
	return out;
}

export function boundedLore(entries: LorebookEntry[], maxItems = 40, maxTotal = 24_000): Array<{ title: string; content: string }> {
	const out: Array<{ title: string; content: string }> = [];
	let used = 0;
	for (const entry of entries.slice(0, maxItems)) {
		if (used >= maxTotal) break;
		const content = clipPromptText(entry.content, Math.min(4_000, maxTotal - used));
		out.push({ title: entry.comment || entry.keys[0] || "", content });
		used += content.length;
	}
	return out;
}
