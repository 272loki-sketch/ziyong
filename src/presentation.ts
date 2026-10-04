import type { WorldState } from "./types.ts";
import type { LiteraryEcologyState } from "./stage/literary-ecology.ts";
import type { ModularWorldState } from "./stage/literary-world-modular.ts";
import { buildCalendarProjection, defaultGregorianCalendar, parseNarrativeDate as parseDate, projectCalendarMonth, type CalendarDayView, type CalendarMonthView, type CalendarProjectionSource } from "./calendar.ts";

export type { CalendarDayView, CalendarEventView, CalendarMonthView, CalendarProjectionSource } from "./calendar.ts";

export interface PlayerStatusView {
	time: string;
	location: string;
	playerName: string;
	inventory: string[];
	flags: Record<string, string>;
	characters: Array<{ name: string; affinity: number; status: string; notes: string }>;
}

/** ST/MVU 卡前端只读兼容投影；真源仍是梨园 WorldState。 */
export interface TavernVariablesView {
	stat_data: {
		学生证: Record<string, unknown>;
		班级终端: { 班级排名: Record<string, Record<string, unknown>> };
		学生系统: { 男: Record<string, Record<string, unknown>>; 女: Record<string, Record<string, unknown>> };
	};
}

export interface CalendarView {
	year: number;
	month: number;
	currentDay: number;
	days: CalendarDayView[];
	months?: CalendarMonthView[];
	projection?: CalendarProjectionSource;
}

export interface PresentationView {
	version: 1;
	status: PlayerStatusView;
	calendar?: CalendarView;
	options?: string[];
}

export interface BbsPostView { author: string; avatar?: string; title?: string; body: string }
export interface BbsView { appName: string; title: string; posts: BbsPostView[] }

export function projectPlayerStatus(state: WorldState, userName: string): PlayerStatusView {
	return {
		time: state.time,
		location: state.location,
		playerName: userName,
		inventory: [...state.inventory],
		flags: { ...state.flags },
		characters: Object.entries(state.characters).map(([name, value]) => ({ name, affinity: value.affinity, status: value.status, notes: value.notes })),
	};
}

export function parseNarrativeDate(time: string): { year: number; month: number; day: number } | null {
	return parseDate(time, defaultGregorianCalendar());
}

export function projectCalendar(state: WorldState, world: ModularWorldState, ecology: LiteraryEcologyState): CalendarView | undefined {
	const projection = buildCalendarProjection(state.time, world, ecology);
	if (!projection) return undefined;
	const cursor = { year: projection.currentDate.year, month: projection.currentDate.month };
	const current = projectCalendarMonth(projection, cursor);
	if (!current || current.currentDay === null) return undefined;
	const months = [-1, 0, 1].flatMap((delta) => {
		const target = delta === 0 ? cursor : delta < 0 ? current.previous : current.next;
		if (!target) return [];
		const month = projectCalendarMonth(projection, target);
		return month ? [month] : [];
	});
	return { year: current.year, month: current.month, currentDay: current.currentDay, days: current.days, months, projection };
}

export function projectPresentation(state: WorldState, world: ModularWorldState, ecology: LiteraryEcologyState, userName: string): PresentationView {
	const calendar = projectCalendar(state, world, ecology);
	return { version: 1, status: projectPlayerStatus(state, userName), ...(calendar ? { calendar } : {}) };
}

const flagValue = (state: WorldState, pattern: RegExp): string => Object.entries(state.flags).find(([key]) => pattern.test(key))?.[1] ?? "";

export function projectTavernVariables(state: WorldState, userName: string): TavernVariablesView {
	const maleStudents: Record<string, Record<string, unknown>> = {};
	const femaleStudents: Record<string, Record<string, unknown>> = {};
	for (const [name, value] of Object.entries(state.characters)) {
		const target = /铃音|桔梗|惠|帆波|有栖|爱里|皋月|千秋|日和|美雨|麻耶|雫|一夏|翼|茜|知惠|佐枝|真冬|辉夜|千花|爱$|祈$|心羽|绘名|咲希|穗波|志步|实乃理|杏$|莉波|夕湖|悠月|飞鸟|蓝$|麻子|武子|弥子|圭$|真昼|纱代|小梢|一歌|萱乃/.test(name) ? femaleStudents : maleStudents;
		target[name] = {
			在场状态: /离场|不在场/.test(value.status) ? "离场" : "在场",
			关系: value.notes || "普通关系",
			态度: value.status || "状态未明",
			好感度: value.affinity,
			当前状态: value.status,
			备注: value.notes,
		};
	}
	const ranks = Object.fromEntries(["A班", "B班", "C班", "D班"].map((name, index) => [name, {
		显示名: name,
		领导者: "",
		排名: `第${index + 1}名`,
		班级点数: Number(flagValue(state, new RegExp(`${name}.*(?:班级)?点数|(?:班级)?点数.*${name}`))) || 1000,
	}]));
	return {
		stat_data: {
			学生证: {
				姓名: userName,
				年龄: Number(flagValue(state, /年龄/)) || 15,
				所属年级: flagValue(state, /所属年级|学年/) || "一年级",
				班级: flagValue(state, /实际班级|班级/) || "D班",
				实际班级: flagValue(state, /实际班级|班级/) || "D班",
				社团: flagValue(state, /社团/) || "无",
				个人点数: Number(flagValue(state, /个人点数/)) || 100000,
				当前时间: state.time,
				当前地点: state.location,
				效果状态: Object.fromEntries(Object.entries(state.flags).filter(([key]) => !/班级|年级|年龄|社团|点数/.test(key))),
			},
			班级终端: { 班级排名: ranks },
			学生系统: { 男: maleStudents, 女: femaleStudents },
		},
	};
}

/** Luker 日历兼容源：由权威投影序列化，不让模型重算月份。 */
export function serializeCalendarSource(calendar: CalendarView): string {
	const lines = [`<calendar>`, `year: ${calendar.year}`, `month: ${calendar.month}`, `current_day: ${calendar.currentDay}`, `days:`];
	for (const day of calendar.days) {
		const events = day.events.map((event) => `${event.title}${event.summary ? `：${event.summary}` : ""}`).join("；");
		lines.push(`  ${day.day}: ${events}`);
	}
	lines.push(`</calendar>`);
	return lines.join("\n");
}

/** 旧 rpCurtain 的 calendar 数据迁入原生展示；保留已生成日程，避免历史楼层被空投影覆盖。 */
export function parseLegacyCalendarSource(text: string): CalendarView | undefined {
	const match = text.match(/<calendar>\s*([\s\S]*?)\s*<\/calendar>/i);
	if (!match) return undefined;
	const body = match[1].replace(/：/g, ":");
	const value = (key: string) => Number(new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*(\\d+)`, "i").exec(body)?.[1]);
	const year = value("year"), month = value("month"), currentDay = value("current_day");
	if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return undefined;
	const count = new Date(year, month, 0).getDate();
	const eventsByDay = new Map<number, string>();
	for (const row of body.split(/\r?\n/)) {
		const found = /^\s*(\d{1,2})\s*:\s*(.*?)\s*$/.exec(row);
		if (!found) continue;
		const day = Number(found[1]);
		if (day >= 1 && day <= count && found[2]) eventsByDay.set(day, found[2]);
	}
	return {
		year,
		month,
		currentDay: currentDay >= 1 && currentDay <= count ? currentDay : 1,
		days: Array.from({ length: count }, (_, index) => {
			const day = index + 1;
			const summary = eventsByDay.get(day);
			const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
			return { day, weekday: new Date(year, month - 1, day).getDay(), current: day === currentDay, events: summary ? [{ id: `legacy-calendar:${year}-${month}-${day}`, title: summary, summary: "", source: "world" as const, sourceLabel: "历史日历", visibility: "public" as const, startDate: date, endDate: date, dayIndex: 1, days: 1, startsHere: true, endsHere: true }] : [] };
		}),
	};
}

export function serializeBbsSource(bbs: BbsView): string {
	const lines = [`<Small_theater>`, `<Output_content_self-check></Output_content_self-check>`, `APPname: ${bbs.appName}`, `title: ${bbs.title}`, ``];
	for (const post of bbs.posts) lines.push(`${post.author} [${post.avatar ?? ""}]${post.title ? ` (${post.title})` : ""}: ${post.body}`);
	lines.push(`</Small_theater>`);
	return lines.join("\n");
}
