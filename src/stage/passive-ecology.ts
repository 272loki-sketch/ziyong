/** 已生成生态素材的只读投影；不调用模型、不推进状态、不带旧主权/停点规则。 */
import type { EcologyCardPool, EcologyGlobalPool, LiteraryEcologyState } from "./literary-ecology.ts";
import type { WorldState } from "../types.ts";
import { selectRelevantEcologyRows } from "./plot-adaptation.ts";
import type { BeatMsg } from "./assemble.ts";
export function existingEcologyReference(input: { cardPool: EcologyCardPool; globalPool: EcologyGlobalPool; ecology: LiteraryEcologyState; state: WorldState; history: BeatMsg[]; userText: string }): string | undefined {
	const active = input.cardPool.templates.filter(x => x.status === "active");
	const chosen = selectRelevantEcologyRows(active, { ...input, outline: { revision: 0, hash: "", premise: "", currentFocus: [], collections: {} } }, 3);
	if (!chosen.length) return undefined;
	return JSON.stringify({ kind: "existing-candidates-not-facts", materials: chosen.map(x => ({ name: x.name, form: x.form, locations: x.locations, likelyActors: x.likelyActors, possibleDevelopments: x.possibleDevelopments })) }, null, 2).slice(0, 5000);
}
