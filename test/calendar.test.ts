import assert from "node:assert/strict";
import test from "node:test";

import { addCalendarDays, dateToOrdinal, defaultGregorianCalendar, isValidCalendarDate, ordinalToDate, parseCalendarDefinitionRecord, parseNarrativeDate, projectCalendarMonth, shiftCalendarMonth, weekdayOf, type CalendarDefinition, type CalendarProjectionSource } from "../src/calendar.ts";
import type { WorldModuleRecord } from "../src/stage/literary-world-modular.ts";

const fixed: CalendarDefinition = { id: "fixed", kind: "fixed", era: "星辉历", months: [{ name: "甲月", days: 2 }, { name: "乙月", days: 3 }], weekdays: ["曜一", "曜二", "曜三"], anchorDate: { year: 1, month: 1, day: 1 }, anchorWeekday: 0 };

test("calendar：公历闰年、星期与日期运算不依赖本地时区", () => {
	const calendar = defaultGregorianCalendar();
	assert.equal(isValidCalendarDate(calendar, { year: 1900, month: 2, day: 29 }), false);
	assert.equal(isValidCalendarDate(calendar, { year: 2000, month: 2, day: 29 }), true);
	assert.equal(isValidCalendarDate(calendar, { year: 2100, month: 2, day: 29 }), false);
	assert.equal(weekdayOf(calendar, { year: 2015, month: 4, day: 6 }), 1);
	assert.deepEqual(addCalendarDays(calendar, { year: 2016, month: 2, day: 28 }, 2), { year: 2016, month: 3, day: 1 });
});

test("calendar：固定历支持自定义月长、周长、月份名和跨年导航", () => {
	assert.equal(weekdayOf(fixed, { year: 1, month: 1, day: 1 }), 0);
	assert.equal(weekdayOf(fixed, { year: 1, month: 2, day: 1 }), 2);
	assert.equal(weekdayOf(fixed, { year: 2, month: 1, day: 1 }), 2);
	assert.deepEqual(parseNarrativeDate("星辉历102年乙月3日（黄昏）", fixed), { year: 102, month: 2, day: 3 });
	assert.equal(parseNarrativeDate("星辉历102年甲月3日", fixed), null);
	assert.deepEqual(shiftCalendarMonth(fixed, { year: 4, month: 2 }, 1), { year: 5, month: 1 });
});

test("calendar：日期与序号在边界上互逆", () => {
	for (const date of [{ year: 1, month: 1, day: 1 }, { year: 1, month: 2, day: 3 }, { year: 2, month: 1, day: 1 }]) {
		assert.deepEqual(ordinalToDate(fixed, dateToOrdinal(fixed, date)!), date);
	}
});

test("calendar：自定义历法 record 严格校验，不静默钳制", () => {
	const record = (attributes: WorldModuleRecord["attributes"]): WorldModuleRecord => ({ id: "calendar-definition", facet: "rule", label: "星辉历", status: "生效", summary: "", visibility: "public", attributes, originRefs: [], updatedRound: 1 });
	assert.equal(parseCalendarDefinitionRecord(record({ calendarKind: "fixed", era: "星辉历", months: ["甲月|2", "乙月|3"], weekdays: ["曜一", "曜二", "曜三"], anchorDate: "1-1-1", anchorWeekday: 0 }))?.months.length, 2);
	assert.equal(parseCalendarDefinitionRecord(record({ calendarKind: "fixed", months: ["坏月|0"], weekdays: ["曜一"] })), null);
});

test("calendar：跨月绝对区间与跨年年度重复正确展开", () => {
	const calendar = defaultGregorianCalendar();
	const source: CalendarProjectionSource = { definition: calendar, currentDate: { year: 2015, month: 4, day: 30 }, events: [
		{ recurrence: "none", start: { year: 2015, month: 4, day: 29 }, end: { year: 2015, month: 5, day: 3 }, event: { id: "range", title: "长假", summary: "", source: "world", sourceLabel: "校历", visibility: "public" } },
		{ recurrence: "yearly", start: { month: 12, day: 30 }, end: { month: 1, day: 2 }, event: { id: "new-year", title: "年祭", summary: "", source: "world", sourceLabel: "校历", visibility: "public" } },
	] };
	const april = projectCalendarMonth(source, { year: 2015, month: 4 })!;
	const may = projectCalendarMonth(source, { year: 2015, month: 5 })!;
	assert.equal(april.days[28]?.events[0]?.dayIndex, 1);
	assert.equal(may.days[2]?.events[0]?.dayIndex, 5);
	const january = projectCalendarMonth(source, { year: 2016, month: 1 })!;
	assert.equal(january.days[0]?.events.find((event) => event.id === "new-year")?.dayIndex, 3);
	assert.equal(january.days[2]?.events.some((event) => event.id === "new-year"), false);
});

test("calendar：2 月 29 日年度重复只在闰年出现", () => {
	const calendar = defaultGregorianCalendar();
	const source: CalendarProjectionSource = { definition: calendar, currentDate: { year: 2016, month: 2, day: 1 }, events: [{ recurrence: "yearly", start: { month: 2, day: 29 }, end: { month: 2, day: 29 }, event: { id: "leap", title: "闰日", summary: "", source: "world", sourceLabel: "校历", visibility: "public" } }] };
	assert.equal(projectCalendarMonth(source, { year: 2015, month: 2 })!.days.flatMap((day) => day.events).length, 0);
	assert.equal(projectCalendarMonth(source, { year: 2016, month: 2 })!.days[28]?.events[0]?.id, "leap");
});

test("calendar：年份起点首月仍可投影，恶意 era 不破坏解析", () => {
	const source: CalendarProjectionSource = { definition: defaultGregorianCalendar(), currentDate: { year: 1, month: 1, day: 1 }, events: [] };
	assert.equal(projectCalendarMonth(source, { year: 1, month: 1 })?.days.length, 31);
	const unsafe = { ...fixed, era: "纪元(" };
	assert.deepEqual(parseNarrativeDate("纪元(1年甲月1日", unsafe), { year: 1, month: 1, day: 1 });
});
