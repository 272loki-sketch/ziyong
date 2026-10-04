import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	findCutPoint,
	prepareCompaction,
} from "../src/core/compaction/index.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";
import {
	FIXTURE_NAMES,
	type FixtureName,
	generateFixture,
} from "./fixtures/generate-synthetic-fixtures.ts";

const EXPECTED = {
	"before-compaction.jsonl": {
		rows: 1003, messages: 990, user: 55, assistant: 484, toolResult: 448, bashExecution: 3,
		toolCalls: 454, pendingCalls: 6, thinking: 49, modelChanges: 5, thinkingChanges: 5, compactions: 2,
		minimumBytes: 1_800_000,
	},
	"large-session.jsonl": {
		rows: 1019, messages: 914, user: 88, assistant: 453, toolResult: 373, bashExecution: 0,
		toolCalls: 391, pendingCalls: 18, thinking: 1, modelChanges: 1, thinkingChanges: 103, compactions: 0,
		minimumBytes: 900_000,
	},
} as const;

// Only protocol/model enum strings, generator identity, artificial ISO dates,
// and explicitly SYNTHETIC payloads are permitted. Failures expose counts, not
// fixture content, so an accidental sensitive replacement is not printed.
const ALLOWED_STRINGS = new Set([
	"session", "message", "model_change", "thinking_level_change", "compaction",
	"user", "assistant", "toolResult", "bashExecution", "text", "thinking", "toolCall",
	"read", "bash", "write", "edit", "stop", "toolUse", "off", "low", "medium", "high",
	"anthropic", "anthropic-messages", "claude-sonnet-4-20250514", "generate-synthetic-fixtures.ts",
]);

function load(name: FixtureName) {
	const raw = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
	// Strict JSON parsing, unlike the production parser that can skip bad lines.
	const rows = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
	return { raw, rows };
}

function migrate(name: FixtureName): SessionEntry[] {
	const { raw } = load(name);
	const parsed = parseSessionEntries(raw);
	migrateSessionEntries(parsed);
	return parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
}

function stringViolations(value: unknown): number {
	if (typeof value === "string") {
		const synthetic = value.includes("SYNTHETIC");
		const artificialDate = /^2000-01-01T\d{2}:\d{2}:\d{2}\.000Z$/.test(value);
		const unexpected = !synthetic && !artificialDate && !ALLOWED_STRINGS.has(value);
		const privateLocator = /(?:[A-Za-z]:[\\/]|\/(?:home|root|Users)\/|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/.test(value);
		return Number(unexpected || privateLocator);
	}
	if (Array.isArray(value)) return value.reduce((sum, part) => sum + stringViolations(part), 0);
	if (value && typeof value === "object") return Object.values(value).reduce<number>((sum, part) => sum + stringViolations(part), 0);
	return 0;
}

for (const name of FIXTURE_NAMES) {
	describe(`SYNTHETIC fixture ${name}`, () => {
		it("is byte-reproducible and contains only permitted synthetic strings", () => {
			const { raw, rows } = load(name);
			// Compare booleans so a failing assertion never dumps either payload.
			expect(raw === generateFixture(name)).toBe(true);
			expect(generateFixture(name) === generateFixture(name)).toBe(true);
			expect(rows[0].provenance?.kind === "SYNTHETIC").toBe(true);
			expect(rows[0].provenance?.source === "SYNTHETIC_ALGORITHMIC_ONLY").toBe(true);
			expect(rows[0].cwd === "SYNTHETIC_WORKSPACE").toBe(true);
			expect(stringViolations(rows)).toBe(0);
			const messages = rows.filter((row) => row.type === "message").map((row) => row.message);
			const payloads: string[] = [];
			for (const message of messages) {
				if (typeof message.content === "string") payloads.push(message.content);
				if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (typeof block.text === "string") payloads.push(block.text);
						if (typeof block.thinking === "string") payloads.push(block.thinking);
					}
				}
			}
			expect(payloads.length).toBeGreaterThan(100);
			expect(payloads.filter((text) => !text.startsWith("SYNTHETIC: ")).length).toBe(0);
		});

		it("preserves scale, settings, thinking, tools and incomplete/error-result cases", () => {
			const { raw, rows } = load(name);
			const expected = EXPECTED[name];
			expect(rows.length).toBe(expected.rows);
			expect(Buffer.byteLength(raw)).toBeGreaterThanOrEqual(expected.minimumBytes);
			const messages = rows.filter((row) => row.type === "message").map((row) => row.message);
			expect(messages.length).toBe(expected.messages);
			for (const role of ["user", "assistant", "toolResult", "bashExecution"] as const) {
				expect(messages.filter((message) => message.role === role).length).toBe(expected[role]);
			}
			expect(rows.filter((row) => row.type === "model_change").length).toBe(expected.modelChanges);
			expect(rows.filter((row) => row.type === "thinking_level_change").length).toBe(expected.thinkingChanges);
			expect(rows.filter((row) => row.type === "compaction").length).toBe(expected.compactions);
			const blocks = messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
			expect(blocks.filter((block) => block.type === "thinking").length).toBe(expected.thinking);
			const calls = blocks.filter((block) => block.type === "toolCall");
			expect(calls.length).toBe(expected.toolCalls);
			expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
			expect([...new Set(calls.map((call) => call.name))].sort()).toEqual(["bash", "edit", "read", "write"]);
			const callNames = new Map(calls.map((call) => [call.id, call.name]));
			const results = messages.filter((message) => message.role === "toolResult");
			expect(results.filter((result) => callNames.get(result.toolCallId) !== result.toolName).length).toBe(0);
			expect(new Set(results.map((result) => result.toolCallId)).size).toBe(results.length);
			expect(calls.length - results.length).toBe(expected.pendingCalls);
			expect(results.filter((result) => result.isError).length).toBeGreaterThan(0);
			expect(Math.max(...blocks.map((block) => (block.text ?? block.thinking ?? "").length))).toBe(65536);
			const users = messages.filter((message) => message.role === "user");
			expect(users.some((message) => typeof message.content === "string")).toBe(true);
			expect(users.some((message) => Array.isArray(message.content))).toBe(true);
			const paths = calls.map((call) => call.arguments.path).filter((path) => path !== undefined);
			expect(paths.filter((path) => typeof path !== "string" || !path.startsWith("SYNTHETIC/")).length).toBe(0);
		});

		it("migrates v1 IDs, parent links and compaction indices into a usable context", () => {
			const { raw, rows } = load(name);
			expect(rows[0].version).toBe(1);
			expect(rows.slice(1).filter((row) => "id" in row || "parentId" in row).length).toBe(0);
			const targets = rows.filter((row) => row.type === "compaction").map((row) => row.firstKeptEntryIndex);
			const parsed = parseSessionEntries(raw);
			migrateSessionEntries(parsed);
			const header = parsed.find((row) => row.type === "session");
			expect(header?.version).toBe(CURRENT_SESSION_VERSION);
			const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
			expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
			expect(entries.filter((entry, index) => entry.parentId !== (index ? entries[index - 1].id : null)).length).toBe(0);
			const compactions = entries.filter((entry): entry is CompactionEntry => entry.type === "compaction");
			for (const [index, entry] of compactions.entries()) {
				const target = parsed[targets[index]] as SessionMessageEntry;
				expect(entry.firstKeptEntryId === target.id).toBe(true);
				expect(target.type === "message" && target.message.role === "user").toBe(true);
				expect("firstKeptEntryIndex" in entry).toBe(false);
			}
			const idsBefore = entries.map((entry) => entry.id).join(",");
			migrateSessionEntries(parsed);
			expect(entries.map((entry) => entry.id).join(",") === idsBefore).toBe(true);
			const context = buildSessionContext(entries);
			expect(context.messages.length).toBeGreaterThan(100);
			expect(context.model !== null).toBe(true);
			expect(estimateContextTokens(context.messages).tokens).toBeGreaterThan(100000);
			if (compactions.length) {
				expect(context.messages[0].role === "compactionSummary").toBe(true);
				expect(context.messages.length).toBeLessThan(EXPECTED[name].messages);
			}
		});

		it("prepares compaction with synthetic file operations and a valid message boundary", () => {
			const entries = migrate(name);
			const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
			expect(preparation !== undefined).toBe(true);
			if (!preparation) return;
			expect(preparation.tokensBefore).toBeGreaterThan(100000);
			expect(preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length).toBeGreaterThan(0);
			const kept = entries.find((entry) => entry.id === preparation.firstKeptEntryId) as SessionMessageEntry;
			expect(kept.type === "message" && ["user", "assistant"].includes(kept.message.role)).toBe(true);
			for (const paths of Object.values(preparation.fileOps)) {
				expect(paths.size).toBeGreaterThan(0);
				expect([...paths].filter((path) => !path.startsWith("SYNTHETIC/")).length).toBe(0);
			}
			if (name === "before-compaction.jsonl") {
				expect(preparation.previousSummary?.startsWith("SYNTHETIC")).toBe(true);
			}
		});
	});
}

describe("SYNTHETIC derived tree and cut-point coverage", () => {
	it("keeps separate sibling leaves without including the unselected branch", () => {
		const entries = migrate("large-session.jsonl");
		const parent = entries.find((entry, index) => index > 200 && entry.type === "message" && entry.message.role === "user")!;
		const branches: SessionMessageEntry[] = ["A", "B"].map((label) => ({
			type: "message", id: `SYNTHETIC-branch-${label}`, parentId: parent.id,
			timestamp: "2000-01-01T01:00:00.000Z",
			message: { role: "user", content: `SYNTHETIC: alternate leaf ${label}`, timestamp: 946688400000 },
		}));
		for (const branch of branches) {
			const context = buildSessionContext([...entries, ...branches], branch.id);
			expect(context.messages.at(-1) === branch.message).toBe(true);
			expect(context.messages.includes(branches.find((entry) => entry !== branch)!.message)).toBe(false);
			expect(context.messages.length).toBeLessThan(EXPECTED["large-session.jsonl"].messages);
		}
	});

	it("covers split-turn and whole-history budgets without cutting at a tool result", () => {
		const entries = migrate("large-session.jsonl");
		const split = findCutPoint(entries, 0, entries.length, 32);
		expect(split.isSplitTurn).toBe(true);
		const splitEntry = entries[split.firstKeptEntryIndex] as SessionMessageEntry;
		expect(splitEntry.type === "message" && splitEntry.message.role === "assistant").toBe(true);
		const whole = findCutPoint(entries, 0, entries.length, Number.MAX_SAFE_INTEGER);
		expect(whole.isSplitTurn).toBe(false);
		const firstMessage = entries.slice(whole.firstKeptEntryIndex).find((entry) => entry.type === "message") as SessionMessageEntry;
		expect(firstMessage.message.role === "user").toBe(true);
	});
});
