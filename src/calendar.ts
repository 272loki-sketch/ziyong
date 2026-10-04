import type { LiteraryEcologyState } from "./stage/literary-ecology.ts";
import type { ModularWorldState, WorldModuleRecord } from "./stage/literary-world-modular.ts";

export interface CalendarDate { year: number; month: number; day: number }
export interface CalendarMonthRef { year: number; month: number }
export interface CalendarDefinition {
	id: string;
	kind: "gregorian" | "fixed";
	era: string;
	months: Array<{ name: string; days: number }>;
	weekdays: string[];
	anchorDate: CalendarDate;
	anchorWeekday: number;
}
export interface CalendarEventData {
	id: string;
	title: string;
	summary: string;
	source: "world" | "ecology";
	sourceLabel: string;
	visibility: "public" | "discoverable";
}
export type CalendarEventSpec =
	| { recurrence: "none"; start: CalendarDate; end: CalendarDate; event: CalendarEventData }
	| { recurrence: "yearly"; start: { month: number; day: number }; end: { month: number; day: number }; event: CalendarEventData };
export interface CalendarEventView extends CalendarEventData {
	startDate: string;
	endDate: string;
	dayIndex: number;
	days: number;
	startsHere: boolean;
	endsHere: boolean;
}
export interface CalendarDayView { day: number; weekday: number; current: boolean; events: CalendarEventView[] }
export interface CalendarMonthView {
	year: number;
	month: number;
	monthName: string;
	weekdayNames: string[];
	currentDay: number | null;
	previous?: CalendarMonthRef;
	next?: CalendarMonthRef;
	days: CalendarDayView[];
}
export interface CalendarProjectionSource { definition: CalendarDefinition; currentDate: CalendarDate; events: CalendarEventSpec[] }

const GREGORIAN_MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const floorMod = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

export function defaultGregorianCalendar(): CalendarDefinition {
	return {
		id: "builtin:gregorian", kind: "gregorian", era: "",
		months: GREGORIAN_MONTHS.map((days, index) => ({ name: `${index + 1}月`, days })),
		weekdays: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
		anchorDate: { year: 1970, month: 1, day: 1 }, anchorWeekday: 4,
	};
}

const text = (value: unknown, max = 200): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const list = (value: unknown): string[] => Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];

export function parseCalendarDefinitionRecord(record: WorldModuleRecord): CalendarDefinition | null {
	const kind = record.attributes.calendarKind;
	if (kind !== "gregorian" && kind !== "fixed") return null;
	if (kind === "gregorian") return { ...defaultGregorianCalendar(), id: record.id, era: text(record.attributes.era) };
	const months = list(record.attributes.months).map((row) => {
		const match = /^(.*?)\|\s*(\d+)$/.exec(row);
		return match ? { name: match[1]!.trim(), days: Number(match[2]) } : null;
	});
	const weekdays = list(record.attributes.weekdays);
	if (!months.length || months.length > 60 || months.some((month) => !month?.name || month.days < 1 || month.days > 60) || months.reduce((sum, month) => sum + (month?.days ?? 0), 0) > 2000) return null;
	if (!weekdays.length || weekdays.length > 30) return null;
	const anchorDate = parseNumericDate(text(record.attributes.anchorDate)) ?? { year: 1, month: 1, day: 1 };
	const anchorWeekday = Number(record.attributes.anchorWeekday ?? 0);
	const definition: CalendarDefinition = { id: record.id, kind, era: text(record.attributes.era), months: months as Array<{ name: string; days: number }>, weekdays, anchorDate, anchorWeekday };
	if (!Number.isInteger(anchorWeekday) || anchorWeekday < 0 || anchorWeekday >= weekdays.length || !isValidCalendarDate(definition, anchorDate)) return null;
	return definition;
}

export function resolveCalendarDefinition(world: ModularWorldState): CalendarDefinition {
	const records = world.modules["institution-calendar"]?.records ?? [];
	const candidates = records.filter((record) => record.facet === "rule" && record.visibility !== "secret" && (record.attributes.calendarKind === "gregorian" || record.attributes.calendarKind === "fixed"))
		.sort((a, b) => Number(b.id === "calendar-definition") - Number(a.id === "calendar-definition") || b.updatedRound - a.updatedRound || a.id.localeCompare(b.id));
	for (const record of candidates) {
		const parsed = parseCalendarDefinitionRecord(record);
		if (parsed) return parsed;
	}
	return defaultGregorianCalendar();
}

const leap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
export function monthDays(definition: CalendarDefinition, year: number, month: number): number | null {
	if (!Number.isInteger(year) || year < 1 || !Number.isInteger(month) || month < 1 || month > definition.months.length) return null;
	if (definition.kind === "gregorian" && month === 2) return leap(year) ? 29 : 28;
	return definition.months[month - 1]?.days ?? null;
}
export function isValidCalendarDate(definition: CalendarDefinition, date: CalendarDate): boolean {
	const count = monthDays(definition, date.year, date.month);
	return !!count && Number.isInteger(date.day) && date.day >= 1 && date.day <= count;
}
function parseNumericDate(value: string): CalendarDate | null {
	const match = /^(\d{1,6})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?:日)?$/.exec(value.trim());
	return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}
export function parseNarrativeDate(value: string, definition = defaultGregorianCalendar()): CalendarDate | null {
	const numeric = /(\d{1,6})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?:日)?/.exec(value);
	if (numeric) {
		const date = { year: Number(numeric[1]), month: Number(numeric[2]), day: Number(numeric[3]) };
		return isValidCalendarDate(definition, date) ? date : null;
	}
	if (definition.kind === "fixed") {
		const escape = (source: string): string => source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const names = [...definition.months].sort((a, b) => b.name.length - a.name.length).map((month) => escape(month.name)).join("|");
		const era = definition.era ? `(?:${escape(definition.era)})?` : "";
		const named = new RegExp(`${era}(\\d{1,6})年(${names})(\\d{1,2})日`).exec(value);
		if (named) {
			const date = { year: Number(named[1]), month: definition.months.findIndex((month) => month.name === named[2]) + 1, day: Number(named[3]) };
			return isValidCalendarDate(definition, date) ? date : null;
		}
	}
	return null;
}

export function dateToOrdinal(definition: CalendarDefinition, date: CalendarDate): number | null {
	if (!isValidCalendarDate(definition, date)) return null;
	let beforeYear: number;
	if (definition.kind === "gregorian") {
		const y = date.year - 1;
		beforeYear = 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
	} else beforeYear = (date.year - 1) * definition.months.reduce((sum, month) => sum + month.days, 0);
	let beforeMonth = 0;
	for (let month = 1; month < date.month; month++) beforeMonth += monthDays(definition, date.year, month) ?? 0;
	return beforeYear + beforeMonth + date.day - 1;
}
export function ordinalToDate(definition: CalendarDefinition, ordinal: number): CalendarDate | null {
	if (!Number.isInteger(ordinal) || ordinal < 0) return null;
	let low = 1, high = Math.max(2, Math.ceil(ordinal / 300) + 2);
	while ((dateToOrdinal(definition, { year: high, month: 1, day: 1 }) ?? Infinity) <= ordinal) high *= 2;
	while (low < high) {
		const middle = Math.floor((low + high + 1) / 2);
		if ((dateToOrdinal(definition, { year: middle, month: 1, day: 1 }) ?? Infinity) <= ordinal) low = middle; else high = middle - 1;
	}
	let remaining = ordinal - (dateToOrdinal(definition, { year: low, month: 1, day: 1 }) ?? 0);
	let month = 1;
	while (remaining >= (monthDays(definition, low, month) ?? Infinity)) remaining -= monthDays(definition, low, month++) ?? 0;
	return { year: low, month, day: remaining + 1 };
}
export function addCalendarDays(definition: CalendarDefinition, date: CalendarDate, delta: number): CalendarDate | null {
	const ordinal = dateToOrdinal(definition, date);
	return ordinal === null ? null : ordinalToDate(definition, ordinal + Math.trunc(delta));
}
export function weekdayOf(definition: CalendarDefinition, date: CalendarDate): number | null {
	const value = dateToOrdinal(definition, date), anchor = dateToOrdinal(definition, definition.anchorDate);
	return value === null || anchor === null ? null : floorMod(definition.anchorWeekday + value - anchor, definition.weekdays.length);
}
export function shiftCalendarMonth(definition: CalendarDefinition, cursor: CalendarMonthRef, delta: number): CalendarMonthRef | null {
	if (cursor.year < 1 || cursor.month < 1 || cursor.month > definition.months.length) return null;
	const absolute = (cursor.year - 1) * definition.months.length + cursor.month - 1 + Math.trunc(delta);
	if (absolute < 0) return null;
	return { year: Math.floor(absolute / definition.months.length) + 1, month: floorMod(absolute, definition.months.length) + 1 };
}
const formatDate = (date: CalendarDate): string => `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
function parseEventPoint(value: unknown, definition: CalendarDefinition, currentYear: number): CalendarDate | { month: number; day: number } | null {
	const source = text(value);
	const full = parseNarrativeDate(source, definition);
	if (full) return full;
	const short = /^(\d{1,2})[-/.月](\d{1,2})(?:日)?$/.exec(source);
	if (!short) return null;
	const candidate = { year: definition.kind === "gregorian" ? 2000 : currentYear, month: Number(short[1]), day: Number(short[2]) };
	return isValidCalendarDate(definition, candidate) ? { month: candidate.month, day: candidate.day } : null;
}
export function normalizeCalendarEvents(world: ModularWorldState, ecology: LiteraryEcologyState, definition: CalendarDefinition, currentDate: CalendarDate): CalendarEventSpec[] {
	const specs: CalendarEventSpec[] = [];
	for (const module of Object.values(world.modules)) for (const record of module.records) {
		if (record.visibility === "secret" || (record.facet === "rule" && record.attributes.calendarKind)) continue;
		const start = parseEventPoint(record.attributes.date, definition, currentDate.year);
		if (!start) continue;
		const yearly = record.attributes.recurrence === "yearly";
		const end = parseEventPoint(record.attributes.end, definition, currentDate.year) ?? start;
		const event: CalendarEventData = { id: `${module.id}:${record.id}`, title: record.label, summary: record.summary, source: "world", sourceLabel: module.id === "institution-calendar" ? "制度日历" : "世界", visibility: record.visibility === "public" ? "public" : "discoverable" };
		if (yearly) specs.push({ recurrence: "yearly", start: { month: start.month, day: start.day }, end: { month: end.month, day: end.day }, event });
		else if ("year" in start && typeof start.year === "number" && "year" in end && typeof end.year === "number") specs.push({ recurrence: "none", start: start as CalendarDate, end: end as CalendarDate, event });
	}
	for (const occurrence of ecology.occurrences) {
		if (occurrence.visibility === "secret" || !["scheduled", "active"].includes(occurrence.status)) continue;
		const start = parseEventPoint(occurrence.time, definition, currentDate.year);
		if (!start || !("year" in start)) continue;
		const endPoint = parseEventPoint(occurrence.expires, definition, currentDate.year);
		const end = endPoint && "year" in endPoint ? endPoint : start;
		specs.push({ recurrence: "none", start, end, event: { id: `ecology:${occurrence.id}`, title: occurrence.name, summary: occurrence.development, source: "ecology", sourceLabel: "人物生态", visibility: occurrence.visibility === "public" ? "public" : "discoverable" } });
	}
	return specs.slice(0, 160);
}
function coverage(spec: CalendarEventSpec, date: CalendarDate, definition: CalendarDefinition): { start: CalendarDate; end: CalendarDate; dayIndex: number; days: number } | null {
	const target = dateToOrdinal(definition, date); if (target === null) return null;
	const candidates = spec.recurrence === "none" ? [{ start: spec.start, end: spec.end }] : [date.year - 1, date.year, date.year + 1].flatMap((year) => {
		const start = { year, ...spec.start };
		if (!isValidCalendarDate(definition, start)) return [];
		let endYear = year;
		if (spec.end.month < spec.start.month || (spec.end.month === spec.start.month && spec.end.day < spec.start.day)) endYear++;
		const end = { year: endYear, ...spec.end };
		return isValidCalendarDate(definition, end) ? [{ start, end }] : [];
	});
	for (const row of candidates) {
		const start = dateToOrdinal(definition, row.start), end = dateToOrdinal(definition, row.end);
		if (start !== null && end !== null && target >= start && target <= end) return { start: row.start, end: row.end, dayIndex: target - start + 1, days: end - start + 1 };
	}
	return null;
}
export function projectCalendarMonth(source: CalendarProjectionSource, cursor: CalendarMonthRef): CalendarMonthView | null {
	const count = monthDays(source.definition, cursor.year, cursor.month);
	const previous = shiftCalendarMonth(source.definition, cursor, -1), next = shiftCalendarMonth(source.definition, cursor, 1);
	if (!count) return null;
	const currentDay = source.currentDate.year === cursor.year && source.currentDate.month === cursor.month ? source.currentDate.day : null;
	const days = Array.from({ length: count }, (_, index): CalendarDayView => {
		const date = { year: cursor.year, month: cursor.month, day: index + 1 };
		const events = source.events.flatMap((spec): CalendarEventView[] => {
			const hit = coverage(spec, date, source.definition); if (!hit) return [];
			return [{ ...spec.event, startDate: formatDate(hit.start), endDate: formatDate(hit.end), dayIndex: hit.dayIndex, days: hit.days, startsHere: hit.dayIndex === 1, endsHere: hit.dayIndex === hit.days }];
		});
		return { day: date.day, weekday: weekdayOf(source.definition, date) ?? 0, current: date.day === currentDay, events };
	});
	return { year: cursor.year, month: cursor.month, monthName: source.definition.months[cursor.month - 1]?.name ?? `${cursor.month}月`, weekdayNames: source.definition.weekdays, currentDay, ...(previous ? { previous } : {}), ...(next ? { next } : {}), days };
}
export function buildCalendarProjection(time: string, world: ModularWorldState, ecology: LiteraryEcologyState): CalendarProjectionSource | null {
	const definition = resolveCalendarDefinition(world);
	const currentDate = parseNarrativeDate(time, definition);
	return currentDate ? { definition, currentDate, events: normalizeCalendarEvents(world, ecology, definition, currentDate) } : null;
}
