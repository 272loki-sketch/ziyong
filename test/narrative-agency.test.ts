import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildStageInjection, buildStageSystemPrompt } from "../src/stage/assemble.ts";
import { buildLiteraryDirectorPrompt, formatLiteraryDirection, parseLiteraryDirection } from "../src/stage/literary-director.ts";
import { buildSceneConductorPrompt, formatSceneConductor, parseSceneConductor } from "../src/stage/scene-conductor.ts";
import { scanSkillFiles, workflowSkill, type WorkflowSkillStage } from "../src/stage/skill-store.ts";
import { writeTools } from "../src/stage/tools.ts";
import { defaultState } from "../src/state.ts";
import { DEFAULT_CONFIG, type CharacterCard } from "../src/types.ts";

// Scan actual public builtins, without reading the project's private overrides.
function builtinWorkflows() {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-narrative-agency-"));
	try {
		symlinkSync(fileURLToPath(new URL("../skills/", import.meta.url)), join(cwd, "skills"), "dir");
		const skills = scanSkillFiles(cwd);
		return (["writer", "director", "character", "continuity"] as WorkflowSkillStage[]).map((stage) => {
			const skill = workflowSkill(skills, stage);
			assert.ok(skill, `missing builtin ${stage}`);
			assert.equal(skill.source, "builtin");
			return skill;
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

const card: CharacterCard = {
	name: "云澜", description: "", personality: "", scenario: "", firstMes: "", mesExample: "",
	systemPrompt: "", postHistoryInstructions: "", creatorNotes: "", alternateGreetings: [], tags: [], book: [],
};
const config = { ...DEFAULT_CONFIG, userName: "沈舟" };
const injectionOptions = () => ({ state: defaultState(), activatedLore: [], card, config });
const encodings = (value: Record<string, unknown>): unknown[] => [value, JSON.stringify(value), `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``];

function section(text: string, label: string): string {
	const heading = `【${label}】\n`;
	const index = text.indexOf(heading);
	assert.notEqual(index, -1, `missing ${label}`);
	const start = index + heading.length;
	const end = text.indexOf("\n\n【", start);
	return text.slice(start, end < 0 ? undefined : end);
}

// Guard system-owned instructions only, not user presets or narrative vocabulary.
function noAgencyInstructions(text: string) {
	for (const removed of [
		/\b(?:ask|playerStop)\b|玩家停点|待确认交互边界/,
		/(?:不得|不能|禁止|不替)[^。\n]*(?:主角|用户角色|玩家|用户)[^。\n]*(?:思想|对白|行动|选择|判断)/,
		/(?:主角|用户角色)[^。\n]*(?:允许|自主|自行决定|可(?:以|依|自然|作|按|说|做|决定))/,
		/(?:主角|用户角色)[^。\n]*(?:言行|行动|对白|判断)[^。\n]*可/,
		/(?:重大|不可逆|身份|关键未(?:定|决))[^。\n]*(?:确认|请用户|留给用户|擅猜)/,
		/(?:等待|等用户|请用户|交还|交给)[^。\n]*(?:决定|接话|回应|选择|行动权|操作)/,
		/代写边界|保留控制权|明确保留给用户|冻结主角/,
		/(?:下一步|接下来)(?:应|该|必须|要)由用户角色[^。\n]*(?:draft_seal|封笔|收笔)/,
		/只允许[^。\n]*对方[^。\n]*反应[^。\n]*停点/,
		/(?:每段|这一段)[^。\n]*(?:至少|必须)[^。\n]*(?:变化|改变|潜台词)/,
	]) assert.doesNotMatch(text, removed);
}

test("内置工作流只做减法：主角控制规则及反向解释不回流，稿纸流程仍在", () => {
	const skills = builtinWorkflows();
	for (const skill of skills) noAgencyInstructions(`${skill.description}\n${skill.body}`);
	const writer = skills.find((skill) => skill.workflow === "writer")!.body;
	for (const tool of ["beat_plan", "draft_append", "draft_seal"]) assert.ok(writer.includes(tool));
	assert.match(writer, /thinking[^。\n]*(?:禁止|不)[^。\n]*预写/);
	assert.match(writer, /正文[^。\n]*稿纸/);
});

test("系统工作方式与稿纸 schema 不追加主角控制或询问指令", () => {
	noAgencyInstructions(buildStageSystemPrompt({ card, config, constantLore: [] }));
	const tools = writeTools("中文");
	// A legacy ask schema may exist; StageEngine's actual exposed list is tested separately.
	for (const tool of tools.filter((tool) => tool.name !== "ask")) noAgencyInstructions(tool.description);
	const append = tools.find((tool) => tool.name === "draft_append");
	assert.ok(append);
	assert.deepEqual(append.parameters.required, ["segment"]);
	assert.equal((append.parameters.properties as Record<string, { type: string }>).segment.type, "string");
});

test("writerWorkflow 单独署名，预设指导和 presetTail 原文字节保留", () => {
	const writerWorkflow = builtinWorkflows().find((skill) => skill.workflow === "writer")!.body;
	const writerGuidance = [{ topic: "自定义", text: "  {{user}} 等待雨停。\r\n重大决定由用户确认。\n" }];
	const presetTail = ["  用户末端原文\r\n保留 {{user}}。  ", "第二段\n末行\t"];
	const before = structuredClone({ writerGuidance, presetTail });
	const text = buildStageInjection({ ...injectionOptions(), writerWorkflow, writerGuidance, presetTail });
	const guidance = section(text, "预设写作指导");
	assert.ok(guidance.includes(`## ${writerGuidance[0].topic}\n${writerGuidance[0].text}`));
	assert.doesNotMatch(guidance, /\b(?:beat_plan|draft_append|draft_seal|thinking)\b|【主演工作流】/);
	assert.ok(section(text, "主演工作流").includes(writerWorkflow));
	assert.equal(text.split("【主演工作流】").length - 1, 1);
	assert.equal(section(text, "预设末端指令"), presetTail.join("\n\n"));
	assert.ok(text.indexOf("【主演工作流】") < text.indexOf("【预设末端指令】"));
	assert.deepEqual({ writerGuidance, presetTail }, before);
	const workflowOnly = buildStageInjection({ ...injectionOptions(), writerWorkflow });
	assert.ok(!workflowOnly.includes("【预设写作指导】"));
	const guidanceOnly = buildStageInjection({ ...injectionOptions(), writerGuidance });
	assert.ok(!guidanceOnly.includes("【主演工作流】"));
});

test("导演与编排无停点仍解析正常候选，不改写看向或等待等叙事词汇", () => {
	const narrative = "她看向窗外，等待雨停。";
	for (const stop of [undefined, ""]) {
		const legacy = stop === undefined ? {} : { playerStop: stop };
		for (const input of encodings({ candidateBeats: [narrative], ...legacy })) {
			const direction = parseLiteraryDirection(input);
			assert.ok(direction);
			assert.deepEqual(direction.candidateBeats, [narrative]);
			assert.ok(formatLiteraryDirection(direction).includes(narrative));
		}
		for (const input of encodings({ turnOrder: [narrative], informationBoundary: ["尚未拆信"], ...legacy })) {
			const conductor = parseSceneConductor(input);
			assert.ok(conductor);
			assert.deepEqual(conductor.turnOrder, [narrative]);
			assert.deepEqual(conductor.informationBoundary, ["尚未拆信"]);
			assert.ok(formatSceneConductor(conductor)?.includes(narrative));
		}
	}
});

test("legacy playerStop 可解析，但字段、内容与交接标签不投影给主演", () => {
	const playerStop = "LEGACY_STOP_MUST_NOT_REACH_WRITER";
	const direction = parseLiteraryDirection({ candidateBeats: ["整理书信"], playerStop });
	const conductor = parseSceneConductor({ turnOrder: ["收好信封"], playerStop });
	assert.ok(direction && conductor);
	const literaryDirection = formatLiteraryDirection(direction);
	const sceneConductor = formatSceneConductor(conductor);
	for (const text of [literaryDirection, sceneConductor ?? "", buildStageInjection({ ...injectionOptions(), literaryDirection, sceneConductor })]) {
		assert.ok(!text.includes(playerStop));
		noAgencyInstructions(text);
	}
	assert.ok(literaryDirection.includes("整理书信") && sceneConductor?.includes("收好信封"));
	const stopOnly = parseLiteraryDirection({ playerStop });
	if (stopOnly) assert.ok(!formatLiteraryDirection(stopOnly));
	assert.ok(!formatSceneConductor(parseSceneConductor({ playerStop })));
});

test("辅助导演和编排提示词不制造 playerStop 或主角控制说明", () => {
	const director = buildLiteraryDirectorPrompt({ state: defaultState(), history: [], activatedLore: [], userText: "继续。", charName: card.name, userName: config.userName });
	const conductor = buildSceneConductorPrompt({ outline: { revision: 1, hash: "offline", premise: "", currentFocus: [], collections: {} } });
	noAgencyInstructions(director.systemPrompt);
	noAgencyInstructions(conductor.systemPrompt);
});
