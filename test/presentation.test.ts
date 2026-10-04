import assert from "node:assert/strict";
import test from "node:test";

import { parseLegacyCalendarSource, projectCalendar, projectPlayerStatus, projectTavernVariables, serializeCalendarSource } from "../src/presentation.ts";
import { defaultModularWorldState } from "../src/stage/literary-world-modular.ts";
import { defaultLiteraryEcologyState } from "../src/stage/literary-ecology.ts";

test("梨园原生展示：玩家状态只读自 rp-state，不含 UpdateVariable", () => {
	const view = projectPlayerStatus({ time: "2015年4月6日 清晨", location: "公交站台", characters: {}, inventory: ["学生证"], flags: { 学年: "第一学年" }, plot_threads: [] }, "测试玩家");
	assert.equal(view.time, "2015年4月6日 清晨");
	assert.equal(view.location, "公交站台");
	assert.equal(JSON.stringify(view).includes("UpdateVariable"), false);
});

test("梨园原生选项：展示结构接受独立 options，不写入任何状态", () => {
	const view = { version: 1 as const, status: projectPlayerStatus({ time: "", location: "", characters: {}, inventory: [], flags: {}, plot_threads: [] }, "用户"), options: ["登上公交车", "再看一眼线路牌"] };
	assert.deepEqual(view.options, ["登上公交车", "再看一眼线路牌"]);
	assert.equal("options" in view.status, false);
});

test("卡前端变量桥：rp-state 投影为学生证、班级终端和学生系统", () => {
	const variables = projectTavernVariables({
		time: "2015年4月6日 07:50", location: "公交车内",
		characters: { 堀北铃音: { affinity: 3, status: "在场，正在质问", notes: "同车陌生人" } },
		inventory: [], flags: { 实际班级: "D班", 个人点数: "100000" }, plot_threads: [],
	}, "测试玩家");
	assert.equal(variables.stat_data.学生证.姓名, "测试玩家");
	assert.equal(variables.stat_data.学生证.当前地点, "公交车内");
	assert.equal(variables.stat_data.班级终端.班级排名.D班.班级点数, 1000);
	assert.equal(variables.stat_data.学生系统.女.堀北铃音.好感度, 3);
});

test("历史日历：无原生日期可投影时可从旧 rpCurtain 恢复完整日期内容", () => {
	const calendar = parseLegacyCalendarSource(`<calendar>\nyear: 2015\nmonth: 4\ncurrent_day: 6\ndays:\n  1: 周三·春假，讨论入学准备\n  6: 周一·入学典礼 ← 今天\n  30: 周四·月末\n</calendar>`)!;
	assert.equal(calendar.days.length, 30);
	assert.equal(calendar.currentDay, 6);
	assert.match(calendar.days[0].events[0]?.title ?? "", /讨论入学准备/);
	assert.match(calendar.days[5].events[0]?.title ?? "", /入学典礼/);
	assert.match(calendar.days[29].events[0]?.title ?? "", /月末/);
	assert.match(serializeCalendarSource(calendar), /  30: 周四·月末/);
});

test("梨园原生日历：代码生成本月天数，只合并已提交世界/生态事件", () => {
	const world = defaultModularWorldState();
	world.modules["institution-calendar"] = { id: "institution-calendar", kind: "institution", revision: 1, summary: "校历", records: [{ id: "opening", facet: "event", label: "入学典礼", status: "已公布", summary: "2015年4月6日举行", visibility: "public", attributes: { date: "2015-04-06" }, originRefs: [], updatedRound: 1 }] };
	const ecology = defaultLiteraryEcologyState();
	ecology.occurrences.push({ id: "meet", name: "午休约定", kind: "personal", status: "scheduled", time: "2015年4月8日 午休", location: "休息区", participants: [], cause: "", development: "与椿樱子下棋", visibility: "discoverable", discovery: "", expires: "", withoutUser: "", userRole: "optional", prototypeId: "", templateId: "", patternKey: "meet", tone: "routine", intrusion: "optional", createdRound: 1, lastAdvancedRound: 1, cooldownUntilRound: 0 });
	const calendar = projectCalendar({ time: "2015年4月6日 清晨", location: "公交站台", characters: {}, inventory: [], flags: {}, plot_threads: [] }, world, ecology)!;
	assert.equal(calendar.days.length, 30);
	assert.equal(calendar.days[5].events[0]?.title, "入学典礼");
	assert.equal(calendar.days[7].events[0]?.title, "午休约定");
	assert.equal(calendar.days.filter((day) => day.events.length > 0).length, 2, "不能为每个未来日期随机造事件");
	const source = serializeCalendarSource(calendar);
	assert.match(source, /<calendar>/);
	assert.match(source, /year: 2015/);
	assert.match(source, /  30:/);
});

test("梨园原生日历：非日历模块的普通日号不误入，显式日期仍可投影", () => {
	const world = defaultModularWorldState();
	world.modules["social"] = { id: "social", kind: "social", revision: 1, summary: "传播", records: [
		{ id: "loose", facet: "wind", label: "三日传闻", status: "传播中", summary: "圈层内议论了三日", visibility: "public", attributes: {}, originRefs: [], updatedRound: 1 },
		{ id: "dated", facet: "event", label: "公告发布", status: "已公开", summary: "校方发布公告", visibility: "public", attributes: { date: "2015-04-09" }, originRefs: [], updatedRound: 1 },
	] };
	const calendar = projectCalendar({ time: "2015年4月6日", location: "", characters: {}, inventory: [], flags: {}, plot_threads: [] }, world, defaultLiteraryEcologyState())!;
	assert.equal(calendar.days[2]?.events.length, 0);
	assert.equal(calendar.days[8]?.events[0]?.title, "公告发布");
});

test("梨园原生日历：其他月份的显式日期不落入当前月", () => {
	const world = defaultModularWorldState();
	world.modules["institution-calendar"] = { id: "institution-calendar", kind: "institution", revision: 1, summary: "校历", records: [
		{ id: "may", facet: "event", label: "五月活动", status: "已公布", summary: "下月举行", visibility: "public", attributes: { date: "2015-05-06" }, originRefs: [], updatedRound: 1 },
	] };
	const calendar = projectCalendar({ time: "2015年4月6日", location: "", characters: {}, inventory: [], flags: {}, plot_threads: [] }, world, defaultLiteraryEcologyState())!;
	assert.equal(calendar.days.flatMap((day) => day.events).length, 0);
});

test("梨园原生日历：投影同时保留相邻月，使跨月事件可导航", () => {
	const world = defaultModularWorldState();
	world.modules["institution-calendar"] = { id: "institution-calendar", kind: "institution", revision: 1, summary: "校历", records: [
		{ id: "holiday", facet: "event", label: "连续假期", status: "已公布", summary: "跨月假期", visibility: "public", attributes: { date: "2015-04-29", end: "2015-05-03" }, originRefs: [], updatedRound: 1 },
	] };
	const calendar = projectCalendar({ time: "2015年4月30日", location: "", characters: {}, inventory: [], flags: {}, plot_threads: [] }, world, defaultLiteraryEcologyState())!;
	assert.equal(calendar.months?.length, 3);
	const may = calendar.months?.find((month) => month.month === 5)!;
	assert.equal(may.days[0]?.events[0]?.title, "连续假期");
	assert.equal(may.days[2]?.events[0]?.dayIndex, 5);
});
