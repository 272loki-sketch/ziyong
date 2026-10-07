import assert from "node:assert/strict";
import test from "node:test";
import {
	DIRECTOR_ROLES,
	directorMainSkill,
	executeDirectorBatch,
	formatDirectorReports,
	type DirectorContext,
	type DirectorPhase,
	type DirectorRole,
	type DirectorTask,
} from "../src/stage/agent-director.ts";
import type { SkillFile } from "../src/stage/skill-store.ts";

const WORKFLOWS: Record<DirectorRole, string> = {
	continuity: "director-evidence",
	setting: "director-setting",
	ecology: "director-ecology",
	"idea-a": "director-ideas",
	"idea-b": "director-ideas",
	"review-facts": "director-review-facts",
	"review-style": "director-review-style",
};

function skillsFor(roles: DirectorRole[] = Object.keys(WORKFLOWS) as DirectorRole[]): SkillFile[] {
	const workflows = new Set(roles.map((role) => WORKFLOWS[role]));
	return [...workflows].map((workflow) => ({
		dir: workflow,
		name: workflow,
		description: workflow,
		workflow,
		resident: false,
		everyBeat: false,
		body: `skill-body:${workflow}`,
		source: "builtin",
		updateStatus: "current",
	}) as SkillFile);
}

function context(overrides: Partial<DirectorContext> = {}): DirectorContext {
	return {
		userText: "我停在门边，等她回答。",
		card: { name: "云澜" },
		state: { place: "门边" },
		history: [{ role: "assistant", text: "她抬眼看向门口。" }],
		sources: [{ id: "s1", text: "当前分支记录：她仍在门边。" }],
		sessionId: "session-1",
		leafId: "leaf-1",
		...overrides,
	};
}

const emptyReport = JSON.stringify({ summary: "", facts: [], inferences: [], candidates: [], issues: [] });
const tasksFor = (phase: DirectorPhase): DirectorTask[] => DIRECTOR_ROLES[phase].map((role) => ({ role, task: `核对 ${role}` }));

test("DIRECTOR_ROLES 固定三阶段角色，非法、缺失、重复和跨阶段角色均拒绝", async () => {
	assert.deepEqual(DIRECTOR_ROLES.evidence, ["continuity", "setting", "ecology"]);
	assert.deepEqual(DIRECTOR_ROLES.ideas, ["idea-a", "idea-b"]);
	assert.deepEqual(DIRECTOR_ROLES.review, ["review-facts", "review-style"]);
	const base = {
		context: context(),
		skills: skillsFor(),
		run: async () => emptyReport,
	};
	await assert.rejects(executeDirectorBatch({ ...base, phase: "evidence", tasks: [{ role: "continuity", task: "" }] }), /恰好提供/);
	await assert.rejects(executeDirectorBatch({ ...base, phase: "evidence", tasks: [
		{ role: "continuity", task: "" }, { role: "continuity", task: "" }, { role: "ecology", task: "" },
	] }), /重复/);
	await assert.rejects(executeDirectorBatch({ ...base, phase: "ideas", tasks: [
		{ role: "idea-a", task: "" }, { role: "setting", task: "" } as DirectorTask,
	] }), /未知或不匹配/);
	await assert.rejects(executeDirectorBatch({ ...base, phase: "evidence", tasks: [
		{ role: "continuity", task: "" }, { role: "setting", task: "" }, { role: "unknown", task: "" } as DirectorTask,
	] }), /未知或不匹配/);
});

test("一阶段所有固定专家真实并行启动，最多三路且各角色只请求一次", async () => {
	let active = 0;
	let peak = 0;
	const calls: Array<{ step: string; system: string }> = [];
	let release!: () => void;
	const allStarted = new Promise<void>((resolve) => { release = resolve; });
	const run = async (step: string, system: string): Promise<string> => {
		active++;
		peak = Math.max(peak, active);
		calls.push({ step, system });
		if (calls.length === 3) release();
		await allStarted;
		active--;
		return emptyReport;
	};
	const reports = await executeDirectorBatch({
		phase: "evidence", tasks: tasksFor("evidence"), context: context(), skills: skillsFor(),
		run: run as never,
	});
	assert.equal(peak, 3);
	assert.equal(calls.length, 3);
	assert.deepEqual(calls.map((call) => call.step).sort(), ["directorSetting", "ecologyRuntime", "literaryContinuity"].sort());
	assert.ok(calls.every((call) => call.system.startsWith("skill-body:")));
	assert.deepEqual(reports.map((report) => report.status), ["success", "success", "success"]);
});

test("各角色映射自己的模型 slot；双构思分别请求，单角色请求预算一次", async () => {
	const calls: string[] = [];
	const reports = await executeDirectorBatch({
		phase: "ideas", tasks: tasksFor("ideas"), context: context(), skills: skillsFor(),
		run: async (step, _system, _user, maxTokens) => { calls.push(step); assert.equal(maxTokens, 1_200); return emptyReport; },
	});
	assert.deepEqual(calls, ["directorIdeas", "directorIdeas"]);
	assert.deepEqual(reports.map((report) => report.role), ["idea-a", "idea-b"]);
	const reviewCalls: string[] = [];
	await executeDirectorBatch({
		phase: "review", tasks: tasksFor("review"), context: context({ draft: "待审稿" }), skills: skillsFor(),
		run: async (step) => { reviewCalls.push(step); return emptyReport; },
	});
	assert.deepEqual(reviewCalls, ["directorReviewFacts", "directorReviewStyle"]);
});

test("来源核验拒绝缺失、伪造及跨阶段 draft 来源，并降级为未证实推断", async () => {
	const output = JSON.stringify({
		summary: "本拍有一项已证实事实。",
		facts: [
			{ text: "来源支持的位置", sourceIds: ["s1"] },
			{ text: "缺少来源的判断", sourceIds: [] },
			{ text: "伪造来源的判断", sourceIds: ["fake"] },
			{ text: "证据与伪来源混用", sourceIds: ["s1", "fake"] },
			{ text: "证据 id 缺失", sourceIds: undefined },
			{ text: "此阶段 draft 不是有效虚拟来源", sourceIds: ["draft"] },
		],
		inferences: [],
		candidates: ["可以停留在等候，不必制造新事件。"],
		issues: [{ text: "同样不能以伪来源成为问题", sourceIds: ["fake"] }],
	});
	const reports = await executeDirectorBatch({
		phase: "evidence", tasks: tasksFor("evidence"), context: context(), skills: skillsFor(),
		run: async () => output,
	});
	for (const report of reports) {
		assert.equal(report.status, "degraded");
		assert.ok(report.facts.every((fact) => fact.sourceIds.length > 0 && fact.sourceIds.every((id) => id === "s1")));
		assert.ok(report.inferences.length > 0);
		assert.ok(report.candidates.length > 0, "候选无需旧事实来源证明");
		assert.equal(report.issues.length, 0);
	}
	assert.ok(reports[0]!.inferences.some((item) => item.includes("伪造来源")));
});

test("draft 仅在审阅阶段作为虚拟来源；有效问题保留，混入伪来源则降级", async () => {
	const output = JSON.stringify({
		summary: "可定位的审阅结果。",
		facts: [{ text: "稿件确实写了该句。", sourceIds: ["draft"] }],
		inferences: [],
		candidates: [],
		issues: [
			{ text: "引用稿件中的问题。", sourceIds: ["draft"] },
			{ text: "缺失来源的问题。", sourceIds: [] },
			{ text: "带伪造来源的问题。", sourceIds: ["draft", "fake"] },
		],
	});
	const reports = await executeDirectorBatch({
		phase: "review", tasks: tasksFor("review"), context: context({ draft: "她说：‘我知道答案。’" }), skills: skillsFor(),
		run: async (_step, _system, user) => {
			const payload = JSON.parse(user) as { context: { draft?: string } };
			assert.equal(payload.context.draft, "她说：‘我知道答案。’");
			return output;
		},
	});
	for (const report of reports) {
		assert.equal(report.status, "degraded");
		assert.deepEqual(report.facts[0]?.sourceIds, ["draft"]);
		assert.deepEqual(report.issues.map((issue) => issue.sourceIds), [["draft"]]);
		assert.equal(report.inferences.length, 2);
	}
});

test("非风格岗位上下文有界，不发送大全文预设或非审阅draft", async () => {
	const presetText = "原始预设".repeat(12_000);
	let payload: { context: { presetText?: string; userText: string; draft?: string } } | undefined;
	await executeDirectorBatch({
		phase: "ideas", tasks: tasksFor("ideas"), context: context({
			presetText, draft: "不应发送的旧稿", userText: "输入".repeat(8_000),
		}), skills: skillsFor(),
		run: async (_step, _system, user) => {
			payload = JSON.parse(user) as typeof payload;
			return emptyReport;
		},
	});
	assert.equal(payload?.context.presetText, undefined);
	assert.equal(payload?.context.userText.length, 6_000);
	assert.equal("draft" in (payload?.context ?? {}), false);
});

test("单角色失败会返回失败报告，不泄露原始输出或提示词", async () => {
	const reports = await executeDirectorBatch({
		phase: "ideas", tasks: tasksFor("ideas"), context: context({ userText: "私有原始提示词标记" }), skills: skillsFor(),
		run: async (_step, _system, _user) => { throw new Error("gateway offline"); },
	});
	assert.ok(reports.every((report) => report.status === "failed" && report.candidates.length === 0));
	assert.match(reports[0]!.summary, /gateway offline/);
	const formatted = formatDirectorReports(reports);
	assert.doesNotMatch(formatted, /私有原始提示词标记|skill-body|gateway offline.*\{/);
	assert.match(formatted, /失败|failed/);
});

test("畸形专家输出失败；缺少 Skill 不调用模型", async () => {
	let calls = 0;
	const malformed = await executeDirectorBatch({
		phase: "ideas", tasks: tasksFor("ideas"), context: context(), skills: skillsFor(),
		run: async () => { calls++; return "not-json"; },
	});
	assert.equal(calls, 2);
	assert.ok(malformed.every((report) => report.status === "failed"));
	const absent = await executeDirectorBatch({
		phase: "ideas", tasks: tasksFor("ideas"), context: context(), skills: [],
		run: async () => { calls++; return emptyReport; },
	});
	assert.equal(calls, 2);
	assert.match(absent[0]!.summary, /director-ideas/);
});

test("取消或切叶后立即停止采用结果；取消前已完成的报告也不泄漏", async () => {
	const controller = new AbortController();
	const finishers: Array<(value: string) => void> = [];
	const running = executeDirectorBatch({
		phase: "ideas", tasks: tasksFor("ideas"), context: context(), skills: skillsFor(), signal: controller.signal,
		run: async () => new Promise<string>((resolve) => { finishers.push(resolve); }),
	});
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	const reports = await running;
	assert.ok(reports.every((report) => report.status === "failed" && report.candidates.length === 0));
	for (const finish of finishers) finish(JSON.stringify({ summary: "late", facts: [], inferences: [], candidates: ["迟到候选"], issues: [] }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(reports.every((report) => report.candidates.length === 0));

	let current = true;
	const staleRun = executeDirectorBatch({
		phase: "ideas", tasks: tasksFor("ideas"), context: context(), skills: skillsFor(), isCurrent: () => current,
		run: async () => new Promise<string>((resolve) => setTimeout(() => resolve(emptyReport), 250)),
	});
	setTimeout(() => { current = false; }, 10);
	const staleReports = await staleRun;
	assert.ok(staleReports.every((report) => report.status === "failed" && report.summary.includes("未采用")));
});

test("directorMainSkill 只读取 director-main Skill 正文", () => {
	const supplied = skillsFor();
	supplied.push({
		dir: "main", name: "main", description: "main", workflow: "director-main" as never,
		resident: false, everyBeat: false, body: "唯一主 Agent 正文 owner", source: "builtin", updateStatus: "current",
	} as SkillFile);
	assert.equal(directorMainSkill(supplied), "唯一主 Agent 正文 owner");
	assert.equal(directorMainSkill([]), "");
});

test("来源校验只接受实际发送范围，超额裁出的 id 不得混作证据", async () => {
	const sources = Array.from({ length: 32 }, (_, i) => ({ id: `raw-${i}`, text: `来源 ${i}`.repeat(200) }));
	const reports = await executeDirectorBatch({ phase: "ideas", tasks: tasksFor("ideas"), context: context({ sources }), skills: skillsFor(),
		run: async (_s, _sp, user) => {
			const payload = JSON.parse(user);
			assert.ok(!payload.context.sources.some((x: any) => x.id === "raw-31"));
			return JSON.stringify({ summary: "", facts: [{ text: "未发送来源不能证明的断言", sourceIds: ["raw-31"] }], inferences: [], candidates: [], issues: [] });
		},
	});
	assert.ok(reports.every(report => report.status === "degraded" && report.facts.length === 0));
});

test("前阶段短报告可参考但不是新事实来源，完整待审稿和明确人设不丢失", async () => {
	const draft = "这是完整待审正文。".repeat(4000);
	const prior = { role: "continuity" as const, status: "success" as const, summary: "前阶段关系线索", facts: [{ text: "仍在门口", sourceIds: ["s1"] }], inferences: ["未证实的心情"], candidates: ["可选思路"], issues: [] };
	const reports = await executeDirectorBatch({ phase: "review", tasks: tasksFor("review"), context: context({ priorReports: [prior], draft, userPersona: "明确设定的人设" }), skills: skillsFor(),
		run: async (_s, _sp, user) => {
			const payload = JSON.parse(user);
			assert.equal(payload.context.draft, draft);
			assert.equal(payload.context.userPersona, "明确设定的人设");
			assert.equal(payload.context.priorReports[0].summary, prior.summary);
			return JSON.stringify({ summary: "", facts: [{ text: "报告不是原文", sourceIds: ["continuity"] }], inferences: [], candidates: [], issues: [] });
		},
	});
	assert.ok(reports.every(report => report.facts.length === 0));
});

test("只输出私自代写而无报告schema的专家回包是失败，不冒充零问题审阅", async () => {
	const reports = await executeDirectorBatch({ phase: "review", tasks: tasksFor("review"), context: context({ draft: "正文" }), skills: skillsFor(), run: async () => JSON.stringify({ narrative: "偷偷代写", patch: [] }) });
	assert.ok(reports.every(report => report.status === "failed"));
});

test("严格语义恢复：degraded来源报告同岗重取一次，固定3/2/2岗位全部保留", async () => {
	const invalid = JSON.stringify({ summary: "原始来源报告", facts: [
		{ text: "未获来源支持的断言", sourceIds: ["s1", "fake-source"] },
	], inferences: [], candidates: [], issues: [{ text: "未提供来源的问题", sourceIds: [] }] });
	const repaired = JSON.stringify({ summary: "已重新核对来源", facts: [{ text: "她仍在门边。", sourceIds: ["s1"] }],
		inferences: ["原断言尚未证实"], candidates: [], issues: [] });
	for (const phase of ["evidence", "ideas", "review"] as const) {
		const originals = new Map<DirectorRole, { step: string; system: string; payload: any }>();
		const counts = new Map<DirectorRole, number>();
		const reports = await executeDirectorBatch({ phase, tasks: tasksFor(phase), context: context({ draft: "她仍在门边。" }),
			skills: skillsFor(), repairMalformed: true,
			run: async (step, system, user, maxTokens, recoverMalformed) => {
				const payload = JSON.parse(user);
				const role = payload.role as DirectorRole;
				counts.set(role, (counts.get(role) ?? 0) + 1);
				if (!recoverMalformed) {
					assert.equal(maxTokens, 1200);
					assert.equal(payload.validation_errors, undefined);
					originals.set(role, { step, system, payload });
					return invalid;
				}
				assert.equal(recoverMalformed, true);
				assert.equal(maxTokens, 3600);
				const original = originals.get(role)!;
				assert.equal(step, original.step, "recovery keeps the same model slot");
				assert.equal(system, original.system, "no prompt text is appended outside the Skill");
				const { validation_errors, invalid_report, ...basePayload } = payload;
				assert.deepEqual(basePayload, original.payload);
				assert.equal(invalid_report, invalid, "feedback carries the real raw report, not its downgraded projection");
				assert.deepEqual(validation_errors, [
					{ code: "invalid_source_ids", path: "facts[0].sourceIds", sourceIds: ["s1", "fake-source"] },
					{ code: "invalid_source_ids", path: "issues[0].sourceIds", sourceIds: [] },
				]);
				return repaired;
			},
		});
		assert.deepEqual(reports.map(report => report.role), DIRECTOR_ROLES[phase]);
		assert.deepEqual([...counts.values()], DIRECTOR_ROLES[phase].map(() => 2));
		assert.ok(reports.every(report => report.status === "success"));
		assert.ok(reports.every(report => report.facts.length === 1 && report.facts[0].text === "她仍在门边。" && report.facts[0].sourceIds[0] === "s1"));
		assert.ok(reports.every(report => !report.facts.some(fact => fact.text === "未获来源支持的断言")));
	}
});

test("严格语义恢复：重报告仍混入假来源即failed，不过滤fake后冒称成功或再次重试", async () => {
	const invalid = JSON.stringify({ summary: "来源待核对", facts: [{ text: "伪造事实", sourceIds: ["s1", "fake"] }],
		inferences: [], candidates: [], issues: [{ text: "伪造问题", sourceIds: ["draft", "fake"] }] });
	const calls: Array<{ role: DirectorRole; recover: boolean }> = [];
	const reports = await executeDirectorBatch({ phase: "review", tasks: tasksFor("review"), context: context({ draft: "她仍在门边。" }),
		skills: skillsFor(), repairMalformed: true,
		run: async (_step, _system, user, _maxTokens, recoverMalformed) => {
			calls.push({ role: JSON.parse(user).role, recover: recoverMalformed === true });
			return invalid;
		},
	});
	assert.deepEqual(reports.map(report => report.role), DIRECTOR_ROLES.review);
	for (const report of reports) {
		assert.deepEqual(calls.filter(call => call.role === report.role).map(call => call.recover), [false, true]);
		assert.equal(report.status, "failed");
		assert.match(report.summary, /来源校验失败.*sourceIds/);
		assert.match(report.summary, /facts\[0\].sourceIds/);
		assert.equal(report.facts.length, 0);
		assert.equal(report.issues.length, 0);
		assert.ok(report.inferences.every(text => text.startsWith("未证实")));
	}
});

test("兼容语义行为：repairMalformed=false保留degraded，不请求恢复模型", async () => {
	let calls = 0;
	const reports = await executeDirectorBatch({ phase: "ideas", tasks: tasksFor("ideas"), context: context(), skills: skillsFor(), repairMalformed: false,
		run: async (_step, _system, _user, _maxTokens, recoverMalformed) => {
			calls++;
			assert.notEqual(recoverMalformed, true);
			return JSON.stringify({ summary: "兼容报告", facts: [{ text: "未引用来源", sourceIds: [] }], inferences: [], candidates: [], issues: [] });
		},
	});
	assert.equal(calls, 2);
	assert.ok(reports.every(report => report.status === "degraded" && report.facts.length === 0 && report.inferences.length === 1));
});

test("畸形结构恢复也带机器反馈，恢复后语义无效仍失败且每岗最多两次", async () => {
	for (const repaired of [emptyReport,
		JSON.stringify({ summary: "仍无来源", facts: [{ text: "缺失sourceIds", sourceIds: [] }], inferences: [], candidates: [], issues: [] }),
		"still-not-json", { error: "synthetic recovery unavailable" }]) {
		const counts = new Map<string, number>();
		const reports = await executeDirectorBatch({ phase: "ideas", tasks: tasksFor("ideas"), context: context(), skills: skillsFor(), repairMalformed: true,
			run: async (_step, _system, user, _maxTokens, recoverMalformed) => {
				const payload = JSON.parse(user);
				counts.set(payload.role, (counts.get(payload.role) ?? 0) + 1);
				if (!recoverMalformed) return "not-json";
				assert.equal(payload.invalid_report, "not-json");
				assert.deepEqual(payload.validation_errors, [{ code: "invalid_report_schema" }]);
				return repaired;
			},
		});
		assert.deepEqual([...counts.values()], [2, 2]);
		assert.ok(reports.every(report => report.status === (repaired === emptyReport ? "success" : "failed")));
		assert.ok(reports.every(report => report.facts.length === 0));
		if (typeof repaired !== "string") assert.ok(reports.every(report => report.summary.includes(repaired.error)));
	}
});

test("语义恢复反馈有界：原报告最多24000字，引用按实际发送sources再次校验", async () => {
	const sources = Array.from({ length: 32 }, (_, index) => ({ id: `source-${index}`, text: `来源${index}`.repeat(200) }));
	const invalid = JSON.stringify({ summary: "合成原报告".repeat(5000), facts: [{ text: "超额未发送来源", sourceIds: ["source-31"] }],
		inferences: [], candidates: [], issues: [] });
	assert.ok(invalid.length > 24000);
	const reports = await executeDirectorBatch({ phase: "ideas", tasks: tasksFor("ideas"), context: context({ sources }), skills: skillsFor(), repairMalformed: true,
		run: async (_step, _system, user, _maxTokens, recoverMalformed) => {
			const payload = JSON.parse(user);
			assert.ok(!payload.context.sources.some((source: any) => source.id === "source-31"));
			if (recoverMalformed) {
				assert.equal(payload.invalid_report, invalid.slice(0, 24000));
				assert.ok(payload.validation_errors.length <= 16);
				assert.equal(payload.validation_errors[0].code, "invalid_source_ids");
			}
			return invalid;
		},
	});
	assert.ok(reports.every(report => report.status === "failed" && report.facts.length === 0));
});

test("同岗语义恢复期间取消/切叶立即失败，迟到有效报告也不得采用", { timeout: 3000 }, async () => {
	const invalid = JSON.stringify({ summary: "待恢复", facts: [{ text: "没有来源", sourceIds: [] }], inferences: [], candidates: [], issues: [] });
	const late = JSON.stringify({ summary: "迟到成功", facts: [{ text: "迟到事实", sourceIds: ["s1"] }], inferences: [], candidates: ["迟到候选"], issues: [] });
	for (const mode of ["abort", "stale"] as const) {
		const controller = new AbortController();
		let isCurrent = true;
		const finishers: Array<(value: string) => void> = [];
		let calls = 0;
		const running = executeDirectorBatch({ phase: "ideas", tasks: tasksFor("ideas"), context: context(), skills: skillsFor(), repairMalformed: true,
			signal: controller.signal, isCurrent: () => isCurrent,
			run: async (_step, _system, _user, _maxTokens, recoverMalformed) => {
				calls++;
				if (!recoverMalformed) return invalid;
				return new Promise<string>(resolve => { finishers.push(resolve); });
			},
		});
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(finishers.length, 2, "both fixed idea roles must enter their own recovery");
		if (mode === "abort") controller.abort(); else isCurrent = false;
		const reports = await running;
		assert.deepEqual(reports.map(report => report.role), DIRECTOR_ROLES.ideas);
		assert.ok(reports.every(report => report.status === "failed" && report.summary.includes("未采用")));
		for (const finish of finishers) finish(late);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(calls, 4);
		assert.ok(reports.every(report => report.facts.length === 0 && report.candidates.length === 0));
	}
});

test("岗位资料分工：仅style收到完整纯预设，常驻规则/卡/世界/相关设定与真实scope保留", async () => {
	const writerPresetText = "PURE_WRITER_STYLE\n" + "原始风格块。".repeat(4000) + "\nPURE_WRITER_END";
	assert.ok(writerPresetText.length > 20000);
	const assembled = "LEGACY_ASSEMBLED_MARKER\n角色与世界marker展开，不是纯写作预设。";
	const constantLore = [{ uid: 1, content: "常驻角色规则：云澜不识海图。" }, { uid: 2, content: "常驻世界规则：渡船在日落后停航。" }];
	const draft = "完整待审正文。".repeat(4000);
	const supplied = context({ writerPresetText, presetText: assembled, constantLore, draft,
		world: { location: "港口", rule: "潮汐改变渡口开放状态。" }, ecology: { living: "值守员在码头巡逻。" },
		outline: { candidate: "可核对渡船记录。" }, lore: [{ content: "本拍相关设定：仓库位于码头东侧。" }],
		sources: [{ id: "preset", text: assembled }, { id: "ecology", text: "码头生活" },
			{ id: "outline", text: "待演候选" }, { id: "s1", text: "她仍在门边。" }],
		priorReports: [{ role: "review-style", status: "success", summary: "前阶段资料", facts: [
			{ text: "写作约束", sourceIds: ["ctx:presetText"] }, { text: "未传元数据", sourceIds: ["ctx:sessionId"] },
		], inferences: [], candidates: [], issues: [] }],
	});
	for (const phase of ["evidence", "ideas", "review"] as const) {
		const reports = await executeDirectorBatch({ phase, tasks: tasksFor(phase), context: supplied, skills: skillsFor(),
			run: async (_step, _system, user) => {
				const payload = JSON.parse(user), role = payload.role as DirectorRole;
				const style = role === "review-style";
				assert.equal(payload.context.presetText, style ? writerPresetText : undefined);
				assert.ok(!user.includes("LEGACY_ASSEMBLED_MARKER"), "expanded legacy preset must not override the pure preset");
				assert.equal(user.includes("PURE_WRITER_STYLE"), style);
				assert.deepEqual(payload.context.constantLore, constantLore);
				assert.deepEqual(payload.context.card, supplied.card);
				assert.deepEqual(payload.context.world, supplied.world);
				assert.deepEqual(payload.context.lore, supplied.lore);
				assert.equal(payload.context.userText, supplied.userText);
				assert.equal(payload.context.draft, phase === "review" ? draft : undefined);
				const needsEcology = ["ecology", "idea-a", "idea-b", "review-facts"].includes(role);
				const needsOutline = role === "idea-a" || role === "idea-b";
				assert.deepEqual(payload.context.ecology, needsEcology ? supplied.ecology : undefined);
				assert.deepEqual(payload.context.outline, needsOutline ? supplied.outline : undefined);
				const ids = new Set(payload.source_scope.map((entry: any) => entry.id));
				assert.equal(ids.has("preset"), style);
				assert.equal(ids.has("ctx:presetText"), style);
				assert.equal(ids.has("ecology"), needsEcology);
				assert.equal(ids.has("outline"), needsOutline);
				assert.ok(!ids.has("ctx:sessionId") && !ids.has("ctx:leafId") && !ids.has("ctx:writerPresetText"));
				assert.ok(ids.has("ctx:constantLore") && ids.has("ctx:card") && ids.has("ctx:world") && ids.has("s1"));
				assert.equal(payload.context.priorReports[0].facts.length, style ? 1 : 0, "prior reports cannot carry a source excluded from this role");
				for (const entry of payload.source_scope) {
					const path = entry.path.replace(/\[(\d+)\]/g, ".$1").split(".");
					let value: any = payload;
					for (const key of path) value = value?.[key];
					assert.notEqual(value, undefined, `source ${entry.id} must point to delivered data`);
				}
				return JSON.stringify({ summary: "原规则已送达", facts: [
					{ text: "常驻世界规则已核对", sourceIds: ["ctx:constantLore"] },
					{ text: "当拍世界位置已核对", sourceIds: ["ctx:world"] },
				], inferences: [], candidates: [], issues: [] });
			},
		});
		assert.ok(reports.every(report => report.status === "success" && report.facts.length === 2));
	}
});

test("旧SDK兼容：review-style仍完整发送legacy presetText，事实审阅不接收且两方draft不裁", async () => {
	const presetText = "LEGACY_ORIGINAL\n" + "原始预设".repeat(12000) + "\nLEGACY_END";
	const draft = "完整稿件".repeat(8000);
	const reports = await executeDirectorBatch({ phase: "review", tasks: tasksFor("review"),
		context: context({ presetText, draft, sources: [{ id: "preset", text: presetText }] }), skills: skillsFor(),
		run: async (_step, _system, user) => {
			const payload = JSON.parse(user), style = payload.role === "review-style";
			assert.equal(payload.context.draft, draft);
			assert.equal(payload.context.presetText, style ? presetText : undefined);
			assert.equal(user.includes("LEGACY_END"), style);
			assert.equal(payload.source_scope.some((entry: any) => entry.id === "preset"), style);
			assert.equal(payload.source_scope.some((entry: any) => entry.id === "draft"), true);
			return emptyReport;
		},
	});
	assert.ok(reports.every(report => report.status === "success"));
});

test("未送达预设/字段不能成为事实来源，过滤必须早于sources预算", async () => {
	const reports = await executeDirectorBatch({ phase: "evidence", tasks: tasksFor("evidence"), skills: skillsFor(),
		context: context({ writerPresetText: "不应送达的风格原文", presetText: "不应送达的assembled原文", constantLore: "常驻规则原文",
			sources: [{ id: "preset", text: "写作风格".repeat(1000) },
				...Array.from({ length: 12 }, (_, index) => ({ id: `sent-${index}`, text: "相关事实".repeat(250) })),
				{ id: "outside-budget", text: "超额来源" }],
		}),
		run: async (_step, _system, user) => {
			const payload = JSON.parse(user), ids = new Set(payload.source_scope.map((entry: any) => entry.id));
			assert.ok(ids.has("sent-11"), "excluded preset must not consume the source budget");
			assert.ok(!ids.has("outside-budget") && !ids.has("preset") && !ids.has("ctx:presetText"));
			assert.ok(!ids.has("ctx:writerPresetText") && !ids.has("ctx:ecology") && !ids.has("draft"));
			return JSON.stringify({ summary: "校验真实scope", facts: [
				{ text: "确实送达的最后来源", sourceIds: ["sent-11"] },
				{ text: "确实送达的规则", sourceIds: ["ctx:constantLore"] },
			], inferences: [], candidates: [], issues: ["preset", "ctx:presetText", "ctx:writerPresetText", "ctx:ecology", "ctx:sessionId", "outside-budget", "draft"]
				.map(id => ({ text: `未送达:${id}`, sourceIds: [id] })) });
		},
	});
	for (const report of reports) {
		assert.equal(report.status, "degraded");
		assert.deepEqual(report.facts.map(fact => fact.sourceIds), [["sent-11"], ["ctx:constantLore"]]);
		assert.equal(report.issues.length, 0);
		assert.equal(report.inferences.length, 7);
		assert.ok(report.inferences.every(text => text.startsWith("未证实")));
	}
});
