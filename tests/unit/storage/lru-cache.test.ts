import { describe, it, expect} from 'vitest';

/**
 * LRU Cache implementation tests (Phase 1.2)
 *
 * Note: The LRU cache is implemented as a private class within QdrantStorage.
 * These tests verify the expected behavior through a standalone implementation
 * that matches the one in qdrant.ts.
 */

// Standalone LRU cache implementation for testing (mirrors the one in qdrant.ts)
class LRUCache<K, V> {
  private cache: Map<K, V>;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Delete least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

describe('LRU Cache (Phase 1.2)', () => {
  describe('Basic Operations', () => {
    it('should store and retrieve values', () => {
      const cache = new LRUCache<string, boolean>(100);

      cache.set('chunk-1', true);
      cache.set('chunk-2', false);

      expect(cache.get('chunk-1')).toBe(true);
      expect(cache.get('chunk-2')).toBe(false);
    });

    it('should return undefined for missing keys', () => {
      const cache = new LRUCache<string, boolean>(100);

      expect(cache.get('non-existent')).toBeUndefined();
    });

    it('should check key existence', () => {
      const cache = new LRUCache<string, boolean>(100);

      cache.set('exists', true);

      expect(cache.has('exists')).toBe(true);
      expect(cache.has('not-exists')).toBe(false);
    });

    it('should delete keys', () => {
      const cache = new LRUCache<string, boolean>(100);

      cache.set('chunk-1', true);
      expect(cache.has('chunk-1')).toBe(true);

      const deleted = cache.delete('chunk-1');
      expect(deleted).toBe(true);
      expect(cache.has('chunk-1')).toBe(false);
    });

    it('should clear all entries', () => {
      const cache = new LRUCache<string, boolean>(100);

      cache.set('chunk-1', true);
      cache.set('chunk-2', true);
      cache.set('chunk-3', true);

      expect(cache.size).toBe(3);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.has('chunk-1')).toBe(false);
    });

    it('should track size correctly', () => {
      const cache = new LRUCache<string, boolean>(100);

      expect(cache.size).toBe(0);

      cache.set('chunk-1', true);
      expect(cache.size).toBe(1);

      cache.set('chunk-2', true);
      expect(cache.size).toBe(2);

      cache.delete('chunk-1');
      expect(cache.size).toBe(1);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict least recently used item when at capacity', () => {
      const cache = new LRUCache<string, boolean>(3);

      cache.set('chunk-1', true); // Oldest
      cache.set('chunk-2', true);
      cache.set('chunk-3', true); // Newest, cache is now full

      expect(cache.size).toBe(3);

      // Add a new item, should evict chunk-1 (LRU)
      cache.set('chunk-4', true);

      expect(cache.size).toBe(3);
      expect(cache.has('chunk-1')).toBe(false); // Evicted
      expect(cache.has('chunk-2')).toBe(true);
      expect(cache.has('chunk-3')).toBe(true);
      expect(cache.has('chunk-4')).toBe(true);
    });

    it('should update access order on get', () => {
      const cache = new LRUCache<string, boolean>(3);

      cache.set('chunk-1', true);
      cache.set('chunk-2', true);
      cache.set('chunk-3', true);

      // Access chunk-1, making it most recently used
      cache.get('chunk-1');

      // Add new item, should now evict chunk-2 (new LRU)
      cache.set('chunk-4', true);

      expect(cache.has('chunk-1')).toBe(true); // Kept because it was accessed
      expect(cache.has('chunk-2')).toBe(false); // Evicted
      expect(cache.has('chunk-3')).toBe(true);
      expect(cache.has('chunk-4')).toBe(true);
    });

    it('should update access order on set (existing key)', () => {
      const cache = new LRUCache<string, boolean>(3);

      cache.set('chunk-1', true);
      cache.set('chunk-2', true);
      cache.set('chunk-3', true);

      // Update chunk-1, making it most recently used
      cache.set('chunk-1', false);

      // Add new item, should now evict chunk-2 (new LRU)
      cache.set('chunk-4', true);

      expect(cache.has('chunk-1')).toBe(true);
      expect(cache.get('chunk-1')).toBe(false); // Value was updated
      expect(cache.has('chunk-2')).toBe(false); // Evicted
      expect(cache.has('chunk-3')).toBe(true);
      expect(cache.has('chunk-4')).toBe(true);
    });

    it('should handle sequential evictions', () => {
      const cache = new LRUCache<string, boolean>(2);

      cache.set('a', true);
      cache.set('b', true);
      cache.set('c', true); // Evicts 'a'
      cache.set('d', true); // Evicts 'b'
      cache.set('e', true); // Evicts 'c'

      expect(cache.size).toBe(2);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(false);
      expect(cache.has('d')).toBe(true);
      expect(cache.has('e')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should work with size of 1', () => {
      const cache = new LRUCache<string, boolean>(1);

      cache.set('chunk-1', true);
      expect(cache.get('chunk-1')).toBe(true);

      cache.set('chunk-2', true);
      expect(cache.has('chunk-1')).toBe(false);
      expect(cache.has('chunk-2')).toBe(true);
    });

    it('should handle large number of entries', () => {
      const cache = new LRUCache<string, boolean>(1000);

      // Add 1500 items
      for (let i = 0; i < 1500; i++) {
        cache.set(`chunk-${i}`, true);
      }

      expect(cache.size).toBe(1000);

      // First 500 should be evicted
      expect(cache.has('chunk-0')).toBe(false);
      expect(cache.has('chunk-499')).toBe(false);

      // Last 1000 should remain
      expect(cache.has('chunk-500')).toBe(true);
      expect(cache.has('chunk-1499')).toBe(true);
    });

    it('should work with different value types', () => {
      const boolCache = new LRUCache<string, boolean>(10);
      boolCache.set('key', true);
      expect(boolCache.get('key')).toBe(true);

      const numberCache = new LRUCache<string, number>(10);
      numberCache.set('key', 42);
      expect(numberCache.get('key')).toBe(42);

      const objectCache = new LRUCache<string, { exists: boolean }>(10);
      objectCache.set('key', { exists: true });
      expect(objectCache.get('key')).toEqual({ exists: true });
    });

    it('should not affect size when updating existing key', () => {
      const cache = new LRUCache<string, boolean>(3);

      cache.set('chunk-1', true);
      cache.set('chunk-2', true);

      expect(cache.size).toBe(2);

      // Update existing key
      cache.set('chunk-1', false);

      expect(cache.size).toBe(2); // Size unchanged
    });
  });

  describe('Chunk Existence Cache Use Case', () => {
    it('should efficiently cache chunk existence checks', () => {
      // Simulates the use case in QdrantStorage
      const chunkExistsCache = new LRUCache<string, boolean>(50000);

      // Simulate checking and caching chunk existence
      const chunksToCheck = ['chunk-a', 'chunk-b', 'chunk-c'];
      const existsInQdrant = new Set(['chunk-a', 'chunk-c']); // Simulated Qdrant response

      // Cache the results
      for (const chunkId of chunksToCheck) {
        const exists = existsInQdrant.has(chunkId);
        chunkExistsCache.set(chunkId, exists);
      }

      // Later lookups should hit cache
      expect(chunkExistsCache.get('chunk-a')).toBe(true);
      expect(chunkExistsCache.get('chunk-b')).toBe(false);
      expect(chunkExistsCache.get('chunk-c')).toBe(true);
    });

    it('should invalidate cache on chunk deletion', () => {
      const chunkExistsCache = new LRUCache<string, boolean>(50000);

      // Chunk exists
      chunkExistsCache.set('chunk-to-delete', true);
      expect(chunkExistsCache.get('chunk-to-delete')).toBe(true);

      // Simulate chunk deletion - invalidate cache
      chunkExistsCache.delete('chunk-to-delete');

      // Cache miss - would need to check Qdrant again
      expect(chunkExistsCache.get('chunk-to-delete')).toBeUndefined();
    });

    it('should update cache when new chunks are stored', () => {
      const chunkExistsCache = new LRUCache<string, boolean>(50000);

      // Initially not in cache
      expect(chunkExistsCache.get('new-chunk')).toBeUndefined();

      // After storing in Qdrant, update cache
      chunkExistsCache.set('new-chunk', true);

      expect(chunkExistsCache.get('new-chunk')).toBe(true);
    });
  });
});
