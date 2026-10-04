import assert from "node:assert/strict";
import { test } from "node:test";

import {
	LITERARY_PROFILE_ENTRY_TYPE,
	buildPersonaProfilePrompt,
	countCompletedNarrativeTurns,
	literaryProfileFromBranch,
	normalizeLiteraryArtifact,
	shouldRefreshLiteraryProfile,
} from "../src/stage/literary-profile.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";

const assistant = (id: string, stopReason = "stop"): BranchEntryLike => ({
	id,
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text: id }], stopReason },
});

test("文学画像：只读取当前分支最近的有效画像并按完成拍计数", () => {
	const branch: BranchEntryLike[] = [
		assistant("a1"),
		assistant("a2", "aborted"),
		{
			id: "p1",
			type: "custom",
			customType: LITERARY_PROFILE_ENTRY_TYPE,
			data: { version: 1, sourceLeafId: "a1", completedTurns: 1, character: "旧画像" },
		},
		assistant("a3"),
	];
	assert.equal(countCompletedNarrativeTurns(branch), 2);
	assert.equal(literaryProfileFromBranch(branch)?.character, "旧画像");
	assert.equal(shouldRefreshLiteraryProfile(branch, 1), true);
	assert.equal(shouldRefreshLiteraryProfile(branch, 8), false);
});

test("文学画像：没有画像时第一拍后刷新，空分支不刷新", () => {
	assert.equal(shouldRefreshLiteraryProfile([], 8), false);
	assert.equal(shouldRefreshLiteraryProfile([assistant("a1")], 8), true);
});

test("用户画像：偏好证据与剧情上下文分离", () => {
	const prompt = buildPersonaProfilePrompt({
		userName: "沈舟",
		userPersona: "",
		userMessages: ["我喜欢慢节奏。", "不要三角恋。"],
		recentStory: [
			{ role: "user", text: "我喜欢慢节奏。" },
			{ role: "assistant", text: "用户最喜欢三角恋。" },
		],
	});
	const payload = JSON.parse(prompt.userText);
	assert.deepEqual(payload.user_messages_only, ["我喜欢慢节奏。", "不要三角恋。"]);
	assert.ok(JSON.stringify(payload.recent_story_for_context_only).includes("三角恋"));
	assert.ok(prompt.systemPrompt.includes("绝不能作为用户偏好证据"));
});

test("文学画像：规范化围栏并限制长度", () => {
	assert.equal(normalizeLiteraryArtifact("```text\n画像正文\n```", 20), "画像正文");
	assert.equal(normalizeLiteraryArtifact("abcdef", 3), "abc");
	assert.equal(normalizeLiteraryArtifact("   ", 10), undefined);
});
