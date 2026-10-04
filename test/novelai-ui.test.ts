import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("NovelAI UI：图片槽挂载后自动生成，并以全局队列保证开始间隔至少10秒", () => {
	const source = readFileSync("web/src/components/Messages.tsx", "utf8");
	assert.match(source, /NOVELAI_MIN_START_GAP_MS\s*=\s*10_000/);
	assert.match(source, /let novelAiQueue/);
	assert.match(source, /await enqueueNovelAi/);
	assert.match(source, /useEffect\(\(\) => \{[\s\S]*?apiGet<\{ src: string \| null \}>[\s\S]*?else if \(alive\) void generate\(\)/);
});
