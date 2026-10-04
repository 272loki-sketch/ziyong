import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectWriterContext, isConfirmedContextOverflow, WriterContextPreflight } from "../src/stage/context-preflight.ts";

test("writer capacity inspection never mutates or rejects arbitrary text/history/tools", () => {
	const context = { systemPrompt: "卡原文".repeat(1000), messages: [{ role: "user", content: [{ type: "text", text: "<not-closed>正文\\n###[]{}".repeat(2000) }] }], tools: [{ arbitrary: ["schema"] }] };
	const before = JSON.stringify(context);
	assert.equal(inspectWriterContext({ contextWindow: 100 }, context, 32768).status, "warning");
	assert.equal(JSON.stringify(context), before);
	assert.deepEqual(inspectWriterContext({}, context, 32768), { status: "unknown" });
	assert.deepEqual(inspectWriterContext({ contextWindow: Infinity }, context), { status: "unknown" });
});
test("preflight warns once across initial and later requests, unknown models stay silent", () => {
	const tracker = new WriterContextPreflight(), notices: string[] = [];
	tracker.check({}, { messages: ["x".repeat(10000)] }, 100, notice => notices.push(notice));
	assert.equal(notices.length, 0);
	tracker.check({ contextWindow: 10 }, { messages: ["x".repeat(10000)] }, 100, notice => notices.push(notice));
	tracker.check({ contextWindow: 10 }, { messages: ["x".repeat(20000)] }, 100, notice => notices.push(notice));
	assert.equal(notices.length, 1);
	assert.equal(tracker.snapshot().checks, 3);
	assert.equal(tracker.snapshot().warnings, 2);
});
test("only explicit context overflow is classified, not TPM/output validation/refusal", () => {
	for (const message of ["context_length_exceeded", "context_length_exceeded: TPM quota exceeded", "maximum context length is 200000 tokens", "prompt is too long: 123456 tokens > 10000", "request exceeds maximum input tokens", "input+max_tokens total exceeds context window"]) assert.equal(isConfirmedContextOverflow(message), true, message);
	for (const message of ["429 tokens per minute limit reached", "Input tokens per minute limit exceeded", "Input tokens exceed tokens-per-minute quota", "max_tokens must be less than 32768", "max_tokens exceeds maximum tokens allowed", "output tokens exceeds maximum tokens", "tools unsupported", "the assistant refused this request", "maximum number of requests reached"]) assert.equal(isConfirmedContextOverflow(message), false, message);
});
