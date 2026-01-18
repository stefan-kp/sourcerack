/**
 * Unit tests for QueryOrchestrator
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  QueryOrchestrator,
  QueryError,
  QueryErrorCode,
  DEFAULT_QUERY_CONFIG,
  type QueryConfig,
  type PaginationCursor,
} from '../../../src/indexer/query.js';
import type { MetadataStorage } from '../../../src/storage/metadata.js';
import type { QdrantStorage, SearchResult } from '../../../src/storage/qdrant.js';
import type { EmbeddingProvider, EmbeddingVector } from '../../../src/embeddings/types.js';

// Mock implementations
function createMockMetadata(): MetadataStorage {
  return {
    isCommitIndexed: vi.fn().mockReturnValue(true),
    getIndexedCommit: vi.fn().mockReturnValue({
      id: 1,
      repo_id: 'repo-1',
      commit_sha: 'abc123',
      status: 'complete',
    }),
  } as unknown as MetadataStorage;
}

function createMockVector(seed: number): EmbeddingVector {
  const vector: number[] = [];
  for (let i = 0; i < 384; i++) {
    vector.push(Math.sin(seed + i) * 0.5 + 0.5);
  }
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return vector.map((v) => v / magnitude);
}

function createMockSearchResult(
  id: string,
  score: number,
  symbol: string
): SearchResult {
  return {
    id,
    score,
    payload: {
      repo_id: 'repo-1',
      commits: ['abc123'],
      branches: ['main'],
      path: `src/${symbol}.ts`,
      symbol,
      symbol_type: 'function',
      language: 'typescript',
      content_type: 'code',
      start_line: 1,
      end_line: 10,
      content: `function ${symbol}() { return 42; }`,
    },
  };
}

function createMockVectors(results: SearchResult[]): QdrantStorage {
  return {
    search: vi.fn().mockResolvedValue(results),
  } as unknown as QdrantStorage;
}

function createMockEmbeddings(): EmbeddingProvider {
  return {
    name: 'mock',
    dimensions: 384,
    maxTokens: 512,
    embed: vi.fn().mockResolvedValue(createMockVector(1)),
    embedBatch: vi.fn().mockResolvedValue([createMockVector(1)]),
    initialize: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
  };
}

describe('QueryOrchestrator', () => {
  let metadata: MetadataStorage;
  let vectors: QdrantStorage;
  let embeddings: EmbeddingProvider;
  let orchestrator: QueryOrchestrator;

  beforeEach(() => {
    metadata = createMockMetadata();
    embeddings = createMockEmbeddings();
  });

  describe('Query Validation (T108-T112)', () => {
    beforeEach(() => {
      vectors = createMockVectors([
        createMockSearchResult('chunk-1', 0.9, 'getUserById'),
        createMockSearchResult('chunk-2', 0.8, 'createUser'),
      ]);
      orchestrator = new QueryOrchestrator(metadata, vectors, embeddings);
    });

    it('should validate commit is indexed before searching', async () => {
      const result = await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'get user',
      });

      expect(metadata.isCommitIndexed).toHaveBeenCalledWith('repo-1', 'abc123');
      expect(result.isIndexed).toBe(true);
    });

    it('should return not indexed status for unindexed commit', async () => {
      vi.mocked(metadata.isCommitIndexed).mockReturnValue(false);

      const result = await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'not-indexed',
        query: 'get user',
      });

      expect(result.success).toBe(false);
      expect(result.isIndexed).toBe(false);
      expect(result.error).toContain('not indexed');
    });

    it('should execute search and return formatted results', async () => {
      const result = await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'get user',
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      // Note: scores may be boosted based on symbol name matching
      expect(result.results[0]).toMatchObject({
        id: 'chunk-1',
        path: 'src/getUserById.ts',
        symbol: 'getUserById',
        symbolType: 'function',
        language: 'typescript',
        startLine: 1,
        endLine: 10,
        content: 'function getUserById() { return 42; }',
      });
    });

    it('should pass language filter to search', async () => {
      await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'test',
        language: 'python',
      });

      expect(vectors.search).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          repo_id: 'repo-1',
          commit: 'abc123',
          language: 'python',
        }),
        expect.any(Number)
      );
    });

    it('should pass path pattern filter to search', async () => {
      await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'test',
        pathPattern: 'src/services/*',
      });

      expect(vectors.search).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          pathPattern: 'src/services/*',
        }),
        expect.any(Number)
      );
    });
  });

  describe('Result Limiting (T113-T115)', () => {
    beforeEach(() => {
      const manyResults = Array.from({ length: 60 }, (_, i) =>
        createMockSearchResult(`chunk-${i}`, 1 - i * 0.01, `func${i}`)
      );
      vectors = createMockVectors(manyResults);
      orchestrator = new QueryOrchestrator(metadata, vectors, embeddings);
    });

    it('should apply default limit of 50', async () => {
      const result = await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'test',
      });

      // Search limit is min(requestedLimit * 3, maxLimit) for re-ranking
      // With defaultLimit=50 and maxLimit=100: min(50 * 3, 100) = 100
      expect(vectors.search).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Object),
        DEFAULT_QUERY_CONFIG.maxLimit
      );
    });

    it('should respect custom limit', async () => {
      const result = await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'test',
        limit: 20,
      });

      // Search limit is min(requestedLimit * 3, maxLimit) for re-ranking
      // With limit=20 and maxLimit=100: min(20 * 3, 100) = 60
      expect(vectors.search).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Object),
        60
      );
    });

    it('should reject limit exceeding max', async () => {
      await expect(
        orchestrator.query({
          repoId: 'repo-1',
          commitSha: 'abc123',
          query: 'test',
          limit: 150,
        })
      ).rejects.toThrow(QueryError);

      await expect(
        orchestrator.query({
          repoId: 'repo-1',
          commitSha: 'abc123',
          query: 'test',
          limit: 150,
        })
      ).rejects.toThrow(/exceeds maximum/);
    });

    it('should reject zero or negative limit', async () => {
      await expect(
        orchestrator.query({
          repoId: 'repo-1',
          commitSha: 'abc123',
          query: 'test',
          limit: 0,
        })
      ).rejects.toThrow(QueryError);

      await expect(
        orchestrator.query({
          repoId: 'repo-1',
          commitSha: 'abc123',
          query: 'test',
          limit: -1,
        })
      ).rejects.toThrow(/must be positive/);
    });

    it('should use custom config limits', async () => {
      const customConfig: QueryConfig = {
        defaultLimit: 25,
        maxLimit: 50,
      };

      orchestrator = new QueryOrchestrator(
        metadata,
        vectors,
        embeddings,
        customConfig
      );

      await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'test',
      });

      // Search limit is min(requestedLimit * 3, maxLimit) for re-ranking
      // With defaultLimit=25 and maxLimit=50: min(25 * 3, 50) = 50
      expect(vectors.search).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Object),
        50
      );
    });
  });

  describe('Cursor-Based Pagination (T116-T118)', () => {
    beforeEach(() => {
      // Create results with distinct scores for pagination testing
      const paginatedResults = [
        createMockSearchResult('chunk-1', 0.95, 'func1'),
        createMockSearchResult('chunk-2', 0.90, 'func2'),
        createMockSearchResult('chunk-3', 0.85, 'func3'),
        createMockSearchResult('chunk-4', 0.80, 'func4'),
        createMockSearchResult('chunk-5', 0.75, 'func5'),
        createMockSearchResult('chunk-6', 0.70, 'func6'),
      ];
      vectors = createMockVectors(paginatedResults);
      orchestrator = new QueryOrchestrator(metadata, vectors, embeddings);
    });

    it('should return next cursor when more results exist', async () => {
      const result = await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'test',
        limit: 3,
      });

      expect(result.results).toHaveLength(3);
      expect(result.nextCursor).not.toBeNull();
      expect(result.nextCursor?.lastScore).toBe(0.85);
      expect(result.nextCursor?.lastId).toBe('chunk-3');
    });

    it('should return null cursor on last page', async () => {
      // Mock fewer results than limit
      vectors = createMockVectors([
        createMockSearchResult('chunk-1', 0.95, 'func1'),
        createMockSearchResult('chunk-2', 0.90, 'func2'),
      ]);
      orchestrator = new QueryOrchestrator(metadata, vectors, embeddings);

      const result = await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'test',
        limit: 10,
      });

      expect(result.nextCursor).toBeNull();
    });

    it('should filter results based on cursor', async () => {
      const cursor: PaginationCursor = {
        lastScore: 0.85,
        lastId: 'chunk-3',
      };

      const result = await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'test',
        limit: 10,
        cursor,
      });

      // Should only return results after the cursor
      // chunk-4, chunk-5, chunk-6 have lower scores than cursor
      expect(result.results.length).toBeLessThanOrEqual(3);
    });

    it('should provide total count for pagination UI', async () => {
      const result = await orchestrator.query({
        repoId: 'repo-1',
        commitSha: 'abc123',
        query: 'test',
        limit: 3,
      });

      expect(result.totalCount).toBeGreaterThanOrEqual(result.results.length);
    });
  });

  describe('Indexing Status Check', () => {
    beforeEach(() => {
      vectors = createMockVectors([]);
      orchestrator = new QueryOrchestrator(metadata, vectors, embeddings);
    });

    it('should return indexed status', () => {
      vi.mocked(metadata.getIndexedCommit).mockReturnValue({
        id: 1,
        repo_id: 'repo-1',
        commit_sha: 'abc123',
        status: 'complete',
        indexed_at: new Date().toISOString(),
        chunk_count: 100,
      });

      const status = orchestrator.getIndexingStatus('repo-1', 'abc123');
      expect(status).toBe('indexed');
    });

    it('should return in_progress status', () => {
      vi.mocked(metadata.getIndexedCommit).mockReturnValue({
        id: 1,
        repo_id: 'repo-1',
        commit_sha: 'abc123',
        status: 'in_progress',
        indexed_at: new Date().toISOString(),
        chunk_count: 0,
      });

      const status = orchestrator.getIndexingStatus('repo-1', 'abc123');
      expect(status).toBe('in_progress');
    });

    it('should return not_indexed status', () => {
      vi.mocked(metadata.getIndexedCommit).mockReturnValue(null);

      const status = orchestrator.getIndexingStatus('repo-1', 'abc123');
      expect(status).toBe('not_indexed');
    });
  });
});
