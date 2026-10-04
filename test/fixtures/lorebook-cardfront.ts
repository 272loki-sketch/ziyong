export const lorebookRegexScripts = [
	{
		scriptName: "贴吧前端2",
		findRegex: "/<Small_theater>\\s*([\\s\\S]*?)<\\/Small_theater>/g",
		replaceString: "```html\n<!DOCTYPE html>\n<html><body><div class=\"thread\">$1</div><script>const floorElement = document.createElement('div'); floorElement.className = 'floor';</script></body></html>\n```",
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
	},
	{
		scriptName: "替换表情",
		findRegex: "/\\[表情(\\d+)\\]/g",
		replaceString: "<img src=\"https://tb2.bdstatic.com/tb/editor/images/client/image_emoticon$1.png\">",
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
	},
	{
		scriptName: "小剧场",
		findRegex: "/<legacy_theater>([\\s\\S]*?)<\\/legacy_theater>/g",
		replaceString: "$1",
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
	},
	{
		scriptName: "日期（大小固定优化适配）",
		findRegex: "/<calendar>([\\s\\S]*?)<\\/calendar>/g",
		replaceString: "<time>$1</time>",
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
	},
] as const;

export const lorebookEntries = Object.fromEntries([
	...[4, 8, 9, 14, 15, 17, 112, 114, 116, 124, 127, 169, 172, 173, 174, 175, 178, 182, 233].map((uid) => [String(uid), { uid, enabled: false, disable: true }]),
	["280", { uid: 280, enabled: true, disable: false }],
	["281", { uid: 281, enabled: true, disable: false }],
	["282", { uid: 282, enabled: true, disable: false }],
]);
