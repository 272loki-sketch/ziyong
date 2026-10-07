import type { GenerationMode } from "../generation-mode.ts";

const choices: Array<{ value: GenerationMode; label: string; title: string }> = [
	{
		value: "direct",
		label: "直出",
		title: "使用已有记忆与世界生态材料，由正常文学导演统筹、单主演直接输出；不新增生态备料、心理画像、脑暴或审稿。",
	},
	{
		value: "director",
		label: "导演",
		title: "固定专家团队与唯一主 writer：专家每拍必经三写前分析、两路构思候选、二审阅；专家不写正文，由主 writer 单独写作。",
	},
];

export function GenerationModeControl({
	value,
	onChange,
	compact = false,
}: {
	value: GenerationMode;
	onChange: (mode: GenerationMode) => void;
	compact?: boolean;
}) {
	return (
		<div
			className={`seg-row generation-mode-control ${compact ? "generation-mode-compact" : ""}`}
			role="radiogroup"
			aria-label="剧情生成模式"
		>
			{choices.map((choice) => (
				<button
					key={choice.value}
					type="button"
					className={`seg generation-mode-option ${value === choice.value ? "active" : ""}`}
					role="radio"
					aria-checked={value === choice.value}
					title={choice.title}
					onClick={() => onChange(choice.value)}
				>
					{choice.label}
				</button>
			))}
		</div>
	);
}
