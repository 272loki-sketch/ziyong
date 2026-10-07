import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSkillFiles } from "../src/stage/skill-store.ts";
import { fileURLToPath } from "node:url";
import { DIRECTOR_ROLES, directorMainSkill } from "../src/stage/agent-director.ts";
import { isGenerationMode, effectiveGenerationMode } from "../src/stage/generation-mode.ts";
import { buildLiteraryDirectorPrompt } from "../src/stage/literary-director.ts";
import { defaultState } from "../src/state.ts";

test("所有固定专家的内置Skill都由实际scanner识别，不是空workflow或测试手造对象", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-public-workflow-"));
	symlinkSync(fileURLToPath(new URL("../skills/", import.meta.url)), join(cwd, "skills"), "dir");
	const skills = scanSkillFiles(cwd);
	rmSync(cwd, { recursive: true, force: true });
	for (const workflow of ["writer-direct", "director-main", "director-evidence", "director-setting", "director-ecology", "director-ideas", "director-review-facts", "director-review-style"]) assert.ok(skills.some(x => x.workflow === workflow && x.body.trim()), workflow);
	assert.match(directorMainSkill(skills), /evidence[\s\S]*ideas[\s\S]*begin_narrative[\s\S]*review[\s\S]*finalize/);
	assert.deepEqual(Object.values(DIRECTOR_ROLES).map(x => x.length), [3, 2, 2]);
});

test("两种模式不是ask/质量档，旧未知值不会成为第三种可选模式", () => {
	assert.equal(isGenerationMode("direct"), true);assert.equal(isGenerationMode("director"), true);
	for (const v of ["ask", "profile", "guided", "legacy", null, undefined]) { assert.equal(isGenerationMode(v), false); assert.equal(effectiveGenerationMode(v), "director"); }
});

test("正常文学导演保留完整候选字段与来源资料，不会被改成缩减的一句提醒", () => {
	const original = readFileSync(new URL("../skills/Stitches拍前导演/SKILL.md", import.meta.url), "utf8");assert.match(original, /workflow: director/);
	const p = buildLiteraryDirectorPrompt({ state: defaultState(), history: [], activatedLore: [], userText: "继续。", charName: "同门", userName: "主角", characterCard: { name: "同门", description: "原始人物资料", personality: "人物性格", scenario: "当前场景" }, userPersona: "主角的原始人设" });
	for (const field of ["scenePressure", "characterInitiatives", "personalThreads", "offstageThreads", "candidateBeats", "withheldInformation", "relationshipLimit"]) assert.ok(p.systemPrompt.includes(field));
	assert.match(p.userText, /原始人物资料|主角的原始人设/);assert.doesNotMatch(p.systemPrompt, /轻量|简化|玩家停点|等待用户/);
});

test("新模式系统骨架只标注原始资料，不强制小说变成用户/NPC轮流接话", async () => {
	const { buildStageSystemPrompt, buildStageInjection } = await import("../src/stage/assemble.ts");
	const { DEFAULT_CONFIG } = await import("../src/types.ts");
	const card = { name: "云澜", description: "师姐", personality: "谨慎", scenario: "清晨", firstMes: "", mesExample: "", creatorNotes: "", systemPrompt: "", postHistoryInstructions: "", alternateGreetings: [], characterBook: null, extensions: {} } as never;
	for (const generationMode of ["direct", "director"] as const) {
		const system = buildStageSystemPrompt({ card, config: DEFAULT_CONFIG, constantLore: [], generationMode });
		assert.match(system, /角色卡资料|用户提供的人设/);
		assert.doesNotMatch(system, /# 用户扮演|# 你扮演的角色|历史偏好画像|文学画像/);
		const injected = buildStageInjection({ card, config: DEFAULT_CONFIG, state: defaultState(), activatedLore: [], history: [], latestUserText: "继续", literaryEcology: "已保存的生态切片" } as never);
		assert.doesNotMatch(injected, /不得强迫用户|探索者|本拍人物行动仍须/);
	}
});
