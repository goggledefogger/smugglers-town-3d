/**
 * Persistent and in-memory cache for Google 3D Tiles and satellite imagery.
 * Uses the standard Web CacheStorage API (`caches.open('smugglers-tiles-v1')`)
 * when available, with an in-memory fallback for headless or test environments.
 *
 * Query parameters like `?session=...` are stripped from keys so that Google
 * billing session renewals reuse cached 3D tile geometry and textures across
 * matches and browser restarts.
 */
import { logger } from '../../app/log.ts';

const log = logger('tile-cache');
const CACHE_NAME = 'smugglers-tiles-v1';

/** Strip ephemeral query strings such as ?session=... or &key=... from cache keys. */
export function cacheKeyFor(url: string): string {
  try {
    const parsed = new URL(url, 'https://tile.googleapis.com');
    // For satellite maps, keep geographic parameters (center, zoom, size, scale)
    // but strip the API key so key rotations or testing don't bust cache.
    if (parsed.pathname.includes('/staticmap')) {
      parsed.searchParams.delete('key');
      return parsed.origin + parsed.pathname + '?' + parsed.searchParams.toString();
    }
    // For 3D tiles, the path alone uniquely identifies the GLB or JSON tile
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

class TileCacheManager {
  private cachePromise: Promise<Cache | null> | null = null;
  private readonly memCache = new Map<string, ArrayBuffer>();
  private readonly maxMemEntries = 64;

  private async getCache(): Promise<Cache | null> {
    if (typeof globalThis.caches === 'undefined') return null;
    if (!this.cachePromise) {
      this.cachePromise = globalThis.caches.open(CACHE_NAME).catch(err => {
        log.warn('CacheStorage open failed, using memory cache only', err);
        return null;
      });
    }
    return this.cachePromise;
  }

  async getBuffer(url: string): Promise<ArrayBuffer | null> {
    const key = cacheKeyFor(url);
    const inMem = this.memCache.get(key);
    if (inMem) return inMem.slice(0);

    const cache = await this.getCache();
    if (!cache) return null;

    try {
      const match = await cache.match(key);
      if (!match) return null;
      const buf = await match.arrayBuffer();
      this.storeMem(key, buf);
      return buf.slice(0);
    } catch (e) {
      log.debug('cache match error', e);
      return null;
    }
  }

  async putBuffer(url: string, data: ArrayBuffer, contentType = 'application/octet-stream'): Promise<void> {
    const key = cacheKeyFor(url);
    this.storeMem(key, data);

    const cache = await this.getCache();
    if (!cache) return;

    try {
      const headers = new Headers({
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=604800' // 7 days
      });
      const response = new Response(data.slice(0), { headers });
      await cache.put(key, response);
    } catch (e) {
      log.debug('cache put error', e);
    }
  }

  async getJson<T = unknown>(url: string): Promise<T | null> {
    const buf = await this.getBuffer(url);
    if (!buf) return null;
    try {
      const text = new TextDecoder().decode(buf);
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async putJson(url: string, data: unknown): Promise<void> {
    const jsonStr = JSON.stringify(data);
    const buf = new TextEncoder().encode(jsonStr).buffer;
    await this.putBuffer(url, buf, 'application/json');
  }

  async clear(): Promise<void> {
    this.memCache.clear();
    if (typeof globalThis.caches !== 'undefined') {
      try {
        await globalThis.caches.delete(CACHE_NAME);
        this.cachePromise = null;
      } catch (e) {
        log.warn('Failed to clear cache', e);
      }
    }
  }

  private storeMem(key: string, data: ArrayBuffer): void {
    if (this.memCache.size >= this.maxMemEntries) {
      const oldest = this.memCache.keys().next().value;
      if (oldest !== undefined) this.memCache.delete(oldest);
    }
    this.memCache.set(key, data);
  }
}

export const tileCache = new TileCacheManager();
