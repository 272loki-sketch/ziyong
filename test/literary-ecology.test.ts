import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	LITERARY_ECOLOGY_ENTRY_TYPE,
	commitLiteraryEcologyRound,
	buildEcologyRuntimePrompt,
	degradedLiteraryEcologyRound,
	defaultLiteraryEcologyState,
	dueEcologyActors,
	ecologyCardKey,
	ecologySearchQueries,
	ecologySearchSceneCue,
	ecologyWireView,
	emptyEcologyCardPool,
	emptyEcologyGlobalPool,
	formatLiteraryEcologyInjection,
	literaryEcologyFromBranch,
	loadEcologyPools,
	normalizeEcologyCardPool,
	normalizeEcologyGlobalPool,
	normalizeLiteraryEcologyState,
	saveEcologyPools,
	validateEcologyTransition,
} from "../src/stage/literary-ecology.ts";
import { scanSkillFiles, workflowSkill } from "../src/stage/skill-store.ts";

test("ecology：全局池与卡池分别规范化并保留来源", () => {
	const global = normalizeEcologyGlobalPool({
		digest: "新增场所活动",
		prototypes: [{ name: "旧书募集", category: "日常", scale: "scene", premise: "公共场所募集旧物", requirements: [], pressures: ["期限"], developments: ["误捐物品"], tags: ["校园"], sources: [{ title: "活动资料", url: "https://example.com", note: "募集机制" }] }],
	}, emptyEcologyGlobalPool());
	assert.ok(global);
	assert.equal(global.prototypes[0]?.name, "旧书募集");
	assert.equal(global.prototypes[0]?.sources[0]?.url, "https://example.com/");

	const card = normalizeEcologyCardPool({ worldGrammar: ["委员会能发起公共活动"], actorGrammar: ["人物按职责参加"], templates: [{ name: "图书馆旧书募集", prototypeId: global.prototypes[0]?.id, form: "各班派代表整理旧书", locations: ["图书馆"], likelyActors: ["图书委员"], constraints: [], possibleDevelopments: [], tags: ["日常"] }] }, emptyEcologyCardPool("card-a", "测试卡"));
	assert.ok(card);
	assert.equal(card.cardKey, "card-a");
	assert.equal(card.templates[0]?.locations[0], "图书馆");
});

test("ecology：卡池按规范化路径隔离并可持久化", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-ecology-"));
	assert.equal(ecologyCardKey(cwd, "cards/a.json"), ecologyCardKey(cwd, "./cards/A.json"));
	assert.notEqual(ecologyCardKey(cwd, "cards/a.json"), ecologyCardKey(cwd, "cards/b.json"));
	const global = { ...emptyEcologyGlobalPool(), revision: 1, digest: "已有原型" };
	const card = { ...emptyEcologyCardPool(ecologyCardKey(cwd, "cards/a.json"), "A"), revision: 1, digest: "已有适配" };
	saveEcologyPools(cwd, "cards/a.json", { global, card });
	const loaded = loadEcologyPools(cwd, "cards/a.json", "A");
	assert.equal(loaded.global.digest, "已有原型");
	assert.equal(loaded.card.digest, "已有适配");
	assert.match(readFileSync(join(cwd, ".liyuan", "ecology", "global-pool.json"), "utf8"), /已有原型/);
});

test("ecology：运行态随分支读取最近快照", () => {
	const early = normalizeLiteraryEcologyState({ digest: "日和在整理书架", actors: [{ name: "日和", location: "图书馆", activity: "整理旧书" }] }, defaultLiteraryEcologyState())!;
	const late = normalizeLiteraryEcologyState({ digest: "图书馆提前闭馆" }, early)!;
	const prefix = [{ type: "custom", customType: LITERARY_ECOLOGY_ENTRY_TYPE, data: early }];
	assert.equal(literaryEcologyFromBranch(prefix).digest, "日和在整理书架");
	assert.equal(literaryEcologyFromBranch([...prefix, { type: "custom", customType: LITERARY_ECOLOGY_ENTRY_TYPE, data: late }]).digest, "图书馆提前闭馆");
});

test("ecology：主演注入不泄露秘密，前端投影需显式揭示", () => {
	const parsed = normalizeLiteraryEcologyState({
		digest: "图书馆正在进行旧书募集",
		occurrences: [
			{ name: "旧书募集", patternKey: "book-drive", visibility: "public", status: "active", location: "图书馆", development: "学生正在捐书" },
			{ name: "秘密筛选", patternKey: "covert-evaluation", visibility: "secret", status: "active", location: "图书馆", development: "校方暗中记录选择" },
		],
		secrets: [{ subject: "活动真实目的", truth: "校方在观察合作方式", knownBy: ["教师"], revealCondition: "调查记录" }],
	}, defaultLiteraryEcologyState())!;
	const state = commitLiteraryEcologyRound(parsed, 0);
	const injection = formatLiteraryEcologyInjection(state)!;
	assert.match(injection, /旧书募集/);
	assert.doesNotMatch(injection, /校方暗中记录|观察合作方式/);
	const view = ecologyWireView(state);
	assert.equal(view.public.events.length, 1);
	assert.match(view.spoilers.secrets[0] ?? "", /观察合作方式/);
});

test("ecology：检索规划支持每拍最多十二项并去重", () => {
	assert.deepEqual(ecologySearchQueries('{"queries":["校园日常活动","电影 场所变化","小说 人物自主线","多余"]}'), ["校园日常活动", "电影 场所变化", "小说 人物自主线", "多余"]);
});

test("ecology：运行态 prompt 直接携带受限世界书工作集", () => {
	const prompt = buildEcologyRuntimePrompt("按 Skill 运行生态。", {
		phase: "arrival",
		ecology: defaultLiteraryEcologyState(),
		global: emptyEcologyGlobalPool(),
		cardPool: emptyEcologyCardPool("card", "测试卡"),
		lore: [{ comment: "考试规则", keys: ["OAA"], content: "搭档笔试总分低于501分会触发退学。", constant: true }],
		state: { time: "上午", location: "教室", characters: {}, inventory: [], flags: {}, plot_threads: [] },
		history: [{ role: "user", text: "我向池宽治询问考试规则。" }],
		userText: "我向池宽治询问考试规则。",
	});
	const parsed = JSON.parse(prompt.userText) as { world_lore?: Array<{ title: string; content: string }> };
	assert.equal(parsed.world_lore?.[0]?.title, "考试规则");
	assert.match(parsed.world_lore?.[0]?.content ?? "", /501/);
});

test("ecology：检索场景线索保留地点活动但剔除用户栏姓名", () => {
	const cue = ecologySearchSceneCue({
		userText: "测试玩家去篮球社参加放学后训练，顺便看看体育馆里有什么活动",
		userName: "测试玩家",
		state: { time: "放学后", location: "体育馆·篮球社", characters: {}, inventory: [], flags: {}, plot_threads: [] },
	});
	assert.equal(cue.latestAction, "用户角色去篮球社参加放学后训练，顺便看看体育馆里有什么活动");
	assert.equal(cue.location, "体育馆·篮球社");
	assert.doesNotMatch(JSON.stringify(cue), /测试玩家/);
});

test("ecology：同构原型和模板按 patternKey 合并，不因换名复制", () => {
	const first = normalizeEcologyGlobalPool({ prototypes: [{ id: "p1", name: "提前闭馆", category: "环境", patternKey: "forced-relocation", premise: "公共场所提前关闭", developments: ["转移地点"], sources: [{ title: "A", url: "https://example.com/a" }] }] }, emptyEcologyGlobalPool())!;
	const second = normalizeEcologyGlobalPool({ prototypes: [{ id: "p2", name: "临时封馆", category: "环境", patternKey: "forced-relocation", premise: "公共场所临时关闭", developments: ["寻找替代场所"], sources: [{ title: "B", url: "https://example.com/b" }] }] }, first)!;
	assert.equal(second.prototypes.length, 1);
	assert.equal(second.prototypes[0]?.id, "p1");
	assert.deepEqual(second.prototypes[0]?.developments, ["转移地点", "寻找替代场所"]);
});

test("ecology：近期同类事件进入冷却，既有事件仍可继续", () => {
	const previous = { ...defaultLiteraryEcologyState(), round: 5, recentUses: [{ key: "chance-meeting", round: 4 }] };
	const blocked = normalizeLiteraryEcologyState({ occurrences: [{ id: "new", name: "走廊偶遇", patternKey: "chance-meeting", status: "active" }] }, previous)!;
	assert.equal(blocked.occurrences.length, 0);
	const existingBase = { ...previous, occurrences: [{ id: "old", name: "既有偶遇", kind: "encounter" as const, status: "active" as const, time: "", location: "走廊", participants: [], cause: "", development: "刚遇见", visibility: "public" as const, discovery: "", expires: "", withoutUser: "", userRole: "optional" as const, prototypeId: "", templateId: "", patternKey: "chance-meeting", tone: "routine" as const, intrusion: "background" as const, createdRound: 4, lastAdvancedRound: 4, cooldownUntilRound: 8 }] };
	const continued = normalizeLiteraryEcologyState({ occurrences: [{ id: "old", name: "既有偶遇", patternKey: "chance-meeting", status: "active", development: "交谈了一句" }] }, existingBase)!;
	assert.equal(continued.occurrences[0]?.development, "交谈了一句");
});

test("ecology：arrival 解析不加轮，aftermath 提交每拍只加一轮", () => {
	const base = { ...defaultLiteraryEcologyState(), round: 7 };
	const arrival = normalizeLiteraryEcologyState({ digest: "抵达图书馆" }, base)!;
	assert.equal(arrival.round, 7);
	assert.equal(commitLiteraryEcologyRound(arrival, 7).round, 8);
});

test("ecology：拍后失败也落一轮降级快照并保留事实", () => {
	const base = { ...defaultLiteraryEcologyState(), round: 3, digest: "图书馆照常开放", actors: [{ id: "a", name: "日和", tier: "core" as const, location: "图书馆", activity: "看书", shortGoal: "", longGoal: "", concern: "", commitments: [], relations: [], knowledge: [], knowledgeLedger: [], nextAction: "继续阅读", lastAdvancedRound: 3, nextDueRound: 4 }] };
	const degraded = degradedLiteraryEcologyRound(base, 3, "aftermath", "上游超时");
	assert.equal(degraded.round, 4);
	assert.equal(degraded.actors[0]?.activity, "看书");
	assert.deepEqual(degraded.degraded, { stage: "aftermath", error: "上游超时" });
});

test("ecology：人物认知保留来源和冻结版本，推断不能直接确认为事实", () => {
	const first = normalizeLiteraryEcologyState({
		actors: [{ id: "alice", name: "爱丽丝", knowledgeLedger: [{ id: "k1", subjectRef: "occurrence:bell", summary: "她听说钟楼可能停摆", certainty: "confirmed", route: "inferred", evidence: "钟声迟到", sourceRef: "occurrence:late-bell" }] }],
	}, { ...defaultLiteraryEcologyState(), round: 4 })!;
	assert.equal(first.actors[0]?.knowledgeLedger[0]?.certainty, "suspected");
	assert.equal(first.actors[0]?.knowledgeLedger[0]?.learnedRound, 4);

	const changedTruth = normalizeLiteraryEcologyState({ actors: [{ id: "alice", name: "爱丽丝" }] }, { ...first, round: 5 })!;
	assert.equal(changedTruth.actors[0]?.knowledgeLedger[0]?.summary, "她听说钟楼可能停摆", "世界变化不能自动刷新人物旧认知");
});

test("ecology：增量人物输出沿用未提供字段，显式空数组仍可清空", () => {
	const base = normalizeLiteraryEcologyState({ actors: [{ id: "alice", name: "爱丽丝", location: "钟楼", activity: "值守", commitments: ["午夜敲钟"], relations: ["认识守门人"], knowledge: ["旧钟较慢"], nextAction: "检查齿轮" }] }, defaultLiteraryEcologyState())!;
	const partial = normalizeLiteraryEcologyState({ actors: [{ id: "alice", name: "爱丽丝", activity: "休息" }] }, base)!;
	assert.equal(partial.actors[0]?.location, "钟楼");
	assert.equal(partial.actors[0]?.nextAction, "检查齿轮");
	assert.deepEqual(partial.actors[0]?.commitments, ["午夜敲钟"]);
	const cleared = normalizeLiteraryEcologyState({ actors: [{ id: "alice", name: "爱丽丝", commitments: [] }] }, partial)!;
	assert.deepEqual(cleared.actors[0]?.commitments, []);
});

test("ecology：传播面与秘密真相分离并按公开级别清洗", () => {
	const state = normalizeLiteraryEcologyState({ occurrences: [
		{ id: "private", name: "密谈", patternKey: "private-talk", visibility: "secret", publicSurface: { publicity: "private", trace: "不应保留", headline: "秘密标题", summary: "秘密原因" } },
		{ id: "trace", name: "仓库异动", patternKey: "warehouse-trace", visibility: "secret", publicSurface: { publicity: "trace", trace: "夜间灯光异常", headline: "不应出现", summary: "幕后交易" } },
		{ id: "public", name: "闭馆通知", patternKey: "closure", visibility: "public", publicSurface: { publicity: "public", headline: "图书馆提前闭馆", summary: "校方发布维护通知", sourceType: "official", claimStatus: "fact", audience: ["全校"] } },
	] }, defaultLiteraryEcologyState())!;
	assert.deepEqual(state.occurrences[0]?.publicSurface, { publicity: "private", trace: "", headline: "", summary: "", result: "", sourceType: "unofficial", claimStatus: "mixed", audience: [], scope: "" });
	assert.equal(state.occurrences[1]?.publicSurface?.trace, "夜间灯光异常");
	assert.equal(state.occurrences[1]?.publicSurface?.summary, "");
	const injection = formatLiteraryEcologyInjection(commitLiteraryEcologyRound(state, 0))!;
	assert.match(injection, /夜间灯光异常|图书馆提前闭馆/);
	assert.doesNotMatch(injection, /幕后交易|秘密原因/);
});

test("ecology：后台人物饥饿保护优先结算长期未推进者", () => {
	const state = normalizeLiteraryEcologyState({ actors: [
		{ id: "recent", name: "近期人物", tier: "active", lastAdvancedRound: 9, nextDueRound: 12 },
		{ id: "stale", name: "久未推进", tier: "background", lastAdvancedRound: 2, nextDueRound: 20 },
		{ id: "due", name: "到期人物", tier: "background", lastAdvancedRound: 8, nextDueRound: 10 },
	] }, { ...defaultLiteraryEcologyState(), round: 10 })!;
	assert.deepEqual(dueEcologyActors(state), [
		{ id: "due", reason: "due" },
		{ id: "stale", reason: "starvation-guard" },
	]);
});

test("ecology：终态事件不能被普通推进重新打开", () => {
	const base = normalizeLiteraryEcologyState({ occurrences: [{ id: "done", name: "闭馆", patternKey: "closure", status: "resolved", development: "已经结束" }] }, defaultLiteraryEcologyState())!;
	const next = normalizeLiteraryEcologyState({ occurrences: [{ id: "done", name: "闭馆", patternKey: "closure", status: "active", development: "又开始了" }] }, base)!;
	assert.equal(next.occurrences[0]?.status, "resolved");
	assert.equal(next.occurrences[0]?.development, "已经结束");
});

test("ecology：通讯送达后才能成为收件人的 message 认知", () => {
	const base = defaultLiteraryEcologyState();
	const pending = normalizeLiteraryEcologyState({ actors: [{ id: "a", name: "甲" }, { id: "b", name: "乙", knowledgeLedger: [{ id: "k", subjectRef: "occurrence:letter", summary: "甲要来", certainty: "confirmed", route: "message", evidence: "信中说", sourceRef: "occurrence:letter" }] }], occurrences: [{ id: "letter", name: "书信", patternKey: "letter", communication: { senderRef: "a", recipientRefs: ["b"], channel: "信使", state: "in-transit" } }] }, base)!;
	assert.match(validateEcologyTransition(base, pending).join("；"), /未送达通讯/);
	const delivered = normalizeLiteraryEcologyState({ actors: pending.actors, occurrences: [{ id: "letter", name: "书信", patternKey: "letter", communication: { senderRef: "a", recipientRefs: ["b"], channel: "信使", state: "delivered" } }] }, base)!;
	assert.deepEqual(validateEcologyTransition(base, delivered), []);
});

test("ecology：公开渠道认知必须引用真正公开的传播面", () => {
	const next = normalizeLiteraryEcologyState({ actors: [{ id: "a", name: "甲", knowledgeLedger: [{ id: "k", subjectRef: "occurrence:notice", summary: "闭馆", certainty: "confirmed", route: "public-channel", evidence: "公告", sourceRef: "occurrence:notice" }] }], occurrences: [{ id: "notice", name: "通知", patternKey: "notice", publicSurface: { publicity: "trace", trace: "有人议论" } }] }, defaultLiteraryEcologyState())!;
	assert.match(validateEcologyTransition(defaultLiteraryEcologyState(), next).join("；"), /没有公开来源/);
});

test("ecology：occurrence 增量更新保留日程、传播面和通讯", () => {
	const base = normalizeLiteraryEcologyState({ actors: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }], occurrences: [{ id: "letter", name: "书信", patternKey: "letter", status: "active", time: "2015-04-08", location: "邮局", visibility: "public", publicSurface: { publicity: "public", headline: "送信通知", summary: "信使已经出发" }, communication: { senderRef: "a", recipientRefs: ["b"], channel: "信使", state: "in-transit" } }] }, defaultLiteraryEcologyState())!;
	const next = normalizeLiteraryEcologyState({ occurrences: [{ id: "letter", name: "书信", patternKey: "letter", development: "继续运输" }] }, base)!;
	assert.equal(next.occurrences[0]?.time, "2015-04-08");
	assert.equal(next.occurrences[0]?.location, "邮局");
	assert.equal(next.occurrences[0]?.publicSurface?.headline, "送信通知");
	assert.equal(next.occurrences[0]?.communication?.state, "in-transit");
});

test("ecology：通讯送达后不能倒退回运输中", () => {
	const base = normalizeLiteraryEcologyState({ actors: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }], occurrences: [{ id: "letter", name: "书信", patternKey: "letter", communication: { senderRef: "a", recipientRefs: ["b"], channel: "信使", state: "delivered" } }] }, defaultLiteraryEcologyState())!;
	const next = normalizeLiteraryEcologyState({ occurrences: [{ id: "letter", name: "书信", patternKey: "letter", communication: { senderRef: "a", recipientRefs: ["b"], channel: "信使", state: "in-transit" } }] }, base)!;
	assert.match(validateEcologyTransition(base, next).join("；"), /不得倒退/);
});

test("ecology：已提交的冻结认知不因来源离开当前信号工作集而失效", () => {
	const previous = normalizeLiteraryEcologyState({ actors: [{ id: "a", name: "甲", knowledgeLedger: [{ id: "k", subjectRef: "world:institution-calendar/old-rule", summary: "旧规九点闭门", certainty: "confirmed", route: "investigated", evidence: "旧公告", sourceRef: "world:institution-calendar/old-rule" }] }] }, defaultLiteraryEcologyState())!;
	assert.deepEqual(validateEcologyTransition(previous, previous, []), []);
});

test("ecology：公共事件和通讯可引用当前 actor 工作集外的人物", () => {
	const next = normalizeLiteraryEcologyState({ actors: [{ id: "a", name: "甲" }], occurrences: [{ id: "notice", name: "全校公告", patternKey: "notice", participants: ["校方", "全校学生"], status: "active", communication: { senderRef: "校方", recipientRefs: ["全校学生"], channel: "OAA", state: "delivered" }, publicSurface: { publicity: "public", headline: "公告", summary: "考试规则发布" } }] }, defaultLiteraryEcologyState())!;
	assert.deepEqual(validateEcologyTransition(defaultLiteraryEcologyState(), next), []);
});

test("ecology：残缺的新人物通讯降级为普通事件，不拖垮整份候选", () => {
	const next = normalizeLiteraryEcologyState({ occurrences: [{ id: "challenge", name: "棋局挑战", kind: "encounter", patternKey: "chess", communication: { senderRef: "", recipientRefs: [], channel: "当面", state: "queued" } }] }, defaultLiteraryEcologyState())!;
	assert.equal(next.occurrences[0]?.communication, undefined);
	assert.deepEqual(validateEcologyTransition(defaultLiteraryEcologyState(), next), []);
});

test("ecology：未物化到当前信号工作集的世界或 lore 认知引用不误拒", () => {
	const next = normalizeLiteraryEcologyState({ actors: [{ id: "a", name: "甲", knowledgeLedger: [{ id: "k", subjectRef: "world:public-information/oaa-rules", summary: "OAA 规则已公布", certainty: "confirmed", route: "investigated", evidence: "查看应用", sourceRef: "world:public-information/oaa-rules" }] }] }, defaultLiteraryEcologyState())!;
	assert.deepEqual(validateEcologyTransition(defaultLiteraryEcologyState(), next, []), []);
});

test("ecology：三件工作流 Skill 均可被装载", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-ecology-skills-"));
	try {
		cpSync(new URL("../skills", import.meta.url), join(cwd, "skills"), { recursive: true });
		const skills = scanSkillFiles(cwd);
		assert.match(workflowSkill(skills, "ecology-global")?.body ?? "", /叙事发动机/);
		assert.match(workflowSkill(skills, "ecology-card")?.body ?? "", /人物语法/);
		assert.match(workflowSkill(skills, "ecology-runtime")?.body ?? "", /生态维护人物、场所与事件/);
		assert.match(workflowSkill(skills, "ecology-runtime")?.body ?? "", /Small_theater/);
		assert.match(workflowSkill(skills, "ecology-runtime")?.body ?? "", /生态结算不补写镜头内行动/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

const commitmentOptions = { latestUserText: "我答应明天去图书馆帮忙。", latestUserEntryId: "user-1", committedState: defaultLiteraryEcologyState() };
const commitmentEvent = (evidence?: unknown, id = "library") => ({ id, name: "整理图书", patternKey: id, userRole: "committed", ...(evidence === undefined ? {} : { userCommitment: evidence }) });
const commitmentEvidence = { source: "latest-user", sourceEntryId: "user-1", occurrenceId: "library", quote: "我答应明天去图书馆帮忙。" };

test("ecology：新用户承诺无证据时只降 optional 并留 warning，不拒整轮", () => {
	const previous = defaultLiteraryEcologyState();
	const next = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent()] }, previous)!;
	assert.deepEqual(validateEcologyTransition(previous, next, [], commitmentOptions), []);
	assert.equal(next.occurrences[0].userRole, "optional");
	assert.match(next.commitmentWarnings?.[0] ?? "", /本拍用户原文锚点/);
	assert.equal(next.occurrences[0].userCommitment, undefined);
});

test("ecology：可唯一定位的本拍逐字引文保存 UTF-16 区间", () => {
	const previous = defaultLiteraryEcologyState();
	const next = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent(commitmentEvidence)] }, previous)!;
	assert.deepEqual(validateEcologyTransition(previous, next, [], commitmentOptions), []);
	assert.equal(next.occurrences[0].userRole, "committed");
	assert.deepEqual(next.occurrences[0].userCommitment, { ...commitmentEvidence, start: 0, end: commitmentOptions.latestUserText.length });
	assert.equal(next.commitmentWarnings, undefined);
});

test("ecology：伪造来源、跨事件引用、改写引文与错误区间均不能升级用户承诺", () => {
	for (const evidence of [
		{ ...commitmentEvidence, sourceEntryId: "user-old" },
		{ ...commitmentEvidence, occurrenceId: "other-event" },
		{ ...commitmentEvidence, quote: "我已答应参加全部活动。" },
		{ ...commitmentEvidence, start: 1, end: commitmentOptions.latestUserText.length },
		{ ...commitmentEvidence, start: 0 },
		{ ...commitmentEvidence, start: "0", end: commitmentOptions.latestUserText.length },
		{ ...commitmentEvidence, source: "recent-history" },
	]) {
		const previous = defaultLiteraryEcologyState();
		const next = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent(evidence)] }, previous)!;
		validateEcologyTransition(previous, next, [], commitmentOptions);
		assert.equal(next.occurrences[0].userRole, "optional", JSON.stringify(evidence));
	}
});

test("ecology：重复引文须显式区间；没有用户 entryId 时不新增承诺", () => {
	const previous = defaultLiteraryEcologyState();
	const text = "我会去。我会去。";
	const evidence = { ...commitmentEvidence, quote: "我会去。" };
	const ambiguous = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent(evidence)] }, previous)!;
	validateEcologyTransition(previous, ambiguous, [], { ...commitmentOptions, latestUserText: text });
	assert.equal(ambiguous.occurrences[0].userRole, "optional");
	const anchored = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent({ ...evidence, start: 4, end: 8 })] }, previous)!;
	validateEcologyTransition(previous, anchored, [], { ...commitmentOptions, latestUserText: text });
	assert.equal(anchored.occurrences[0].userRole, "committed");
	const missingSource = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent(commitmentEvidence)] }, previous)!;
	validateEcologyTransition(previous, missingSource, [], { latestUserText: commitmentOptions.latestUserText });
	assert.equal(missingSource.occurrences[0].userRole, "optional");
});

test("ecology：旧已提交 committed 不要求本拍引用，也不被模型降级/换证据", () => {
	const previous = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent(commitmentEvidence)] }, defaultLiteraryEcologyState())!;
	const next = normalizeLiteraryEcologyState({ occurrences: [{ ...commitmentEvent({ ...commitmentEvidence, sourceEntryId: "invented" }), userRole: "optional" }] }, previous)!;
	const before = JSON.stringify(previous);
	validateEcologyTransition(previous, next, [], { committedState: previous });
	assert.equal(next.occurrences[0].userRole, "committed");
	assert.deepEqual(next.occurrences[0].userCommitment, previous.occurrences[0].userCommitment);
	assert.equal(JSON.stringify(previous), before);
});

test("ecology：arrival证据到aftermath重验，arrival候选不是旧已提交承诺", () => {
	const committedState = defaultLiteraryEcologyState();
	const arrival = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent(commitmentEvidence)] }, committedState)!;
	validateEcologyTransition(committedState, arrival, [], { ...commitmentOptions, committedState });
	const aftermath = normalizeLiteraryEcologyState({ occurrences: [{ id: "library", name: "整理图书", patternKey: "library" }] }, arrival)!;
	validateEcologyTransition(arrival, aftermath, [], { ...commitmentOptions, committedState });
	assert.equal(aftermath.occurrences[0].userRole, "committed");
	assert.deepEqual(aftermath.occurrences[0].userCommitment, arrival.occurrences[0].userCommitment);
	const spoofed = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent({ ...commitmentEvidence, sourceEntryId: "forged" })] }, arrival)!;
	const before = JSON.stringify(arrival);
	validateEcologyTransition(arrival, spoofed, [], { ...commitmentOptions, committedState });
	assert.equal(spoofed.occurrences[0].userRole, "optional");
	assert.equal(JSON.stringify(arrival), before);
});

test("ecology：降级warning随arrival/aftermath和分支快照保留", () => {
	const previous = defaultLiteraryEcologyState();
	const arrival = normalizeLiteraryEcologyState({ occurrences: [commitmentEvent()] }, previous)!;
	validateEcologyTransition(previous, arrival, [], commitmentOptions);
	const aftermath = normalizeLiteraryEcologyState({ digest: "等待用户决定" }, arrival)!;
	validateEcologyTransition(arrival, aftermath, [], commitmentOptions);
	assert.deepEqual(aftermath.commitmentWarnings, arrival.commitmentWarnings);
	const restored = literaryEcologyFromBranch([{ type: "custom", customType: LITERARY_ECOLOGY_ENTRY_TYPE, data: commitLiteraryEcologyRound(aftermath, 0) }]);
	assert.deepEqual(restored.commitmentWarnings, arrival.commitmentWarnings);
	assert.equal(restored.occurrences[0].userRole, "optional");
});

test("ecology：运行prompt传递用户entryId，非语义regex判定", () => {
	const prompt = buildEcologyRuntimePrompt("承诺语义由 Skill 判断。", { phase: "arrival", ecology: defaultLiteraryEcologyState(), global: emptyEcologyGlobalPool(), cardPool: emptyEcologyCardPool("card", "卡"), state: { time: "", location: "", characters: {}, inventory: [], flags: {}, plot_threads: [] }, history: [], userText: commitmentOptions.latestUserText, userEntryId: "user-1" });
	assert.deepEqual(JSON.parse(prompt.userText).latest_turn, { user: commitmentOptions.latestUserText, user_entry_id: "user-1", narrative: "", narrative_entry_id: null });
});
