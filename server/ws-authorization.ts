/** 连接许可不是 Session 状态；撤权先移出集合，再 close，广播和每帧都重验。 */
export class AuthorizedSockets<S> {
	readonly #tokens = new Map<S, string | undefined>();
	private readonly authorize: (token: string | undefined) => boolean;
	private readonly close: (socket: S) => void;
	constructor(authorize: (token: string | undefined) => boolean, close: (socket: S) => void) { this.authorize = authorize; this.close = close; }
	add(socket: S, token: string | undefined): boolean {
		if (!this.authorize(token)) { this.close(socket); return false; }
		this.#tokens.set(socket, token); return true;
	}
	delete(socket: S): void { this.#tokens.delete(socket); }
	allows(socket: S): boolean {
		if (!this.#tokens.has(socket)) return false;
		if (this.authorize(this.#tokens.get(socket))) return true;
		this.#tokens.delete(socket); this.close(socket); return false;
	}
	revokeInvalid(): void { for (const socket of this.#tokens.keys()) this.allows(socket); }
	[Symbol.iterator](): IterableIterator<S> { return this.#tokens.keys(); }
}
