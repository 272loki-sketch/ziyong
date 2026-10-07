import { chmodSync, constants, lstatSync, mkdirSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

export const DATABASE_PLUGIN_STORE_DIRECTORY = ".liyuan-database-plugin";
export const DATABASE_PLUGIN_MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STATE_HEAD_FILE = "state-head.json";
const STATE_SNAPSHOTS_DIRECTORY = "state-snapshots";
const OBJECTS_DIRECTORY = "objects";
const LOCK_DIRECTORY = ".state-lock";
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 10;
const ALLOWED_MESSAGE_EXTENSION_KEY = /^TavernDB_[A-Za-z0-9_]+$/;
const FORBIDDEN_STATE_KEYS = new Set([
	"mes",
	"thinking",
	"rpnarrative",
	"rpauthordraft",
	"rawstory",
	"raw_story",
	"storytext",
]);

export interface DatabasePluginScope {
	sessionId: string;
	card?: string;
}

export type DatabasePluginJsonPrimitive = string | number | boolean | null;
export type DatabasePluginJsonValue =
	| DatabasePluginJsonPrimitive
	| DatabasePluginJsonValue[]
	| { [key: string]: DatabasePluginJsonValue };

/** Host state is intentionally generic JSON; message bodies are not part of this contract. */
export interface DatabasePluginHostState {
	chatMetadata: Record<string, DatabasePluginJsonValue>;
	extensionSettings: Record<string, DatabasePluginJsonValue>;
	messages: Record<string, Record<string, DatabasePluginJsonValue>>;
	worldbooks: Record<string, { entries: DatabasePluginJsonValue[] }>;
}

export interface DatabasePluginStateSnapshot {
	revision: number;
	sourceEntryId?: string;
	state: DatabasePluginHostState;
	createdAt: string;
}

export interface DatabasePluginStateReadResult {
	snapshot: DatabasePluginStateSnapshot | null;
	/** Revision of the newest snapshot visible from the supplied ancestor set; 0 means none. */
	visibleRevision: number;
	/** Latest committed revision across the whole session/card scope. */
	globalRevision: number;
}

export interface DatabasePluginStateWriteResult {
	snapshot: DatabasePluginStateSnapshot;
	visibleRevision: number;
	globalRevision: number;
}

export interface DatabasePluginFileResult {
	name: string;
	path: string;
	sha256: string;
	size: number;
}

export interface DatabasePluginFileContent extends DatabasePluginFileResult {
	data: Buffer;
}

export class DatabasePluginStoreError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DatabasePluginStoreError";
		this.code = code;
	}
}

export class DatabasePluginStoreConflictError extends DatabasePluginStoreError {
	readonly expectedRevision: number;
	readonly actualRevision: number;

	constructor(expectedRevision: number, actualRevision: number) {
		super(
			"revision_conflict",
			`Database plugin state revision conflict (expected ${expectedRevision}, actual ${actualRevision}).`,
		);
		this.name = "DatabasePluginStoreConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export class DatabasePluginStoreValidationError extends DatabasePluginStoreError {
	constructor(message: string) {
		super("invalid_input", message);
		this.name = "DatabasePluginStoreValidationError";
	}
}

export class DatabasePluginStoreBusyError extends DatabasePluginStoreError {
	constructor() {
		super("scope_busy", "Database plugin state scope is locked; retry after the active writer finishes.");
		this.name = "DatabasePluginStoreBusyError";
	}
}

interface StateHeadEntry {
	revision: number;
	file: string;
	sourceEntryId: string | null;
}

interface StateHead {
	version: 1;
	globalRevision: number;
	snapshots: StateHeadEntry[];
}

interface PersistedSnapshot {
	version: 1;
	revision: number;
	sourceEntryId: string | null;
	createdAt: string;
	state: DatabasePluginHostState;
}

function failValidation(message: string): never {
	throw new DatabasePluginStoreValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validateNonEmptyIdentifier(value: unknown, label: string, maxLength = 2048): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
		failValidation(`${label} must be a non-empty string without control characters (max ${maxLength}).`);
	}
	return value;
}

function normalizeScope(scope: DatabasePluginScope): { sessionId: string; card?: string; key: string } {
	if (!isRecord(scope)) failValidation("scope must be an object.");
	const sessionId = validateNonEmptyIdentifier(scope.sessionId, "scope.sessionId");
	let card: string | undefined;
	if (scope.card !== undefined) card = validateNonEmptyIdentifier(scope.card, "scope.card");
	const canonical = JSON.stringify({ sessionId, card: card ?? null });
	return { sessionId, card, key: createHash("sha256").update(canonical).digest("hex") };
}

function validateSourceEntryId(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	return validateNonEmptyIdentifier(value, "sourceEntryId");
}

function assertJsonValue(value: unknown, ancestors = new WeakSet<object>(), at = "state", depth = 0): asserts value is DatabasePluginJsonValue {
	if (depth > 128) failValidation(`${at} exceeds the maximum JSON nesting depth.`);
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) failValidation(`${at} contains a non-finite number.`);
		return;
	}
	if (typeof value !== "object") failValidation(`${at} is not JSON-serializable.`);
	if (ancestors.has(value)) failValidation(`${at} contains a circular reference.`);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (const key of Reflect.ownKeys(value)) {
				if (key === "length") continue;
				if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
					failValidation(`${at} contains an unsupported array property.`);
				}
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) {
					failValidation(`${at}[${key}] is not a plain JSON array item.`);
				}
			}
			for (let index = 0; index < value.length; index++) {
				if (!Object.prototype.hasOwnProperty.call(value, index)) failValidation(`${at} contains an array hole.`);
				assertJsonValue(value[index], ancestors, `${at}[${index}]`, depth + 1);
			}
			return;
		}
		if (!isRecord(value)) failValidation(`${at} must contain only plain JSON objects and arrays.`);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") failValidation(`${at} contains a symbol key.`);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				failValidation(`${at}.${key} is not a plain enumerable JSON field.`);
			}
			if (key === "__proto__" || key === "prototype" || key === "constructor") {
				failValidation(`${at}.${key} is a forbidden object key.`);
			}
			if (FORBIDDEN_STATE_KEYS.has(key.toLowerCase())) {
				failValidation(`${at}.${key} is forbidden in database-plugin snapshots.`);
			}
			assertJsonValue(descriptor.value, ancestors, `${at}.${key}`, depth + 1);
		}
	} finally {
		ancestors.delete(value);
	}
}

function validateHostState(input: unknown): DatabasePluginHostState {
	if (!isRecord(input)) failValidation("state must be a plain object.");
	const required = ["chatMetadata", "extensionSettings", "messages", "worldbooks"] as const;
	for (const key of required) {
		if (!Object.prototype.hasOwnProperty.call(input, key)) failValidation(`state.${key} is required.`);
	}
	for (const key of Object.keys(input)) {
		if (!required.includes(key as (typeof required)[number])) failValidation(`state.${key} is not a supported top-level field.`);
	}
	assertJsonValue(input);
	for (const key of ["chatMetadata", "extensionSettings", "messages", "worldbooks"] as const) {
		if (!isRecord(input[key])) failValidation(`state.${key} must be a plain object.`);
	}
	const messages = input.messages as Record<string, unknown>;
	for (const [entryId, fields] of Object.entries(messages)) {
		validateNonEmptyIdentifier(entryId, "message entry id");
		if (!isRecord(fields)) failValidation(`state.messages[${JSON.stringify(entryId)}] must be an object.`);
		for (const field of Object.keys(fields)) {
			if (!ALLOWED_MESSAGE_EXTENSION_KEY.test(field)) {
				failValidation(`state.messages[${JSON.stringify(entryId)}].${field} is not a TavernDB_* extension field.`);
			}
		}
	}
	const worldbooks = input.worldbooks as Record<string, unknown>;
	for (const [name, book] of Object.entries(worldbooks)) {
		validateNonEmptyIdentifier(name, "worldbook name");
		if (!isRecord(book) || !Array.isArray(book.entries)) {
			failValidation(`state.worldbooks[${JSON.stringify(name)}] must contain an entries array.`);
		}
	}
	return input as unknown as DatabasePluginHostState;
}

function serializeLimitedJson(value: unknown, label: string): Buffer {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		failValidation(`${label} is not JSON-serializable.`);
	}
	if (typeof serialized !== "string") failValidation(`${label} is not JSON-serializable.`);
	const bytes = Buffer.from(serialized, "utf8");
	if (bytes.byteLength > DATABASE_PLUGIN_MAX_OBJECT_BYTES) {
		failValidation(`${label} exceeds the ${DATABASE_PLUGIN_MAX_OBJECT_BYTES}-byte limit.`);
	}
	return bytes;
}

function normalizePluginFileName(input: unknown): string {
	if (typeof input !== "string" || input.length === 0) failValidation("file name must be a non-empty string.");
	if (input.includes("\\") || input.startsWith("/") || /^[A-Za-z]:/.test(input) || input.includes("%")) {
		failValidation("file name must be a relative, unencoded ASCII plugin path.");
	}
	let name = input;
	if (name.startsWith("user/files/")) name = name.slice("user/files/".length);
	else if (name.startsWith("files/")) name = name.slice("files/".length);
	if (!name || name.length > 240 || !/^[A-Za-z0-9._/-]+$/.test(name)) {
		failValidation("file name must be a safe ASCII plugin path of at most 240 characters.");
	}
	const segments = name.split("/");
	if (segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
		failValidation("file name contains an empty, hidden, or traversal path segment.");
	}
	if (segments.some((part) => part.length > 128)) failValidation("file name path segment exceeds 128 characters.");
	return segments.join("/");
}

function decodeBase64(input: unknown): Buffer {
	if (typeof input !== "string") failValidation("dataBase64 must be a standard base64 string.");
	const maxEncodedLength = Math.ceil(DATABASE_PLUGIN_MAX_OBJECT_BYTES / 3) * 4;
	if (input.length > maxEncodedLength || input.length % 4 !== 0) {
		failValidation("dataBase64 is invalid or exceeds the object size limit.");
	}
	const firstPadding = input.indexOf("=");
	const contentLength = firstPadding < 0 ? input.length : firstPadding;
	const paddingLength = input.length - contentLength;
	if (paddingLength > 2
		|| (paddingLength > 0 && (contentLength % 4 !== 4 - paddingLength))
		|| (paddingLength === 0 && contentLength % 4 !== 0)) {
		failValidation("dataBase64 has invalid padding.");
	}
	for (let index = 0; index < contentLength; index++) {
		const code = input.charCodeAt(index);
		const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
			|| (code >= 48 && code <= 57) || code === 43 || code === 47;
		if (!valid) failValidation("dataBase64 contains an invalid character.");
	}
	for (let index = contentLength; index < input.length; index++) {
		if (input.charCodeAt(index) !== 61) failValidation("dataBase64 has invalid padding.");
	}
	const data = Buffer.from(input, "base64");
	if (data.byteLength > DATABASE_PLUGIN_MAX_OBJECT_BYTES) failValidation("file exceeds the 32 MiB object size limit.");
	if (data.toString("base64") !== input) failValidation("dataBase64 is not canonical base64.");
	return data;
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function expectedPublicPath(name: string): string {
	return `/api/database-plugin/files/${encodeURIComponent(name)}`;
}

function isNodeError(error: unknown, code: string): boolean {
	return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	try {
		await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
	} catch (error) {
		if (!isNodeError(error, "EEXIST")) throw error;
	}
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new DatabasePluginStoreError("unsafe_path", "A database-plugin store directory is not a real directory.");
	}
	await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function fsyncDirectory(path: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY);
		await handle.sync();
	} catch (error) {
		// Some supported filesystems do not allow fsync on directory handles.
		if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP") && !isNodeError(error, "EISDIR")
			&& !isNodeError(error, "EACCES") && !isNodeError(error, "EPERM")) throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function writeAtomic(targetPath: string, data: Uint8Array): Promise<void> {
	const parent = dirname(targetPath);
	const existing = await lstat(targetPath).catch((error: unknown) => {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	});
	if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
		throw new DatabasePluginStoreError("unsafe_path", "Refusing to replace a non-regular database-plugin file.");
	}
	const tempPath = join(parent, `.${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(tempPath, "wx", PRIVATE_FILE_MODE);
		await handle.writeFile(data);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await chmod(tempPath, PRIVATE_FILE_MODE);
		await rename(tempPath, targetPath);
		await chmod(targetPath, PRIVATE_FILE_MODE);
		await fsyncDirectory(parent);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer | null> {
	let handle: FileHandle | undefined;
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) {
			throw new DatabasePluginStoreError("unsafe_path", "Refusing to read a non-regular database-plugin file.");
		}
		await chmod(path, PRIVATE_FILE_MODE);
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const opened = await handle.stat();
		if (!opened.isFile() || opened.size > maxBytes) {
			throw new DatabasePluginStoreError("invalid_file", "Database-plugin file is not regular or exceeds the size limit.");
		}
		return await handle.readFile();
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function parseJson<T>(bytes: Buffer, label: string): T {
	try {
		return JSON.parse(bytes.toString("utf8")) as T;
	} catch {
		throw new DatabasePluginStoreError("corrupt_data", `${label} contains invalid JSON.`);
	}
}

function validateHead(value: unknown): StateHead {
	if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.globalRevision) || (value.globalRevision as number) < 0 || !Array.isArray(value.snapshots)) {
		throw new DatabasePluginStoreError("corrupt_data", "Database-plugin state head is invalid.");
	}
	const snapshots: StateHeadEntry[] = [];
	let previousRevision = 0;
	for (const entry of value.snapshots) {
		if (!isRecord(entry)
			|| !Number.isSafeInteger(entry.revision)
			|| (entry.revision as number) <= previousRevision
			|| typeof entry.file !== "string"
			|| !/^r[0-9]{16}-[0-9a-f-]{36}\.json$/.test(entry.file)
			|| !(entry.sourceEntryId === null || typeof entry.sourceEntryId === "string")) {
			throw new DatabasePluginStoreError("corrupt_data", "Database-plugin state head contains an invalid snapshot reference.");
		}
		if (entry.sourceEntryId !== null) validateSourceEntryId(entry.sourceEntryId);
		previousRevision = entry.revision as number;
		snapshots.push({ revision: entry.revision as number, file: entry.file, sourceEntryId: entry.sourceEntryId as string | null });
	}
	if (snapshots.length !== (value.globalRevision as number)
		|| (snapshots.at(-1)?.revision ?? 0) !== value.globalRevision) {
		throw new DatabasePluginStoreError("corrupt_data", "Database-plugin state head revision sequence is inconsistent.");
	}
	return { version: 1, globalRevision: value.globalRevision as number, snapshots };
}

function snapshotFilename(revision: number): string {
	return `r${String(revision).padStart(16, "0")}-${randomUUID()}.json`;
}

function normalizeVisibleEntryIds(value: Iterable<string>): Set<string> {
	if (value == null || typeof value === "string" || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") {
		failValidation("visibleEntryIds must be an iterable of ancestor entry IDs.");
	}
	const ids = new Set<string>();
	for (const id of value) ids.add(validateNonEmptyIdentifier(id, "visible entry id"));
	return ids;
}

export class DatabasePluginStore {
	private readonly rootDirectory: string;

	constructor(cwd: string) {
		if (typeof cwd !== "string" || cwd.length === 0) failValidation("cwd must be a non-empty path.");
		this.rootDirectory = join(resolve(cwd), DATABASE_PLUGIN_STORE_DIRECTORY);
		try {
			lstatSync(this.rootDirectory);
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) throw error;
			try {
				mkdirSync(this.rootDirectory, { mode: PRIVATE_DIRECTORY_MODE });
			} catch (mkdirError) {
				if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
			}
		}
		const info = lstatSync(this.rootDirectory);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new DatabasePluginStoreError("unsafe_path", "The database-plugin store root must be a real directory.");
		}
		chmodSync(this.rootDirectory, PRIVATE_DIRECTORY_MODE);
	}

	async readState(scope: DatabasePluginScope, visibleEntryIds: Iterable<string>): Promise<DatabasePluginStateReadResult> {
		const normalizedScope = normalizeScope(scope);
		const visible = normalizeVisibleEntryIds(visibleEntryIds);
		const directories = await this.ensureScopeDirectories(normalizedScope.key);
		const head = await this.readStateHead(directories.scopeDirectory);
		const selected = [...head.snapshots].reverse().find((entry) => entry.sourceEntryId === null || visible.has(entry.sourceEntryId));
		if (!selected) return { snapshot: null, visibleRevision: 0, globalRevision: head.globalRevision };
		const bytes = await readRegularFile(join(directories.snapshotsDirectory, selected.file), DATABASE_PLUGIN_MAX_OBJECT_BYTES);
		if (!bytes) throw new DatabasePluginStoreError("corrupt_data", "A committed database-plugin state snapshot is missing.");
		const persisted = parseJson<PersistedSnapshot>(bytes, "Database-plugin state snapshot");
		if (!isRecord(persisted)) throw new DatabasePluginStoreError("corrupt_data", "Database-plugin state snapshot is not an object.");
		if (persisted.version !== 1 || persisted.revision !== selected.revision || persisted.sourceEntryId !== selected.sourceEntryId || typeof persisted.createdAt !== "string") {
			throw new DatabasePluginStoreError("corrupt_data", "Database-plugin state snapshot identity does not match its head entry.");
		}
		const state = validateHostState(persisted.state);
		return {
			snapshot: {
				revision: persisted.revision,
				...(persisted.sourceEntryId === null ? {} : { sourceEntryId: persisted.sourceEntryId }),
				state,
				createdAt: persisted.createdAt,
			},
			visibleRevision: persisted.revision,
			globalRevision: head.globalRevision,
		};
	}

	/**
	 * expectedRevision is the global scope revision, not the branch-visible revision.
	 * A source-less snapshot is scope-wide; sourced snapshots are visible only to that source's descendants.
	 */
	async saveState(
		scope: DatabasePluginScope,
		sourceEntryId: string | undefined,
		expectedRevision: number,
		state: DatabasePluginHostState,
	): Promise<DatabasePluginStateWriteResult> {
		const normalizedScope = normalizeScope(scope);
		const source = validateSourceEntryId(sourceEntryId);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			failValidation("expectedRevision must be a non-negative safe integer global revision.");
		}
		const checkedState = validateHostState(state);
		const directories = await this.ensureScopeDirectories(normalizedScope.key);
		const release = await this.acquireScopeLock(directories.scopeDirectory);
		try {
			const head = await this.readStateHead(directories.scopeDirectory);
			if (head.globalRevision !== expectedRevision) throw new DatabasePluginStoreConflictError(expectedRevision, head.globalRevision);
			if (head.globalRevision >= Number.MAX_SAFE_INTEGER) {
				throw new DatabasePluginStoreError("revision_exhausted", "Database-plugin state revision space is exhausted.");
			}
			const revision = head.globalRevision + 1;
			const createdAt = new Date().toISOString();
			const persisted: PersistedSnapshot = {
				version: 1,
				revision,
				sourceEntryId: source ?? null,
				createdAt,
				state: checkedState,
			};
			const snapshotBytes = serializeLimitedJson(persisted, "state snapshot");
			const file = snapshotFilename(revision);
			await writeAtomic(join(directories.snapshotsDirectory, file), snapshotBytes);
			const nextHead: StateHead = {
				version: 1,
				globalRevision: revision,
				snapshots: [...head.snapshots, { revision, file, sourceEntryId: source ?? null }],
			};
			const headBytes = serializeLimitedJson(nextHead, "state head");
			await writeAtomic(join(directories.scopeDirectory, STATE_HEAD_FILE), headBytes);
			const snapshot: DatabasePluginStateSnapshot = {
				revision,
				...(source === undefined ? {} : { sourceEntryId: source }),
				state: checkedState,
				createdAt,
			};
			return { snapshot, visibleRevision: revision, globalRevision: revision };
		} finally {
			await release();
		}
	}

	async putFile(scope: DatabasePluginScope, name: string, dataBase64: string): Promise<DatabasePluginFileResult> {
		const normalizedScope = normalizeScope(scope);
		const normalizedName = normalizePluginFileName(name);
		const data = decodeBase64(dataBase64);
		const objectPath = await this.resolveObjectPath(normalizedScope.key, normalizedName, true);
		await writeAtomic(objectPath, data);
		return { name: normalizedName, path: expectedPublicPath(normalizedName), sha256: sha256(data), size: data.byteLength };
	}

	async readFile(scope: DatabasePluginScope, name: string): Promise<DatabasePluginFileContent | null> {
		const normalizedScope = normalizeScope(scope);
		const normalizedName = normalizePluginFileName(name);
		const objectPath = await this.resolveObjectPath(normalizedScope.key, normalizedName, false);
		if (!objectPath) return null;
		const data = await readRegularFile(objectPath, DATABASE_PLUGIN_MAX_OBJECT_BYTES);
		if (!data) return null;
		return { name: normalizedName, path: expectedPublicPath(normalizedName), sha256: sha256(data), size: data.byteLength, data };
	}

	async deleteFile(scope: DatabasePluginScope, name: string): Promise<boolean> {
		const normalizedScope = normalizeScope(scope);
		const normalizedName = normalizePluginFileName(name);
		const objectPath = await this.resolveObjectPath(normalizedScope.key, normalizedName, false);
		if (!objectPath) return false;
		const info = await lstat(objectPath).catch((error: unknown) => {
			if (isNodeError(error, "ENOENT")) return null;
			throw error;
		});
		if (!info) return false;
		if (info.isSymbolicLink() || !info.isFile()) {
			throw new DatabasePluginStoreError("unsafe_path", "Refusing to delete a non-regular database-plugin file.");
		}
		await unlink(objectPath);
		await fsyncDirectory(dirname(objectPath));
		return true;
	}

	async listFiles(scope: DatabasePluginScope): Promise<DatabasePluginFileResult[]> {
		const normalizedScope = normalizeScope(scope);
		const scopesDirectory = join(this.rootDirectory, "scopes");
		await ensurePrivateDirectory(scopesDirectory);
		await ensurePrivateDirectory(join(scopesDirectory, normalizedScope.key));
		const objectsDirectory = join(scopesDirectory, normalizedScope.key, OBJECTS_DIRECTORY);
		await ensurePrivateDirectory(objectsDirectory);
		const results: DatabasePluginFileResult[] = [];
		const walk = async (directory: string): Promise<void> => {
			const entries = await readdir(directory, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(directory, entry.name);
				const info = await lstat(fullPath);
				if (info.isSymbolicLink()) throw new DatabasePluginStoreError("unsafe_path", "A symbolic link exists in the plugin object store.");
				if (entry.name.startsWith(".")) {
					if (info.isFile() && /^\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) continue;
					throw new DatabasePluginStoreError("unsafe_path", "A hidden entry exists in the plugin object store.");
				}
				if (info.isDirectory()) {
					if (!/^[A-Za-z0-9._-]+$/.test(entry.name) || entry.name.startsWith(".")) {
						throw new DatabasePluginStoreError("unsafe_path", "A non-plugin directory exists in the object store.");
					}
					await ensurePrivateDirectory(fullPath);
					await walk(fullPath);
					continue;
				}
				if (!info.isFile()) throw new DatabasePluginStoreError("unsafe_path", "A non-regular entry exists in the plugin object store.");
				const name = relative(objectsDirectory, fullPath).split(sep).join("/");
				const normalizedName = normalizePluginFileName(name);
				if (info.size > DATABASE_PLUGIN_MAX_OBJECT_BYTES) {
					throw new DatabasePluginStoreError("invalid_file", "A plugin object exceeds the 32 MiB size limit.");
				}
				const data = await readRegularFile(fullPath, DATABASE_PLUGIN_MAX_OBJECT_BYTES);
				if (!data) continue;
				results.push({ name: normalizedName, path: expectedPublicPath(normalizedName), sha256: sha256(data), size: data.byteLength });
			}
		};
		await walk(objectsDirectory);
		return results.sort((left, right) => left.name.localeCompare(right.name));
	}

	private async ensureScopeDirectories(scopeKey: string): Promise<{ scopeDirectory: string; snapshotsDirectory: string }> {
		const scopesDirectory = join(this.rootDirectory, "scopes");
		await ensurePrivateDirectory(scopesDirectory);
		const scopeDirectory = join(scopesDirectory, scopeKey);
		await ensurePrivateDirectory(scopeDirectory);
		const snapshotsDirectory = join(scopeDirectory, STATE_SNAPSHOTS_DIRECTORY);
		await ensurePrivateDirectory(snapshotsDirectory);
		return { scopeDirectory, snapshotsDirectory };
	}

	private async resolveObjectPath(scopeKey: string, name: string, createParents: boolean): Promise<string | null> {
		const normalizedName = normalizePluginFileName(name);
		const objectsDirectory = join(this.rootDirectory, "scopes", scopeKey, OBJECTS_DIRECTORY);
		if (createParents) {
			await ensurePrivateDirectory(join(this.rootDirectory, "scopes"));
			await ensurePrivateDirectory(join(this.rootDirectory, "scopes", scopeKey));
			await ensurePrivateDirectory(objectsDirectory);
		} else {
			for (const directory of [join(this.rootDirectory, "scopes"), join(this.rootDirectory, "scopes", scopeKey), objectsDirectory]) {
				const exists = await lstat(directory).catch((error: unknown) => {
					if (isNodeError(error, "ENOENT")) return null;
					throw error;
				});
				if (!exists) return null;
				if (exists.isSymbolicLink() || !exists.isDirectory()) {
					throw new DatabasePluginStoreError("unsafe_path", "A plugin object path parent is not a real directory.");
				}
				await chmod(directory, PRIVATE_DIRECTORY_MODE);
			}
		}
		let parent = objectsDirectory;
		const segments = normalizedName.split("/");
		for (const segment of segments.slice(0, -1)) {
			parent = join(parent, segment);
			if (createParents) await ensurePrivateDirectory(parent);
			else {
				const info = await lstat(parent).catch((error: unknown) => {
					if (isNodeError(error, "ENOENT")) return null;
					throw error;
				});
				if (!info) return null;
				if (info.isSymbolicLink() || !info.isDirectory()) {
					throw new DatabasePluginStoreError("unsafe_path", "A plugin object path parent is not a real directory.");
				}
				await chmod(parent, PRIVATE_DIRECTORY_MODE);
			}
		}
		return join(parent, segments.at(-1)!);
	}

	private async readStateHead(scopeDirectory: string): Promise<StateHead> {
		const path = join(scopeDirectory, STATE_HEAD_FILE);
		const bytes = await readRegularFile(path, DATABASE_PLUGIN_MAX_OBJECT_BYTES);
		if (!bytes) return { version: 1, globalRevision: 0, snapshots: [] };
		return validateHead(parseJson<unknown>(bytes, "Database-plugin state head"));
	}

	private async acquireScopeLock(scopeDirectory: string): Promise<() => Promise<void>> {
		const lockPath = join(scopeDirectory, LOCK_DIRECTORY);
		const token = randomUUID();
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		while (Date.now() < deadline) {
			try {
				await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
				await chmod(lockPath, PRIVATE_DIRECTORY_MODE);
				const ownerPath = join(lockPath, "owner.json");
				let handle: FileHandle | undefined;
				try {
					handle = await open(ownerPath, "wx", PRIVATE_FILE_MODE);
					await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
					await handle.sync();
				} finally {
					await handle?.close();
				}
				await chmod(ownerPath, PRIVATE_FILE_MODE);
				return async () => {
					const ownerBytes = await readRegularFile(ownerPath, 4096);
					if (!ownerBytes) return;
					const owner = parseJson<{ token?: string }>(ownerBytes, "Database-plugin scope lock");
					if (owner.token !== token) return;
					await unlink(ownerPath).catch((error: unknown) => {
						if (!isNodeError(error, "ENOENT")) throw error;
					});
					await rmdir(lockPath);
				};
			} catch (error) {
				if (!isNodeError(error, "EEXIST")) {
					// If setup failed before another writer could enter, remove only our empty lock dir.
					await rmdir(lockPath).catch(() => undefined);
					throw error;
				}
				const info = await lstat(lockPath).catch((lockError: unknown) => {
					if (isNodeError(lockError, "ENOENT")) return null;
					throw lockError;
				});
				if (info && (info.isSymbolicLink() || !info.isDirectory())) {
					throw new DatabasePluginStoreError("unsafe_path", "The state lock path is not a real directory.");
				}
				// A process crash can leave the lock behind. Fail closed after a bounded wait;
				// never guess that another writer's lock is stale and risk breaking CAS.
				await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_POLL_MS));
			}
		}
		throw new DatabasePluginStoreBusyError();
	}
}
