import type { LiteraryEcologyState } from "./literary-ecology.ts";
import type { ModularWorldState, WorldDomainRef, WorldVisibility } from "./literary-world-modular.ts";

export interface CrossDomainSignal {
	source: "world" | "ecology";
	sourceRound: number;
	ref: WorldDomainRef;
	kind: string;
	visibility: WorldVisibility;
	summary: string;
}

export function ecologySignalsForWorld(ecology: LiteraryEcologyState): CrossDomainSignal[] {
	return ecology.occurrences.filter((item) => (item.status === "active" || item.status === "scheduled") && (item.visibility !== "secret" || item.publicSurface?.publicity === "trace" || item.publicSurface?.publicity === "public")).slice(0, 20).map((item) => {
		const surface = item.publicSurface;
		const summary = surface?.publicity === "trace"
			? `${item.name}@${item.location || "地点未定"}：${surface.trace}`
			: surface?.publicity === "public"
				? `${surface.headline || item.name}@${item.location || "地点未定"}：${surface.summary || surface.trace}`
				: `${item.name}@${item.location || "地点未定"}：${item.development}`;
		const visibility = surface?.publicity === "trace" || surface?.publicity === "public" ? "public" : item.visibility === "public" ? "public" : item.visibility === "secret" ? "secret" : "discoverable";
		return { source: "ecology", sourceRound: ecology.round, ref: { domain: "ecology", recordId: item.id }, kind: surface?.publicity === "trace" ? "public-trace" : item.kind, visibility, summary };
	});
}

export function worldSignalsForEcology(world: ModularWorldState): CrossDomainSignal[] {
	return Object.values(world.modules).flatMap((module) => module.records.filter((record) => record.visibility !== "secret").map((record) => {
		const schedule = [record.attributes.date, record.attributes.time, record.attributes.deadline, record.attributes.location].filter((value) => typeof value === "string" && value.trim()).join(" / ");
		return { source: "world" as const, sourceRound: world.round, ref: { domain: "world" as const, moduleId: module.id, recordId: record.id }, kind: record.facet, visibility: record.visibility, summary: `${record.label}（${record.status || "持续中"}）：${record.summary}${schedule ? `［${schedule}］` : ""}` };
	})).slice(0, 30);
}
