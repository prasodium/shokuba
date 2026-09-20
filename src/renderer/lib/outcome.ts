/** Forms show these errors themselves, so mutations return them rather than throw. */
export type Outcome<T = void> = { ok: true; value: T } | { ok: false; error: string }
