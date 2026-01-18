/**
 * Integration tests for semantic search functionality
 *
 * These tests require a running Qdrant instance.
 * Skip with SKIP_INTEGRATION_TESTS=1 if Qdrant is not available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  QdrantStorage,
  type ChunkUpsert,
} from '../../src/storage/qdrant.js';

// Skip integration tests if Qdrant is not available
const SKIP_TESTS = process.env.SKIP_INTEGRATION_TESTS === '1';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

// Test collection name (unique per test run)
const TEST_COLLECTION = `test_search_${Date.now()}`;

// Test vector dimensions (matching all-MiniLM-L6-v2)
const DIMENSIONS = 384;

describe.skipIf(SKIP_TESTS)('Semantic Search Integration', () => {
  let storage: QdrantStorage;

  // Helper to generate deterministic mock vectors
  // Different content produces different vectors
  function mockVector(content: string): number[] {
    const vector: number[] = [];
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }

    for (let i = 0; i < DIMENSIONS; i++) {
      // Generate deterministic but varied values
      vector.push(Math.sin(hash + i * 0.1) * 0.5 + 0.5);
    }

    // Normalize to unit vector
    const magnitude = Math.sqrt(
      vector.reduce((sum, val) => sum + val * val, 0)
    );
    return vector.map((v) => v / magnitude);
  }

  beforeAll(async () => {
    storage = new QdrantStorage({
      url: QDRANT_URL,
      collectionName: TEST_COLLECTION,
      dimensions: DIMENSIONS,
    });

    await storage.initialize();

    // Insert test code chunks representing a small codebase
    const testChunks: ChunkUpsert[] = [
      {
        id: 'user-service-get',
        vector: mockVector('async function getUserById(id: string): Promise<User>'),
        payload: {
          repo_id: 'repo-main',
          commits: ['v1.0', 'v1.1'],
          branches: ['main'],
          path: 'src/services/userService.ts',
          symbol: 'getUserById',
          symbol_type: 'function',
          language: 'typescript',
          start_line: 10,
          end_line: 25,
          content: `async function getUserById(id: string): Promise<User> {
  const user = await db.users.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User not found');
  return user;
}`,
        },
      },
      {
        id: 'user-service-create',
        vector: mockVector('async function createUser(data: CreateUserInput): Promise<User>'),
        payload: {
          repo_id: 'repo-main',
          commits: ['v1.0', 'v1.1'],
          branches: ['main'],
          path: 'src/services/userService.ts',
          symbol: 'createUser',
          symbol_type: 'function',
          language: 'typescript',
          start_line: 27,
          end_line: 40,
          content: `async function createUser(data: CreateUserInput): Promise<User> {
  const hashedPassword = await bcrypt.hash(data.password, 10);
  return db.users.create({
    data: { ...data, password: hashedPassword }
  });
}`,
        },
      },
      {
        id: 'user-model',
        vector: mockVector('interface User { id: string; email: string; name: string }'),
        payload: {
          repo_id: 'repo-main',
          commits: ['v1.0', 'v1.1'],
          branches: ['main'],
          path: 'src/models/user.ts',
          symbol: 'User',
          symbol_type: 'interface',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          content: `interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}`,
        },
      },
      {
        id: 'order-service-get',
        vector: mockVector('async function getOrderById(orderId: string): Promise<Order>'),
        payload: {
          repo_id: 'repo-main',
          commits: ['v1.1'], // Only in v1.1
          branches: ['main'],
          path: 'src/services/orderService.ts',
          symbol: 'getOrderById',
          symbol_type: 'function',
          language: 'typescript',
          start_line: 15,
          end_line: 30,
          content: `async function getOrderById(orderId: string): Promise<Order> {
  const order = await db.orders.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError('Order not found');
  return order;
}`,
        },
      },
      {
        id: 'python-auth',
        vector: mockVector('def authenticate_user(username: str, password: str) -> User'),
        payload: {
          repo_id: 'repo-main',
          commits: ['v1.0', 'v1.1'],
          branches: ['main'],
          path: 'src/auth/auth.py',
          symbol: 'authenticate_user',
          symbol_type: 'function',
          language: 'python',
          start_line: 20,
          end_line: 35,
          content: `def authenticate_user(username: str, password: str) -> User:
    user = db.users.get_by_username(username)
    if not user or not verify_password(password, user.password):
        raise AuthenticationError("Invalid credentials")
    return user`,
        },
      },
      {
        id: 'other-repo-chunk',
        vector: mockVector('function processData()'),
        payload: {
          repo_id: 'repo-other',
          commits: ['abc123'],
          branches: ['main'],
          path: 'src/processor.ts',
          symbol: 'processData',
          symbol_type: 'function',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          content: 'function processData() { /* ... */ }',
        },
      },
    ];

    await storage.upsertChunks(testChunks);
  });

  afterAll(async () => {
    if (storage?.isReady()) {
      try {
        const { QdrantClient } = await import('@qdrant/js-client-rest');
        const client = new QdrantClient({ url: QDRANT_URL });
        await client.deleteCollection(TEST_COLLECTION);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Commit-Scoped Search (FR-002)', () => {
    it('should only return results from specified commit', async () => {
      // Search for "get by id" pattern
      const queryVector = mockVector('get by id function');

      // Search in v1.0 - should not include orderService (only in v1.1)
      const v1Results = await storage.search(queryVector, {
        repo_id: 'repo-main',
        commit: 'v1.0',
      });

      const v1Ids = v1Results.map((r) => r.id);
      expect(v1Ids).toContain('user-service-get');
      expect(v1Ids).not.toContain('order-service-get');

      // Search in v1.1 - should include orderService
      const v1_1Results = await storage.search(queryVector, {
        repo_id: 'repo-main',
        commit: 'v1.1',
      });

      const v1_1Ids = v1_1Results.map((r) => r.id);
      expect(v1_1Ids).toContain('user-service-get');
      expect(v1_1Ids).toContain('order-service-get');
    });

    it('should only return results from specified repository', async () => {
      const queryVector = mockVector('function');

      const results = await storage.search(queryVector, {
        repo_id: 'repo-main',
        commit: 'v1.1',
      });

      // Should not include chunks from other repo
      const ids = results.map((r) => r.id);
      expect(ids).not.toContain('other-repo-chunk');
    });

    it('should return empty results for non-indexed commit', async () => {
      const queryVector = mockVector('user');

      const results = await storage.search(queryVector, {
        repo_id: 'repo-main',
        commit: 'non-existent-commit',
      });

      expect(results.length).toBe(0);
    });
  });

  describe('Language Filtering', () => {
    it('should filter results by language', async () => {
      const queryVector = mockVector('authenticate user password');

      // Search for TypeScript only
      const tsResults = await storage.search(
        queryVector,
        {
          repo_id: 'repo-main',
          commit: 'v1.1',
          language: 'typescript',
        },
        10
      );

      expect(tsResults.every((r) => r.payload.language === 'typescript')).toBe(
        true
      );
      expect(tsResults.map((r) => r.id)).not.toContain('python-auth');

      // Search for Python only
      const pyResults = await storage.search(
        queryVector,
        {
          repo_id: 'repo-main',
          commit: 'v1.1',
          language: 'python',
        },
        10
      );

      expect(pyResults.every((r) => r.payload.language === 'python')).toBe(true);
    });
  });

  describe('Result Ranking', () => {
    it('should return results ranked by relevance score', async () => {
      // Search for user-related functions
      const queryVector = mockVector('get user by id');

      const results = await storage.search(
        queryVector,
        {
          repo_id: 'repo-main',
          commit: 'v1.1',
        },
        10
      );

      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }

      // Scores should be between 0 and 1 for cosine similarity
      expect(results.every((r) => r.score >= 0 && r.score <= 1)).toBe(true);
    });

    it('should include full payload in results', async () => {
      const queryVector = mockVector('user service');

      const results = await storage.search(
        queryVector,
        {
          repo_id: 'repo-main',
          commit: 'v1.1',
        },
        5
      );

      expect(results.length).toBeGreaterThan(0);

      const result = results[0];
      expect(result.payload).toBeDefined();
      expect(result.payload.repo_id).toBe('repo-main');
      expect(result.payload.content).toBeDefined();
      expect(result.payload.path).toBeDefined();
      expect(result.payload.symbol).toBeDefined();
      expect(result.payload.start_line).toBeDefined();
      expect(result.payload.end_line).toBeDefined();
    });
  });

  describe('Result Limits', () => {
    it('should respect result limit parameter', async () => {
      const queryVector = mockVector('function');

      const limitedResults = await storage.search(
        queryVector,
        {
          repo_id: 'repo-main',
          commit: 'v1.1',
        },
        2
      );

      expect(limitedResults.length).toBeLessThanOrEqual(2);
    });

    it('should use default limit when not specified', async () => {
      const queryVector = mockVector('function');

      const results = await storage.search(queryVector, {
        repo_id: 'repo-main',
        commit: 'v1.1',
      });

      // Default limit is 10
      expect(results.length).toBeLessThanOrEqual(10);
    });
  });
});
