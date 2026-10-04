const STORAGE_KEY = "liyuan.novel-play.selected-docs";

function read(): string[] {
	try {
		const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	} catch { return []; }
}

export function markNovelPlaySelected(docId: string): void {
	if (!docId) return;
	const next = new Set(read());
	next.add(docId);
	try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* Private browsing may deny storage. */ }
}

export function selectedNovelPlayDocs(): string[] { return read(); }
