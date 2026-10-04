import assert from "node:assert/strict";
import test from "node:test";

import {
	buildWireUrl,
	canOpenWire,
	nextRetryMs,
	shouldQueueFrame,
	shouldWakeFromOnline,
	shouldWakeFromVisibility,
	WS_CLOSED,
	WS_CLOSING,
	WS_CONNECTING,
	WS_OPEN,
	WS_RETRY_INITIAL_MS,
	WS_RETRY_MAX_MS,
} from "../web/src/ws-lifecycle.ts";

test("buildWireUrl：按页面协议选 ws / wss", () => {
	assert.equal(buildWireUrl("http:", "localhost:7620"), "ws://localhost:7620/ws");
	assert.equal(buildWireUrl("https:", "example.com"), "wss://example.com/ws");
});

test("canOpenWire：只在没有活动连接时允许新建连接", () => {
	assert.equal(canOpenWire(undefined), true);
	assert.equal(canOpenWire(null), true);
	assert.equal(canOpenWire(WS_CLOSED), true);
	assert.equal(canOpenWire(WS_CONNECTING), false);
	assert.equal(canOpenWire(WS_OPEN), false);
	assert.equal(canOpenWire(WS_CLOSING), false);
});

test("nextRetryMs：指数退避且封顶", () => {
	assert.equal(nextRetryMs(WS_RETRY_INITIAL_MS), 3000);
	assert.equal(nextRetryMs(6000), WS_RETRY_MAX_MS);
	assert.equal(nextRetryMs(WS_RETRY_MAX_MS), WS_RETRY_MAX_MS);
});

test("visibility/online 唤醒：只在可安全重连时触发", () => {
	assert.equal(shouldWakeFromVisibility("visible", false, WS_CLOSED), true);
	assert.equal(shouldWakeFromVisibility("hidden", false, WS_CLOSED), false);
	assert.equal(shouldWakeFromVisibility("visible", true, WS_CLOSED), false);
	assert.equal(shouldWakeFromVisibility("visible", false, WS_OPEN), false);

	assert.equal(shouldWakeFromOnline(false, WS_CLOSED), true);
	assert.equal(shouldWakeFromOnline(true, WS_CLOSED), false);
	assert.equal(shouldWakeFromOnline(false, WS_CONNECTING), false);
});

test("断线队列：只自动重放用户可重试的 prompt", () => {
	assert.equal(shouldQueueFrame("prompt"), true);
	assert.equal(shouldQueueFrame("assistant_prompt"), true);
	assert.equal(shouldQueueFrame("abort"), false);
	assert.equal(shouldQueueFrame("new"), false);
	assert.equal(shouldQueueFrame("choice_reply"), false);
});
