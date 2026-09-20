// Spec reference: PLAT-16 (Provider abstraction)
export interface KVProvider {
  // Spec reference: KV-2 (API shape)
  get(key: string[]): Promise<unknown | null>;
  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }>;
  atomic(): KVAtomicBuilder;
}

export interface KVAtomicBuilder {
  check(key: string[], expectedVersion: number): KVAtomicBuilder;
  set(key: string[], value: unknown): KVAtomicBuilder;
  delete(key: string[]): KVAtomicBuilder;
  commit(): Promise<{ ok: boolean; version?: number }>;
}
