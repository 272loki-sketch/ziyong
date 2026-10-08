/**
 * Native worldbook host protocol, not a second memory/recall algorithm.
 * AM selection and the final user-input template belong to the unchanged plugin.
 * This adapter only activates ordinary worldbook keys and honours their placement.
 */
export interface DatabasePluginWorldbookEntry {
 uid?: number;
 comment?: string;
 content: string;
 enabled?: boolean;
 disable?: boolean;
 type?: string;
 constant?: boolean;
 keys?: string[];
 key?: string[];
 keys_secondary?: string[];
 keysecondary?: string[];
 selective?: boolean;
 selective_logic?: number | string;
 position?: string | number;
 depth?: number;
 role?: number | string;
 order?: number;
 scan_depth?: number | null;
 case_sensitive?: boolean | null;
 match_whole_words?: boolean | null;
 exclude_recursion?: boolean;
 prevent_recursion?: boolean;
}
export interface DatabasePluginPreparedPrompt {
 /** Exact final input passed by the original generate interceptor to its host. */
 userInput: string;
 /** Unmodified native entries; disabled indexes are not an alternative recall source. */
 worldbookEntries: DatabasePluginWorldbookEntry[];
}
export function selectDatabasePluginWorldbookEntries(entries: DatabasePluginWorldbookEntry[], history: string[], userInput: string): DatabasePluginWorldbookEntry[] {
 const active = new Set<DatabasePluginWorldbookEntry>();
 const recursive: string[] = [];
 const keyMatches = (key: string, text: string, entry: DatabasePluginWorldbookEntry) => {
  if (!key) return false;
  if (key.startsWith('/') && /^\/.+\/[dgimsuvy]*$/.test(key)) {
   const end = key.lastIndexOf('/');
   try { return new RegExp(key.slice(1, end), key.slice(end + 1)).test(text); } catch { return false; }
  }
  const source = entry.case_sensitive ? text : text.toLocaleLowerCase();
  const needle = entry.case_sensitive ? key : key.toLocaleLowerCase();
  if (entry.match_whole_words !== false && /^[\w -]+$/.test(needle)) {
   const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`).test(source);
  }
  return source.includes(needle);
 };
 const hasKeys = (entry: DatabasePluginWorldbookEntry, text: string) => {
  const primary = entry.keys ?? entry.key ?? [];
  if (!primary.some(key => keyMatches(key, text, entry))) return false;
  const secondary = entry.keys_secondary ?? entry.keysecondary ?? [];
  if (!secondary.length || entry.selective === false) return true;
  const matches = secondary.map(key => keyMatches(key, text, entry));
  switch (entry.selective_logic) {
   case 1: case 'NOT_ALL': return !matches.every(Boolean);
   case 2: case 'NOT_ANY': return !matches.some(Boolean);
   case 3: case 'AND_ALL': return matches.every(Boolean);
   default: return matches.some(Boolean);
  }
 };
 // Native recursion only. In particular, never read an enabled:false index to
 // manufacture AM codes, nor select records by their table/comment names.
 for (let pass = 0; pass <= entries.length; pass++) {
  const additions: DatabasePluginWorldbookEntry[] = [];
  for (const entry of entries) {
   if (active.has(entry) || entry.enabled === false || entry.disable === true || !entry.content) continue;
   const depth = Number.isFinite(entry.scan_depth) ? Math.max(0, Number(entry.scan_depth)) : 2;
   const recent = depth > 1 ? history.slice(-(depth - 1)) : [];
   const text = [...recent, userInput].join('\n');
   const constant = entry.type === 'constant' || entry.constant === true;
   if (!constant && !hasKeys(entry, text) && (entry.exclude_recursion || !hasKeys(entry, recursive.join('\n')))) continue;
   active.add(entry); additions.push(entry);
  }
  if (!additions.length) break;
  recursive.push(...additions.filter(entry => !entry.prevent_recursion).map(entry => entry.content));
 }
 return entries.filter(entry => active.has(entry)).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}
export function databasePluginWorldbookParts(entries: DatabasePluginWorldbookEntry[]) {
 const before: string[] = [], after: string[] = [];
 const depthEntries: DatabasePluginWorldbookEntry[] = [];
 for (const entry of entries) {
  const position = entry.position ?? 'before_character_definition';
  if (position === 0 || ['0', 'before_char', 'before_character', 'before_character_definition'].includes(String(position))) before.push(entry.content);
  else if (position === 1 || ['1', 'after_char', 'after_character', 'after_character_definition'].includes(String(position))) after.push(entry.content);
  else if (position === 4 || ['4', 'at_depth_as_system', 'at_depth_as_user', 'at_depth_as_assistant', 'at_depth'].includes(String(position))) depthEntries.push(entry);
  else throw new Error(`数据库世界书投送位置尚未适配：${String(position)}；拒绝擅自改位`);
 }
 return { before: before.join('\n\n'), after: after.join('\n\n'), depthEntries };
}
/** Inject a native depth/role group without changing any existing message. */
export function insertDatabasePluginDepthEntries(messages: unknown[], entries: DatabasePluginWorldbookEntry[]): unknown[] {
 const groups = new Map<string, { depth: number; role: string; entries: DatabasePluginWorldbookEntry[] }>();
 for (const entry of entries) {
  const depth = Math.max(0, Math.trunc(Number(entry.depth) || 0));
  const role = entry.position === 'at_depth_as_user' || entry.role === 'user' || entry.role === 1 ? 'user'
   : entry.position === 'at_depth_as_assistant' || entry.role === 'assistant' || entry.role === 2 ? 'assistant' : 'system';
  const key = `${depth}:${role}`;
  if (!groups.has(key)) groups.set(key, { depth, role, entries: [] });
  groups.get(key)!.entries.push(entry);
 }
 // Compute all positions against the original history (not already inserted
 // worldbook messages), so different role/depth groups cannot move each other.
 const insertions = new Map<number, unknown[]>();
 const roleOrder = {system:0,user:1,assistant:2} as Record<string,number>;
 for (const group of [...groups.values()].sort((a,b)=>b.depth-a.depth || roleOrder[a.role]-roleOrder[b.role])) {
  const at = Math.max(0, messages.length - group.depth);
  const message = { role: group.role, content: [{ type: 'text', text: group.entries.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)).map(entry => entry.content).join('\n\n') }], timestamp: 0 };
  if (!insertions.has(at)) insertions.set(at, []);
  insertions.get(at)!.push(message);
 }
 const result: unknown[] = [];
 for (let i = 0; i <= messages.length; i++) {
  result.push(...(insertions.get(i) ?? []));
  if (i < messages.length) result.push(messages[i]);
 }
 return result;
}

/** Honour existing preset worldInfo/character markers instead of moving their
 * contents around. Only unrepresented slots use the ordinary card fallback. */
export function placeDatabasePluginCharacterEntries(pieces: Array<{source: string; id: string; text: string}>, worldbook: {before: string; after: string}) {
 const result = pieces.map(piece => ({...piece}));
 const remaining = {...worldbook};
 for (const side of ['before', 'after'] as const) {
  if (!remaining[side]) continue;
  const marker = side === 'before' ? 'worldInfoBefore' : 'worldInfoAfter';
  let at = result.findIndex(piece => piece.source === 'marker' && piece.id === marker);
  if (at >= 0) { result[at].text += '\n\n' + remaining[side]; remaining[side] = ''; continue; }
  const characterMarkers = ['charDescription', 'charPersonality', 'scenario', 'dialogueExamples'];
  const positions = result.flatMap((piece, index) => piece.source === 'marker' && characterMarkers.includes(piece.id) ? [index] : []);
  if (!positions.length) continue;
  at = side === 'before' ? positions[0] : positions.at(-1)! + 1;
  result.splice(at, 0, {source: 'marker', id: marker, text: remaining[side]}); remaining[side] = '';
 }
 return {presetBefore: result.map(piece => piece.text), remaining};
}
