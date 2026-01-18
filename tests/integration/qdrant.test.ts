/**
 * Integration tests for Qdrant vector storage
 *
 * These tests require a running Qdrant instance.
 * Skip with SKIP_INTEGRATION_TESTS=1 if Qdrant is not available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  QdrantStorage,
  QdrantStorageError,
  QdrantErrorCode,
  type ChunkPayload,
  type ChunkUpsert,
} from '../../src/storage/qdrant.js';

// Skip integration tests if Qdrant is not available
const SKIP_TESTS = process.env.SKIP_INTEGRATION_TESTS === '1';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

// Test collection name (unique per test run)
const TEST_COLLECTION = `test_sourcerack_${Date.now()}`;

// Test vector dimensions (matching all-MiniLM-L6-v2)
const DIMENSIONS = 384;

describe.skipIf(SKIP_TESTS)('QdrantStorage Integration', () => {
  let storage: QdrantStorage;

  // Helper to generate mock vectors
  function mockVector(seed: number): number[] {
    const vector: number[] = [];
    for (let i = 0; i < DIMENSIONS; i++) {
      vector.push(Math.sin(seed + i) * 0.5 + 0.5);
    }
    // Normalize
    const magnitude = Math.sqrt(
      vector.reduce((sum, val) => sum + val * val, 0)
    );
    return vector.map((v) => v / magnitude);
  }

  // Helper to create test payload
  function createPayload(overrides: Partial<ChunkPayload> = {}): ChunkPayload {
    return {
      repo_id: 'test-repo-123',
      commits: ['abc123'],
      branches: ['main'],
      path: 'src/test.ts',
      symbol: 'testFunction',
      symbol_type: 'function',
      language: 'typescript',
      start_line: 1,
      end_line: 10,
      content: 'function testFunction() { return 42; }',
      ...overrides,
    };
  }

  beforeAll(async () => {
    storage = new QdrantStorage({
      url: QDRANT_URL,
      collectionName: TEST_COLLECTION,
      dimensions: DIMENSIONS,
    });

    try {
      await storage.initialize();
    } catch (error) {
      console.warn('Qdrant not available, skipping integration tests:', error);
      throw error;
    }
  });

  afterAll(async () => {
    if (storage?.isReady()) {
      // Clean up test collection
      try {
        const { QdrantClient } = await import('@qdrant/js-client-rest');
        const client = new QdrantClient({ url: QDRANT_URL });
        await client.deleteCollection(TEST_COLLECTION);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  beforeEach(async () => {
    // Clear collection before each test by deleting all points
    if (storage?.isReady()) {
      try {
        const stats = await storage.getStats();
        if (stats.pointCount > 0) {
          // Delete by filter (all points)
          const { QdrantClient } = await import('@qdrant/js-client-rest');
          const client = new QdrantClient({ url: QDRANT_URL });
          await client.delete(TEST_COLLECTION, {
            filter: {
              must: [{ is_empty: { key: '_never_exists_' } }],
            },
            wait: true,
          });
        }
      } catch {
        // Ignore cleanup errors in beforeEach
      }
    }
  });

  describe('Initialization', () => {
    it('should initialize and be ready', () => {
      expect(storage.isReady()).toBe(true);
    });

    it('should throw error for invalid configuration', () => {
      expect(
        () =>
          new QdrantStorage({
            url: '',
            collectionName: 'test',
            dimensions: 384,
          })
      ).toThrow(QdrantStorageError);
    });

    it('should throw error for zero dimensions', () => {
      expect(
        () =>
          new QdrantStorage({
            url: QDRANT_URL,
            collectionName: 'test',
            dimensions: 0,
          })
      ).toThrow(QdrantStorageError);
    });
  });

  describe('Chunk Operations', () => {
    it('should upsert a single chunk', async () => {
      const chunk: ChunkUpsert = {
        id: 'chunk-1',
        vector: mockVector(1),
        payload: createPayload(),
      };

      await storage.upsertChunk(chunk);

      const chunks = await storage.getChunks(['chunk-1']);
      expect(chunks.size).toBe(1);
      expect(chunks.get('chunk-1')?.symbol).toBe('testFunction');
    });

    it('should upsert multiple chunks in bulk', async () => {
      const chunks: ChunkUpsert[] = [
        { id: 'bulk-1', vector: mockVector(1), payload: createPayload({ symbol: 'func1' }) },
        { id: 'bulk-2', vector: mockVector(2), payload: createPayload({ symbol: 'func2' }) },
        { id: 'bulk-3', vector: mockVector(3), payload: createPayload({ symbol: 'func3' }) },
      ];

      await storage.upsertChunks(chunks);

      const result = await storage.getChunks(['bulk-1', 'bulk-2', 'bulk-3']);
      expect(result.size).toBe(3);
    });

    it('should update existing chunk on upsert', async () => {
      const chunk1: ChunkUpsert = {
        id: 'update-test',
        vector: mockVector(1),
        payload: createPayload({ content: 'original content' }),
      };

      await storage.upsertChunk(chunk1);

      const chunk2: ChunkUpsert = {
        id: 'update-test',
        vector: mockVector(1),
        payload: createPayload({ content: 'updated content' }),
      };

      await storage.upsertChunk(chunk2);

      const chunks = await storage.getChunks(['update-test']);
      expect(chunks.get('update-test')?.content).toBe('updated content');
    });

    it('should check chunk existence', async () => {
      const chunks: ChunkUpsert[] = [
        { id: 'exists-1', vector: mockVector(1), payload: createPayload() },
        { id: 'exists-2', vector: mockVector(2), payload: createPayload() },
      ];

      await storage.upsertChunks(chunks);

      const existing = await storage.chunksExist(['exists-1', 'exists-2', 'not-exists']);
      expect(existing.has('exists-1')).toBe(true);
      expect(existing.has('exists-2')).toBe(true);
      expect(existing.has('not-exists')).toBe(false);
    });

    it('should delete chunks', async () => {
      const chunks: ChunkUpsert[] = [
        { id: 'delete-1', vector: mockVector(1), payload: createPayload() },
        { id: 'delete-2', vector: mockVector(2), payload: createPayload() },
      ];

      await storage.upsertChunks(chunks);
      await storage.deleteChunks(['delete-1']);

      const existing = await storage.chunksExist(['delete-1', 'delete-2']);
      expect(existing.has('delete-1')).toBe(false);
      expect(existing.has('delete-2')).toBe(true);
    });
  });

  describe('Semantic Search', () => {
    beforeEach(async () => {
      // Insert test data for search tests
      const chunks: ChunkUpsert[] = [
        {
          id: 'search-1',
          vector: mockVector(1),
          payload: createPayload({
            repo_id: 'repo-1',
            commits: ['commit-a'],
            symbol: 'getUserById',
            language: 'typescript',
            path: 'src/user.ts',
          }),
        },
        {
          id: 'search-2',
          vector: mockVector(2),
          payload: createPayload({
            repo_id: 'repo-1',
            commits: ['commit-a'],
            symbol: 'getOrderById',
            language: 'typescript',
            path: 'src/order.ts',
          }),
        },
        {
          id: 'search-3',
          vector: mockVector(3),
          payload: createPayload({
            repo_id: 'repo-1',
            commits: ['commit-b'], // Different commit
            symbol: 'deleteUser',
            language: 'typescript',
            path: 'src/user.ts',
          }),
        },
        {
          id: 'search-4',
          vector: mockVector(4),
          payload: createPayload({
            repo_id: 'repo-2', // Different repo
            commits: ['commit-a'],
            symbol: 'createUser',
            language: 'python',
            path: 'src/user.py',
          }),
        },
      ];

      await storage.upsertChunks(chunks);
    });

    it('should search within repo and commit scope', async () => {
      const results = await storage.search(mockVector(1), {
        repo_id: 'repo-1',
        commit: 'commit-a',
      });

      // Should only return chunks from repo-1, commit-a
      expect(results.length).toBe(2);
      const ids = results.map((r) => r.id);
      expect(ids).toContain('search-1');
      expect(ids).toContain('search-2');
      expect(ids).not.toContain('search-3'); // Different commit
      expect(ids).not.toContain('search-4'); // Different repo
    });

    it('should filter by language', async () => {
      const results = await storage.search(
        mockVector(1),
        {
          repo_id: 'repo-1',
          commit: 'commit-a',
          language: 'typescript',
        },
        10
      );

      expect(results.every((r) => r.payload.language === 'typescript')).toBe(true);
    });

    it('should return ranked results with scores', async () => {
      const results = await storage.search(mockVector(1), {
        repo_id: 'repo-1',
        commit: 'commit-a',
      });

      // Results should be ordered by score (descending)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }

      // All results should have scores
      expect(results.every((r) => typeof r.score === 'number')).toBe(true);
    });

    it('should respect result limit', async () => {
      const results = await storage.search(
        mockVector(1),
        {
          repo_id: 'repo-1',
          commit: 'commit-a',
        },
        1
      );

      expect(results.length).toBe(1);
    });

    it('should return empty results for non-matching filters', async () => {
      const results = await storage.search(mockVector(1), {
        repo_id: 'non-existent-repo',
        commit: 'commit-a',
      });

      expect(results.length).toBe(0);
    });
  });

  describe('Commit Reference Management', () => {
    it('should add commit reference to existing chunk', async () => {
      const chunk: ChunkUpsert = {
        id: 'commit-ref-test',
        vector: mockVector(1),
        payload: createPayload({
          commits: ['commit-a'],
        }),
      };

      await storage.upsertChunk(chunk);
      await storage.addCommitToChunk('commit-ref-test', 'commit-b');

      const chunks = await storage.getChunks(['commit-ref-test']);
      const payload = chunks.get('commit-ref-test');
      expect(payload?.commits).toContain('commit-a');
      expect(payload?.commits).toContain('commit-b');
    });

    it('should not duplicate commit reference', async () => {
      const chunk: ChunkUpsert = {
        id: 'no-dup-test',
        vector: mockVector(1),
        payload: createPayload({
          commits: ['commit-a'],
        }),
      };

      await storage.upsertChunk(chunk);
      await storage.addCommitToChunk('no-dup-test', 'commit-a');

      const chunks = await storage.getChunks(['no-dup-test']);
      const payload = chunks.get('no-dup-test');
      expect(payload?.commits.filter((c) => c === 'commit-a').length).toBe(1);
    });

    it('should throw error when adding commit to non-existent chunk', async () => {
      await expect(
        storage.addCommitToChunk('non-existent', 'commit-a')
      ).rejects.toThrow(QdrantStorageError);
    });
  });

  describe('Statistics', () => {
    it('should return collection statistics', async () => {
      const chunks: ChunkUpsert[] = [
        { id: 'stats-1', vector: mockVector(1), payload: createPayload() },
        { id: 'stats-2', vector: mockVector(2), payload: createPayload() },
      ];

      await storage.upsertChunks(chunks);

      const stats = await storage.getStats();
      expect(stats.dimensions).toBe(DIMENSIONS);
      expect(stats.pointCount).toBeGreaterThanOrEqual(2);
      expect(typeof stats.segmentCount).toBe('number');
    });
  });
});
