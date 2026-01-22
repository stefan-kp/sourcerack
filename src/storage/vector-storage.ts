/**
 * VectorStorage interface for SourceRack
 *
 * Provides an abstraction layer for vector storage backends.
 * Implementations: SqliteVssStorage (default), QdrantStorage (optional)
 */

import type { EmbeddingVector } from '../embeddings/types.js';

/**
 * Content type for filtering
 */
export type ContentType = 'code' | 'docs' | 'config';

/**
 * Determine content type from file path and language
 */
export function getContentType(filePath: string, language: string): ContentType {
  const lowerPath = filePath.toLowerCase();
  const ext = lowerPath.split('.').pop() ?? '';

  // Documentation files
  if (
    ext === 'md' ||
    ext === 'markdown' ||
    ext === 'rst' ||
    ext === 'txt' ||
    ext === 'adoc' ||
    language === 'markdown'
  ) {
    return 'docs';
  }

  // Configuration files
  if (
    ext === 'json' ||
    ext === 'yaml' ||
    ext === 'yml' ||
    ext === 'toml' ||
    ext === 'ini' ||
    ext === 'xml' ||
    ext === 'env' ||
    language === 'json' ||
    language === 'yaml' ||
    language === 'toml' ||
    lowerPath.includes('config') ||
    lowerPath.includes('.rc') ||
    lowerPath.endsWith('rc')
  ) {
    return 'config';
  }

  // Everything else is code
  return 'code';
}

/**
 * Chunk payload stored alongside vectors
 */
export interface ChunkPayload {
  /** Repository ID (UUID) */
  repo_id: string;
  /** Commit SHAs this chunk belongs to */
  commits: string[];
  /** Branch names (for reference, derived from commits) */
  branches: string[];
  /** File path within repository */
  path: string;
  /** Symbol name (function, class, etc.) */
  symbol: string;
  /** Symbol type */
  symbol_type: string;
  /** Programming language */
  language: string;
  /** Content type for filtering (code, docs, config) */
  content_type: ContentType;
  /** Start line number */
  start_line: number;
  /** End line number */
  end_line: number;
  /** Source code content */
  content: string;
  /** Whether the symbol is exported (optional, for ranking) */
  is_exported?: boolean;
}

/**
 * Search result from vector storage
 */
export interface SearchResult {
  /** Chunk ID (content-addressed hash) */
  id: string;
  /** Relevance score (0-1, higher is better) */
  score: number;
  /** Chunk payload */
  payload: ChunkPayload;
}

/**
 * Search filters for commit-scoped queries
 */
export interface SearchFilters {
  /** Repository ID (required) */
  repo_id: string;
  /** Commit SHA (required) */
  commit: string;
  /** Optional language filter */
  language?: string;
  /** Optional path pattern filter (glob-like) */
  pathPattern?: string;
  /** Optional content type filter (default: 'code') */
  contentType?: ContentType | ContentType[];
  /** Include all content types (overrides contentType filter) */
  includeAllContentTypes?: boolean;
}

/**
 * Chunk to upsert into vector storage
 */
export interface ChunkUpsert {
  /** Chunk ID (content-addressed hash) */
  id: string;
  /** Embedding vector */
  vector: EmbeddingVector;
  /** Chunk payload */
  payload: ChunkPayload;
}

/**
 * Vector storage error codes
 */
export enum VectorStorageErrorCode {
  /** Connection failed */
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  /** Collection/table operation failed */
  COLLECTION_ERROR = 'COLLECTION_ERROR',
  /** Upsert operation failed */
  UPSERT_FAILED = 'UPSERT_FAILED',
  /** Search operation failed */
  SEARCH_FAILED = 'SEARCH_FAILED',
  /** Invalid configuration */
  INVALID_CONFIG = 'INVALID_CONFIG',
  /** Not initialized */
  NOT_INITIALIZED = 'NOT_INITIALIZED',
}

/**
 * Base error class for vector storage errors
 */
export class VectorStorageError extends Error {
  constructor(
    message: string,
    public readonly code: VectorStorageErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'VectorStorageError';
  }
}

/**
 * Storage statistics
 */
export interface VectorStorageStats {
  /** Total number of vectors/points */
  pointCount: number;
  /** Number of segments (implementation-specific) */
  segmentCount: number;
  /** Vector dimensions */
  dimensions: number;
}

/**
 * Vector storage interface
 *
 * Implementations must provide all methods for vector storage operations.
 */
export interface VectorStorage {
  /**
   * Initialize the storage (create collection/tables if needed)
   */
  initialize(): Promise<void>;

  /**
   * Check if storage is ready for operations
   */
  isReady(): boolean;

  /**
   * Upsert a single chunk
   */
  upsertChunk(chunk: ChunkUpsert): Promise<void>;

  /**
   * Upsert multiple chunks (bulk operation)
   */
  upsertChunks(chunks: ChunkUpsert[]): Promise<void>;

  /**
   * Add a commit reference to an existing chunk
   * Used when a chunk already exists but appears in a new commit
   */
  addCommitToChunk(chunkId: string, commitSha: string): Promise<void>;

  /**
   * Semantic search within a specific commit
   */
  search(
    queryVector: EmbeddingVector,
    filters: SearchFilters,
    limit?: number
  ): Promise<SearchResult[]>;

  /**
   * Get chunks by their IDs
   */
  getChunks(chunkIds: string[]): Promise<Map<string, ChunkPayload>>;

  /**
   * Check if chunks exist by their IDs
   */
  chunksExist(chunkIds: string[]): Promise<Set<string>>;

  /**
   * Delete chunks by their IDs
   */
  deleteChunks(chunkIds: string[]): Promise<void>;

  /**
   * Delete all chunks belonging to a repository
   * Returns the number of deleted chunks
   */
  deleteByRepoId(repoId: string): Promise<number>;

  /**
   * Get storage statistics
   */
  getStats(): Promise<VectorStorageStats>;

  /**
   * Close the storage connection
   */
  close(): Promise<void>;
}
