import type { WorldState } from "../types.ts";
import type { LiteraryEcologyState } from "./literary-ecology.ts";
import type { PlotAdaptation } from "./plot-adaptation.ts";

export type PresenceKind = "onstage" | "nearby" | "offstage";
export interface PresenceResolution { onstage: string[]; nearby: string[]; offstage: string[]; reasons: Record<string, string[]>; }

const norm = (value: string) => value.trim().toLocaleLowerCase();
const hasName = (text: string, name: string) => name.length > 1 && text.includes(name);
const unique = (items: string[]) => [...new Set(items.filter(Boolean))];

/** Deterministic, conservative scene roster. It never creates a character; uncertainty stays nearby. */
export function resolvePresence(input: { state: WorldState; cardName: string; userName: string; userText: string; recentText: string; ecology: LiteraryEcologyState; plot?: PlotAdaptation }): PresenceResolution {
	const names = unique([input.cardName, ...Object.keys(input.state.characters)]).filter((name) => norm(name) !== norm(input.userName));
	const evidence = `${input.userText}\n${input.recentText}`;
	const onstage = new Set<string>(input.cardName ? [input.cardName] : []);
	const nearby = new Set<string>();
	const reasons: Record<string, string[]> = {};
	const note = (name: string, reason: string) => { (reasons[name] ??= []).push(reason); };
	for (const name of names) {
		const character = input.state.characters[name];
		const actor = input.ecology.actors.find((row) => norm(row.name) === norm(name));
		const mentioned = hasName(evidence, name);
		const localActor = !!actor && !!input.state.location && actor.location === input.state.location;
		const activeOccurrence = input.ecology.occurrences.some((row) => row.status === "active" && row.location === input.state.location && row.participants.some((p) => norm(p) === norm(name)));
		const statusHere = !!character && /在场|身边|同处|同行|当前地点/.test(`${character.status} ${character.notes}`);
		const selected = input.plot?.selected?.involvedCharacters.some((p) => norm(p) === norm(name)) ?? false;
		if (name === input.cardName || mentioned || localActor || activeOccurrence || statusHere) {
			onstage.add(name);
			if (mentioned) note(name, "近期正文或用户输入点名");
			if (localActor || activeOccurrence || statusHere) note(name, "有当前地点的在场证据");
		} else if (selected || actor?.tier === "active") {
			nearby.add(name); note(name, selected ? "本拍候选涉及" : "生态活跃人物");
		}
	}
	for (const name of onstage) nearby.delete(name);
	return { onstage: [...onstage], nearby: [...nearby], offstage: names.filter((name) => !onstage.has(name) && !nearby.has(name)), reasons };
}
