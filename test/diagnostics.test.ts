import assert from "node:assert/strict";
import test from "node:test";

import { diagnosticsFromBranch } from "../src/stage/diagnostics.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";

test("diagnostics projects recent turn stages and branch commits", () => {
	const branch: BranchEntryLike[] = [
		{ id: "u1", type: "user", message: { role: "user", content: [{ type: "text", text: "继续" }] } },
		{ id: "a1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "正文" }], details: {
			rpNarrative: "正文", rpCurtain: "状态栏", rpPrep: {
				literaryContinuity: { positions: ["教室"] },
				literaryDirectionData: { scenePressure: "迟到的电话" },
				workflowStatus: { continuity: "success", director: "success" },
			}, rpWorkflow: { appends: 2, rounds: 4, appendRejects: 1, durationMs: 1200, outputTokens: 300 },
			rpTimeline: [{ kind: "thinking", text: "x" }, { kind: "tool", activities: [] }, { kind: "text", text: "正文" }],
			rpPatchAudit: [{ character: "A", fields: ["status"], lore: [{ fingerprint: "fp1", source: "private/source.json" }], verification: "not-semantic-verified", private: "不得透出" }],
		} } },
		{ id: "s1", type: "custom", customType: "rp-state", data: { digest: "账本已更新", characters: ["A"], _diagnosticSourceEntryId: "a1" } },
		{ id: "wa1", type: "custom", customType: "rp-world-audit", data: { status: "committed", narrativeEntryId: "a1", audit: { summary: "审计通过" }, secret: "不得透出" } },
		{ id: "w1", type: "custom", customType: "rp-world-state", data: { digest: "世界推进一轮", secret: "不得透出", _diagnosticSourceEntryId: "a1" } },
		{ id: "e1", type: "custom", customType: "rp-ecology-state", data: { digest: "人物继续活动", private: "不得透出", _diagnosticSourceEntryId: "a1" } },
	];
	const view = diagnosticsFromBranch(branch);
	assert.equal(view.turns.length, 1);
	const turn = view.turns[0]!;
	assert.equal(turn.timeline.thinking, 1);
	assert.equal(turn.stages.find((stage) => stage.id === "world-facts")?.status, "success");
	assert.equal(turn.stages.find((stage) => stage.id === "world-audit")?.status, "success");
	assert.equal(turn.stages.find((stage) => stage.id === "world-commit")?.status, "committed");
	assert.equal(turn.artifacts.curtain, "状态栏");
	assert.equal(turn.artifacts.commits.length, 4);
	assert.equal(JSON.stringify(turn).includes("不得透出"), false);
	assert.equal(JSON.stringify(turn).includes("characters"), false);
	assert.equal(JSON.stringify(turn).includes("private/source.json"), false);
});

test("diagnostics identifies failed world stage and degraded ecology", () => {
	const branch: BranchEntryLike[] = [
		{ id: "a1", type: "assistant", message: { role: "assistant", details: { rpNarrative: "正文", rpWorkflow: { appends: 1 } } } },
		{ id: "wa", type: "custom", customType: "rp-world-audit", data: { status: "proposal-failed", narrativeEntryId: "a1", errors: ["提案不可解析"] } },
		{ id: "eco", type: "custom", customType: "rp-ecology-state", data: { round: 2, degraded: { stage: "aftermath", error: "认知引用不合法" }, _diagnosticSourceEntryId: "a1" } },
	];
	const turn = diagnosticsFromBranch(branch).turns[0]!;
	assert.equal(turn.stages.find((stage) => stage.id === "world-facts")?.status, "success");
	assert.equal(turn.stages.find((stage) => stage.id === "world-proposal")?.status, "failed");
	assert.equal(turn.stages.find((stage) => stage.id === "world-audit")?.status, "skipped");
	assert.equal(turn.stages.find((stage) => stage.id === "ecology-aftermath")?.status, "degraded");
});

test("diagnostics respects the requested recent-turn limit", () => {
	const branch: BranchEntryLike[] = Array.from({ length: 4 }, (_, index) => ({
		id: `a${index}`, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `reply ${index}` }], details: { rpWorkflow: { appends: 1 } } },
	}));
	assert.equal(diagnosticsFromBranch(branch, 2).turns.length, 2);
	assert.equal(diagnosticsFromBranch(branch, Number.NaN).turns.length, 4);
	assert.equal(diagnosticsFromBranch(branch, 2.9).turns.length, 2);
});

test("diagnostics excludes legacy assistants and unrelated manual operations", () => {
	const branch: BranchEntryLike[] = [
		{ id: "legacy", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "旧消息" }] } },
		{ id: "a1", type: "assistant", message: { role: "assistant", details: { rpNarrative: "正文", rpWorkflow: { appends: 1 } } } },
		{ id: "wrong-audit", type: "custom", customType: "rp-world-audit", data: { status: "committed", narrativeEntryId: "another-turn", audit: { summary: "不属于本拍" } } },
		{ id: "manual-proposal", type: "custom", customType: "rp-outline-proposal", data: { status: "pending", proposal: { kind: "chat" } } },
		{ id: "manual-outline", type: "custom", customType: "rp-outline", data: { revision: 2 } },
	];
	const view = diagnosticsFromBranch(branch);
	assert.equal(view.turns.length, 1);
	assert.equal(view.turns[0]?.artifacts.commits.length, 0);
	assert.equal(view.turns[0]?.stages.find((stage) => stage.id === "outline-reconcile")?.status, "skipped");
});

test("diagnostics distinguishes proposal preflight rejection from audit rejection", () => {
	const base = (audit?: unknown): BranchEntryLike[] => [
		{ id: "a1", type: "assistant", message: { role: "assistant", details: { rpNarrative: "正文", rpWorkflow: { appends: 1 } } } },
		{ id: "wa", type: "custom", customType: "rp-world-audit", data: { status: "rejected", narrativeEntryId: "a1", errors: ["越权"], ...(audit ? { audit } : {}) } },
	];
	const preflight = diagnosticsFromBranch(base()).turns[0]!;
	assert.equal(preflight.stages.find((stage) => stage.id === "world-proposal")?.status, "rejected");
	assert.equal(preflight.stages.find((stage) => stage.id === "world-audit")?.status, "skipped");
	const audited = diagnosticsFromBranch(base({ summary: "独立审计拒绝" })).turns[0]!;
	assert.equal(audited.stages.find((stage) => stage.id === "world-proposal")?.status, "success");
	assert.equal(audited.stages.find((stage) => stage.id === "world-audit")?.status, "rejected");
});

test("diagnostics distinguishes no-change scribe from scribe failure", () => {
	const base = (diagnostic: Record<string, unknown>): BranchEntryLike[] => [
		{ id: "a1", type: "assistant", message: { role: "assistant", details: { rpNarrative: "正文", rpWorkflow: { appends: 1 } } } },
		{ id: "d1", type: "custom", customType: "rp-turn-diagnostic", data: { sourceEntryId: "a1", stage: "scribe", ...diagnostic } },
	];
	const skipped = diagnosticsFromBranch(base({ kind: "skipped", reason: "empty-patch" })).turns[0]!;
	assert.equal(skipped.stages.find((stage) => stage.id === "ledger")?.status, "skipped");
	assert.match(skipped.stages.find((stage) => stage.id === "ledger")?.summary ?? "", /无需/);
	const failed = diagnosticsFromBranch(base({ kind: "failed", error: "输出不可解析" })).turns[0]!;
	assert.equal(failed.stages.find((stage) => stage.id === "ledger")?.status, "degraded");
	assert.match(failed.stages.find((stage) => stage.id === "ledger")?.summary ?? "", /不可解析/);
});

test("diagnostics caps curtain and accepts runtime outline status", () => {
	const branch: BranchEntryLike[] = [{ id: "a1", type: "assistant", message: { role: "assistant", details: { rpNarrative: "正文", rpCurtain: "x".repeat(40_000), rpWorkflow: { appends: 1 } } } }];
	const turn = diagnosticsFromBranch(branch, 1, { a1: { outline: { status: "stable", summary: "无需调整" } } }).turns[0]!;
	assert.equal(turn.artifacts.curtain?.length, 32_000);
	assert.equal(turn.artifacts.curtainTruncated, true);
	assert.equal(turn.curtainChars, 40_000);
	assert.equal(turn.stages.find((stage) => stage.id === "outline-reconcile")?.status, "stable");
});

test("diagnostics reads settled curtain override", () => {
	const branch: BranchEntryLike[] = [
		{ id: "a1", type: "assistant", message: { role: "assistant", details: { rpNarrative: "正文", rpWorkflow: { appends: 1 } } } },
		{ id: "c1", type: "custom", customType: "rp-curtain-override", data: { targetEntryId: "a1", curtain: "<StatusBlock>最终状态</StatusBlock>" } },
	];
	const [view] = diagnosticsFromBranch(branch, 1).turns;
	assert.match(view?.artifacts.curtain ?? "", /最终状态/);
	assert.equal(view?.stages.find((stage) => stage.id === "curtain")?.status, "success");
});

test("diagnostics projects a failed text-only turn without an assistant entry", () => {
	const branch: BranchEntryLike[] = [{
		id: "debug-1",
		type: "custom",
		customType: "rp-text-debug",
		data: {
			beatLog: [
				{ ev: "activity", data: "文学连续性：生成失败（超时）" },
				{ ev: "text", data: "<content>已收到的正文</content>" },
				{ ev: "provider_error", data: "Stream ended without finish_reason" },
			],
			draft: "",
			loopTail: "",
			finalText: "",
		},
	}];
	const turn = diagnosticsFromBranch(branch).turns[0]!;
	assert.equal(turn.stages.find((stage) => stage.id === "writer")?.status, "failed");
	assert.match(turn.stages.find((stage) => stage.id === "writer")?.summary ?? "", /已收到/);
	assert.equal(turn.stages.find((stage) => stage.id === "ledger")?.status, "skipped");
	assert.match(JSON.stringify(turn), /finish_reason/);
});

test("diagnostics projects bound safe performance beyond commit limit and preserves input observations", () => {
	const branch: BranchEntryLike[] = [
		{ id: "a1", type: "message", message: { role: "assistant", details: { rpNarrative: "正文", rpWorkflow: { durationMs: 5, appends: 1 }, rpInputComposition: { systemChars: 123 }, rpContextPreflight: { status: "warning", checks: 3, warnings: 1, inputChars: 1234, prompt: "不公开" } } } },
		...Array.from({ length: 35 }, (_, index) => ({ id: `s${index}`, type: "custom", customType: "rp-state", data: { _diagnosticSourceEntryId: "a1" } })),
		{ id: "wrong", type: "custom", customType: "rp-turn-performance", data: { version: 1, narrativeEntryId: "another", totalMs: 999, phases: {} } },
		{ id: "perf", type: "custom", customType: "rp-turn-performance", data: { version: 1, narrativeEntryId: "a1", totalMs: 20, timeToFirstNarrativeMs: 7, prompt: "不公开", phases: { writer: { durationMs: 10, calls: 3, inputTokens: 12, status: "success", reasoning: "不公开" } } } },
	];
	const turn = diagnosticsFromBranch(branch).turns[0]!;
	assert.equal(turn.performance?.totalMs, 20);
	assert.equal(turn.performance?.narrativeEntryId, "a1");
	assert.equal(turn.performance?.phases.writer?.calls, 3);
	assert.equal(turn.artifacts.commits.length, 32);
	assert.equal(turn.artifacts.contextPreflight?.checks, 3);
	assert.equal(JSON.stringify(turn).includes("不公开"), false);
});
