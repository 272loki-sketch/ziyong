import type { ModelInfo, ModelRef, ModelsResponse } from "../api.ts";

const keyOf = (model: ModelRef): string => `${encodeURIComponent(model.provider)}:${encodeURIComponent(model.id)}`;

export function ModelPlugSelector({ label, value, models, onChange, inheritLabel = "继承总插头", disabled = false }: {
	label: string;
	value: ModelRef | null;
	models: ModelsResponse | null;
	onChange: (value: ModelRef | null) => void;
	inheritLabel?: string;
	disabled?: boolean;
}) {
	const current = models?.current;
	const selectedKey = value ? keyOf(value) : "";
	const available = models?.models ?? [];
	const groups = new Map<string, ModelInfo[]>();
	for (const model of available) {
		const items = groups.get(model.providerName) ?? [];
		items.push(model);
		groups.set(model.providerName, items);
	}
	const missing = models !== null && value && !available.some((model) => model.provider === value.provider && model.id === value.id);
	const id = `model-plug-${label.replace(/\W+/g, "-")}`;
	return (
		<div className="field-group">
			<label className="field-label" htmlFor={id}>{label}</label>
			<select id={id} disabled={disabled} className="field-input" value={selectedKey} onChange={(event) => {
				if (!event.target.value) return onChange(null);
				const model = available.find((item) => keyOf(item) === event.target.value);
				if (model) onChange({ provider: model.provider, id: model.id });
			}}>
				<option value="">{inheritLabel}{current ? `（${current.name || current.id}）` : ""}</option>
				{missing && <option value={selectedKey}>已失效：{value.provider}/{value.id}</option>}
				{[...groups].map(([providerName, items]) => (
					<optgroup key={providerName} label={providerName}>
						{items.map((model) => <option key={keyOf(model)} value={keyOf(model)}>{model.name || model.id}</option>)}
					</optgroup>
				))}
			</select>
		</div>
	);
}
