type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: undefined;
}

/** Model-level compatibility overrides provider-level compatibility; unspecified defaults to supported. */
export function modelSupportsTools(model: Record<string, unknown> | undefined, providerCompat?: unknown): boolean {
	const modelValue = asRecord(model?.compat)?.supportsTools;
	if (typeof modelValue === "boolean") return modelValue;
	const providerValue = asRecord(providerCompat)?.supportsTools;
	return typeof providerValue === "boolean" ? providerValue : true;
}

/** Return a copied model entry with only compat.supportsTools changed. */
export function withModelToolsSupport<T extends Record<string, unknown>>(model: T, supportsTools: boolean): T {
	const compat = { ...(asRecord(model.compat) ?? {}), supportsTools };
	return { ...model, compat } as T;
}

/** Copy the config path down to one model, preserving every unrelated field and compat value. */
export function withConfigModelToolsSupport<T extends UnknownRecord>(
	config: T,
	providerName: string,
	modelId: string,
	supportsTools: boolean,
): T {
	const providers = asRecord(config.providers) ?? {};
	const provider = asRecord(providers[providerName]);
	if (!provider) throw new Error("当前模型渠道未在启用配置中，请先配置并启用该渠道");
	const models = Array.isArray(provider.models) ? provider.models : [];
	const index = models.findIndex((item) => asRecord(item) && String(asRecord(item)?.id) === modelId);
	const nextModels = [...models];
	if (index >= 0) {
		nextModels[index] = withModelToolsSupport(asRecord(nextModels[index]) ?? {}, supportsTools);
	} else {
		nextModels.push(withModelToolsSupport<Record<string, unknown>>({ id: modelId }, supportsTools));
	}

	return {
		...config,
		providers: {
			...providers,
			[providerName]: { ...provider, models: nextModels },
		},
	} as T;
}
