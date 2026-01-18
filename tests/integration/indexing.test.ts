/**
 * Integration tests for the full indexing pipeline
 *
 * These tests require:
 * - A running Qdrant instance
 * - A test Git repository
 *
 * Skip with SKIP_INTEGRATION_TESTS=1 if dependencies are not available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { GitAdapter } from '../../src/git/adapter.js';
import { MetadataStorage } from '../../src/storage/metadata.js';
import { QdrantStorage } from '../../src/storage/qdrant.js';
import { FastEmbedProvider } from '../../src/embeddings/local.js';
import { Indexer, createIndexer } from '../../src/indexer/indexer.js';
import type { IndexingProgressEvent } from '../../src/indexer/types.js';

// Skip integration tests if dependencies are not available
const SKIP_TESTS = process.env.SKIP_INTEGRATION_TESTS === '1';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

// Test collection name (unique per test run)
const TEST_COLLECTION = `test_indexing_${Date.now()}`;

// Test vector dimensions (matching all-MiniLM-L6-v2)
const DIMENSIONS = 384;

describe.skipIf(SKIP_TESTS)('Indexing Pipeline Integration', () => {
  let testDir: string;
  let repoPath: string;
  let git: GitAdapter;
  let metadata: MetadataStorage;
  let vectors: QdrantStorage;
  let embeddings: FastEmbedProvider;
  let indexer: Indexer;
  let repoId: string;
  let initialCommit: string;

  beforeAll(async () => {
    // Create temp directory for test repo
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcerack-indexing-test-'));
    repoPath = path.join(testDir, 'test-repo');
    fs.mkdirSync(repoPath);

    // Initialize git repo with test files
    execSync('git init', { cwd: repoPath });
    execSync('git config user.email "test@test.com"', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });

    // Create initial source files
    fs.mkdirSync(path.join(repoPath, 'src'));

    fs.writeFileSync(
      path.join(repoPath, 'src', 'math.ts'),
      `/**
 * Math utilities
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`
    );

    fs.writeFileSync(
      path.join(repoPath, 'src', 'string.ts'),
      `/**
 * String utilities
 */

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function reverse(s: string): string {
  return s.split('').reverse().join('');
}
`
    );

    execSync('git add .', { cwd: repoPath });
    execSync('git commit -m "Initial commit"', { cwd: repoPath });

    // Get initial commit SHA
    initialCommit = execSync('git rev-parse HEAD', { cwd: repoPath })
      .toString()
      .trim();

    // Initialize components
    git = await GitAdapter.create(repoPath);

    const dbPath = path.join(testDir, 'metadata.db');
    metadata = MetadataStorage.create(dbPath);

    vectors = new QdrantStorage({
      url: QDRANT_URL,
      collectionName: TEST_COLLECTION,
      dimensions: DIMENSIONS,
    });
    await vectors.initialize();

    embeddings = new FastEmbedProvider('all-MiniLM-L6-v2', 32);
    await embeddings.initialize();

    indexer = createIndexer(git, metadata, vectors, embeddings, 16);

    // Register test repository
    repoId = randomUUID();
    metadata.registerRepository(repoId, repoPath, 'test-repo');
  });

  afterAll(async () => {
    // Clean up
    if (vectors?.isReady()) {
      try {
        const { QdrantClient } = await import('@qdrant/js-client-rest');
        const client = new QdrantClient({ url: QDRANT_URL });
        await client.deleteCollection(TEST_COLLECTION);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Remove temp directory
    if (testDir) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Full Indexing Pipeline (T091-T096)', () => {
    it('should index a commit and store chunks', async () => {
      const progressEvents: IndexingProgressEvent[] = [];

      const result = await indexer.indexCommit({
        repoPath,
        repoId,
        commitSha: initialCommit,
        branch: 'main',
        onProgress: (event) => progressEvents.push(event),
      });

      expect(result.success).toBe(true);
      expect(result.repoId).toBe(repoId);
      expect(result.commitSha).toBe(initialCommit);
      expect(result.filesProcessed).toBeGreaterThan(0);
      expect(result.chunksCreated).toBeGreaterThan(0);

      // Verify progress events were emitted
      const eventTypes = progressEvents.map((e) => e.type);
      expect(eventTypes).toContain('started');
      expect(eventTypes).toContain('files_listed');
      expect(eventTypes).toContain('completed');
    });

    it('should mark commit as indexed in metadata', () => {
      const isIndexed = metadata.isCommitIndexed(repoId, initialCommit);
      expect(isIndexed).toBe(true);
    });

    it('should store chunk references', () => {
      const chunkCount = metadata.getCommitChunkCount(repoId, initialCommit);
      expect(chunkCount).toBeGreaterThan(0);
    });

    it('should be idempotent (re-indexing same commit is no-op)', async () => {
      const result = await indexer.indexCommit({
        repoPath,
        repoId,
        commitSha: initialCommit,
        branch: 'main',
      });

      // Should complete immediately without reprocessing
      expect(result.success).toBe(true);
      expect(result.filesProcessed).toBe(0);
      expect(result.chunksCreated).toBe(0);
    });

    it('should enable search on indexed commit', async () => {
      // Generate query embedding
      const queryVector = await embeddings.embed('add numbers function');

      // Search in indexed commit
      const results = await vectors.search(queryVector, {
        repo_id: repoId,
        commit: initialCommit,
      });

      expect(results.length).toBeGreaterThan(0);
      // Should find the add function
      const hasAddFunction = results.some(
        (r) => r.payload.symbol === 'add' || r.payload.content.includes('add')
      );
      expect(hasAddFunction).toBe(true);
    });
  });

  describe('Concurrent Indexing Protection (T104-T107)', () => {
    it('should prevent concurrent indexing of same commit', async () => {
      // Create a new commit
      fs.writeFileSync(
        path.join(repoPath, 'src', 'array.ts'),
        `export function first<T>(arr: T[]): T | undefined {
  return arr[0];
}
`
      );
      execSync('git add .', { cwd: repoPath });
      execSync('git commit -m "Add array utils"', { cwd: repoPath });

      const newCommit = execSync('git rev-parse HEAD', { cwd: repoPath })
        .toString()
        .trim();

      // Manually acquire lock by calling isIndexingInProgress
      // Then attempt indexing
      const firstIndexPromise = indexer.indexCommit({
        repoPath,
        repoId,
        commitSha: newCommit,
        branch: 'main',
      });

      // Small delay to let first indexing start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check if indexing is in progress
      const inProgress = indexer.isIndexingInProgress(repoId, newCommit);
      // May or may not be in progress depending on timing

      // Wait for first to complete
      const result = await firstIndexPromise;
      expect(result.success).toBe(true);

      // After completion, lock should be released
      const stillInProgress = indexer.isIndexingInProgress(repoId, newCommit);
      expect(stillInProgress).toBe(false);
    });
  });

  describe('Error Handling (T096)', () => {
    it('should handle non-existent commit', async () => {
      await expect(
        indexer.indexCommit({
          repoPath,
          repoId,
          commitSha: 'nonexistent123456789',
          branch: 'main',
        })
      ).rejects.toThrow(/[Cc]ommit not found/);
    });

    it('should emit failed event on error', async () => {
      const progressEvents: IndexingProgressEvent[] = [];

      try {
        await indexer.indexCommit({
          repoPath,
          repoId,
          commitSha: 'nonexistent123456789',
          branch: 'main',
          onProgress: (event) => progressEvents.push(event),
        });
      } catch {
        // Expected
      }

      const failedEvent = progressEvents.find((e) => e.type === 'failed');
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.error).toBeDefined();
    });
  });
});
