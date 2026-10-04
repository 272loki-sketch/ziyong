const MARKER = "// novel-play-api: deterministic integration marker";
const GUARD_MARKER = "// novel-play-api: config mutation guard";

function replaceExactlyOnce(source, anchor, replacement, label) {
	const first = source.indexOf(anchor);
	const last = source.lastIndexOf(anchor);
	if (first < 0) throw new Error(`server patch anchor absent: ${label}`);
	if (first !== last) throw new Error(`server patch anchor occurs multiple times: ${label}`);
	return `${source.slice(0, first)}${replacement}${source.slice(first + anchor.length)}`;
}

/** Deterministically adds the small REST import, authenticated delegate, and synchronous config mutation guard. */
export function apply(source) {
	if (typeof source !== "string") throw new TypeError("server source must be a string");
	let next = source;
	if (!next.includes(MARKER)) {
		next = replaceExactlyOnce(
			next,
			'import { basename, dirname, isAbsolute, join } from "node:path";\n',
			'import { basename, dirname, isAbsolute, join } from "node:path";\n\nimport { handleNovelPlayApiRequest, isNovelPlayStartLocked } from "./novel-play-api.ts";\n',
			"node:path import",
		);
		next = replaceExactlyOnce(
			next,
			"try {\n\t\tconst proposalRoute = /^POST \\/api\\/outline\\/proposals\\/([^/]+)\\/(confirm|reject)$/.exec(route);",
			`try {\n\t\t${MARKER}\n\t\tif (await handleNovelPlayApiRequest(req, res, host)) return true;\n\t\tconst proposalRoute = /^POST \\/api\\/outline\\/proposals\\/([^/]+)\\/(confirm|reject)$/.exec(route);`,
			"authenticated API delegate",
		);
	}
	if (!next.includes(GUARD_MARKER)) {
		next = replaceExactlyOnce(
			next,
			"try {\n\t\t// novel-play-api: deterministic integration marker\n\t\tif (await handleNovelPlayApiRequest(req, res, host)) return true;",
			`try {\n\t\t// novel-play-api: deterministic integration marker\n\t\t${GUARD_MARKER}\n\t\tconst novelPlayConfigMutation = route === "PUT /api/config" || route === "POST /api/card/switch";\n\t\tif (novelPlayConfigMutation && isNovelPlayStartLocked(host)) { sendJson(res, 409, { error: "小说开演启动期间不能修改角色或配置" }); return true; }\n\t\tif (await handleNovelPlayApiRequest(req, res, host)) return true;`,
			"start config mutation guard",
		);
	}
	return next;
}
