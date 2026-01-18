/**
 * Storage-related types for SourceRack
 */

/**
 * Repository record in database
 */
export interface RepositoryRecord {
  id: string;
  path: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/**
 * Indexed commit status
 */
export type IndexedCommitStatus = 'in_progress' | 'complete' | 'failed';

/**
 * Embedding status for indexed commits
 */
export type EmbeddingStatus = 'none' | 'pending' | 'complete';

/**
 * Indexed commit record in database
 */
export interface IndexedCommitRecord {
  id: number;
  repo_id: string;
  commit_sha: string;
  indexed_at: string;
  chunk_count: number;
  status: IndexedCommitStatus;
  embedding_status: EmbeddingStatus;
}

/**
 * Chunk reference record (deduplication)
 */
export interface ChunkRefRecord {
  chunk_id: string;
  commit_id: number;
}

/**
 * GC candidate record
 */
export interface GCCandidateRecord {
  commit_id: number;
  orphaned_at: string;
  eligible_for_gc_at: string;
}

/**
 * Repository with indexed commit count
 */
export interface RepositoryWithStats extends RepositoryRecord {
  indexed_commit_count: number;
}

/**
 * Storage error
 */
export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: StorageErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Storage error codes
 */
export enum StorageErrorCode {
  /** Database initialization failed */
  INIT_FAILED = 'INIT_FAILED',
  /** Record not found */
  NOT_FOUND = 'NOT_FOUND',
  /** Duplicate record */
  DUPLICATE = 'DUPLICATE',
  /** Query execution failed */
  QUERY_FAILED = 'QUERY_FAILED',
  /** Transaction failed */
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
}
