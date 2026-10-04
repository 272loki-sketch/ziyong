/**
 * 从助手回复/交回摘要中抓取本机媒体路径（生图/录音后常只写路径、忘调 show_media）。
 * 仅匹配带常见媒体扩展名的本机路径；不把 http(s) 当本地文件。
 */

const MEDIA_EXT = String.raw`png|jpe?g|webp|gif|avif|bmp|mp3|wav|ogg|m4a|aac|flac|mp4|webm|mov|m4v|mkv`;

/** Windows `C:\…\a.png` / `C:/…/a.png` */
const WIN_ABS = new RegExp(
	String.raw`[A-Za-z]:[/\\][^\s"'|<>\r\n*]+\.(?:${MEDIA_EXT})`,
	"gi",
);

/**
 * Unix 绝对路径：限常见根前缀，避免误吃 URL 路径段。
 * 例：`/home/u/a.png`、`/tmp/out.webp`、`/Users/x/a.png`
 */
const UNIX_ABS = new RegExp(
	String.raw`/(?:home|Users|tmp|var|opt|data|root|mnt|media|private|Volumes)(?:/[^\s"'|<>\r\n*]*)+\.(?:${MEDIA_EXT})`,
	"gi",
);

function normalizePath(p: string): string {
	return p.replace(/[，。,.；;）)】\]]+$/g, "");
}

function isPlausibleLocalPath(p: string): boolean {
	if (!p || p.includes("://")) return false;
	if (/^https?:/i.test(p)) return false;
	// 拒绝 `s://x.com/a.png` 一类残骸
	if (p.includes("://") || /^[a-z]:\/\//i.test(p)) return false;
	return true;
}

/** 去重、保序；避免 `C:/tmp/a.png` 再被 `/tmp/a.png` 拆出一条 */
export function harvestLocalMediaPaths(text: string): string[] {
	if (!text || typeof text !== "string") return [];
	// 先抹掉 URL，避免 Unix 规则误匹配
	const scrubbed = text.replace(/https?:\/\/[^\s"'|<>\r\n]+/gi, " ");
	const found: string[] = [];
	const seen = new Set<string>();
	const covered: Array<{ start: number; end: number }> = [];

	const tryAdd = (raw: string, start: number, end: number) => {
		const path = normalizePath(raw);
		if (!isPlausibleLocalPath(path)) return;
		if (covered.some((c) => start >= c.start && end <= c.end)) return;
		const key = path.toLowerCase();
		if (seen.has(key)) return;
		// 若已有更长路径包含本路径（Windows 吞掉子串），跳过
		if (found.some((f) => f.toLowerCase().includes(key) && f.length > path.length)) return;
		seen.add(key);
		found.push(path);
		covered.push({ start, end });
	};

	for (const re of [WIN_ABS, UNIX_ABS]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(scrubbed)) !== null) {
			tryAdd(m[0], m.index, m.index + m[0].length);
		}
	}
	return found;
}
