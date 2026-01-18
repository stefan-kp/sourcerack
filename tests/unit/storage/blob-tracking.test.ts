import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStorage, createMetadataStorage } from '../../../src/storage/metadata.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Blob Tracking (Phase 1.1 & 2)', () => {
  let storage: MetadataStorage;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sourcerack-blob-test-'));
    dbPath = join(tempDir, 'test.db');
    storage = createMetadataStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('File-Blob Tracking (file_blobs table)', () => {
    let commitId: number;

    beforeEach(() => {
      storage.registerRepository('repo-1', '/path', 'test');
      const commit = storage.startIndexing('repo-1', 'abc123');
      commitId = commit.id;
    });

    it('should store file-blob mappings for a commit', () => {
      const mappings = [
        { filePath: 'src/index.ts', blobSha: 'blob-sha-1' },
        { filePath: 'src/utils.ts', blobSha: 'blob-sha-2' },
        { filePath: 'src/types.ts', blobSha: 'blob-sha-3' },
      ];

      storage.storeFileBlobs(commitId, mappings);

      const retrieved = storage.getFileBlobs(commitId);
      expect(retrieved.size).toBe(3);
      expect(retrieved.get('src/index.ts')).toBe('blob-sha-1');
      expect(retrieved.get('src/utils.ts')).toBe('blob-sha-2');
      expect(retrieved.get('src/types.ts')).toBe('blob-sha-3');
    });

    it('should return empty map for commit with no file blobs', () => {
      const retrieved = storage.getFileBlobs(commitId);
      expect(retrieved.size).toBe(0);
    });

    it('should handle duplicate file paths (upsert behavior)', () => {
      storage.storeFileBlobs(commitId, [
        { filePath: 'src/index.ts', blobSha: 'blob-sha-1' },
      ]);

      // Store again with same path but different blob
      storage.storeFileBlobs(commitId, [
        { filePath: 'src/index.ts', blobSha: 'blob-sha-2' },
      ]);

      const retrieved = storage.getFileBlobs(commitId);
      expect(retrieved.size).toBe(1);
      expect(retrieved.get('src/index.ts')).toBe('blob-sha-2');
    });

    it('should isolate file blobs between commits', () => {
      const commit2 = storage.startIndexing('repo-1', 'def456');

      storage.storeFileBlobs(commitId, [
        { filePath: 'src/index.ts', blobSha: 'blob-sha-1' },
      ]);
      storage.storeFileBlobs(commit2.id, [
        { filePath: 'src/index.ts', blobSha: 'blob-sha-2' },
      ]);

      const blobs1 = storage.getFileBlobs(commitId);
      const blobs2 = storage.getFileBlobs(commit2.id);

      expect(blobs1.size).toBe(1);
      expect(blobs1.get('src/index.ts')).toBe('blob-sha-1');
      expect(blobs2.size).toBe(1);
      expect(blobs2.get('src/index.ts')).toBe('blob-sha-2');
    });
  });

  describe('Blob-Chunk Tracking (blob_chunks table)', () => {
    it('should store blob-chunk mappings', () => {
      const blobSha = 'blob-sha-abc123';
      const chunkIds = ['chunk-1', 'chunk-2', 'chunk-3'];

      storage.storeBlobChunks(blobSha, chunkIds);

      const retrieved = storage.getChunksForBlobs([blobSha]);
      expect(retrieved.has(blobSha)).toBe(true);
      expect(retrieved.get(blobSha)).toHaveLength(3);
      expect(retrieved.get(blobSha)).toContain('chunk-1');
      expect(retrieved.get(blobSha)).toContain('chunk-2');
      expect(retrieved.get(blobSha)).toContain('chunk-3');
    });

    it('should check if blob is indexed', () => {
      expect(storage.isBlobIndexed('blob-sha-new')).toBe(false);

      storage.storeBlobChunks('blob-sha-new', ['chunk-1']);

      expect(storage.isBlobIndexed('blob-sha-new')).toBe(true);
    });

    it('should get indexed blobs from a list', () => {
      storage.storeBlobChunks('blob-1', ['chunk-1']);
      storage.storeBlobChunks('blob-2', ['chunk-2']);

      const indexed = storage.getIndexedBlobs(['blob-1', 'blob-2', 'blob-3']);

      expect(indexed.size).toBe(2);
      expect(indexed.has('blob-1')).toBe(true);
      expect(indexed.has('blob-2')).toBe(true);
      expect(indexed.has('blob-3')).toBe(false);
    });

    it('should return empty set for empty input', () => {
      const indexed = storage.getIndexedBlobs([]);
      expect(indexed.size).toBe(0);
    });

    it('should get chunks for multiple blobs', () => {
      storage.storeBlobChunks('blob-1', ['chunk-1a', 'chunk-1b']);
      storage.storeBlobChunks('blob-2', ['chunk-2a', 'chunk-2b', 'chunk-2c']);

      const chunkMap = storage.getChunksForBlobs(['blob-1', 'blob-2']);

      expect(chunkMap.size).toBe(2);
      expect(chunkMap.get('blob-1')).toHaveLength(2);
      expect(chunkMap.get('blob-2')).toHaveLength(3);
    });

    it('should return empty map for non-existent blobs', () => {
      const chunkMap = storage.getChunksForBlobs(['non-existent']);
      expect(chunkMap.size).toBe(0);
    });

    it('should handle blob with no chunks (edge case)', () => {
      storage.storeBlobChunks('empty-blob', []);

      // Empty blob shouldn't be marked as indexed since it has no chunks
      expect(storage.isBlobIndexed('empty-blob')).toBe(false);
    });

    it('should not duplicate chunk mappings on re-store', () => {
      storage.storeBlobChunks('blob-1', ['chunk-1', 'chunk-2']);
      storage.storeBlobChunks('blob-1', ['chunk-1', 'chunk-3']); // Re-store with overlap

      const chunkMap = storage.getChunksForBlobs(['blob-1']);
      const chunks = chunkMap.get('blob-1') ?? [];

      // Should have all unique chunks
      expect(chunks).toContain('chunk-1');
      expect(chunks).toContain('chunk-2');
      expect(chunks).toContain('chunk-3');
      // chunk-1 should not be duplicated
      expect(chunks.filter((c) => c === 'chunk-1')).toHaveLength(1);
    });
  });

  describe('File-Level Skip Integration', () => {
    let commitId: number;

    beforeEach(() => {
      storage.registerRepository('repo-1', '/path', 'test');
      const commit = storage.startIndexing('repo-1', 'abc123');
      commitId = commit.id;
    });

    it('should support full file-level skip workflow', () => {
      // Simulate first indexing: store file blobs and blob chunks
      const fileMappings = [
        { filePath: 'src/index.ts', blobSha: 'blob-index' },
        { filePath: 'src/utils.ts', blobSha: 'blob-utils' },
      ];
      storage.storeFileBlobs(commitId, fileMappings);

      storage.storeBlobChunks('blob-index', ['chunk-index-1', 'chunk-index-2']);
      storage.storeBlobChunks('blob-utils', ['chunk-utils-1']);

      // Simulate second commit with same blobs
      const commit2 = storage.startIndexing('repo-1', 'def456');

      // Check which blobs are already indexed
      const blobsToCheck = ['blob-index', 'blob-utils', 'blob-new'];
      const indexedBlobs = storage.getIndexedBlobs(blobsToCheck);

      expect(indexedBlobs.has('blob-index')).toBe(true);
      expect(indexedBlobs.has('blob-utils')).toBe(true);
      expect(indexedBlobs.has('blob-new')).toBe(false);

      // Get chunk IDs for indexed blobs (skip parsing)
      const reusedChunks = storage.getChunksForBlobs(['blob-index', 'blob-utils']);
      const allReusedChunkIds = [
        ...(reusedChunks.get('blob-index') ?? []),
        ...(reusedChunks.get('blob-utils') ?? []),
      ];

      expect(allReusedChunkIds).toHaveLength(3);
      expect(allReusedChunkIds).toContain('chunk-index-1');
      expect(allReusedChunkIds).toContain('chunk-index-2');
      expect(allReusedChunkIds).toContain('chunk-utils-1');

      // Store file blobs for new commit
      storage.storeFileBlobs(commit2.id, [
        { filePath: 'src/index.ts', blobSha: 'blob-index' },
        { filePath: 'src/utils.ts', blobSha: 'blob-utils' },
        { filePath: 'src/new.ts', blobSha: 'blob-new' },
      ]);

      // Store new blob chunks
      storage.storeBlobChunks('blob-new', ['chunk-new-1']);

      // Verify all blobs are now indexed
      const finalIndexed = storage.getIndexedBlobs(['blob-index', 'blob-utils', 'blob-new']);
      expect(finalIndexed.size).toBe(3);
    });
  });

  describe('Embedding Status (Phase 1.0)', () => {
    beforeEach(() => {
      storage.registerRepository('repo-1', '/path', 'test');
    });

    it('should start indexing with default embedding status (complete)', () => {
      const commit = storage.startIndexing('repo-1', 'abc123');
      expect(commit.embedding_status).toBe('complete');
    });

    it('should start indexing with custom embedding status (none)', () => {
      const commit = storage.startIndexing('repo-1', 'abc123', 'none');
      expect(commit.embedding_status).toBe('none');
    });

    it('should start indexing with pending embedding status', () => {
      const commit = storage.startIndexing('repo-1', 'abc123', 'pending');
      expect(commit.embedding_status).toBe('pending');
    });

    it('should update embedding status', () => {
      const commit = storage.startIndexing('repo-1', 'abc123', 'pending');
      expect(commit.embedding_status).toBe('pending');

      storage.updateEmbeddingStatus(commit.id, 'complete');

      const updated = storage.getIndexedCommitById(commit.id);
      expect(updated?.embedding_status).toBe('complete');
    });

    it('should preserve embedding status through completion', () => {
      const commit = storage.startIndexing('repo-1', 'abc123', 'none');
      storage.completeIndexing(commit.id, 42);

      const completed = storage.getIndexedCommitById(commit.id);
      expect(completed?.status).toBe('complete');
      expect(completed?.embedding_status).toBe('none');
    });
  });
});
