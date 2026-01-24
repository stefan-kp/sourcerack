/**
 * Indexer types for SourceRack
 */

import type { CodeChunk } from '../parser/types.js';

/**
 * Progress event types for indexing
 */
export type IndexingEventType =
  | 'started'
  | 'incremental_start'
  | 'files_listed'
  | 'grammars_installing'
  | 'file_parsed'
  | 'chunks_embedded'
  | 'chunks_stored'
  | 'sqi_extracting'
  | 'completed'
  | 'failed';

/**
 * Progress event emitted during indexing
 */
export interface IndexingProgressEvent {
  /** Event type */
  type: IndexingEventType;
  /** Repository ID */
  repoId: string;
  /** Commit SHA being indexed */
  commitSha: string;
  /** Current file being processed (if applicable) */
  currentFile?: string;
  /** Total files to process */
  totalFiles?: number;
  /** Files processed so far */
  filesProcessed?: number;
  /** Total chunks created */
  chunksCreated?: number;
  /** Chunks reused from existing index */
  chunksReused?: number;
  /** Error message (for failed event) */
  error?: string;
  /** Missing grammars being installed (for grammars_installing event) */
  missingGrammars?: string[];
  /** Message for incremental_start event */
  message?: string;
  /** Timestamp */
  timestamp: Date;
}

/**
 * File coverage by language
 */
export interface LanguageCoverage {
  /** Language name */
  language: string;
  /** Number of files */
  fileCount: number;
  /** Whether SQI extraction is supported */
  sqiSupported: boolean;
}

/**
 * File coverage summary
 */
export interface FileCoverage {
  /** Total files found */
  totalFiles: number;
  /** Files with SQI support (symbols extracted) */
  sqiSupportedFiles: number;
  /** Files without SQI support (no symbol extraction) */
  unsupportedFiles: number;
  /** Coverage by language */
  byLanguage: LanguageCoverage[];
}

/**
 * Indexing result
 */
export interface IndexingResult {
  /** Whether indexing completed successfully */
  success: boolean;
  /** Repository ID */
  repoId: string;
  /** Commit SHA that was indexed */
  commitSha: string;
  /** Number of files processed */
  filesProcessed: number;
  /** Number of chunks created */
  chunksCreated: number;
  /** Number of chunks reused (for incremental indexing) */
  chunksReused: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Error message (if failed) */
  error?: string;
  /** File coverage summary */
  fileCoverage?: FileCoverage;
  /** Base commit SHA (when incremental indexing was used) */
  baseCommitSha?: string;
  /** Number of changed files (when incremental indexing was used) */
  changedFiles?: number;
  /** Number of unchanged files (when incremental indexing was used) */
  unchangedFiles?: number;
}

/**
 * Incremental indexing result
 */
export interface IncrementalIndexingResult extends IndexingResult {
  /** Base commit SHA (the previous indexed commit) */
  baseCommitSha: string;
  /** Files that changed between commits */
  changedFiles: number;
  /** Files that were unchanged */
  unchangedFiles: number;
}

/**
 * Indexing options
 */
export interface IndexingOptions {
  /** Repository path on disk */
  repoPath: string;
  /** Repository ID (UUID) */
  repoId: string;
  /** Commit SHA to index */
  commitSha: string;
  /** Branch name (for reference) */
  branch?: string;
  /** Progress callback */
  onProgress?: (event: IndexingProgressEvent) => void;
  /** Skip embedding generation (SQI-only indexing) */
  skipEmbeddings?: boolean;
  /** Force re-indexing even if commit is already indexed */
  force?: boolean;
}

/**
 * Incremental indexing options
 */
export interface IncrementalIndexingOptions extends IndexingOptions {
  /** Base commit SHA to compare against */
  baseCommitSha: string;
}

/**
 * Indexing lock status
 */
export interface IndexingLockStatus {
  /** Whether a lock exists */
  locked: boolean;
  /** Lock holder (if locked) */
  lockHolder?: string;
  /** When the lock was acquired */
  lockedAt?: Date;
  /** Commit being indexed */
  commitSha?: string;
}

/**
 * Processed chunk with ID and embedding
 */
export interface ProcessedChunk {
  /** Content-addressed chunk ID */
  id: string;
  /** The code chunk */
  chunk: CodeChunk;
  /** Embedding vector */
  embedding: number[];
}

/**
 * Indexer error
 */
export class IndexerError extends Error {
  constructor(
    message: string,
    public readonly code: IndexerErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'IndexerError';
  }
}

/**
 * Indexer error codes
 */
export enum IndexerErrorCode {
  /** Repository not found */
  REPO_NOT_FOUND = 'REPO_NOT_FOUND',
  /** Commit not found */
  COMMIT_NOT_FOUND = 'COMMIT_NOT_FOUND',
  /** Indexing already in progress */
  INDEXING_IN_PROGRESS = 'INDEXING_IN_PROGRESS',
  /** Parsing failed */
  PARSE_ERROR = 'PARSE_ERROR',
  /** Embedding failed */
  EMBEDDING_ERROR = 'EMBEDDING_ERROR',
  /** Storage error */
  STORAGE_ERROR = 'STORAGE_ERROR',
  /** Lock acquisition failed */
  LOCK_FAILED = 'LOCK_FAILED',
}
