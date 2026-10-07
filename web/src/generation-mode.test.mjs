import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const srcDir = dirname(fileURLToPath(import.meta.url));
const cache = new Map();

function loadTypeScript(path) {
	const filename = resolve(path);
	if (cache.has(filename)) return cache.get(filename);
	const source = readFileSync(filename, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filename,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => loadTypeScript(resolve(dirname(filename), specifier));
	const wrapper = vm.runInThisContext(`(function(require, module, exports) { ${output}\n})`, { filename });
	wrapper(localRequire, module, module.exports);
	cache.set(filename, module.exports);
	return module.exports;
}

const modes = loadTypeScript(resolve(srcDir, "generation-mode.ts"));
const workflowUi = loadTypeScript(resolve(srcDir, "generation-workflow-ui.ts"));
const { DeliverySessionGate, PromptOutbox, OUTBOX_KEY } = loadTypeScript(resolve(srcDir, "ws-lifecycle.ts"));

function memoryStorage(initial = null) {
	let value = initial;
	return {
		getItem(key) { return key === OUTBOX_KEY ? value : null; },
		setItem(key, next) { if (key === OUTBOX_KEY) value = next; },
		read() { return value; },
	};
}

test("story mode survives persistent outbox replay", () => {
	const storage = memoryStorage();
	const outbox = new PromptOutbox(storage, () => 1);
	const sent = { ...modes.buildStoryPromptFrame("沿着旧线索继续", "direct"), sessionId: "session-1", messageId: "msg-direct" };
	assert.equal(outbox.enqueue(sent, false).accepted, true);
	assert.equal(JSON.parse(storage.read())[0].frame.generationMode, "direct");

	const reloaded = new PromptOutbox(storage, () => 2);
	assert.equal(reloaded.flushable("prompt", "session-1")[0].generationMode, "direct");
	const gate = new DeliverySessionGate();
	gate.hello("prompt", "session-1", 1);
	assert.equal(gate.frames(reloaded, "prompt")[0].generationMode, "direct");
});

test("prompt pinning excludes control commands and assistant frames", () => {
	const story = modes.pinGenerationMode({ type: "prompt", text: "继续剧情" }, "direct");
	assert.equal(story.generationMode, "direct");
	const command = { type: "prompt", text: "/rewind 1" };
	assert.equal(modes.pinGenerationMode(command, "direct"), command);
	assert.equal("generationMode" in command, false);
	const assistant = { type: "assistant_prompt", text: "总结一下" };
	assert.equal(modes.pinGenerationMode(assistant, "direct"), assistant);
	assert.equal("generationMode" in assistant, false);
});

test("degraded and failed generation stages never present as success", () => {
	assert.equal(workflowUi.generationStageStatusPresentation("degraded").label, "报告待复核");
	assert.equal(workflowUi.generationStageStatusPresentation("degraded").icon, "!");
	assert.equal(workflowUi.generationStageStatusPresentation("failed").label, "失败");
	assert.equal(workflowUi.generationStageStatusPresentation("success").label, "成功");
});

test("restored text retains its captured mode; a new selection can replace it", () => {
	const draft = modes.restoredPromptMode("恢复这段剧情", "direct");
	const newlySelectedMode = "director";
	const resubmissionMode = modes.modeForPromptSubmission("恢复这段剧情", newlySelectedMode, draft);
	const frame = modes.buildStoryPromptFrame("恢复这段剧情", resubmissionMode);
	assert.equal(frame.generationMode, "direct");
	const storage = memoryStorage();
	const outbox = new PromptOutbox(storage, () => 2);
	assert.equal(outbox.enqueue({ ...frame, sessionId: "restored-session", messageId: "restored-message" }, false).accepted, true);
	assert.equal(JSON.parse(storage.read())[0].frame.generationMode, "direct");
	assert.equal(modes.modeForPromptSubmission("改写后的新输入", newlySelectedMode, draft), "director");
	assert.equal(modes.modeForPromptSubmission("恢复这段剧情", newlySelectedMode, null), "director");
});

test("legacy prose drafts default to director; commands and assistant frames stay mode-free", () => {
	const legacyItem = {
		frame: { type: "prompt", text: "旧版待发送剧情", sessionId: "legacy-session", messageId: "legacy-message" },
		createdAt: 1,
		state: "pending",
	};
	const storage = memoryStorage(JSON.stringify([legacyItem]));
	const outbox = new PromptOutbox(storage, () => 2);
	assert.equal(outbox.items[0].frame.generationMode, "director");
	const gate = new DeliverySessionGate();
	gate.hello("prompt", "legacy-session", 1);
	const replayed = gate.frames(outbox, "prompt")[0];
	assert.equal(replayed.generationMode, "director");

	const legacyDraft = modes.restoredPromptMode("旧版草稿", undefined);
	assert.equal(legacyDraft.generationMode, "director");
	const command = { type: "prompt", text: "/rewind 1" };
	assert.equal(modes.pinGenerationMode(command, "direct"), command);
	assert.equal(Object.hasOwn(command, "generationMode"), false);

	const assistantStorage = memoryStorage();
	const assistantOutbox = new PromptOutbox(assistantStorage, () => 3);
	assistantOutbox.enqueue({ type: "assistant_prompt", text: "帮我看一下", sessionId: "assistant-1", messageId: "msg-assistant", generationMode: "direct" }, true);
	assert.equal("generationMode" in JSON.parse(assistantStorage.read())[0].frame, false);
});
