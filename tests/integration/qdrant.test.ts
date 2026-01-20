/**
 * Integration tests for Qdrant vector storage
 *
 * These tests require a running Qdrant instance.
 * Skip with SKIP_INTEGRATION_TESTS=1 if Qdrant is not available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
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

  // Helper to generate test UUIDs (Qdrant requires UUID or integer IDs)
  function testId(name: string): string {
    // Use a deterministic UUID based on test name for reproducibility
    // This creates a valid UUID format from the name
    const hash = name.split('').reduce((acc, char) => {
      return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
    }, 0);
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    return `${hex.slice(0, 8)}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-8${hex.slice(1, 4)}-${hex.padEnd(12, '0').slice(0, 12)}`;
  }

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
      content_type: 'code', // Required for search to work (default filter is 'code')
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
      const chunkId = testId('chunk-1');
      const chunk: ChunkUpsert = {
        id: chunkId,
        vector: mockVector(1),
        payload: createPayload(),
      };

      await storage.upsertChunk(chunk);

      const chunks = await storage.getChunks([chunkId]);
      expect(chunks.size).toBe(1);
      expect(chunks.get(chunkId)?.symbol).toBe('testFunction');
    });

    it('should upsert multiple chunks in bulk', async () => {
      const bulkId1 = testId('bulk-1');
      const bulkId2 = testId('bulk-2');
      const bulkId3 = testId('bulk-3');
      const chunks: ChunkUpsert[] = [
        { id: bulkId1, vector: mockVector(1), payload: createPayload({ symbol: 'func1' }) },
        { id: bulkId2, vector: mockVector(2), payload: createPayload({ symbol: 'func2' }) },
        { id: bulkId3, vector: mockVector(3), payload: createPayload({ symbol: 'func3' }) },
      ];

      await storage.upsertChunks(chunks);

      const result = await storage.getChunks([bulkId1, bulkId2, bulkId3]);
      expect(result.size).toBe(3);
    });

    it('should update existing chunk on upsert', async () => {
      const updateId = testId('update-test');
      const chunk1: ChunkUpsert = {
        id: updateId,
        vector: mockVector(1),
        payload: createPayload({ content: 'original content' }),
      };

      await storage.upsertChunk(chunk1);

      const chunk2: ChunkUpsert = {
        id: updateId,
        vector: mockVector(1),
        payload: createPayload({ content: 'updated content' }),
      };

      await storage.upsertChunk(chunk2);

      const chunks = await storage.getChunks([updateId]);
      expect(chunks.get(updateId)?.content).toBe('updated content');
    });

    it('should check chunk existence', async () => {
      const existsId1 = testId('exists-1');
      const existsId2 = testId('exists-2');
      const notExistsId = testId('not-exists');
      const chunks: ChunkUpsert[] = [
        { id: existsId1, vector: mockVector(1), payload: createPayload() },
        { id: existsId2, vector: mockVector(2), payload: createPayload() },
      ];

      await storage.upsertChunks(chunks);

      const existing = await storage.chunksExist([existsId1, existsId2, notExistsId]);
      expect(existing.has(existsId1)).toBe(true);
      expect(existing.has(existsId2)).toBe(true);
      expect(existing.has(notExistsId)).toBe(false);
    });

    it('should delete chunks', async () => {
      const deleteId1 = testId('delete-1');
      const deleteId2 = testId('delete-2');
      const chunks: ChunkUpsert[] = [
        { id: deleteId1, vector: mockVector(1), payload: createPayload() },
        { id: deleteId2, vector: mockVector(2), payload: createPayload() },
      ];

      await storage.upsertChunks(chunks);
      await storage.deleteChunks([deleteId1]);

      const existing = await storage.chunksExist([deleteId1, deleteId2]);
      expect(existing.has(deleteId1)).toBe(false);
      expect(existing.has(deleteId2)).toBe(true);
    });
  });

  describe('Semantic Search', () => {
    const searchId1 = testId('search-1');
    const searchId2 = testId('search-2');
    const searchId3 = testId('search-3');
    const searchId4 = testId('search-4');

    beforeEach(async () => {
      // Insert test data for search tests
      const chunks: ChunkUpsert[] = [
        {
          id: searchId1,
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
          id: searchId2,
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
          id: searchId3,
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
          id: searchId4,
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
      expect(ids).toContain(searchId1);
      expect(ids).toContain(searchId2);
      expect(ids).not.toContain(searchId3); // Different commit
      expect(ids).not.toContain(searchId4); // Different repo
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
      const commitRefId = testId('commit-ref-test');
      const chunk: ChunkUpsert = {
        id: commitRefId,
        vector: mockVector(1),
        payload: createPayload({
          commits: ['commit-a'],
        }),
      };

      await storage.upsertChunk(chunk);
      await storage.addCommitToChunk(commitRefId, 'commit-b');

      const chunks = await storage.getChunks([commitRefId]);
      const payload = chunks.get(commitRefId);
      expect(payload?.commits).toContain('commit-a');
      expect(payload?.commits).toContain('commit-b');
    });

    it('should not duplicate commit reference', async () => {
      const noDupId = testId('no-dup-test');
      const chunk: ChunkUpsert = {
        id: noDupId,
        vector: mockVector(1),
        payload: createPayload({
          commits: ['commit-a'],
        }),
      };

      await storage.upsertChunk(chunk);
      await storage.addCommitToChunk(noDupId, 'commit-a');

      const chunks = await storage.getChunks([noDupId]);
      const payload = chunks.get(noDupId);
      expect(payload?.commits.filter((c) => c === 'commit-a').length).toBe(1);
    });

    it('should throw error when adding commit to non-existent chunk', async () => {
      const nonExistentId = testId('non-existent');
      await expect(
        storage.addCommitToChunk(nonExistentId, 'commit-a')
      ).rejects.toThrow(QdrantStorageError);
    });
  });

  describe('Statistics', () => {
    it('should return collection statistics', async () => {
      const statsId1 = testId('stats-1');
      const statsId2 = testId('stats-2');
      const chunks: ChunkUpsert[] = [
        { id: statsId1, vector: mockVector(1), payload: createPayload() },
        { id: statsId2, vector: mockVector(2), payload: createPayload() },
      ];

      await storage.upsertChunks(chunks);

      const stats = await storage.getStats();
      expect(stats.dimensions).toBe(DIMENSIONS);
      expect(stats.pointCount).toBeGreaterThanOrEqual(2);
      expect(typeof stats.segmentCount).toBe('number');
    });
  });
});
