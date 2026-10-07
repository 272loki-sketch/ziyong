import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { entryRawText } from "../src/stage/compact.ts";
import { narrativeMemoryWindow, committedNarrativeText, type NarrativeMemoryEntry } from "../src/memory/narrative-window.ts";
import { loadChunks } from "../src/memory/store.ts";
import { memorySearch, onNarrativeTurnEnd, updateMemoryConfig, updateStoreConfig } from "../src/memory/service.ts";
const body = (turn: number) => `第${turn}拍：合成角色把编号物品${turn}锁在各自的柜子里，只有该角色知道钥匙所在。`;
const entries = (turns: number): NarrativeMemoryEntry[] => Array.from({ length: turns }, (_, i) => [
	{ id: `u${i + 1}`, type: "message", message: { role: "user", content: `第${i + 1}拍合成输入：把物品收好，请记住不同编号的归属。` } },
	{ id: `a${i + 1}`, type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "text", text: body(i + 1) + "<format>NOT_STORY</format>" }], details: { rpGenerationMode: "director", rpNarrative: body(i + 1), rpAuthorDraft: "AUTHOR_DRAFT_NOT_FACT" } } },
]).flat();
test("memory window keeps the complete N committed turns with exact canonical text and source ids", () => {
	const branch = entries(4); const window = narrativeMemoryWindow(branch, "a4", 3)!;
	assert.deepEqual(window.entries.map(e => e.entryId), ["u2", "a2", "u3", "a3", "u4", "a4"]);
	assert.equal(window.narrativeText, body(4));
	assert.ok(window.entries.every(e => !/PRIVATE_REASONING|NOT_STORY|AUTHOR_DRAFT/.test(e.text)));
	assert.equal(window.entries.find(e => e.entryId === "a2")?.text, body(2));
});
test("memory source id bounds the snapshot and rejects stale source ids/new-mode process text", () => {
	assert.equal(narrativeMemoryWindow(entries(4), "a3", 3)!.entries.at(-1)!.entryId, "a3");
	assert.equal(narrativeMemoryWindow(entries(2), "other-session-author", 3), undefined);
	assert.equal(committedNarrativeText({ type: "message", message: { role: "assistant", content: "REPORT_ONLY", details: { rpGenerationMode: "director" } } }), "");
	assert.equal(committedNarrativeText({ type: "message", message: { role: "assistant", stopReason: "aborted", details: { rpNarrative: "unfinished" } } }), "");
});
test("memory every-three host projection persists all three narratives and hides sibling-branch sources", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-memory-host-window-")); const scope = { sessionId: "synthetic-scope", card: "synthetic-card.json" };
	try {
		updateMemoryConfig(cwd, { enabled: true, embedMode: "local" }); updateStoreConfig(cwd, "narrative", { everyNTurns: 3 });
		for (let turn = 1; turn <= 3; turn++) {
			const window = narrativeMemoryWindow(entries(turn), `a${turn}`, 3)!;
			const r = await onNarrativeTurnEnd(cwd, scope, window.narrativeText, { entries: window.entries, branchLeafId: `a${turn}` });
			assert.equal(r.stored, turn === 3);
		}
		const chunks = loadChunks(cwd, scope, "narrative");
		for (let turn = 1; turn <= 3; turn++) assert.ok(chunks.some(c => c.text.includes(`编号物品${turn}`) && c.meta.sourceRefs?.some(r => r.entryId === `a${turn}`)));
		assert.ok(chunks.every(c => c.meta.branchLeafId === "a3"));
		const visible = new Set(entries(3).map(e => e.id!)); const hidden = new Set(["sibling-user", "sibling-author"]);
		assert.ok((await memorySearch(cwd, scope, "narrative", "编号物品1", 10, visible)).length > 0);
		assert.equal((await memorySearch(cwd, scope, "narrative", "编号物品1", 10, hidden)).length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("archived source coordinates refer to canonical narrative rather than interleaved author/format text", () => {
	const entry = entries(1)[1]!;
	assert.equal(entryRawText(entry), body(1));
	assert.equal(committedNarrativeText(entry).slice(0, 10), body(1).slice(0, 10));
});
test("periodic windows omit uncompleted input/reply pairs between completed beats", () => {
	const branch = entries(3); branch.splice(2, 0,
		{ id: "canceled-u", type: "message", message: { role: "user", content: "CANCELED_USER_NOT_COMMITTED" } },
		{ id: "canceled-a", type: "message", message: { role: "assistant", stopReason: "aborted", details: { rpNarrative: "unfinished-body" } } });
	const ids = narrativeMemoryWindow(branch, "a3", 3)!.entries.map(e => e.entryId);
	assert.ok(!ids.includes("canceled-u") && !ids.includes("canceled-a"));
});
