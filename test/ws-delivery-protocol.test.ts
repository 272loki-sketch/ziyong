import assert from "node:assert/strict";
import test from "node:test";
import { DeliverySessionGate, legacyDeliveryWarning, OUTBOX_KEY, PromptOutbox, shouldRetryUnacknowledged, type OutboxStorage } from "../web/src/ws-lifecycle.ts";

class MemoryStorage implements OutboxStorage {
	data: string | null = null;
	fail = false;
	getItem(key: string): string | null { assert.equal(key, OUTBOX_KEY); return this.data; }
	setItem(key: string, value: string): void { assert.equal(key, OUTBOX_KEY); if (this.fail) throw new Error("storage denied"); this.data = value; }
}

const prompt = (type: "prompt" | "assistant_prompt" = "prompt") => ({ type, sessionId: "session-1", messageId: "msg-1", text: "继续这一幕" });

test("legacy hello with sessionId is not ACK capability: no auto-send/retry, draft remains", () => {
	const storage = new MemoryStorage(), box = new PromptOutbox(storage), gate = new DeliverySessionGate();
	assert.equal(box.enqueue(prompt(), true).accepted, true);
	assert.equal(gate.hello("prompt", "session-1"), false);
	assert.match(legacyDeliveryWarning("prompt"), /更新宿主/);
	assert.deepEqual(gate.frames(box, "prompt"), []);
	// 15s retry tick uses the same gate and still cannot send to an old host.
	assert.deepEqual(gate.frames(box, "prompt"), []);
	assert.equal(box.items.length, 1);
	assert.equal(box.items[0].state, "pending");
	assert.equal(box.items[0].frame.text, "继续这一幕");
});

test("protocol v1 hello explicitly enables reliable delivery", () => {
	const box = new PromptOutbox(new MemoryStorage()), gate = new DeliverySessionGate();
	box.enqueue(prompt(), true);
	assert.equal(gate.hello("prompt", "session-1", 1), true);
	assert.deepEqual(gate.frames(box, "prompt"), [prompt()]);
});

test("assistant prompt with uncertain ACK is retained but never automatically retried after disconnect/reload", () => {
	const storage = new MemoryStorage(), box = new PromptOutbox(storage), gate = new DeliverySessionGate();
	box.enqueue(prompt("assistant_prompt"), true);
	assert.equal(shouldRetryUnacknowledged("assistant_prompt"), false);
	assert.deepEqual(gate.hello("assistant_prompt", "session-1", 1), true);
	assert.equal(gate.frames(box, "assistant_prompt").length, 1);
	assert.equal(box.markDispatched("msg-1"), true); // durable write-ahead marker before send
	assert.deepEqual(gate.frames(box, "assistant_prompt"), []);
	const restoredBeforeClose = new PromptOutbox({ getItem: () => storage.data, setItem: (_key, value) => { storage.data = value; } });
	assert.equal(restoredBeforeClose.items[0].state, "rejected");
	assert.deepEqual(gate.frames(restoredBeforeClose, "assistant_prompt"), []);
	box.disconnect();
	assert.equal(box.items[0].state, "rejected");
	assert.match(box.items[0].reason ?? "", /先检查助手历史/);
	assert.deepEqual(gate.frames(box, "assistant_prompt"), []);
	const restored = new PromptOutbox({ getItem: () => storage.data, setItem: (_key, value) => { storage.data = value; } });
	gate.disconnect();
	gate.hello("assistant_prompt", "session-1", 1);
	assert.deepEqual(gate.frames(restored, "assistant_prompt"), []);
	assert.equal(restored.items[0].frame.text, "继续这一幕");
});

test("offline assistant prompt remains unsent and may have its first send after protocol-v1 hello", () => {
	const storage = new MemoryStorage(), box = new PromptOutbox(storage), gate = new DeliverySessionGate();
	const result = box.enqueue(prompt("assistant_prompt"), false);
	assert.equal(result.accepted, true);
	assert.equal(box.items[0].state, "pending");
	assert.equal(box.items[0].dispatched, false);
	const restored = new PromptOutbox({ getItem: () => storage.data, setItem: (_key, value) => { storage.data = value; } });
	assert.equal(restored.items[0].state, "pending");
	assert.equal(restored.items[0].dispatched, false);
	gate.hello("assistant_prompt", "session-1", 1);
	assert.deepEqual(gate.frames(restored, "assistant_prompt"), [prompt("assistant_prompt")]);
	assert.equal(restored.markDispatched("msg-1"), true);
	assert.deepEqual(gate.frames(restored, "assistant_prompt"), []);
	restored.disconnect(); gate.disconnect();
	gate.hello("assistant_prompt", "session-1", 1);
	assert.deepEqual(gate.frames(restored, "assistant_prompt"), []);
});

test("failed write-ahead marker refuses assistant send and leaves recoverable copy", () => {
	const storage = new MemoryStorage(), box = new PromptOutbox(storage), gate = new DeliverySessionGate();
	box.enqueue(prompt("assistant_prompt"), true);
	gate.hello("assistant_prompt", "session-1", 1);
	storage.fail = true;
	assert.equal(box.markDispatched("msg-1"), false);
	assert.equal(box.items[0].state, "rejected");
	assert.match(box.items[0].reason ?? "", /本次未发送/);
	assert.deepEqual(gate.frames(box, "assistant_prompt"), []);
});

test("legacy assistant outbox record without dispatched marker is conservatively recover-only", () => {
	const storage = new MemoryStorage();
	storage.data = JSON.stringify([{ frame: prompt("assistant_prompt"), createdAt: 1, state: "pending" }]);
	const box = new PromptOutbox(storage), gate = new DeliverySessionGate();
	assert.equal(box.items[0].state, "rejected");
	assert.match(box.items[0].reason ?? "", /状态不明/);
	gate.hello("assistant_prompt", "session-1", 1);
	assert.deepEqual(gate.frames(box, "assistant_prompt"), []);
});

test("story prompt retains persistent-ID retry behavior after disconnect", () => {
	const box = new PromptOutbox(new MemoryStorage()), gate = new DeliverySessionGate();
	box.enqueue(prompt(), true);
	assert.equal(shouldRetryUnacknowledged("prompt"), true);
	gate.hello("prompt", "session-1", 1);
	box.disconnect(); gate.disconnect();
	gate.hello("prompt", "session-1", 1);
	assert.deepEqual(gate.frames(box, "prompt"), [prompt()]);
});
