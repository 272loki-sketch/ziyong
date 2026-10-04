import { readFileSync, writeFileSync } from "node:fs";

const MARKER = "novel-play-runtime-integration-v2";
const replacements = [
	['from "../novel-play/runtime.ts"; // novel-play-runtime-integration-v1', 'from "../novel-play/runtime.ts"; // novel-play-runtime-integration-v2'],
	['\tsceneConductor?: SceneConductor;\n\tnovelProjection?: NovelPlayProjection;\n}', '\tsceneConductor?: SceneConductor;\n}'],
	['\t\tlet novelProjection = rerollPrep?.novelProjection;\n\t\tlet preparedNovelPlay: PreparedNovelPlayTurn | undefined;', '\t\tlet novelProjection: NovelPlayProjection | undefined;\n\t\tlet preparedNovelPlay: PreparedNovelPlayTurn | undefined;'],
	['\t\t\t\t\t...(sceneConductor ? { sceneConductor } : {}),\n\t\t\t\t\t...(novelProjection ? { novelProjection } : {}),', '\t\t\t\t\t...(sceneConductor ? { sceneConductor } : {}),'],
	['\t\t\tif (userText !== null) {', '\t\t\tif (!aborted && userText !== null) {'],
];

function occurrenceCount(source, snippet) {
	let count = 0, from = 0;
	while ((from = source.indexOf(snippet, from)) >= 0) { count++; from += snippet.length; }
	return count;
}
function assertExactlyOnce(source, snippet, phase) {
	const count = occurrenceCount(source, snippet);
	if (count === 0) throw new Error(`engine patch snippet missing (${phase}): ${snippet.slice(0, 100)}`);
	if (count !== 1) throw new Error(`engine patch snippet ambiguous (${phase}): ${snippet.slice(0, 100)}`);
}
function assertApplied(source) {
	for (const [, after] of replacements) assertExactlyOnce(source, after, "applied");
	if (source.includes("rerollPrep?.novelProjection") || source.includes("...(novelProjection ? { novelProjection } : {})")) throw new Error("director-only novel projection remains serialized in rpPrep");
}
export function apply(source) {
	if (typeof source !== "string") throw new TypeError("engine source must be a string");
	if (source.includes(MARKER)) { assertApplied(source); return source; }
	let next = source;
	for (const [before, after] of replacements) {
		assertExactlyOnce(next, before, "source");
		next = next.replace(before, after);
	}
	if (!next.includes(MARKER)) throw new Error("engine patch marker was not installed");
	assertApplied(next);
	return next;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (process.env.GITHUB_REF_NAME !== "feat/novel-play-foundation") throw new Error("refusing to patch outside feat/novel-play-foundation");
	const file = "src/stage/engine.ts", source = readFileSync(file, "utf8"), next = apply(source);
	if (next !== source) writeFileSync(file, next, "utf8");
}
