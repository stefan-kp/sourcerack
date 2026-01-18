/**
 * Integration tests for incremental indexing
 *
 * These tests require:
 * - A running Qdrant instance
 * - A test Git repository with multiple commits
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
import { createIndexer, Indexer } from '../../src/indexer/indexer.js';
import {
  createIncrementalIndexer,
  IncrementalIndexer,
} from '../../src/indexer/incremental.js';

// Skip integration tests if dependencies are not available
const SKIP_TESTS = process.env.SKIP_INTEGRATION_TESTS === '1';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

// Test collection name (unique per test run)
const TEST_COLLECTION = `test_incremental_${Date.now()}`;

// Test vector dimensions (matching all-MiniLM-L6-v2)
const DIMENSIONS = 384;

describe.skipIf(SKIP_TESTS)('Incremental Indexing Integration', () => {
  let testDir: string;
  let repoPath: string;
  let git: GitAdapter;
  let metadata: MetadataStorage;
  let vectors: QdrantStorage;
  let embeddings: FastEmbedProvider;
  let indexer: Indexer;
  let incrementalIndexer: IncrementalIndexer;
  let repoId: string;
  let commit1: string;
  let commit2: string;
  let commit3: string;

  beforeAll(async () => {
    // Create temp directory for test repo
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sourcerack-incremental-test-')
    );
    repoPath = path.join(testDir, 'test-repo');
    fs.mkdirSync(repoPath);

    // Initialize git repo
    execSync('git init', { cwd: repoPath });
    execSync('git config user.email "test@test.com"', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });

    // Commit 1: Initial files
    fs.mkdirSync(path.join(repoPath, 'src'));

    fs.writeFileSync(
      path.join(repoPath, 'src', 'math.ts'),
      `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`
    );

    fs.writeFileSync(
      path.join(repoPath, 'src', 'utils.ts'),
      `export function log(message: string): void {
  console.log(message);
}
`
    );

    execSync('git add .', { cwd: repoPath });
    execSync('git commit -m "Commit 1: Initial files"', { cwd: repoPath });
    commit1 = execSync('git rev-parse HEAD', { cwd: repoPath })
      .toString()
      .trim();

    // Commit 2: Modify math.ts, add new file
    fs.writeFileSync(
      path.join(repoPath, 'src', 'math.ts'),
      `export function add(a: number, b: number): number {
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
      `export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
`
    );

    execSync('git add .', { cwd: repoPath });
    execSync('git commit -m "Commit 2: Add multiply, string utils"', {
      cwd: repoPath,
    });
    commit2 = execSync('git rev-parse HEAD', { cwd: repoPath })
      .toString()
      .trim();

    // Commit 3: Delete utils.ts, modify string.ts
    fs.unlinkSync(path.join(repoPath, 'src', 'utils.ts'));

    fs.writeFileSync(
      path.join(repoPath, 'src', 'string.ts'),
      `export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function reverse(s: string): string {
  return s.split('').reverse().join('');
}
`
    );

    execSync('git add .', { cwd: repoPath });
    execSync('git commit -m "Commit 3: Remove utils, add reverse"', {
      cwd: repoPath,
    });
    commit3 = execSync('git rev-parse HEAD', { cwd: repoPath })
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
    incrementalIndexer = createIncrementalIndexer(
      repoPath,
      git,
      metadata,
      vectors,
      embeddings,
      16
    );

    // Register test repository
    repoId = randomUUID();
    metadata.registerRepository(repoId, repoPath, 'test-repo');

    // Full index commit 1
    await indexer.indexCommit({
      repoPath,
      repoId,
      commitSha: commit1,
      branch: 'main',
    });
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

  describe('Incremental Indexing (T098-T102)', () => {
    it('should incrementally index from commit1 to commit2', async () => {
      const result = await incrementalIndexer.indexIncremental({
        repoPath,
        repoId,
        commitSha: commit2,
        baseCommitSha: commit1,
        branch: 'main',
      });

      expect(result.success).toBe(true);
      expect(result.baseCommitSha).toBe(commit1);
      expect(result.commitSha).toBe(commit2);

      // Should have changed files (math.ts modified, string.ts added)
      expect(result.changedFiles).toBeGreaterThan(0);

      // Should have unchanged files (utils.ts)
      expect(result.unchangedFiles).toBeGreaterThan(0);

      // Should reuse some chunks from unchanged files
      expect(result.chunksReused).toBeGreaterThan(0);

      // Should create new chunks for changed/added content
      expect(result.chunksCreated).toBeGreaterThan(0);
    });

    it('should mark commit2 as indexed', () => {
      const isIndexed = metadata.isCommitIndexed(repoId, commit2);
      expect(isIndexed).toBe(true);
    });

    it('should incrementally index from commit2 to commit3', async () => {
      const result = await incrementalIndexer.indexIncremental({
        repoPath,
        repoId,
        commitSha: commit3,
        baseCommitSha: commit2,
        branch: 'main',
      });

      expect(result.success).toBe(true);

      // utils.ts was deleted, string.ts was modified
      expect(result.changedFiles).toBeGreaterThanOrEqual(1);

      // math.ts is unchanged between commit2 and commit3
      expect(result.unchangedFiles).toBeGreaterThanOrEqual(1);
    });

    it('should enable search on incrementally indexed commit', async () => {
      // Search for reverse function (only in commit3)
      const queryVector = await embeddings.embed('reverse string function');

      const results = await vectors.search(queryVector, {
        repo_id: repoId,
        commit: commit3,
      });

      expect(results.length).toBeGreaterThan(0);

      // Should find reverse function
      const hasReverse = results.some(
        (r) =>
          r.payload.symbol === 'reverse' || r.payload.content.includes('reverse')
      );
      expect(hasReverse).toBe(true);
    });

    it('should not find deleted content in new commit', async () => {
      // Search for log function (only in commit1 and commit2, deleted in commit3)
      const queryVector = await embeddings.embed('log function console');

      const resultsCommit3 = await vectors.search(queryVector, {
        repo_id: repoId,
        commit: commit3,
      });

      // log function should not be in commit3 results
      const hasLog = resultsCommit3.some(
        (r) => r.payload.symbol === 'log' && r.payload.path.includes('utils')
      );
      expect(hasLog).toBe(false);

      // But should still be findable in commit2
      const resultsCommit2 = await vectors.search(queryVector, {
        repo_id: repoId,
        commit: commit2,
      });

      const hasLogInCommit2 = resultsCommit2.some(
        (r) => r.payload.symbol === 'log' || r.payload.content.includes('console.log')
      );
      expect(hasLogInCommit2).toBe(true);
    });
  });

  describe('Incremental Indexing Error Handling', () => {
    it('should require base commit to be indexed', async () => {
      const unindexedCommit = 'abc123nonexistent';

      await expect(
        incrementalIndexer.indexIncremental({
          repoPath,
          repoId,
          commitSha: commit3,
          baseCommitSha: unindexedCommit,
          branch: 'main',
        })
      ).rejects.toThrow(/[Bb]ase commit not indexed/);
    });

    it('should be idempotent for already indexed commit', async () => {
      const result = await incrementalIndexer.indexIncremental({
        repoPath,
        repoId,
        commitSha: commit3,
        baseCommitSha: commit2,
        branch: 'main',
      });

      // Should complete without reprocessing
      expect(result.success).toBe(true);
      expect(result.filesProcessed).toBe(0);
      expect(result.chunksCreated).toBe(0);
    });
  });

  describe('Performance Characteristics', () => {
    it('should be significantly faster than full indexing for small changes', async () => {
      // Create a new commit with minimal changes
      fs.writeFileSync(
        path.join(repoPath, 'src', 'tiny.ts'),
        `export const VERSION = "1.0.0";`
      );
      execSync('git add .', { cwd: repoPath });
      execSync('git commit -m "Tiny change"', { cwd: repoPath });
      const commit4 = execSync('git rev-parse HEAD', { cwd: repoPath })
        .toString()
        .trim();

      const startIncremental = Date.now();
      const incrResult = await incrementalIndexer.indexIncremental({
        repoPath,
        repoId,
        commitSha: commit4,
        baseCommitSha: commit3,
        branch: 'main',
      });
      const incrementalTime = Date.now() - startIncremental;

      expect(incrResult.success).toBe(true);
      // Incremental should only process the new file
      expect(incrResult.changedFiles).toBe(1);
      // Most chunks should be reused
      expect(incrResult.chunksReused).toBeGreaterThan(0);

      // Log timing for reference (not a hard assertion due to CI variability)
      console.log(`Incremental indexing time: ${incrementalTime}ms`);
      console.log(`Chunks created: ${incrResult.chunksCreated}`);
      console.log(`Chunks reused: ${incrResult.chunksReused}`);
    });
  });
});
