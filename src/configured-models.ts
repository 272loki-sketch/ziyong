import type { LiyuanAgentConfig } from "./agent-config.ts";
/** A stored profile is not an enabled API. Never revive warehouse keys implicitly. */
export function configuredModels<T extends { provider?: string; id: string }>(models: T[], config: LiyuanAgentConfig): T[] {
	if (!Object.keys(config.providers).length) return models;
	const allowed = new Set(Object.entries(config.providers).flatMap(([provider,p]) => (p.models ?? []).map(m => `${provider}\0${typeof m === "string" ? m : m.id}`)));
	return models.filter(m => allowed.has(`${m.provider}\0${m.id}`));
}
