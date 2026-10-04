import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	LITERARY_WORLD_ENTRY_TYPE,
	defaultLiteraryWorldState,
	formatLiteraryWorldInjection,
	literaryWorldFromBranch,
	normalizeLiteraryWorldState,
} from "../src/stage/literary-world.ts";
import { scanSkillFiles, workflowSkill } from "../src/stage/skill-store.ts";
import { defaultCardWorldProfile, manifestFromProfile, normalizeCardWorldProfile } from "../src/stage/literary-world-profile.ts";

test("literary world：最近分支快照生效，回档分支自然恢复", () => {
	const early = { ...defaultLiteraryWorldState(), round: 1, digest: "城门仍然平静" };
	const late = { ...early, round: 2, digest: "商路开始封锁" };
	const prefix = [
		{ type: "custom", customType: LITERARY_WORLD_ENTRY_TYPE, data: early },
		{ type: "message", message: { role: "assistant", content: "正文" } },
	];
	assert.equal(literaryWorldFromBranch(prefix).digest, "城门仍然平静");
	assert.equal(literaryWorldFromBranch([...prefix, { type: "custom", customType: LITERARY_WORLD_ENTRY_TYPE, data: late }]).digest, "商路开始封锁");
});

test("literary world：解析完整快照并限制数量和等级", () => {
	const parsed = normalizeLiteraryWorldState(JSON.stringify({
		digest: "远方开始流传消息",
		events: [{ id: "event_a", name: "暗中调查", type: "progress", level: 9, stage: "筹备", description: "探子开始查访" }],
		winds: [{ id: "wind_a", topic: "失窃", type: "rumor", level: 2, content: "仓库失窃", scope: "码头", source: "守夜人→脚夫" }],
		blackbox: { secretActions: [{ action: "密室会面", witnesses: "无", trace: "门锁有新划痕" }], secretAssets: [] },
	}), defaultLiteraryWorldState());
	assert.ok(parsed);
	assert.equal(parsed.round, 1);
	assert.equal(parsed.events[0]?.id, "event_a");
	assert.equal(parsed.events[0]?.level, 4);
	assert.equal(parsed.winds[0]?.type, "rumor");
});

test("literary world：主演注入不泄露黑盒具体内容", () => {
	const world = normalizeLiteraryWorldState({
		digest: "表面局势平静",
		blackbox: { secretActions: [{ action: "甲在密室交出名单", witnesses: "无", trace: "" }], secretAssets: [] },
	}, defaultLiteraryWorldState());
	assert.ok(world);
	const injection = formatLiteraryWorldInjection(world)!;
	assert.match(injection, /存在尚未公开/);
	assert.doesNotMatch(injection, /甲在密室交出名单/);
});

test("literary world：用户 Skill 是规则权威且位于 Git 忽略目录", () => {
	const repo = mkdtempSync(join(tmpdir(), "liyuan-literary-world-skill-"));
	try {
		const skillDir = join(repo, ".liyuan-stage-skills", "world-rules");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), [
			"---",
			"name: 世界规则覆盖",
			"description: 测试世界规则边界",
			"workflow: world",
			"resident: false",
			"每轮: false",
			"---",
			"",
			"因果与信息边界由本规则定义。",
		].join("\n"));
		const skill = workflowSkill(scanSkillFiles(repo), "world");
		assert.equal(skill?.source, "user");
		assert.match(skill?.body ?? "", /因果与信息边界/);
		assert.match(skill?.dir ?? "", /world-rules/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("literary world：快照可直接作为 wire 展示数据且黑盒只需计数", () => {
	const world = normalizeLiteraryWorldState({
		digest: "局势正在变化",
		events: [{ id: "event_1", name: "考试筹备", type: "progress", level: 2, stage: "筹备", description: "各班开始行动" }],
		blackbox: { secretActions: [{ action: "秘密调查", witnesses: "无", trace: "无" }], secretAssets: [] },
	}, defaultLiteraryWorldState());
	assert.ok(world);
	assert.equal(world.events[0]?.name, "考试筹备");
	assert.equal(world.blackbox.secretActions.length, 1);
});

test("literary world：推演 prompt 收到角色卡独立适配，但仍由世界 Skill 决定演化", async () => {
	const { buildLiteraryWorldPrompt } = await import("../src/stage/literary-world.ts");
	const base = defaultCardWorldProfile("/tmp", "cards/a.json", "单角色卡", "x");
	const profile = normalizeCardWorldProfile({ digest: "二人封闭场景", modules: [{ id: "relationship-dynamics", name: "关系", mode: "active", cadence: "on-trigger", confidence: 1 }] }, base);
	assert.ok(profile);
	const prompt = buildLiteraryWorldPrompt({ skillBody: "规则", world: defaultLiteraryWorldState(), rpState: { time: "", location: "", characters: {}, inventory: [], flags: {}, plot_threads: [] }, history: [], userText: "你好", narrativeText: "她点头。", charName: "她", userName: "我", manifest: manifestFromProfile(profile) });
	assert.match(prompt.userText, /relationship-dynamics/);
	assert.match(prompt.systemPrompt, /工作流 Skill 是本任务规则的唯一权威/);
});
