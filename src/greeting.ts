/**
 * 开场白装配（角色卡能力，非生成流程）。
 *
 * 从旧 director.ts 抽出——director 整体已删除（harness 层重做，2026-08-02）。
 * 这里只负责：按 greetingIndex 从卡的开场白池取一条、跑宏替换、加标题。
 */

import { applyMacros } from "./card.ts";
import type { CharacterCard, RpConfig, WorldState } from "./types.ts";

/** 开场白正文（首条 firstMes 或用户选中的备选开场白；宏已替换） */
export function buildGreeting(card: CharacterCard, config: RpConfig): string {
	const pool = [card.firstMes, ...card.alternateGreetings];
	const idx = config.greetingIndex ?? 0;
	const mes = (idx >= 0 && idx < pool.length ? pool[idx] : "") || card.firstMes;
	return `【开场 · ${card.name}】\n${applyMacros(mes, { charName: card.name, userName: config.userName })}`;
}

/** 从卡作者开场白提取新会话的时间/地点基线；只认明确年月日。 */
export function initialStateFromGreeting(text: string): WorldState | null {
	const plain = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/【开场[^】]*】/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const date = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(plain);
	if (!date || date.index === undefined) return null;
	const afterDate = plain.slice(date.index + date[0].length);
	const time = /^\s*[,，、]?\s*((?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*\d{1,2}(?:[:：]\d{1,2}|点(?:\d{1,2}分)?)?)/.exec(afterDate)?.[1]?.replace(/\s+/g, "");
	const afterTime = time ? afterDate.slice(afterDate.indexOf(time) + time.length) : afterDate;
	const location = /^\s*[,，、]\s*([^。！？!?\n]{2,80})/.exec(afterTime)?.[1]?.trim().replace(/\s*>\s*/g, "::") ?? "";
	return {
		time: `${date[1]}年${Number(date[2])}月${Number(date[3])}日${time ? ` ${time}` : ""}`,
		location,
		characters: {},
		inventory: [],
		flags: {},
		plot_threads: [],
	};
}
