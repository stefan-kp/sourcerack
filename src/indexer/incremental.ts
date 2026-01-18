/**
 * Incremental indexer for SourceRack
 *
 * Implements efficient incremental indexing by:
 * 1. Computing diff between base and target commits
 * 2. Only parsing/embedding changed files
 * 3. Reusing existing chunks for unchanged files
 */

import { GitAdapter } from '../git/adapter.js';
import { computeCommitDiff } from '../git/diff.js';
import { parseFile } from '../parser/chunker.js';
import {
  detectLanguage,
  getMissingGrammars,
  preInstallGrammars,
} from '../parser/tree-sitter.js';
import { deduplicateChunks } from '../storage/dedup.js';
import { MetadataStorage } from '../storage/metadata.js';
import { QdrantStorage, type ChunkPayload, type ChunkUpsert } from '../storage/qdrant.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { EmbeddingStatus } from '../storage/types.js';
import type { SupportedLanguage } from '../parser/types.js';
import {
  type IncrementalIndexingOptions,
  type IncrementalIndexingResult,
  type IndexingProgressEvent,
  type ProcessedChunk,
  IndexerError,
  IndexerErrorCode,
} from './types.js';
import { createSQIIndexer, SQIIndexer } from '../sqi/sqi-indexer.js';

/**
 * In-memory lock storage for concurrent indexing protection
 */
const incrementalLocks = new Map<
  string,
  { holder: string; lockedAt: Date; commitSha: string }
>();

/**
 * Generate lock key for a repository + commit combination
 */
function getLockKey(repoId: string, commitSha: string): string {
  return `incr:${repoId}:${commitSha}`;
}

/**
 * Incremental indexer
 */
export class IncrementalIndexer {
  private git: GitAdapter;
  private metadata: MetadataStorage;
  private vectors: QdrantStorage | null;
  private embeddings: EmbeddingProvider | null;
  private batchSize: number;
  private repoPath: string;
  private sqiIndexer: SQIIndexer;

  constructor(
    repoPath: string,
    git: GitAdapter,
    metadata: MetadataStorage,
    vectors: QdrantStorage | null,
    embeddings: EmbeddingProvider | null,
    batchSize: number = 32
  ) {
    this.repoPath = repoPath;
    this.git = git;
    this.metadata = metadata;
    this.vectors = vectors;
    this.embeddings = embeddings;
    this.batchSize = batchSize;
    this.sqiIndexer = createSQIIndexer(metadata.getSQIStorage());
  }

  /**
   * Acquire lock for incremental indexing
   */
  private acquireLock(
    repoId: string,
    commitSha: string,
    holder: string
  ): boolean {
    const key = getLockKey(repoId, commitSha);
    if (incrementalLocks.has(key)) {
      return false;
    }
    incrementalLocks.set(key, {
      holder,
      lockedAt: new Date(),
      commitSha,
    });
    return true;
  }

  /**
   * Release lock for incremental indexing
   */
  private releaseLock(repoId: string, commitSha: string): void {
    const key = getLockKey(repoId, commitSha);
    incrementalLocks.delete(key);
  }

  /**
   * Check if incremental indexing is in progress
   */
  isIndexingInProgress(repoId: string, commitSha: string): boolean {
    const key = getLockKey(repoId, commitSha);
    return incrementalLocks.has(key);
  }

  /**
   * Index a commit incrementally based on a previously indexed commit
   */
  async indexIncremental(
    options: IncrementalIndexingOptions
  ): Promise<IncrementalIndexingResult> {
    const { repoId, commitSha, baseCommitSha, branch, onProgress, skipEmbeddings } = options;
    const startTime = Date.now();
    const lockHolder = `incr-indexer-${Date.now()}`;

    // Determine embedding status based on skipEmbeddings flag
    const embeddingsEnabled = !skipEmbeddings && this.embeddings !== null && this.vectors !== null;
    const embeddingStatus: EmbeddingStatus = embeddingsEnabled ? 'complete' : 'none';

    // Emit progress helper
    const emitProgress = (
      event: Partial<IndexingProgressEvent> & { type: IndexingProgressEvent['type'] }
    ): void => {
      if (onProgress) {
        onProgress({
          repoId,
          commitSha,
          timestamp: new Date(),
          ...event,
        });
      }
    };

    // Try to acquire lock
    if (!this.acquireLock(repoId, commitSha, lockHolder)) {
      throw new IndexerError(
        `Incremental indexing already in progress for ${repoId}:${commitSha}`,
        IndexerErrorCode.INDEXING_IN_PROGRESS
      );
    }

    try {
      emitProgress({ type: 'started' });

      // Check if target commit already indexed
      if (this.metadata.isCommitIndexed(repoId, commitSha)) {
        emitProgress({
          type: 'completed',
          filesProcessed: 0,
          chunksCreated: 0,
          chunksReused: 0,
        });
        return {
          success: true,
          repoId,
          commitSha,
          baseCommitSha,
          filesProcessed: 0,
          chunksCreated: 0,
          chunksReused: 0,
          changedFiles: 0,
          unchangedFiles: 0,
          durationMs: Date.now() - startTime,
        };
      }

      // Verify base commit is indexed
      if (!this.metadata.isCommitIndexed(repoId, baseCommitSha)) {
        throw new IndexerError(
          `Base commit not indexed: ${baseCommitSha}`,
          IndexerErrorCode.COMMIT_NOT_FOUND
        );
      }

      // Verify target commit exists
      const commitExists = await this.git.commitExists(commitSha);
      if (!commitExists) {
        throw new IndexerError(
          `Target commit not found: ${commitSha}`,
          IndexerErrorCode.COMMIT_NOT_FOUND
        );
      }

      // Start indexing record with appropriate embedding status
      const commitRecord = this.metadata.startIndexing(repoId, commitSha, embeddingStatus);

      // Get diff between commits
      const diff = await computeCommitDiff(
        this.repoPath,
        baseCommitSha,
        commitSha
      );

      // Filter to supported files
      const changedFiles = diff.changes.filter((change) =>
        this.isSupportedFile(change.path)
      );
      const deletedFiles = diff.changes.filter(
        (c) => c.changeType === 'deleted' && this.isSupportedFile(c.path)
      );

      // Get all files at target commit for unchanged file handling
      const allFiles = await this.git.listFilesAtCommit(commitSha);
      const allSupportedFiles = allFiles.filter((f) =>
        this.isSupportedFile(f.path)
      );

      // Determine unchanged files
      const changedPaths = new Set(changedFiles.map((c) => c.path));
      const deletedPaths = new Set(deletedFiles.map((c) => c.path));
      const unchangedFiles = allSupportedFiles.filter(
        (f) => !changedPaths.has(f.path) && !deletedPaths.has(f.path)
      );

      emitProgress({
        type: 'files_listed',
        totalFiles: changedFiles.length + unchangedFiles.length,
        filesProcessed: 0,
      });

      // Pre-install any missing grammars for changed files
      const filesToProcess = changedFiles.filter(
        (c) => c.changeType === 'added' || c.changeType === 'modified'
      );
      const filePathsToProcess = filesToProcess.map((f) => f.path);
      const missingGrammars = await getMissingGrammars(filePathsToProcess);
      if (missingGrammars.length > 0) {
        emitProgress({
          type: 'grammars_installing',
          missingGrammars,
        } as IndexingProgressEvent);

        const installResults = await preInstallGrammars(filePathsToProcess);
        if (installResults.failed.length > 0) {
          console.warn(
            `Failed to install grammars: ${installResults.failed.join(', ')}`
          );
        }
        if (installResults.installed.length > 0) {
          console.log(
            `Installed grammars: ${installResults.installed.join(', ')}`
          );
        }
      }

      // Copy chunk references from base commit for unchanged files (only if embeddings enabled)
      if (embeddingsEnabled) {
        const baseCommitRecord = this.metadata.getIndexedCommit(
          repoId,
          baseCommitSha
        );
        if (baseCommitRecord) {
          const baseChunkIds = this.metadata.getChunkIdsForCommit(
            baseCommitRecord.id
          );

          // Get chunks for unchanged files from vector store
          const unchangedChunkIds = await this.getChunksForPaths(
            baseChunkIds,
            unchangedFiles.map((f) => f.path)
          );

          // Add references to new commit
          this.metadata.addChunkRefs(commitRecord.id, [...unchangedChunkIds]);

          // Update commit references in vector store
          for (const chunkId of unchangedChunkIds) {
            try {
              await this.vectors!.addCommitToChunk(chunkId, commitSha);
            } catch {
              // Chunk might be deleted, will be recreated if needed
            }
          }

          emitProgress({
            type: 'chunks_stored',
            chunksReused: unchangedChunkIds.size,
          });
        }
      }

      // Phase 2: File-Level Skip for changed files
      // Build a map from path to blob SHA for changed files
      const changedFileInfoMap = new Map<string, string>();
      for (const file of allSupportedFiles) {
        if (changedPaths.has(file.path)) {
          changedFileInfoMap.set(file.path, file.sha);
        }
      }

      // Check which blobs from changed files are already indexed
      const changedBlobShas = [...changedFileInfoMap.values()];
      const indexedBlobSet = embeddingsEnabled && changedBlobShas.length > 0
        ? this.metadata.getIndexedBlobs(changedBlobShas)
        : new Set<string>();

      // Separate changed files into those with indexed blobs and those needing parsing
      const filesNeedingParsing: typeof filesToProcess = [];
      const changedFilesWithIndexedBlobs: { path: string; blobSha: string }[] = [];

      for (const change of filesToProcess) {
        const blobSha = changedFileInfoMap.get(change.path);
        if (blobSha && indexedBlobSet.has(blobSha)) {
          changedFilesWithIndexedBlobs.push({ path: change.path, blobSha });
        } else {
          filesNeedingParsing.push(change);
        }
      }

      // For changed files with indexed blobs, reuse chunk IDs directly
      if (embeddingsEnabled && changedFilesWithIndexedBlobs.length > 0) {
        const indexedBlobShas = changedFilesWithIndexedBlobs.map((f) => f.blobSha);
        const blobChunkMap = this.metadata.getChunksForBlobs(indexedBlobShas);

        const reusedChunkIds: string[] = [];
        for (const blobSha of indexedBlobShas) {
          const chunkIds = blobChunkMap.get(blobSha);
          if (chunkIds) {
            reusedChunkIds.push(...chunkIds);
          }
        }

        if (reusedChunkIds.length > 0) {
          this.metadata.addChunkRefs(commitRecord.id, reusedChunkIds);

          for (const chunkId of reusedChunkIds) {
            try {
              await this.vectors!.addCommitToChunk(chunkId, commitSha);
            } catch {
              // Chunk might have been deleted
            }
          }
        }

        emitProgress({
          type: 'chunks_stored',
          chunksReused: reusedChunkIds.length,
        });
      }

      // Process changed files that need parsing
      const allProcessedChunks: ProcessedChunk[] = [];
      let filesProcessed = changedFilesWithIndexedBlobs.length; // Count skipped files
      let totalChunksCreated = 0;

      // Track new blob -> chunk mappings
      const newBlobChunkMap = new Map<string, string[]>();

      for (const change of filesNeedingParsing) {
        try {
          const { content, isBinary } = await this.git.readFileAtCommit(
            commitSha,
            change.path
          );

          if (isBinary) {
            filesProcessed++;
            continue;
          }

          const blobSha = changedFileInfoMap.get(change.path);

          // Only process chunks if embeddings are enabled
          if (embeddingsEnabled) {
            // Parse file
            const language = this.getLanguage(change.path);
            const parseResult = await parseFile(change.path, content, language);

            if (parseResult.chunks.length === 0) {
              filesProcessed++;
              emitProgress({
                type: 'file_parsed',
                currentFile: change.path,
                totalFiles: filesToProcess.length,
                filesProcessed,
              });
              continue;
            }

            // Deduplicate chunks
            const dedupedChunks = deduplicateChunks(parseResult.chunks);

            // Check which chunks already exist
            const chunkIds = dedupedChunks.map((dc) => dc.id);
            const existingChunks = await this.vectors!.chunksExist(chunkIds);

            // Separate new from existing
            const newChunks = dedupedChunks.filter(
              (dc) => !existingChunks.has(dc.id)
            );
            const reusedChunks = dedupedChunks.filter((dc) =>
              existingChunks.has(dc.id)
            );

            // Add commit reference to existing chunks
            for (const dc of reusedChunks) {
              try {
                await this.vectors!.addCommitToChunk(dc.id, commitSha);
              } catch {
                newChunks.push(dc);
              }
            }

            // Embed new chunks
            if (newChunks.length > 0) {
              const textsToEmbed = newChunks.map((dc) => dc.chunk.content);
              const embeddings = await this.embeddings!.embedBatch(textsToEmbed);

              for (let i = 0; i < newChunks.length; i++) {
                const embedding = embeddings[i];
                const dc = newChunks[i];
                if (embedding && dc) {
                  allProcessedChunks.push({
                    id: dc.id,
                    chunk: dc.chunk,
                    embedding,
                  });
                }
              }

              totalChunksCreated += newChunks.length;
            }

            // Store chunk references
            this.metadata.addChunkRefs(
              commitRecord.id,
              dedupedChunks.map((dc) => dc.id)
            );

            // Track blob -> chunk mapping
            if (blobSha) {
              newBlobChunkMap.set(blobSha, chunkIds);
            }
          }

          filesProcessed++;
          emitProgress({
            type: 'file_parsed',
            currentFile: change.path,
            totalFiles: filesToProcess.length,
            filesProcessed,
          });
        } catch (error) {
          console.error(`Error processing file ${change.path}:`, error);
          filesProcessed++;
        }

        // Store chunks in batches (only if embeddings enabled)
        if (embeddingsEnabled && allProcessedChunks.length >= this.batchSize) {
          await this.storeChunks(allProcessedChunks, repoId, commitSha, branch);
          allProcessedChunks.length = 0;
        }
      }

      // Store remaining chunks (only if embeddings enabled)
      if (embeddingsEnabled && allProcessedChunks.length > 0) {
        await this.storeChunks(allProcessedChunks, repoId, commitSha, branch);
      }

      // Store blob -> chunk mappings for newly processed files
      if (embeddingsEnabled && newBlobChunkMap.size > 0) {
        for (const [blobSha, chunkIds] of newBlobChunkMap) {
          this.metadata.storeBlobChunks(blobSha, chunkIds);
        }
      }

      // Store file -> blob mappings for all files in this commit
      const fileBlobMappings = allSupportedFiles.map((f) => ({
        filePath: f.path,
        blobSha: f.sha,
      }));
      this.metadata.storeFileBlobs(commitRecord.id, fileBlobMappings);

      // Copy SQI data from base commit for unchanged files
      const baseCommitRecordForSqi = this.metadata.getIndexedCommit(
        repoId,
        baseCommitSha
      );
      if (baseCommitRecordForSqi) {
        const sqiStorage = this.metadata.getSQIStorage();
        sqiStorage.copyUnchangedData(
          baseCommitRecordForSqi.id,
          commitRecord.id,
          [...changedPaths, ...deletedPaths]
        );
      }

      // Run SQI extraction for changed files (including those with indexed blobs - need SQI data)
      const sqiFiles: { path: string; content: string }[] = [];
      for (const change of filesToProcess) {
        try {
          const { content, isBinary } = await this.git.readFileAtCommit(
            commitSha,
            change.path
          );
          if (!isBinary) {
            sqiFiles.push({ path: change.path, content });
          }
        } catch {
          // File already processed, skip SQI errors
        }
      }

      if (sqiFiles.length > 0) {
        emitProgress({ type: 'sqi_extracting' } as IndexingProgressEvent);
        await this.sqiIndexer.indexFiles(sqiFiles, {
          repoId,
          commitId: commitRecord.id,
          linkUsages: true,
        });
      }

      // Mark indexing as complete
      const totalChunks = embeddingsEnabled 
        ? this.metadata.getCommitChunkCount(repoId, commitSha) 
        : 0;
      this.metadata.completeIndexing(commitRecord.id, totalChunks);

      emitProgress({
        type: 'completed',
        filesProcessed,
        chunksCreated: totalChunksCreated,
        chunksReused: totalChunks - totalChunksCreated,
      });

      return {
        success: true,
        repoId,
        commitSha,
        baseCommitSha,
        filesProcessed,
        chunksCreated: totalChunksCreated,
        chunksReused: totalChunks - totalChunksCreated,
        changedFiles: changedFiles.length,
        unchangedFiles: unchangedFiles.length,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      emitProgress({
        type: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof IndexerError) {
        throw error;
      }

      throw new IndexerError(
        `Incremental indexing failed: ${error instanceof Error ? error.message : String(error)}`,
        IndexerErrorCode.STORAGE_ERROR,
        error instanceof Error ? error : undefined
      );
    } finally {
      this.releaseLock(repoId, commitSha);
    }
  }

  /**
   * Get chunks for specific file paths
   */
  private async getChunksForPaths(
    allChunkIds: string[],
    paths: string[]
  ): Promise<Set<string>> {
    if (allChunkIds.length === 0 || paths.length === 0 || !this.vectors) {
      return new Set();
    }

    const pathSet = new Set(paths);
    const matchingChunkIds = new Set<string>();

    // Get chunk payloads in batches
    const batchSize = 100;
    for (let i = 0; i < allChunkIds.length; i += batchSize) {
      const batchIds = allChunkIds.slice(i, i + batchSize);
      const chunks = await this.vectors.getChunks(batchIds);

      for (const [id, payload] of chunks) {
        if (pathSet.has(payload.path)) {
          matchingChunkIds.add(id);
        }
      }
    }

    return matchingChunkIds;
  }

  /**
   * Store processed chunks in Qdrant
   */
  private async storeChunks(
    chunks: ProcessedChunk[],
    repoId: string,
    commitSha: string,
    branch?: string
  ): Promise<void> {
    if (chunks.length === 0 || !this.vectors) return;

    const upserts: ChunkUpsert[] = chunks.map((pc) => ({
      id: pc.id,
      vector: pc.embedding,
      payload: {
        repo_id: repoId,
        commits: [commitSha],
        branches: branch ? [branch] : [],
        path: pc.chunk.path,
        symbol: pc.chunk.symbol,
        symbol_type: pc.chunk.symbolType,
        language: pc.chunk.language,
        start_line: pc.chunk.startLine,
        end_line: pc.chunk.endLine,
        content: pc.chunk.content,
      } as ChunkPayload,
    }));

    await this.vectors.upsertChunks(upserts);
  }

  /**
   * Check if file is supported for indexing
   */
  private isSupportedFile(filePath: string): boolean {
    return detectLanguage(filePath) !== null;
  }

  /**
   * Get language from file path
   */
  private getLanguage(filePath: string): SupportedLanguage | undefined {
    return detectLanguage(filePath) ?? undefined;
  }
}

/**
 * Create an incremental indexer instance
 */
export function createIncrementalIndexer(
  repoPath: string,
  git: GitAdapter,
  metadata: MetadataStorage,
  vectors: QdrantStorage | null,
  embeddings: EmbeddingProvider | null,
  batchSize?: number
): IncrementalIndexer {
  return new IncrementalIndexer(
    repoPath,
    git,
    metadata,
    vectors,
    embeddings,
    batchSize
  );
}
