/**
 * Indexer orchestrator for SourceRack
 *
 * Coordinates the full indexing pipeline:
 * resolve commit → list files → parse → chunk → embed → store
 */

import { GitAdapter } from '../git/adapter.js';
import { parseFile } from '../parser/chunker.js';
import {
  detectLanguage,
  getMissingGrammars,
  preInstallGrammars,
} from '../parser/tree-sitter.js';
import { deduplicateChunks } from '../storage/dedup.js';
import { MetadataStorage } from '../storage/metadata.js';
import type { EmbeddingStatus } from '../storage/types.js';
import type { VectorStorage, ChunkPayload, ChunkUpsert } from '../storage/vector-storage.js';
import { getContentType } from '../storage/vector-storage.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { SupportedLanguage } from '../parser/types.js';
import {
  type IndexingOptions,
  type IndexingResult,
  type IndexingProgressEvent,
  type ProcessedChunk,
  type FileCoverage,
  type LanguageCoverage,
  IndexerError,
  IndexerErrorCode,
} from './types.js';
import { createSQIIndexer, SQIIndexer } from '../sqi/sqi-indexer.js';
import { getExtractorRegistry } from '../sqi/extractors/registry.js';


/**
 * In-memory lock storage for concurrent indexing protection
 */
const indexingLocks = new Map<
  string,
  { holder: string; lockedAt: Date; commitSha: string }
>();

/**
 * Generate lock key for a repository + commit combination
 */
function getLockKey(repoId: string, commitSha: string): string {
  return `${repoId}:${commitSha}`;
}

/**
 * Indexer orchestrator
 */
export class Indexer {
  private git: GitAdapter;
  private metadata: MetadataStorage;
  private vectors: VectorStorage | null;
  private embeddings: EmbeddingProvider | null;
  private batchSize: number;
  private sqiIndexer: SQIIndexer;
  private fileContentCache = new Map<string, { content: string; isBinary: boolean }>();

  constructor(
    git: GitAdapter,
    metadata: MetadataStorage,
    vectors: VectorStorage | null,
    embeddings: EmbeddingProvider | null,
    batchSize: number = 32
  ) {
    this.git = git;
    this.metadata = metadata;
    this.vectors = vectors;
    this.embeddings = embeddings;
    this.batchSize = batchSize;
    this.sqiIndexer = createSQIIndexer(metadata.getSQIStorage());
  }


  /**
   * Get file content with caching during an index run
   */
  private async getFileContent(commitSha: string, path: string): Promise<{ content: string; isBinary: boolean }> {
    const key = `${commitSha}:${path}`;
    const cached = this.fileContentCache.get(key);
    if (cached) {
      return cached;
    }
    const result = await this.git.readFileAtCommit(commitSha, path);
    this.fileContentCache.set(key, result);
    return result;
  }

  /**
   * Acquire lock for indexing
   */
  private acquireLock(
    repoId: string,
    commitSha: string,
    holder: string
  ): boolean {
    const key = getLockKey(repoId, commitSha);
    if (indexingLocks.has(key)) {
      return false;
    }
    indexingLocks.set(key, {
      holder,
      lockedAt: new Date(),
      commitSha,
    });
    return true;
  }

  /**
   * Release lock for indexing
   */
  private releaseLock(repoId: string, commitSha: string): void {
    const key = getLockKey(repoId, commitSha);
    indexingLocks.delete(key);
  }

  /**
   * Check if indexing is in progress
   */
  isIndexingInProgress(repoId: string, commitSha: string): boolean {
    const key = getLockKey(repoId, commitSha);
    return indexingLocks.has(key);
  }

  /**
   * Get lock status
   */
  getLockStatus(
    repoId: string,
    commitSha: string
  ): {
    locked: boolean;
    holder?: string;
    lockedAt?: Date;
  } {
    const key = getLockKey(repoId, commitSha);
    const lock = indexingLocks.get(key);
    if (!lock) {
      return { locked: false };
    }
    return {
      locked: true,
      holder: lock.holder,
      lockedAt: lock.lockedAt,
    };
  }

  /**
   * Index a commit (full indexing)
   */
  async indexCommit(options: IndexingOptions): Promise<IndexingResult> {
    const { repoId, commitSha, branch, onProgress, skipEmbeddings, force } = options;
    const startTime = Date.now();
    const lockHolder = `indexer-${Date.now()}`;

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
        `Indexing already in progress for ${repoId}:${commitSha}`,
        IndexerErrorCode.INDEXING_IN_PROGRESS
      );
    }

    try {
      emitProgress({ type: 'started' });

      // Handle force re-indexing
      if (force) {
        const existingCommit = this.metadata.getIndexedCommit(repoId, commitSha);
        if (existingCommit) {
          console.log(`🔄 Force re-indexing: removing existing index for ${commitSha.slice(0, 8)}`);
          this.metadata.deleteCommitRecord(repoId, commitSha);
        }
      } else {
        // Check if already indexed (idempotent)
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
            filesProcessed: 0,
            chunksCreated: 0,
            chunksReused: 0,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Verify commit exists
      const commitExists = await this.git.commitExists(commitSha);
      if (!commitExists) {
        throw new IndexerError(
          `Commit not found: ${commitSha}`,
          IndexerErrorCode.COMMIT_NOT_FOUND
        );
      }

      // Start indexing record in metadata with appropriate embedding status
      const commitRecord = this.metadata.startIndexing(repoId, commitSha, embeddingStatus);

      // List files at commit
      const files = await this.git.listFilesAtCommit(commitSha);
      const supportedFiles = files.filter((f) =>
        this.isSupportedFile(f.path)
      );

      // Compute file coverage by language
      const fileCoverage = this.computeFileCoverage(supportedFiles.map((f) => f.path));

      emitProgress({
        type: 'files_listed',
        totalFiles: supportedFiles.length,
        filesProcessed: 0,
      });

      // Pre-install any missing grammars
      const filePaths = supportedFiles.map((f) => f.path);
      const missingGrammars = await getMissingGrammars(filePaths);
      if (missingGrammars.length > 0) {
        emitProgress({
          type: 'grammars_installing',
          missingGrammars,
        } as IndexingProgressEvent);

        const installResults = await preInstallGrammars(filePaths);
        if (installResults.failed.length > 0) {
          console.warn(
            `⚠️  Failed to install grammars: ${installResults.failed.join(', ')} - files with these languages will be skipped`
          );
        }
        if (installResults.installed.length > 0) {
          console.log(
            `Installed grammars: ${installResults.installed.join(', ')}`
          );
        }
      }

      // Phase 2: File-Level Skip - Check which blobs are already indexed
      const allBlobShas = supportedFiles.map((f) => f.sha);
      const indexedBlobSet = embeddingsEnabled 
        ? this.metadata.getIndexedBlobs(allBlobShas) 
        : new Set<string>();

      // Separate files into those with indexed blobs and those needing parsing
      const filesToParse: typeof supportedFiles = [];
      const filesWithIndexedBlobs: typeof supportedFiles = [];
      
      for (const file of supportedFiles) {
        if (indexedBlobSet.has(file.sha)) {
          filesWithIndexedBlobs.push(file);
        } else {
          filesToParse.push(file);
        }
      }

      // For files with indexed blobs, try to reuse chunk IDs (only if embeddings enabled)
      // Track blobs that have orphaned chunk references (chunks no longer in Qdrant)
      const orphanedBlobs = new Set<string>();
      
      if (embeddingsEnabled && filesWithIndexedBlobs.length > 0) {
        const indexedBlobShas = filesWithIndexedBlobs.map((f) => f.sha);
        const blobChunkMap = this.metadata.getChunksForBlobs(indexedBlobShas);
        
        // First, verify which chunks actually exist in Qdrant
        const allChunkIds: string[] = [];
        for (const [, chunkIds] of blobChunkMap) {
          allChunkIds.push(...chunkIds);
        }
        
        // Batch check which chunks exist
        const existingChunks = allChunkIds.length > 0 
          ? await this.vectors!.chunksExist(allChunkIds)
          : new Set<string>();
        
        // Collect valid reused chunk IDs and identify orphaned blobs
        const reusedChunkIds: string[] = [];
        for (const blobSha of indexedBlobShas) {
          const chunkIds = blobChunkMap.get(blobSha);
          if (chunkIds && chunkIds.length > 0) {
            // Check if ALL chunks for this blob exist
            const allExist = chunkIds.every((id) => existingChunks.has(id));
            if (allExist) {
              reusedChunkIds.push(...chunkIds);
            } else {
              // Some chunks are missing - mark blob as orphaned
              orphanedBlobs.add(blobSha);
            }
          } else {
            // No chunks in mapping - this shouldn't happen but handle it
            orphanedBlobs.add(blobSha);
          }
        }

        // Clean up orphaned blob_chunks entries
        if (orphanedBlobs.size > 0) {
          this.metadata.deleteBlobChunks(Array.from(orphanedBlobs));
        }

        // Add chunk references to new commit (only for valid chunks)
        if (reusedChunkIds.length > 0) {
          this.metadata.addChunkRefs(commitRecord.id, reusedChunkIds);

          // Update commit references in vector store
          for (const chunkId of reusedChunkIds) {
            try {
              await this.vectors!.addCommitToChunk(chunkId, commitSha);
            } catch (error) {
              // Chunk might have been deleted between check and update - rare race condition
              console.warn(`Chunk ${chunkId} not found during reuse:`, error);
            }
          }
        }

        emitProgress({
          type: 'chunks_stored',
          chunksReused: reusedChunkIds.length,
        });
      }
      
      // Move files with orphaned blobs back to filesToParse
      for (const file of filesWithIndexedBlobs) {
        if (orphanedBlobs.has(file.sha)) {
          filesToParse.push(file);
        }
      }

      // Process files that need parsing
      const allProcessedChunks: ProcessedChunk[] = [];
      // Count reused files as already processed (exclude orphaned ones that got moved to filesToParse)
      let filesProcessed = filesWithIndexedBlobs.length - orphanedBlobs.size;

      // Collect files for SQI batch processing
      const sqiFiles: { path: string; content: string }[] = [];

      // Track new blob -> chunk mappings for Phase 2
      const newBlobChunkMap = new Map<string, string[]>();

      for (const file of filesToParse) {
        try {
          // Read file content
          const { content, isBinary } = await this.getFileContent(
            commitSha,
            file.path
          );

          if (isBinary) {
            filesProcessed++;
            continue;
          }

          // Collect for SQI indexing
          sqiFiles.push({ path: file.path, content });

          // Only process chunks if embeddings are enabled
          if (embeddingsEnabled) {
            // Parse file into chunks
            const language = this.getLanguage(file.path);
            const parseResult = await parseFile(file.path, content, language);

            if (parseResult.chunks.length === 0) {
              filesProcessed++;
              emitProgress({
                type: 'file_parsed',
                currentFile: file.path,
                totalFiles: supportedFiles.length,
                filesProcessed,
              });
              continue;
            }

            // Deduplicate chunks
            const dedupedChunks = deduplicateChunks(parseResult.chunks);

            // Check which chunks already exist in vector store
            const chunkIds = dedupedChunks.map((dc) => dc.id);
            const existingChunks = await this.vectors!.chunksExist(chunkIds);

            // Separate new chunks from existing ones
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
              } catch (error) {
                // Chunk might have been deleted, treat as new
                console.warn(`Chunk ${dc.id} not found, will recreate:`, error);
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

              emitProgress({
                type: 'chunks_embedded',
                currentFile: file.path,
                chunksCreated: allProcessedChunks.length,
              });
            }

            // Store chunk references in metadata
            this.metadata.addChunkRefs(
              commitRecord.id,
              dedupedChunks.map((dc) => dc.id)
            );

            // Track blob -> chunk mapping for Phase 2
            newBlobChunkMap.set(file.sha, chunkIds);
          }

          filesProcessed++;
          emitProgress({
            type: 'file_parsed',
            currentFile: file.path,
            totalFiles: supportedFiles.length,
            filesProcessed,
          });
        } catch (error) {
          // Log error but continue with other files
          console.error(`Error processing file ${file.path}:`, error);
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

      // Store blob -> chunk mappings for newly processed files (Phase 2)
      if (embeddingsEnabled && newBlobChunkMap.size > 0) {
        for (const [blobSha, chunkIds] of newBlobChunkMap) {
          this.metadata.storeBlobChunks(blobSha, chunkIds);
        }
      }

      // Store file -> blob mappings for this commit
      const fileBlobMappings = supportedFiles.map((f) => ({
        filePath: f.path,
        blobSha: f.sha,
      }));
      this.metadata.storeFileBlobs(commitRecord.id, fileBlobMappings);

      // Also collect SQI content for files with indexed blobs (need content for SQI)
      for (const file of filesWithIndexedBlobs) {
        try {
          const { content, isBinary } = await this.getFileContent(
            commitSha,
            file.path
          );
          if (!isBinary) {
            sqiFiles.push({ path: file.path, content });
          }
        } catch (error) {
          console.error(`Error reading file for SQI ${file.path}:`, error);
        }
      }

      // Run SQI extraction for structural index
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
        chunksCreated: totalChunks,
        chunksReused: 0,
      });

      return {
        success: true,
        repoId,
        commitSha,
        filesProcessed,
        chunksCreated: totalChunks,
        chunksReused: 0,
        durationMs: Date.now() - startTime,
        fileCoverage,
      };
    } catch (error) {
      // Mark as failed if we started indexing
      emitProgress({
        type: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof IndexerError) {
        throw error;
      }

      throw new IndexerError(
        `Indexing failed: ${error instanceof Error ? error.message : String(error)}`,
        IndexerErrorCode.STORAGE_ERROR,
        error instanceof Error ? error : undefined
      );
    } finally {
      // Always release lock
      this.releaseLock(repoId, commitSha);
      this.fileContentCache.clear();
    }
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
        content_type: getContentType(pc.chunk.path, pc.chunk.language),
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

  /**
   * Compute file coverage by language
   */
  private computeFileCoverage(filePaths: string[]): FileCoverage {
    const sqiRegistry = getExtractorRegistry();
    const languageCounts = new Map<string, { count: number; sqiSupported: boolean }>();

    for (const filePath of filePaths) {
      const language = detectLanguage(filePath);
      if (!language) continue;

      const existing = languageCounts.get(language);
      const sqiSupported = sqiRegistry.isSupported(language);

      if (existing) {
        existing.count++;
      } else {
        languageCounts.set(language, { count: 1, sqiSupported });
      }
    }

    // Convert to array and sort by file count (descending)
    const byLanguage: LanguageCoverage[] = Array.from(languageCounts.entries())
      .map(([language, { count, sqiSupported }]) => ({
        language,
        fileCount: count,
        sqiSupported,
      }))
      .sort((a, b) => b.fileCount - a.fileCount);

    const sqiSupportedFiles = byLanguage
      .filter((l) => l.sqiSupported)
      .reduce((sum, l) => sum + l.fileCount, 0);

    const unsupportedFiles = byLanguage
      .filter((l) => !l.sqiSupported)
      .reduce((sum, l) => sum + l.fileCount, 0);

    return {
      totalFiles: filePaths.length,
      sqiSupportedFiles,
      unsupportedFiles,
      byLanguage,
    };
  }
}

/**
 * Create an indexer instance
 */
export function createIndexer(
  git: GitAdapter,
  metadata: MetadataStorage,
  vectors: VectorStorage | null,
  embeddings: EmbeddingProvider | null,
  batchSize?: number
): Indexer {
  return new Indexer(git, metadata, vectors, embeddings, batchSize);
}
