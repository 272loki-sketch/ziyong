import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyDraftRules } from "../src/draft.ts";
import { defaultState } from "../src/state.ts";
import {
	createWorkspace,
	finalTimeline,
	formatPlan,
	MAX_STEPS,
	MAX_APPENDS,
	MAX_DRAFT_ABSOLUTE_CHARS,
	MAX_DRAFT_BODY_CHARS,
	MAX_STEP_LEN,
	planStepBudget,
	projectedState,
	recordSegment,
	runWriteTool,
	type WorkspaceDeps,
} from "../src/stage/workspace.ts";
import { writeTools } from "../src/stage/tools.ts";

const deps = (): WorkspaceDeps => ({
	rules: emptyDraftRules(),
	userName: "凌云",
	charName: "林霜",
	baseState: defaultState(),
});

test("writeTools：写侧十件在清单里，beat_plan 列首为落笔前构思、draft_edit 声明批量原子", () => {
	const names = writeTools("中文").map((t) => t.name);
	// 顺序本身就是导流：先构思成清单（beat_plan），再一段一段演（append 在 write 之前）
	assert.deepEqual(names, [
		"beat_plan",
		"beat_step_done",
		"draft_append",
		"draft_write",
		"draft_seal",
		"draft_edit",
		"draft_read",
		"draft_search",
		"world_state_update",
		"ask",
	]);
	const byName = new Map(writeTools("中文").map((t) => [t.name, t.description]));
	assert.match(byName.get("draft_write") ?? "", /全量/);
	// draft_write 收窄为「这一拍没有戏」，描述须自证其适用面
	assert.match(byName.get("draft_write") ?? "", /没有戏|寒暄/);
	assert.match(byName.get("draft_append") ?? "", /追加|续写/);
	assert.match(byName.get("draft_seal") ?? "", /封笔/);
	assert.match(byName.get("draft_edit") ?? "", /整批不套用/);
	// beat_plan 的描述必须自证「路标是抽象层，怎么演留给各段」——粒度是这个工具的全部价值
	assert.match(byName.get("beat_plan") ?? "", /路标/);
	assert.match(byName.get("beat_plan") ?? "", /抽象/);
	assert.match(byName.get("beat_plan") ?? "", /怎么演.*再想|留给演到/);
	// 计划是草图：描述须声明可改写，否则模型会把它当成必须演完的剧本
	assert.match(byName.get("beat_plan") ?? "", /草图|改写/);
	assert.doesNotMatch(byName.get("beat_plan") ?? "", /几条就写几段/, "路标数量不再机械决定段数");
});

test("beat_plan：受理回执一句事实（§2.4）；重拟保留已勾条目的进度", () => {
	const ws = createWorkspace();
	const d = deps();
	const r = runWriteTool(ws, d, "beat_plan", {
		steps: ["推门进院", "被值守弟子拦下", "亮出师门信物"],
	});
	assert.equal(r.ok, true);
	assert.equal(ws.plan.length, 3);
	assert.equal(ws.planWrites, 1);
	assert.ok(ws.plan.every((s) => !s.done), "新计划默认全未完成");
	assert.equal(r.text, "计划已接受（3 条路标）。", "受理回执 = 契约文案，无清单回显无教学");

	runWriteTool(ws, d, "draft_append", { segment: "她推门进院。" });
	runWriteTool(ws, d, "beat_step_done", { step: 1 });
	// 重拟：走岔了改写后两条，但已经演过的第一条不该因此丢掉进度
	const again = runWriteTool(ws, d, "beat_plan", {
		steps: ["推门进院", "院里空无一人", "听见后堂有响动"],
	});
	assert.equal(again.ok, true);
	assert.equal(ws.planWrites, 2);
	assert.equal(ws.plan[0]?.done, true, "文字未变的已完成步保留勾选");
	assert.equal(ws.plan[1]?.done, false, "改写出来的新步未完成");
	assert.match(again.activity ?? "", /重拟/, "重拟只进过程条，回执不变");
});

test("beat_plan 粒度门禁：条目写成正文即拒收（构思与排练的结构性分界）", () => {
	const ws = createWorkspace();
	const d = deps();
	const prose = "她推开院门，晨雾还没散尽，青石板上凝着一层薄薄的水汽，脚步踩上去几乎没有声音，" +
		"远处传来隐约的诵经声，像是从很久以前的时光里飘过来的。";
	assert.ok(prose.length > MAX_STEP_LEN, "用例前提：这条确实超长");
	const r = runWriteTool(ws, d, "beat_plan", { steps: ["推门进院", prose] });
	assert.equal(r.ok, false, "计划里写正文必须走不通");
	assert.equal(ws.plan.length, 0, "拒收即一条不记");
	assert.match(r.text, new RegExp(`${MAX_STEP_LEN}`), "回喂说明粒度上限");
	assert.doesNotMatch(r.text, /发生什么|留给/, "拒收回执只留事实＋动作，通道契约在工具描述里（P4）");

	// 条数上限：一拍是一小段戏，不是整章大纲
	const many = Array.from({ length: planStepBudget() + 1 }, (_, i) => `第${i + 1}步`);
	const tooMany = runWriteTool(ws, d, "beat_plan", { steps: many });
	assert.equal(tooMany.ok, false);
	assert.match(tooMany.text, new RegExp(`最多 ${planStepBudget()} 条`));

	// 非数组 / 空数组都拒收，且不抛
	assert.equal(runWriteTool(ws, d, "beat_plan", { steps: [] }).ok, false);
	assert.equal(runWriteTool(ws, d, "beat_plan", {}).ok, false);
});

test("beat_plan 单拍边界：拒绝擅自跳到放学、夜跑或次日", () => {
	const ws = createWorkspace();
	const result = runWriteTool(ws, deps(), "beat_plan", {
		steps: ["回应眼前试探", "放学后前往体育馆参加交流会"],
	});
	assert.equal(result.ok, false);
	assert.match(result.text, /当前场景|跨时间/);
	assert.equal(ws.plan.length, 0);
});

test("用户明确授权时间跳转时，计划和正文通过单拍边界", () => {
	const d = { ...deps(), transitionAuthorized: true };
	const ws = createWorkspace();
	assert.equal(runWriteTool(ws, d, "beat_plan", { steps: ["推进到第二天清晨", "抵达车站"] }).ok, true);
	assert.equal(runWriteTool(ws, d, "draft_append", { segment: "第二天清晨，他抵达车站。" }).ok, true);
});

test("当前场景提到体育馆或交流会本身不算跨场景", () => {
	const ws = createWorkspace();
	assert.equal(runWriteTool(ws, deps(), "draft_append", { segment: "OAA 公告栏列着体育馆交流会，但当前配对状态还是未配对。" }).ok, true);
});

test("稿纸正文边界：剧情插图可就地穿插，日历与 HTML 格式块拒收", () => {
	assert.equal(runWriteTool(createWorkspace(), deps(), "draft_append", { segment: "正文。<image>提示词</image>" }).ok, true);
	for (const content of ["正文。<calendar>四月</calendar>", "<!DOCTYPE html><html></html>"]) {
		const ws = createWorkspace();
		const result = runWriteTool(ws, deps(), "draft_append", { segment: content });
		assert.equal(result.ok, false);
		assert.match(result.text, /封笔和记账后|收尾格式/);
		assert.equal(ws.draft, "");
	}
});

test("稿纸单拍边界：计划漏过时正文仍拒绝跳到放学或体育馆", () => {
	const ws = createWorkspace();
	const result = runWriteTool(ws, deps(), "draft_append", {
		segment: "他吃完饭离开食堂，放学后又去了体育馆参加交流会。",
	});
	assert.equal(result.ok, false);
	assert.match(result.text, /当前场景/);
	assert.equal(ws.draft, "");
});

test("beat_plan：长篇目标动态放宽路标数，但仍保持有限窗口", () => {
	assert.equal(planStepBudget(), 3);
	assert.equal(planStepBudget({ min: 500, max: 800 }), 3);
	assert.equal(planStepBudget({ min: 1500, max: 1800 }), 4);
	assert.equal(planStepBudget({ min: 2700, max: 3300 }), 6);
	assert.equal(planStepBudget({ min: 4000, max: 5000 }), 8);

	const ws = createWorkspace();
	const d = { ...deps(), rules: { wordRange: { min: 2700, max: 3300 } } };
	const r = runWriteTool(ws, d, "beat_plan", { steps: ["一", "二", "三", "四", "五", "六", "七", "八"] });
	assert.equal(r.ok, false);
	assert.match(r.text, /最多 6 条/);
});

test("beat_step_done：按序号勾掉并回报剩余；越界/重复勾/无计划都拒收", () => {
	const ws = createWorkspace();
	const d = deps();
	assert.equal(runWriteTool(ws, d, "beat_step_done", { step: 1 }).ok, false, "没有计划时无从勾起");

	runWriteTool(ws, d, "beat_plan", { steps: ["推门进院", "被弟子拦下"] });
	runWriteTool(ws, d, "draft_append", { segment: "她推门进院。" });
	const ok = runWriteTool(ws, d, "beat_step_done", { step: 1 });
	assert.equal(ok.ok, true);
	assert.equal(ws.plan[0]?.done, true);
	assert.match(ok.text, /还剩 1 条/);

	assert.equal(runWriteTool(ws, d, "beat_step_done", { step: 1 }).ok, false, "重复勾拒收");
	assert.equal(runWriteTool(ws, d, "beat_step_done", { step: 9 }).ok, false, "越界拒收");
	assert.equal(runWriteTool(ws, d, "beat_step_done", {}).ok, false, "缺参数拒收");

	// 全部勾完：回执仍只报事实（进度/判定由轮次注入承载，回执不抢注入的活）
	const last = runWriteTool(ws, d, "beat_step_done", { step: 2 });
	assert.equal(last.ok, true);
	assert.match(last.text, /还剩 0 条/);
	assert.doesNotMatch(last.text, /接着演|draft_append/, "勾完不催段");
	assert.doesNotMatch(last.text, /ask|收笔前/, "回执不带评估导向");
});

test("draft_append 回执一句事实（§2.4 瘦身）：无字数读数、无评估导向、无验收报告", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "beat_plan", { steps: ["推门进院", "被弟子拦下"] });
	const r = runWriteTool(ws, d, "draft_append", { segment: "她推开院门，晨雾还没散尽。" });
	assert.equal(r.ok, true);
	assert.equal(r.text, "已续写（第 1 段）。", "回执 = 一句事实");
	assert.ok(!/\d+ 字/.test(r.activity ?? ""), "过程条也不报字数");

	// 定点改稿回执同样只留事实（改动明细），不附验收报告
	const e = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "晨雾", new: "薄雾" }] });
	assert.equal(e.ok, true);
	assert.match(e.text, /已改 1 处/);
	assert.doesNotMatch(e.text, /验收/, "改稿回执不再附验收报告——事实在 seal 回执可见");

	// 封笔是验收场合：事实报告在此给出
	const sealed = runWriteTool(ws, d, "draft_seal", {});
	assert.equal(sealed.ok, true);
	assert.equal(ws.sealed, true);
	assert.doesNotMatch(sealed.text, /\d+ 字|目标/, "封笔回执零测量值（8/10 去数字化）");
});

test("formatPlan：空计划有可读兜底，混合状态各按其形渲染", () => {
	assert.match(formatPlan([]), /还没有计划/);
	const rendered = formatPlan([
		{ text: "推门进院", done: true },
		{ text: "被弟子拦下", done: false },
	]);
	assert.match(rendered, /1\. ☑ ~~推门进院~~/);
	assert.match(rendered, /2\. □ 被弟子拦下/);
});

test("draft_write：收稿落工作区（验收已退役，回执只认收）；空 content 拒收", () => {
	const ws = createWorkspace();
	const d = deps();
	const bad = runWriteTool(ws, d, "draft_write", { content: "  " });
	assert.equal(bad.ok, false);
	assert.equal(ws.writes, 0);

	const r = runWriteTool(ws, d, "draft_write", { content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "山门外的雪落了一夜。");
	assert.equal(ws.writes, 1);
	assert.match(r.text, /已收稿（第 1 稿/);
});

test("draft_write 门禁：查过世界＝这拍有戏，一次交完被拒收并导向 draft_append", () => {
	const ws = createWorkspace();
	const d = deps();
	ws.lookups = 2; // 引擎在读侧工具执行后打点（lorebook / memory / world_state_get）

	const r = runWriteTool(ws, d, "draft_write", { content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, false, "拒收而不是放行后再劝");
	assert.equal(ws.draft, "", "拒收不留痕：稿子没被写进去");
	assert.equal(ws.writes, 0);
	assert.match(r.text, /draft_append/, "把正确的路回喂给模型");
	assert.match(r.text, /查过 2 次世界/, "回喂里带上判据本身");
});

test("draft_write 门禁：没查过世界（寒暄拍）照常收稿", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_write", { content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
	assert.equal(ws.writes, 1);
});

test("draft_write 门禁：writing_guide 不计入 lookups，故读过方法论仍可一次交完", () => {
	// lookups 只认「查世界」；读写作方法论不是遇到了要处理的事
	const ws = createWorkspace();
	assert.equal(ws.lookups, 0, "新工作区从 0 起");
	const r = runWriteTool(ws, deps(), "draft_write", { content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
});

test("draft_write 门禁：续写到一半改用全量重交不拦（另有 draft_edit 的劝导）", () => {
	const ws = createWorkspace();
	const d = deps();
	ws.lookups = 1;
	runWriteTool(ws, d, "draft_append", { segment: "第一段。" });
	const r = runWriteTool(ws, d, "draft_write", { content: "整篇重写过的正文。" });
	assert.equal(r.ok, true, "appends>0 时门禁让路");
	assert.equal(ws.draft, "整篇重写过的正文。");
});

test("draft_write 门禁：internal 代收绕过门禁——兜底路径不能把正文丢掉", () => {
	// 宽进严出：模型直出正文由引擎代收为 draft_write。被门禁拦下就等于这拍白演。
	const ws = createWorkspace();
	ws.lookups = 3;
	const r = runWriteTool(ws, deps(), "draft_write", { content: "直出的正文。" }, true);
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "直出的正文。");
});

// ---------------- M-E：draft_append / draft_seal（分段续写） ----------------

const minRules = (): WorkspaceDeps => ({
	...deps(),
	rules: { ...emptyDraftRules(), wordRange: { min: 800, max: 2000 } },
});

test("draft_append：追加不覆盖；封笔前无验收报告，封笔后事实可见（M-R1 事实化）", () => {
	const ws = createWorkspace();
	const d = minRules();
	// 第一段只有几十字——字数目标 800 起，但回执不做任何评价
	const r1 = runWriteTool(ws, d, "draft_append", { segment: "山门外雪落了一夜。他推门进屋，炉火将熄。" });
	assert.equal(r1.ok, true);
	assert.equal(ws.draft, "山门外雪落了一夜。他推门进屋，炉火将熄。");
	assert.equal(ws.appends, 1);
	assert.equal(ws.sealed, false);
	assert.equal(r1.text, "已续写（第 1 段）。");
	// 追加第二段：不覆盖，续在末尾
	runWriteTool(ws, d, "draft_append", { segment: "她还在窗边坐着，像在等什么。" });
	assert.ok(ws.draft.includes("山门外雪落了一夜。"));
	assert.ok(ws.draft.includes("她还在窗边坐着"));
	assert.equal(ws.appends, 2);
	// 明确篇幅目标时，前两次过短封笔会让模型继续展开；第三次才允许收束。
	assert.equal(runWriteTool(ws, d, "draft_seal", {}).ok, false);
	assert.equal(runWriteTool(ws, d, "draft_seal", {}).ok, false);
	const r3 = runWriteTool(ws, d, "draft_seal", {});
	assert.equal(ws.sealed, true);
	assert.match(r3.text, /已封笔/);
	assert.doesNotMatch(r3.text, /待修|违规|修正/, "封笔回执不变成质量报告");
});

test("draft_write：不以固定字数限制模型，格式尾巴完整保留", () => {
	const body = "字".repeat(MAX_DRAFT_BODY_CHARS);
	const tail = `<StatusBlock>${"状态".repeat(2000)}</StatusBlock>`;
	const ws = createWorkspace();
	const accepted = runWriteTool(ws, deps(), "draft_write", { content: body + tail });
	assert.equal(accepted.ok, true, "正文刚好触顶且巨大格式尾巴仍可收稿");
	assert.equal(ws.draft, body + tail, "输出合约尾巴完整保留");
	assert.equal(ws.appendLimitReached, false);

	const before = ws.draft;
	const rejected = runWriteTool(ws, deps(), "draft_write", { content: "字".repeat(MAX_DRAFT_ABSOLUTE_CHARS + 1) });
	assert.equal(rejected.ok, true);
	assert.notEqual(ws.draft, before, "长篇重交应正常覆盖，不截断");
});

test("draft_append：不限制续写段数，模型自行决定何时封笔", () => {
	const ws = createWorkspace();
	const d = minRules();
	for (let i = 1; i <= MAX_APPENDS; i++) {
		assert.equal(runWriteTool(ws, d, "draft_append", { segment: `第${i}段。` }).ok, true);
	}
	const before = ws.draft;
	const fourth = runWriteTool(ws, d, "draft_append", { segment: "第4段。" });
	assert.equal(fourth.ok, true);
	assert.notEqual(ws.draft, before, "第4段应继续写入现稿");
	assert.equal(ws.appendRejects, 0);
	assert.equal(ws.appendLimitReached, false);
	assert.equal(runWriteTool(ws, d, "draft_append", { segment: "第5段。" }).ok, true);
	assert.equal(ws.appendRejects, 0);
	assert.equal(runWriteTool(ws, d, "draft_seal", {}).ok, false, "明显低于目标时首次封笔应暂缓");
	assert.equal(runWriteTool(ws, d, "draft_seal", {}).ok, false, "第二次仍给模型继续展开机会");
	assert.equal(runWriteTool(ws, d, "draft_seal", {}).ok, true, "第三次允许收束，避免死循环");
});

test("draft_append：明确 2800-3200 长篇目标时，2200 字首段不提前封笔", () => {
	const ws = createWorkspace();
	const d = deps();
	d.rules.wordRange = { min: 2800, max: 3200 };
	const body = "字".repeat(2200);
	const accepted = runWriteTool(ws, d, "draft_append", { segment: body });
	assert.equal(accepted.ok, true);
	assert.equal(ws.draft, body, "超过软预算的原子首段必须完整落稿，不截断");
	assert.equal(ws.appendLimitReached, false);
	assert.equal(ws.overBudget, false);
	assert.equal(ws.sealed, false, "明确长篇目标必须允许继续补足篇幅");
	assert.equal(runWriteTool(ws, d, "draft_append", { segment: "继续补足篇幅" }).ok, true);
});

test("draft_append：长稿不因固定字数上限拒收", () => {
	const ws = createWorkspace();
	const d = deps();
	const rejected = runWriteTool(ws, d, "draft_append", { segment: "字".repeat(MAX_DRAFT_ABSOLUTE_CHARS + 1) });
	assert.equal(rejected.ok, true);
	assert.ok(ws.draft.length > MAX_DRAFT_ABSOLUTE_CHARS);
	assert.equal(ws.appendLimitReached, false, "空稿拒收绝不能进入收笔阶段");
	assert.equal(ws.sealed, false);
	const retry = runWriteTool(ws, d, "draft_append", { segment: "池宽治是《催眠性指导》中的主要角色。" });
	assert.equal(retry.ok, true, "长稿后仍可继续写");
	assert.match(ws.draft, /池宽治/);
});

test("draft_append：追加进时间线是追加段（draft=true），不塌成替换", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "第一段。" });
	runWriteTool(ws, d, "draft_append", { segment: "第二段。" });
	const draftSegs = ws.timeline.filter((s) => s.kind === "text" && s.draft === true);
	assert.equal(draftSegs.length, 2, "两段续写应为两个独立稿段");
	assert.equal((draftSegs[0] as { text: string }).text, "第一段。");
	assert.equal((draftSegs[1] as { text: string }).text, "第二段。");
});

test("draft_append：续写后 draft_edit 改一处，时间线保持分段不塌成一整块", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "山门外的雪落了一夜。" });
	runWriteTool(ws, d, "draft_append", { segment: "他推门进屋，炉火将熄。" });
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "推门进屋", new: "推门进了屋" }] });
	assert.equal(r.ok, true);
	assert.equal(ws.edits, 1);
	const segs = ws.timeline.filter((s) => s.kind === "text" && s.draft === true);
	assert.equal(segs.length, 2, "改稿后仍是两个稿段（分段形态不塌）");
});

test("finalTimeline：分段同构——稿段原位保留，尾巴收独立末段（8/09 输出形式）", () => {
	const ws = createWorkspace();
	const d = deps();
	recordSegment(ws, { kind: "thinking", text: "构思第一段。" });
	runWriteTool(ws, d, "draft_append", { segment: "第一段。" });
	recordSegment(ws, { kind: "thinking", text: "构思第二段。" });
	runWriteTool(ws, d, "draft_append", { segment: "第二段。" });
	// 尾巴（状态栏）流式记档：非稿 text，不得黏进稿段
	recordSegment(ws, { kind: "text", text: "<StatusBlock>地点：山门</StatusBlock>" });
	const finalText = `${ws.draft}\n\n<StatusBlock>地点：山门</StatusBlock>`;
	const tl = finalTimeline(ws, finalText);
	const textSegs = tl.filter((s): s is Extract<(typeof tl)[number], { kind: "text" }> => s.kind === "text");
	assert.equal(textSegs.length, 3, "两个稿段 + 一个尾巴段");
	assert.equal(textSegs[0].text, "第一段。");
	assert.equal(textSegs[0].draft, true);
	assert.equal(textSegs[1].text, "第二段。");
	assert.equal(textSegs[1].draft, true);
	assert.ok(textSegs[2].text.includes("StatusBlock"), "尾巴独立末段");
	assert.notEqual(textSegs[2].draft, true, "尾巴段不带 draft 标记");
	// 内容一致：稿段拼接 + 尾巴 = finalText
	assert.equal([textSegs[0].text, textSegs[1].text].join("\n\n") + "\n\n" + textSegs[2].text, finalText);
});

test("finalTimeline：无稿（直出路径）回退单段全文", () => {
	const ws = createWorkspace();
	recordSegment(ws, { kind: "thinking", text: "直接说。" });
	recordSegment(ws, { kind: "text", text: "你好。" });
	const tl = finalTimeline(ws, "你好。");
	const textSegs = tl.filter((s) => s.kind === "text");
	assert.equal(textSegs.length, 1, "直出路径仍是单段");
	assert.equal((textSegs[0] as { text: string }).text, "你好。");
});

test("draft_seal：回执不点名状态栏——格式块点名唯一归谢幕注入（M-R1 §2.3）", () => {
	const ws = createWorkspace();
	const d = deps();
	d.rules.statusBarTagGroup = ["StatusBlock"];
	runWriteTool(ws, d, "draft_append", { segment: "他推门进屋，炉火将熄。" });
	const r = runWriteTool(ws, d, "draft_seal", {});
	assert.match(r.text, /已封笔/);
	assert.doesNotMatch(r.text, /状态栏|StatusBlock|最后一步/, "状态栏点名从 seal 回执退场（七处催告之一）");
	assert.doesNotMatch(r.text, /\d+ 字/, "回执零测量值");
});


test("seal 回执补认稿外直出（8/10）：ws.strayText 非空时以事实一行出现，空则不提", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "出租车在酒店门口停下。" });
	ws.strayText = "收到定位，她只回了两个字。然后起身换衣。";
	const sealed = runWriteTool(ws, d, "draft_seal", {});
	assert.match(sealed.text, /直出不在稿内/, "稿外直出是事实");
	assert.match(sealed.text, /起头「收到定位/, "带起头引文供模型辨认");
	assert.doesNotMatch(sealed.text, /补进|draft_edit|必须/, "只报事实，处置归模型");

	const ws2 = createWorkspace();
	runWriteTool(ws2, d, "draft_append", { segment: "正文一段。" });
	const sealed2 = runWriteTool(ws2, d, "draft_seal", {});
	assert.doesNotMatch(sealed2.text, /直出/, "无稿外直出则只字不提");
});

test("draft_seal：空工作区封笔被拒", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_seal", {});
	assert.equal(r.ok, false);
	assert.match(r.text, /draft_write|draft_append/);
});

test("draft_seal：明确长篇目标时，过短正文前两次封笔被暂缓", () => {
	const ws = createWorkspace();
	const d = { ...deps(), rules: { wordRange: { min: 2700, max: 3300 } } };
	runWriteTool(ws, d, "draft_append", { segment: "字".repeat(800) });
	const first = runWriteTool(ws, d, "draft_seal", {});
	const second = runWriteTool(ws, d, "draft_seal", {});
	const third = runWriteTool(ws, d, "draft_seal", {});
	assert.equal(first.ok, false);
	assert.equal(second.ok, false);
	assert.match(first.text, /2700–3300/);
	assert.equal(third.ok, true, "两次软门禁后仍允许收束，避免模型死循环");
});

test("稿纸收稿：多个完整句挤成超长小说段时拒收，要求模型重排", () => {
	const ws = createWorkspace();
	const long = `${"池宽治压低声音说着考试规则。".repeat(30)}`;
	const result = runWriteTool(ws, deps(), "draft_append", { segment: long });
	assert.equal(result.ok, false);
	assert.match(result.text, /插入空行|小说段落/);
	assert.equal(ws.draft, "");
	assert.match(result.activity ?? "", /过长/);
});

test("draft_seal：封笔后 draft_edit 仍可改（封笔≠锁稿，改完再验）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "山门外的雪落了一夜。" });
	runWriteTool(ws, d, "draft_append", { segment: "她还在窗边。" });
	runWriteTool(ws, d, "draft_seal", {});
	assert.equal(ws.sealed, true);
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "窗边", new: "廊下" }] });
	assert.equal(r.ok, true);
	assert.ok(ws.draft.includes("廊下"));
	assert.equal(ws.sealed, false, "正文变化后必须重新封笔");
});

test("正文变化会废弃按旧稿提交的账本补丁", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "她留在山门。" });
	runWriteTool(ws, d, "draft_seal", {});
	assert.equal(runWriteTool(ws, d, "world_state_update", { patch: { location: "山门" } }).ok, true);
	assert.equal(ws.patches.length, 1);
	assert.equal(runWriteTool(ws, d, "draft_edit", { edits: [{ old: "留在山门", new: "走进前院" }] }).ok, true);
	assert.equal(ws.patches.length, 0, "旧正文产生的 patch 不能提交到新正文");
	assert.equal(ws.sealed, false);
});

test("draft_edit 不能绕过收尾格式和跨场景门禁", () => {
	const d = deps();
	const formatWs = createWorkspace();
	runWriteTool(formatWs, d, "draft_write", { content: "她留在门边。" });
	assert.equal(runWriteTool(formatWs, d, "draft_edit", { edits: [{ old: "门边", new: "<calendar>次日</calendar>" }] }).ok, false);
	assert.equal(formatWs.draft, "她留在门边。");

	const sceneWs = createWorkspace();
	runWriteTool(sceneWs, d, "draft_write", { content: "她留在门边。" });
	assert.equal(runWriteTool(sceneWs, d, "draft_edit", { edits: [{ old: "她留在门边。", new: "第二天，她去了体育馆。" }] }).ok, false);
	assert.equal(sceneWs.draft, "她留在门边。");
});

test("draft_write：全量替换语义——第二稿覆盖第一稿", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "第一稿。" });
	runWriteTool(ws, d, "draft_write", { content: "第二稿。" });
	assert.equal(ws.draft, "第二稿。");
	assert.equal(ws.writes, 2);
});


test("world_state_update：只在 sealed 后验收入队，基准账本不动", () => {
	const ws = createWorkspace();
	const d = deps();
	const early = runWriteTool(ws, d, "world_state_update", { patch: { location: "藏经阁" } });
	assert.equal(early.ok, false);
	assert.match(early.text, /尚未封笔/);
	runWriteTool(ws, d, "draft_write", { content: "她走进藏经阁。" });
	runWriteTool(ws, d, "draft_seal", {});
	const r = runWriteTool(ws, d, "world_state_update", {
		patch: { location: "藏经阁", characters: { 林霜: { affinity: 35 } } },
	});
	assert.equal(r.ok, true);
	assert.match(r.text, /已记账（定稿后生效）/);
	assert.equal(ws.patches.length, 1);
	assert.equal(d.baseState.location, ""); // 基准未被改动
	const proj = projectedState(ws, d.baseState);
	assert.equal(proj.location, "藏经阁");
	assert.equal(proj.characters["林霜"].affinity, 35);
});

test("world_state_update：非法 patch 拒收（非对象 / 全字段无效）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "正文。" });
	assert.equal(runWriteTool(ws, d, "world_state_update", { patch: "藏经阁" }).ok, false);
	assert.equal(runWriteTool(ws, d, "world_state_update", { patch: [1] }).ok, false);
	const r = runWriteTool(ws, d, "world_state_update", { patch: { time: 42 } });
	assert.equal(r.ok, false);
	assert.match(r.text, /记账被拒/);
	assert.equal(ws.patches.length, 0);
});

test("world_state_update：角色键在投影上归一（大小写变体不裂成两人）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "正文。" });
	runWriteTool(ws, d, "draft_seal", {});
	runWriteTool(ws, d, "world_state_update", { patch: { characters: { Alice: { affinity: 10 } } } });
	runWriteTool(ws, d, "world_state_update", { patch: { characters: { "alice ": { status: "警惕" } } } });
	const proj = projectedState(ws, d.baseState);
	assert.deepEqual(Object.keys(proj.characters), ["Alice"]);
	assert.equal(proj.characters.Alice.affinity, 10);
	assert.equal(proj.characters.Alice.status, "警惕");
});

test("world_state_update：兼容 OpenAI 端点二次序列化的 JSON 对象参数", () => {
	const ws = createWorkspace();
	const context = deps();
	runWriteTool(ws, context, "draft_write", { content: "她走进教室。" });
	runWriteTool(ws, context, "draft_seal", {});
	const result = runWriteTool(ws, context, "world_state_update", { patch: JSON.stringify({ location: "D班教室" }) });
	assert.equal(result.ok, true);
	assert.equal(ws.patches.length, 1);
	assert.equal(ws.patches[0]?.location, "D班教室");
});

test("world_state_update：角色 status/notes 命中 lore 名称时只记录来源，不伪称语义已验证", () => {
	const ws = createWorkspace();
	const d = deps();
	d.loreEntries = [{
		uid: 1,
		keys: ["林霜"],
		secondaryKeys: [],
		comment: "林霜",
		content: "林霜旧伤未愈。",
		constant: false,
		enabled: true,
		selective: false,
		order: 100,
		source: "card",
	}];
	runWriteTool(ws, d, "draft_write", { content: "正文。" });
	runWriteTool(ws, d, "draft_seal", {});
	const result = runWriteTool(ws, d, "world_state_update", {
		patch: { characters: { 林霜: { status: "已经痊愈", notes: "今日可动武" } } },
	});
	assert.equal(result.ok, true, "不做不可靠的自由文本冲突拦截");
	assert.equal(ws.patchAudit.length, 1);
	assert.deepEqual(ws.patchAudit[0]?.fields, ["status", "notes"]);
	assert.equal(ws.patchAudit[0]?.lore[0]?.source, "card");
	assert.match(ws.patchAudit[0]?.lore[0]?.fingerprint ?? "", /^[a-f0-9]{12}$/);
	assert.equal(ws.patchAudit[0]?.verification, "not-semantic-verified");
});

test("未知写侧工具名：可读文本，不抛", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_fly", {});
	assert.equal(r.ok, false);
	assert.match(r.text, /未知写侧工具/);
});

// ---------------- M-B：draft_edit / draft_read / draft_search ----------------

test("draft_edit：无稿时拒绝——改稿之前必须先落笔（两种写法都指路）", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_edit", { edits: [{ old: "甲", new: "乙" }] });
	assert.equal(r.ok, false);
	assert.equal(ws.edits, 0);
	assert.match(r.text, /draft_append/);
	assert.match(r.text, /draft_write/);
});

test("draft_edit：多处定点替换一次套用，稿次不增而 edits 增；回执只留改动明细", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "他推开门。屋里很暗。她抬起头。" });
	const r = runWriteTool(ws, d, "draft_edit", {
		edits: [
			{ old: "他推开门。", new: "他一把推开门。" },
			{ old: "她抬起头。", new: "她缓缓抬起头。" },
		],
	});
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "他一把推开门。屋里很暗。她缓缓抬起头。");
	assert.equal(ws.edits, 1);
	assert.equal(ws.writes, 1, "定点改稿不算新稿次");
	assert.match(r.text, /已改 2 处/);
});

test("draft_edit：批量原子——任一处定位失败则整批不改", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "他推开门。屋里很暗。" });
	const before = ws.draft;
	const r = runWriteTool(ws, d, "draft_edit", {
		edits: [
			{ old: "他推开门。", new: "他一把推开门。" },
			{ old: "根本不存在的句子", new: "X" },
		],
	});
	assert.equal(r.ok, false);
	assert.equal(ws.draft, before, "第一处也不能落笔");
	assert.equal(ws.edits, 0);
	assert.match(r.text, /整批未套用/);
	assert.match(r.text, /根本不存在的句子/, "回显模型自己声称的 old");
});

test("draft_edit：old 不唯一时拒绝并要求扩大引用范围", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "她笑了。他也笑了。" });
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "笑了", new: "哭了" }] });
	assert.equal(r.ok, false);
	assert.match(r.text, /2 处/);
	assert.match(r.text, /唯一/);
});

test("draft_edit：中文标点变体按归一命中，并回报命中级别", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "他说：“走吧。”然后转身。" });
	// 模型用直角引号引用——归一后应命中
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "「走吧。」", new: "「再等等。」" }] });
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "他说：「再等等。」然后转身。", "下标映射回原文必须精确");
	assert.match(r.text, /标点归一/, "非精确命中要告知模型");
});

test("draft_search：命中给上下文引用；多处命中提示 old 需唯一", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "她笑了。风很大。他也笑了。" });
	const one = runWriteTool(ws, d, "draft_search", { query: "风很大" });
	assert.equal(one.ok, true);
	assert.match(one.text, /命中 1 处/);

	const many = runWriteTool(ws, d, "draft_search", { query: "笑了" });
	assert.match(many.text, /命中 2 处/);
	assert.match(many.text, /必须唯一/);

	const none = runWriteTool(ws, d, "draft_search", { query: "不存在" });
	assert.match(none.text, /找不到/);
});

test("draft_read：回现稿全文，零测量值（8/10 验收退役）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "山门外落了一夜雪。<StatusBlock>地点：山门</StatusBlock>" });
	const r = runWriteTool(ws, d, "draft_read", {});
	assert.equal(r.ok, true);
	assert.match(r.text, /山门外落了一夜雪/);
	assert.doesNotMatch(r.text, /\d+ 字/, "回执不带任何字数");
});
