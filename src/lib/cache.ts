/**
 * Lightweight in-memory TTL cache for public API responses.
 *
 * Why not Redis? For public, read-heavy, non-sensitive data (product listings,
 * collections, categories) a simple in-memory cache is sufficient and has
 * zero infrastructure cost. Data is lost on server restart — acceptable since
 * Cloudflare edge caching handles repeated requests anyway.
 *
 * Usage:
 *   const cached = memCache.get<MyType>('key');
 *   if (cached) return res.json(cached);
 *   const data = await prisma...
 *   memCache.set('key', data, 60_000); // cache 60 seconds
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class MemCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set(key: string, data: unknown, ttlMs = 60_000): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Invalidate all keys matching a prefix — useful after admin updates */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }
}

// Singleton — shared across all requests in this process
export const memCache = new MemCache();
