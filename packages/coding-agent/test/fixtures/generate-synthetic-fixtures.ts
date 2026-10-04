/**
 * SYNTHETIC session fixtures. No captured session, prompt, thinking, or private file
 * is read by this generator. All payloads, identifiers, paths, times, and usage
 * values below are invented. Numeric profiles preserve parser/compaction scale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_NAMES = ["before-compaction.jsonl", "large-session.jsonl"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];
type ToolName = "read" | "bash" | "write" | "edit";

interface Profile {
	users: number;
	exchanges: number;
	finalReplies: number;
	bashExecutions: number;
	thinkingBlocks: number;
	thinkingChanges: number;
	modelChanges: number;
	compactions: number;
	extraCalls: number;
	assistantChars: number;
	resultChars: number;
	tools: Record<ToolName, number>;
}

const PROFILES: Record<FixtureName, Profile> = {
	"before-compaction.jsonl": {
		users: 55,
		exchanges: 448,
		finalReplies: 36,
		bashExecutions: 3,
		thinkingBlocks: 49,
		thinkingChanges: 5,
		modelChanges: 5,
		compactions: 2,
		extraCalls: 6,
		assistantChars: 1100,
		resultChars: 1600,
		tools: { read: 107, bash: 206, write: 16, edit: 125 },
	},
	"large-session.jsonl": {
		users: 88,
		exchanges: 373,
		finalReplies: 80,
		bashExecutions: 0,
		thinkingBlocks: 1,
		thinkingChanges: 103,
		modelChanges: 1,
		compactions: 0,
		extraCalls: 18,
		assistantChars: 320,
		resultChars: 768,
		tools: { read: 50, bash: 192, write: 3, edit: 146 },
	},
};

const EPOCH = Date.UTC(2000, 0, 1);
const PROVIDER = "anthropic";
const MODEL = "claude-sonnet-4-20250514";
const TOOL_NAMES: ToolName[] = ["read", "bash", "write", "edit"];
const THINKING_LEVELS = ["off", "low", "medium", "high"];

function syntheticText(name: FixtureName, kind: string, ordinal: number, length: number): string {
	const tag = `${name.replace(".jsonl", "")}_${kind}_${String(ordinal).padStart(6, "0")}`;
	const prefix = `SYNTHETIC: ${tag}: GENERATED_TEST_DATA_ONLY\n`;
	const unit = `SYNTHETIC_${tag}_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ\n`;
	return (prefix + unit.repeat(Math.ceil(length / unit.length))).slice(0, length);
}

function share(total: number, index: number, count: number): number {
	return Math.floor(((index + 1) * total) / count) - Math.floor((index * total) / count);
}

/** Spread even rare write calls throughout the session instead of front-loading them. */
function planTools(counts: Record<ToolName, number>): ToolName[] {
	const total = TOOL_NAMES.reduce((sum, tool) => sum + counts[tool], 0);
	const used: Record<ToolName, number> = { read: 0, bash: 0, write: 0, edit: 0 };
	const plan: ToolName[] = [];
	for (let i = 0; i < total; i++) {
		const available = TOOL_NAMES.filter((tool) => used[tool] < counts[tool]);
		available.sort(
			(a, b) => (counts[b] * (i + 1) - used[b] * total) - (counts[a] * (i + 1) - used[a] * total),
		);
		const tool = available[0];
		used[tool]++;
		plan.push(tool);
	}
	return plan;
}

function toolArguments(name: FixtureName, tool: ToolName, ordinal: number): Record<string, unknown> {
	const path = `SYNTHETIC/workspace/module-${String(ordinal % 31).padStart(2, "0")}.ts`;
	switch (tool) {
		case "read":
			return { path, offset: 1, limit: 100 };
		case "bash":
			return { command: `printf '%s\\n' SYNTHETIC_TOOL_${ordinal}` };
		case "write":
			return { path, content: syntheticText(name, "write-content", ordinal, 2048) };
		case "edit":
			return {
				path,
				oldText: syntheticText(name, "edit-old", ordinal, 1024),
				newText: syntheticText(name, "edit-new", ordinal, 1024),
			};
	}
}

export function generateFixture(name: FixtureName): string {
	const profile = PROFILES[name];
	const rows: Record<string, unknown>[] = [
		{
			type: "session",
			version: 1,
			id: `SYNTHETIC-${name.replace(".jsonl", "")}-v1`,
			timestamp: new Date(EPOCH).toISOString(),
			cwd: "SYNTHETIC_WORKSPACE",
			provider: PROVIDER,
			modelId: MODEL,
			thinkingLevel: "high",
			provenance: {
				kind: "SYNTHETIC",
				generator: "generate-synthetic-fixtures.ts",
				revision: 1,
				source: "SYNTHETIC_ALGORITHMIC_ONLY",
			},
		},
	];
	const toolPlan = planTools(profile.tools);
	const userIndices: number[] = [];
	let assistantCount = 0;
	let exchangeCount = 0;
	let callCount = 0;
	let thinkingChangeCount = 0;
	let compactionCount = 0;

	function append(type: string, fields: Record<string, unknown>): void {
		const time = EPOCH + rows.length * 1000;
		const message = fields.message as Record<string, unknown> | undefined;
		if (message) message.timestamp = time;
		rows.push({ type, timestamp: new Date(time).toISOString(), ...fields });
	}

	function assistant(content: Record<string, unknown>[], stopReason: string): void {
		assistantCount++;
		const input = 4000 + assistantCount * 400;
		const output = 128 + (assistantCount % 16);
		const cacheRead = (assistantCount % 3) * 32;
		const cacheWrite = (assistantCount % 5) * 8;
		append("message", {
			message: {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: PROVIDER,
				model: MODEL,
				stopReason,
				usage: {
					input,
					output,
					cacheRead,
					cacheWrite,
					totalTokens: input + output + cacheRead + cacheWrite,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
	}

	function toolCall(): Record<string, unknown> {
		const tool = toolPlan[callCount++];
		return {
			type: "toolCall",
			id: `SYNTHETIC-${name.replace(".jsonl", "")}-call-${String(callCount).padStart(6, "0")}`,
			name: tool,
			arguments: toolArguments(name, tool, callCount),
		};
	}

	for (let turn = 0; turn < profile.users; turn++) {
		for (let i = 0; i < share(profile.modelChanges, turn, profile.users); i++) {
			append("model_change", { provider: PROVIDER, modelId: MODEL });
		}
		// In the large profile these settings precede the turn; the other profile
		// retains a trailing settings entry after its last message.
		const thinkingChanges = share(profile.thinkingChanges, turn, profile.users);
		if (name === "large-session.jsonl") {
			for (let i = 0; i < thinkingChanges; i++) {
				append("thinking_level_change", { thinkingLevel: THINKING_LEVELS[thinkingChangeCount++ % 4] });
			}
		}
		userIndices.push(rows.length);
		const userText = syntheticText(name, "user", turn + 1, name === "before-compaction.jsonl" ? 384 : 192);
		append("message", {
			message: { role: "user", content: turn % 2 ? [{ type: "text", text: userText }] : userText },
		});

		for (let i = 0; i < share(profile.exchanges, turn, profile.users); i++) {
			exchangeCount++;
			const call = toolCall();
			const content: Record<string, unknown>[] = [];
			if (exchangeCount <= profile.thinkingBlocks) {
				content.push({ type: "thinking", thinking: syntheticText(name, "reasoning-placeholder", exchangeCount, 512) });
			}
			content.push({ type: "text", text: syntheticText(name, "assistant", exchangeCount, profile.assistantChars) });
			content.push(call);
			// Deliberate unmatched parallel calls preserve incomplete-tool-response
			// edge cases; their IDs and arguments are also wholly SYNTHETIC.
			if (exchangeCount > profile.exchanges - profile.extraCalls) content.push(toolCall());
			assistant(content, "toolUse");
			append("message", {
				message: {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [
						{
							type: "text",
							text: syntheticText(name, "tool-result", exchangeCount, exchangeCount % 150 === 0 ? 65536 : profile.resultChars),
						},
					],
					isError: exchangeCount % 23 === 0,
				},
			});
		}
		for (let i = 0; i < share(profile.finalReplies, turn, profile.users); i++) {
			assistant([{ type: "text", text: syntheticText(name, "final-reply", turn + 1, profile.assistantChars) }], "stop");
		}
		for (let i = 0; i < share(profile.bashExecutions, turn, profile.users); i++) {
			append("message", {
				message: {
					role: "bashExecution",
					command: `printf '%s\\n' SYNTHETIC_BASH_${turn}`,
					output: syntheticText(name, "bash-output", turn + 1, 4096),
					exitCode: 0,
					cancelled: false,
					truncated: true,
					fullOutputPath: `SYNTHETIC/workspace/output-${turn}.txt`,
				},
			});
		}
		if (profile.compactions && (turn === Math.floor(profile.users / 3) - 1 || turn === Math.floor((profile.users * 2) / 3) - 1)) {
			compactionCount++;
			append("compaction", {
				summary: syntheticText(name, "compaction-summary", compactionCount, 4096),
				firstKeptEntryIndex: userIndices[Math.max(0, turn - 7)],
				tokensBefore: 150000 + compactionCount * 10000,
			});
		}
		if (name === "before-compaction.jsonl") {
			for (let i = 0; i < thinkingChanges; i++) {
				append("thinking_level_change", { thinkingLevel: THINKING_LEVELS[thinkingChangeCount++ % 4] });
			}
		}
	}
	if (callCount !== toolPlan.length || compactionCount !== profile.compactions) {
		throw new Error("SYNTHETIC fixture profile count mismatch");
	}
	return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

const directory = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes("--check");
	for (const name of FIXTURE_NAMES) {
		const path = join(directory, name);
		const generated = generateFixture(name);
		if (check) {
			if (readFileSync(path, "utf8") !== generated) throw new Error(`SYNTHETIC fixture is out of date: ${name}`);
		} else {
			writeFileSync(path, generated, "utf8");
		}
	}
	console.log(`SYNTHETIC fixtures ${check ? "verified" : "generated"}: ${FIXTURE_NAMES.length}`);
}
