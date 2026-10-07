import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizedSockets } from "../server/ws-authorization.ts";
import { PromptDeliveryLedger, findPersistedSubmission, readSubmissionIdentity } from "../server/prompt-delivery.ts";
import { OUTBOX_KEY, OUTBOX_LIMIT, PromptOutbox, DeliverySessionGate, newMessageId, type OutboxStorage, type ReliablePrompt } from "../web/src/ws-lifecycle.ts";

class Storage implements OutboxStorage {
	values = new Map<string, string>(); fail = false;
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	setItem(key: string, value: string): void { if (this.fail) throw new Error("QuotaExceededError"); this.values.set(key, value); }
}
const prompt = (id = "m1", sessionId = "story-a", text = "走进庭院"): ReliablePrompt => ({ type: "prompt", text, messageId: id, sessionId, ...(!text.trimStart().startsWith("/") ? { generationMode: "director" as const } : {}) });

test("WS 改密：旧 token / 设置前匿名连接同时移除，广播及逐帧校验均拒绝", () => {
	let tokens: Set<string> | undefined;
	const closed: string[] = [], clients = new AuthorizedSockets<string>((token) => !tokens || !!token && tokens.has(token), (socket) => closed.push(socket));
	assert.equal(clients.add("anonymous", undefined), true);
	tokens = new Set(["old"]); clients.revokeInvalid();
	assert.deepEqual([...clients], []);
	assert.equal(clients.add("a", "old"), true);
	tokens = new Set(["new"]);
	assert.equal(clients.allows("a"), false); // 无需等一次广播或 close 回调
	assert.deepEqual([...clients], []);
	assert.deepEqual(closed, ["anonymous", "a"]);
	assert.equal(clients.add("b", "new"), true);
	clients.revokeInvalid(); assert.deepEqual([...clients], ["b"]);
});
test("注销只撤对应 token；未失效连接仍广播，已失效连接不会再广播", () => {
	const tokens = new Set(["t1", "t2"]), closed: string[] = [];
	const clients = new AuthorizedSockets<string>((token) => !!token && tokens.has(token), (socket) => closed.push(socket));
	clients.add("a", "t1"); clients.add("same-device", "t1"); clients.add("b", "t2");
	tokens.delete("t1"); clients.revokeInvalid();
	assert.deepEqual([...clients].filter((socket) => clients.allows(socket)), ["b"]);
	assert.deepEqual(closed, ["a", "same-device"]);
});
test("legacy 明确兼容；半个投递身份绝不降级 legacy", () => {
	assert.equal(readSubmissionIdentity({}), "legacy");
	assert.equal(readSubmissionIdentity({ sessionId: "a" }), "invalid");
	assert.equal(readSubmissionIdentity({ messageId: "m1" }), "invalid");
	assert.deepEqual(readSubmissionIdentity(prompt()), { sessionId: "story-a", messageId: "m1" });
});
test("ledger 按 channel/target/id 隔离；pending 防重入，同 ID 改文拒绝，不驱逐 pending", () => {
	const ledger = new PromptDeliveryLedger(2), identity = { sessionId: "a", messageId: "m1" };
	assert.equal(ledger.begin("story", identity, "text"), "new");
	assert.equal(ledger.begin("story", identity, "text"), "pending");
	assert.equal(ledger.begin("story", identity, "other"), "conflict");
	assert.equal(ledger.begin("assistant", identity, "text"), "new");
	assert.equal(ledger.begin("command", identity, "/back"), "full");
	ledger.accept("story", identity);
	assert.equal(ledger.begin("story", identity, "text"), "accepted");
	assert.equal(ledger.begin("command", identity, "/back"), "new");
});
test("树 user id 而非同文去重，完整树可包含旁支；assistant 不冒充已接受 user", () => {
	const entries = [
		{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "old branch" }], details: { rpClientMessageId: "m1" } } },
		{ type: "message", id: "a1", message: { role: "assistant", content: "text", details: { rpClientMessageId: "m2" } } },
	];
	assert.deepEqual(findPersistedSubmission(entries, "m1"), { entryId: "u1", text: "old branch" });
	assert.equal(findPersistedSubmission(entries, "m2"), undefined);
});
test("outbox 写入在网络前；刷新仍是原 ID，只有匹配 ACK 清除", () => {
	const storage = new Storage(), box = new PromptOutbox(storage);
	assert.equal(box.enqueue(prompt(), false).accepted, true);
	assert.ok(storage.getItem(OUTBOX_KEY));
	const restored = new PromptOutbox(storage);
	assert.deepEqual(restored.flushable("prompt", "story-a"), [prompt()]);
	assert.equal(restored.ack("m1", "different", "accepted"), false);
	assert.equal(restored.items.length, 1);
	restored.ack("m1", "story-a", "accepted");
	assert.equal(new PromptOutbox(storage).items.length, 0);
});
test("hello 错会话持久拒绝且仍可复制，后续 hello 不自动恢复发送", () => {
	const storage = new Storage(), box = new PromptOutbox(storage);
	box.enqueue(prompt(), false);
	assert.equal(box.align("prompt", "story-b").length, 1);
	assert.deepEqual(box.flushable("prompt", "story-b"), []);
	const restored = new PromptOutbox(storage);
	assert.equal(restored.items[0].frame.text, "走进庭院");
	assert.equal(restored.items[0].state, "rejected");
	assert.deepEqual(restored.flushable("prompt", "story-a"), []);
});
test("slash command 离线拒绝且 recover-only；即使在线、刷新/断线也不自动重放", () => {
	for (const text of ["/new", "/back 1", "/rewind 1", "   /compact"]) {
		const storage = new Storage(), box = new PromptOutbox(storage);
		assert.equal(box.enqueue(prompt("m1", "story-a", text), false).accepted, false);
		assert.deepEqual(box.flushable("prompt", "story-a"), []);
		assert.equal(new PromptOutbox(storage).items[0].frame.text, text);
	}
	const storage = new Storage(), box = new PromptOutbox(storage);
	assert.equal(box.enqueue(prompt("m1", "story-a", "/back"), true).accepted, true);
	assert.deepEqual(box.flushable("prompt", "story-a"), []);
	box.disconnect(); assert.equal(box.items[0].state, "rejected");
	assert.deepEqual(new PromptOutbox(storage).flushable("prompt", "story-a"), []);
});
test("quota/上限失败是拒绝，不先发网络或删除已有草稿；同输入连点沿用 id", () => {
	const storage = new Storage(), box = new PromptOutbox(storage);
	box.enqueue(prompt(), false);
	assert.equal(box.enqueue(prompt("second-id"), false).messageId, "m1");
	storage.fail = true;
	assert.equal(box.enqueue(prompt("m2", "story-a", "第二条"), true).accepted, false);
	assert.ok(box.error); assert.equal(box.items.length, 1);
	storage.fail = false;
	for (let i = 1; i < OUTBOX_LIMIT; i++) assert.equal(box.enqueue(prompt(`n${i}`, "story-a", `text ${i}`), false).accepted, true);
	assert.equal(box.enqueue(prompt("overflow", "story-a", "over"), false).accepted, false);
});
test("fake transport: ACK 丢失后刷新+原 ID 重发只产生一次用户条目", () => {
	const storage = new Storage(), ledger = new PromptDeliveryLedger();
	let entries: unknown[] = [], turns = 0;
	const dispatch = (frame: ReliablePrompt, loseAck = false) => {
		if (!findPersistedSubmission(entries, frame.messageId) && ledger.begin("story", frame, frame.text) === "new") {
			turns++; entries.push({ type: "message", id: "u1", message: { role: "user", content: frame.text, details: { rpClientMessageId: frame.messageId } } });
			ledger.accept("story", frame);
		}
		if (!loseAck) new PromptOutbox(storage).ack(frame.messageId, frame.sessionId, "accepted");
	};
	const box = new PromptOutbox(storage); box.enqueue(prompt(), false);
	dispatch(box.flushable("prompt", "story-a")[0], true);
	const restored = new PromptOutbox(storage); dispatch(restored.flushable("prompt", "story-a")[0]);
	assert.equal(turns, 1); assert.equal(new PromptOutbox(storage).items.length, 0);
	// 清空 ledger 模拟重启时仍通过树 id 识别（不声称生成 completion 恰一次）。
	assert.deepEqual(findPersistedSubmission(entries, "m1"), { entryId: "u1", text: "走进庭院" });
});

test("实际 delivery gate + fake socket：open 前后均不发，hello 对齐才冲刷，重连保持原 ID", () => {
	const box = new PromptOutbox(new Storage()), gate = new DeliverySessionGate(), sent: ReliablePrompt[] = [];
	box.enqueue(prompt(), false);
	const flush = () => { for (const frame of gate.frames(box, "prompt")) { sent.push(frame); gate.sent.add(frame.messageId); } };
	flush(); assert.deepEqual(sent, []); // socket open 也尚未有 hello
	gate.hello("assistant_prompt", "assistant-a"); flush(); assert.deepEqual(sent, []);
	gate.hello("prompt", "story-a", 1); box.align("prompt", "story-a"); flush(); flush();
	assert.equal(sent.length, 1);
	gate.disconnect(); flush(); assert.equal(sent.length, 1);
	gate.hello("prompt", "story-a", 1); flush(); assert.equal(sent.length, 2);
	assert.equal(sent[0].messageId, sent[1].messageId);
	gate.disconnect(); gate.hello("prompt", "story-b", 1); box.align("prompt", "story-b"); flush();
	assert.equal(sent.length, 2);
});

test("未知目标只存 recover-only 草稿，不升级成自动重放消息；刷新后仍可复制", () => {
	const storage = new Storage(), box = new PromptOutbox(storage);
	assert.equal(box.recover(prompt("recover", "unconfirmed-target", "尚未连接的输入"), "未知目标").accepted, false);
	const restored = new PromptOutbox(storage);
	assert.equal(restored.items[0].frame.text, "尚未连接的输入");
	assert.deepEqual(restored.flushable("prompt", "unconfirmed-target"), []);
});
test("ACK 后 quota 清理失败可见，但当前页不重投；拒绝状态写失败亦不继续发送", () => {
	const storage = new Storage(), box = new PromptOutbox(storage); box.enqueue(prompt(), false);
	storage.fail = true; box.ack("m1", "story-a", "accepted");
	assert.equal(box.items.length, 0); assert.ok(box.error);
	storage.fail = false; const restored = new PromptOutbox(storage);
	storage.fail = true; restored.ack("m1", "story-a", "rejected", "错会话");
	assert.equal(restored.items[0].state, "rejected"); assert.ok(restored.error);
	assert.deepEqual(restored.flushable("prompt", "story-a"), []);
});
test("损坏 outbox 不自动覆盖或发空队列，保持可见错误", () => {
	const storage = new Storage(); storage.values.set(OUTBOX_KEY, "corrupted bytes");
	const box = new PromptOutbox(storage);
	assert.ok(box.error); assert.equal(box.enqueue(prompt(), true).accepted, false);
	assert.equal(storage.getItem(OUTBOX_KEY), "corrupted bytes");
});

test("被拒绝的显式原 ID 不能插入重复恢复日志或升级成自动重试", () => {
	const storage = new Storage(), box = new PromptOutbox(storage);
	box.enqueue(prompt(), false); box.ack("m1", "story-a", "rejected", "错会话");
	assert.equal(box.enqueue(prompt(), true).accepted, false);
	assert.equal(box.items.length, 1);
	assert.equal(new PromptOutbox(storage).items[0].state, "rejected");
});

test("HTTP VPS 没有 randomUUID 时使用 getRandomValues，生成合法 v4 UUID", () => {
	let calls = 0;
	const id = newMessageId({ getRandomValues: (bytes) => { calls++; bytes.set(Array.from({ length: 16 }, (_, i) => i)); return bytes; } });
	assert.equal(calls, 1);
	assert.equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
	assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
});
test("优先 randomUUID，受限 API 抛错仍能降级；无 crypto fallback 合法且连续调用不同", () => {
	assert.equal(newMessageId({ randomUUID: () => "12345678-1234-4234-8234-123456789abc", getRandomValues: () => { throw new Error("should not be called"); } }), "12345678-1234-4234-8234-123456789abc");
	const downgraded = newMessageId({ randomUUID: () => { throw new Error("secure context required"); }, getRandomValues: (bytes) => bytes.fill(1) });
	assert.match(downgraded, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
	const a = newMessageId(null, () => 42, () => 0.5), b = newMessageId(null, () => 42, () => 0.5);
	assert.notEqual(a, b);
	for (const id of [a, b]) assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
});
