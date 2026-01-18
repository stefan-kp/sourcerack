import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStorage, createMetadataStorage } from '../../../src/storage/metadata.js';
import { StorageError, StorageErrorCode } from '../../../src/storage/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('MetadataStorage', () => {
  let storage: MetadataStorage;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sourcerack-test-'));
    dbPath = join(tempDir, 'test.db');
    storage = createMetadataStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Repository Operations', () => {
    it('should register a repository', () => {
      const repo = storage.registerRepository(
        'test-id-123',
        '/path/to/repo',
        'test-repo'
      );

      expect(repo.id).toBe('test-id-123');
      expect(repo.path).toBe('/path/to/repo');
      expect(repo.name).toBe('test-repo');
      expect(repo.created_at).toBeDefined();
    });

    it('should throw on duplicate repository path', () => {
      storage.registerRepository('id1', '/path/to/repo', 'repo1');

      expect(() => {
        storage.registerRepository('id2', '/path/to/repo', 'repo2');
      }).toThrow(StorageError);
    });

    it('should get repository by ID', () => {
      storage.registerRepository('test-id', '/path', 'name');

      const repo = storage.getRepositoryById('test-id');
      expect(repo).not.toBeNull();
      expect(repo?.path).toBe('/path');
    });

    it('should get repository by path', () => {
      storage.registerRepository('test-id', '/unique/path', 'name');

      const repo = storage.getRepositoryByPath('/unique/path');
      expect(repo).not.toBeNull();
      expect(repo?.id).toBe('test-id');
    });

    it('should return null for non-existent repository', () => {
      const repo = storage.getRepositoryById('non-existent');
      expect(repo).toBeNull();
    });

    it('should list all repositories', () => {
      storage.registerRepository('id1', '/path1', 'alpha');
      storage.registerRepository('id2', '/path2', 'beta');

      const repos = storage.listRepositories();
      expect(repos).toHaveLength(2);
      // Should be sorted by name
      expect(repos[0]?.name).toBe('alpha');
      expect(repos[1]?.name).toBe('beta');
    });

    it('should delete a repository', () => {
      storage.registerRepository('id1', '/path1', 'repo1');

      const deleted = storage.deleteRepository('id1');
      expect(deleted).toBe(true);

      const repo = storage.getRepositoryById('id1');
      expect(repo).toBeNull();
    });
  });

  describe('Indexed Commit Operations', () => {
    const repoId = 'repo-123';

    beforeEach(() => {
      storage.registerRepository(repoId, '/test/repo', 'test');
    });

    it('should start indexing a commit', () => {
      const commit = storage.startIndexing(repoId, 'abc123');

      expect(commit.repo_id).toBe(repoId);
      expect(commit.commit_sha).toBe('abc123');
      expect(commit.status).toBe('in_progress');
      expect(commit.chunk_count).toBe(0);
    });

    it('should complete indexing', () => {
      const commit = storage.startIndexing(repoId, 'abc123');
      storage.completeIndexing(commit.id, 42);

      const updated = storage.getIndexedCommitById(commit.id);
      expect(updated?.status).toBe('complete');
      expect(updated?.chunk_count).toBe(42);
    });

    it('should mark indexing as failed', () => {
      const commit = storage.startIndexing(repoId, 'abc123');
      storage.failIndexing(commit.id);

      const updated = storage.getIndexedCommitById(commit.id);
      expect(updated?.status).toBe('failed');
    });

    it('should check if commit is indexed', () => {
      expect(storage.isCommitIndexed(repoId, 'abc123')).toBe(false);

      const commit = storage.startIndexing(repoId, 'abc123');
      expect(storage.isCommitIndexed(repoId, 'abc123')).toBe(false);

      storage.completeIndexing(commit.id, 10);
      expect(storage.isCommitIndexed(repoId, 'abc123')).toBe(true);
    });

    it('should get indexed commit by repo and SHA', () => {
      storage.startIndexing(repoId, 'abc123');

      const commit = storage.getIndexedCommit(repoId, 'abc123');
      expect(commit).not.toBeNull();
      expect(commit?.commit_sha).toBe('abc123');
    });

    it('should list indexed commits for repository', () => {
      storage.startIndexing(repoId, 'commit1');
      storage.startIndexing(repoId, 'commit2');

      const commits = storage.listIndexedCommits(repoId);
      expect(commits).toHaveLength(2);
    });
  });

  describe('Chunk Reference Operations', () => {
    let commitId: number;

    beforeEach(() => {
      storage.registerRepository('repo-1', '/path', 'test');
      const commit = storage.startIndexing('repo-1', 'abc123');
      commitId = commit.id;
    });

    it('should add chunk references', () => {
      const chunkIds = ['chunk-1', 'chunk-2', 'chunk-3'];
      storage.addChunkRefs(commitId, chunkIds);

      const retrieved = storage.getChunkIdsForCommit(commitId);
      expect(retrieved).toHaveLength(3);
      expect(retrieved).toContain('chunk-1');
      expect(retrieved).toContain('chunk-2');
      expect(retrieved).toContain('chunk-3');
    });

    it('should get chunk reference count', () => {
      storage.addChunkRefs(commitId, ['chunk-1', 'chunk-2']);

      // Add another commit with same chunk
      const commit2 = storage.startIndexing('repo-1', 'def456');
      storage.addChunkRefs(commit2.id, ['chunk-1', 'chunk-3']);

      expect(storage.getChunkRefCount('chunk-1')).toBe(2);
      expect(storage.getChunkRefCount('chunk-2')).toBe(1);
      expect(storage.getChunkRefCount('chunk-3')).toBe(1);
    });

    it('should delete chunk refs for commit', () => {
      storage.addChunkRefs(commitId, ['chunk-1', 'chunk-2']);

      const deleted = storage.deleteChunkRefsForCommit(commitId);
      expect(deleted).toBe(2);

      const refs = storage.getChunkIdsForCommit(commitId);
      expect(refs).toHaveLength(0);
    });
  });

  describe('GC Candidate Operations', () => {
    let commitId: number;

    beforeEach(() => {
      storage.registerRepository('repo-1', '/path', 'test');
      const commit = storage.startIndexing('repo-1', 'abc123');
      commitId = commit.id;
    });

    it('should mark commit as GC candidate', () => {
      storage.markAsGCCandidate(commitId, 30);

      const candidates = storage.getAllGCCandidates();
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.commit_id).toBe(commitId);
    });

    it('should remove from GC candidates', () => {
      storage.markAsGCCandidate(commitId, 30);
      const removed = storage.removeFromGCCandidates(commitId);

      expect(removed).toBe(true);
      expect(storage.getAllGCCandidates()).toHaveLength(0);
    });

    it('should get eligible for GC (future date = not eligible)', () => {
      storage.markAsGCCandidate(commitId, 30);

      // With 30-day retention, should not be eligible yet
      const eligible = storage.getEligibleForGC();
      expect(eligible).toHaveLength(0);
    });
  });

  describe('Statistics', () => {
    it('should return database statistics', () => {
      storage.registerRepository('repo-1', '/path1', 'test1');
      storage.registerRepository('repo-2', '/path2', 'test2');

      const commit = storage.startIndexing('repo-1', 'abc123');
      storage.addChunkRefs(commit.id, ['chunk-1', 'chunk-2']);

      const stats = storage.getStats();
      expect(stats.repositories).toBe(2);
      expect(stats.indexedCommits).toBe(1);
      expect(stats.chunkRefs).toBe(2);
      expect(stats.gcCandidates).toBe(0);
    });
  });

  describe('Repositories with Stats', () => {
    it('should list repositories with indexed commit counts', () => {
      storage.registerRepository('repo-1', '/path1', 'alpha');
      storage.registerRepository('repo-2', '/path2', 'beta');

      // Index 2 commits for repo-1
      const c1 = storage.startIndexing('repo-1', 'commit1');
      storage.completeIndexing(c1.id, 10);
      const c2 = storage.startIndexing('repo-1', 'commit2');
      storage.completeIndexing(c2.id, 20);

      // Index 1 commit for repo-2
      const c3 = storage.startIndexing('repo-2', 'commit3');
      storage.completeIndexing(c3.id, 5);

      const repos = storage.listRepositoriesWithStats();
      expect(repos).toHaveLength(2);

      const repo1 = repos.find((r) => r.id === 'repo-1');
      const repo2 = repos.find((r) => r.id === 'repo-2');

      expect(repo1?.indexed_commit_count).toBe(2);
      expect(repo2?.indexed_commit_count).toBe(1);
    });
  });
});
