/**
 * Qdrant vector store client for SourceRack
 *
 * Provides vector storage and semantic search capabilities.
 * Dimensions are derived from the embedding provider configuration,
 * not hardcoded.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { minimatch } from 'minimatch';
import type { EmbeddingVector } from '../embeddings/types.js';

/**
 * Simple LRU Cache implementation for chunk existence checks
 */
class LRUCache<K, V> {
  private cache: Map<K, V>;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

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
 * Chunk payload stored alongside vectors in Qdrant
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
 * Search result from Qdrant
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
 * Qdrant connection configuration
 */
export interface QdrantConfig {
  /** Qdrant server URL */
  url: string;
  /** API key (optional, for cloud deployments) */
  apiKey?: string;
  /** Collection name */
  collectionName: string;
  /** Vector dimensions (derived from embedding provider) */
  dimensions: number;
}

/**
 * Chunk to upsert into Qdrant
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
 * Qdrant storage error
 */
export class QdrantStorageError extends Error {
  constructor(
    message: string,
    public readonly code: QdrantErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'QdrantStorageError';
  }
}

/**
 * Qdrant error codes
 */
export enum QdrantErrorCode {
  /** Connection failed */
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  /** Collection operation failed */
  COLLECTION_ERROR = 'COLLECTION_ERROR',
  /** Upsert operation failed */
  UPSERT_FAILED = 'UPSERT_FAILED',
  /** Search operation failed */
  SEARCH_FAILED = 'SEARCH_FAILED',
  /** Invalid configuration */
  INVALID_CONFIG = 'INVALID_CONFIG',
}

/**
 * Qdrant vector store client
 */
export class QdrantStorage {
  private client: QdrantClient;
  private collectionName: string;
  private dimensions: number;
  private initialized = false;
  /** LRU cache for chunk existence checks */
  private chunkExistsCache: LRUCache<string, boolean>;

  constructor(config: QdrantConfig) {
    if (!config.url) {
      throw new QdrantStorageError(
        'Qdrant URL is required',
        QdrantErrorCode.INVALID_CONFIG
      );
    }
    if (!config.collectionName) {
      throw new QdrantStorageError(
        'Collection name is required',
        QdrantErrorCode.INVALID_CONFIG
      );
    }
    if (!config.dimensions || config.dimensions <= 0) {
      throw new QdrantStorageError(
        'Vector dimensions must be positive',
        QdrantErrorCode.INVALID_CONFIG
      );
    }

    const clientConfig: { url: string; apiKey?: string } = {
      url: config.url,
    };
    if (config.apiKey) {
      clientConfig.apiKey = config.apiKey;
    }
    this.client = new QdrantClient(clientConfig);
    this.collectionName = config.collectionName;
    this.dimensions = config.dimensions;
    // Initialize LRU cache with 50000 entries (roughly 2-3MB memory)
    this.chunkExistsCache = new LRUCache<string, boolean>(50000);
  }

  /**
   * Initialize the Qdrant collection
   * Creates collection if it doesn't exist, with proper indexes
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === this.collectionName
      );

      if (!exists) {
        // Create collection with vector configuration
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.dimensions,
            distance: 'Cosine',
          },
        });

        // Create payload indexes for efficient filtering
        await this.createPayloadIndexes();
      }

      this.initialized = true;
    } catch (error) {
      throw new QdrantStorageError(
        `Failed to initialize Qdrant collection: ${error instanceof Error ? error.message : String(error)}`,
        QdrantErrorCode.COLLECTION_ERROR,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Create payload indexes for efficient filtering
   */
  private async createPayloadIndexes(): Promise<void> {
    const indexes = [
      { field: 'repo_id', type: 'keyword' as const },
      { field: 'commits', type: 'keyword' as const },
      { field: 'language', type: 'keyword' as const },
      { field: 'path', type: 'keyword' as const },
      { field: 'symbol_type', type: 'keyword' as const },
      { field: 'content_type', type: 'keyword' as const },
      { field: 'symbol', type: 'keyword' as const },
    ];

    for (const { field, type } of indexes) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: field,
          field_schema: type,
        });
      } catch (error) {
        // Index may already exist, ignore error
        console.warn(`Failed to create index for ${field}:`, error);
      }
    }
  }

  /**
   * Check if storage is ready
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Upsert a single chunk
   */
  async upsertChunk(chunk: ChunkUpsert): Promise<void> {
    await this.upsertChunks([chunk]);
  }

  /**
   * Upsert multiple chunks (bulk operation)
   */
  async upsertChunks(chunks: ChunkUpsert[]): Promise<void> {
    if (!this.initialized) {
      throw new QdrantStorageError(
        'Storage not initialized',
        QdrantErrorCode.COLLECTION_ERROR
      );
    }

    if (chunks.length === 0) return;

    try {
      const points = chunks.map((chunk) => ({
        id: chunk.id,
        vector: chunk.vector,
        payload: chunk.payload as unknown as Record<string, unknown>,
      }));

      await this.client.upsert(this.collectionName, {
        wait: true,
        points,
      });

      // Update cache to mark these chunks as existing
      for (const chunk of chunks) {
        this.chunkExistsCache.set(chunk.id, true);
      }
    } catch (error) {
      throw new QdrantStorageError(
        `Failed to upsert chunks: ${error instanceof Error ? error.message : String(error)}`,
        QdrantErrorCode.UPSERT_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Add a commit reference to an existing chunk
   * Used when a chunk already exists but appears in a new commit
   */
  async addCommitToChunk(chunkId: string, commitSha: string): Promise<void> {
    if (!this.initialized) {
      throw new QdrantStorageError(
        'Storage not initialized',
        QdrantErrorCode.COLLECTION_ERROR
      );
    }

    try {
      // Get existing point
      const results = await this.client.retrieve(this.collectionName, {
        ids: [chunkId],
        with_payload: true,
      });

      const existing = results[0];
      if (!existing) {
        throw new QdrantStorageError(
          `Chunk not found: ${chunkId}`,
          QdrantErrorCode.UPSERT_FAILED
        );
      }

      const payload = existing.payload as unknown as ChunkPayload;

      // Add commit if not already present
      if (!payload.commits.includes(commitSha)) {
        payload.commits.push(commitSha);

        await this.client.setPayload(this.collectionName, {
          payload: { commits: payload.commits } as unknown as Record<
            string,
            unknown
          >,
          points: [chunkId],
        });
      }
    } catch (error) {
      if (error instanceof QdrantStorageError) throw error;
      throw new QdrantStorageError(
        `Failed to add commit to chunk: ${error instanceof Error ? error.message : String(error)}`,
        QdrantErrorCode.UPSERT_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Semantic search within a specific commit
   */
  async search(
    queryVector: EmbeddingVector,
    filters: SearchFilters,
    limit: number = 10
  ): Promise<SearchResult[]> {
    if (!this.initialized) {
      throw new QdrantStorageError(
        'Storage not initialized',
        QdrantErrorCode.COLLECTION_ERROR
      );
    }

    try {
      // Build filter conditions
      const mustConditions: {
        key: string;
        match: { value: string } | { any: string[] };
      }[] = [
        { key: 'repo_id', match: { value: filters.repo_id } },
        { key: 'commits', match: { any: [filters.commit] } },
      ];

      if (filters.language) {
        mustConditions.push({
          key: 'language',
          match: { value: filters.language },
        });
      }

      // Content type filter - default to 'code' only unless explicitly overridden
      if (!filters.includeAllContentTypes) {
        if (filters.contentType) {
          const types = Array.isArray(filters.contentType)
            ? filters.contentType
            : [filters.contentType];
          mustConditions.push({
            key: 'content_type',
            match: { any: types },
          });
        } else {
          // Default: only search code
          mustConditions.push({
            key: 'content_type',
            match: { value: 'code' },
          });
        }
      }

      // Path pattern: request more results for post-filtering with glob patterns
      // because we can't do proper glob matching in Qdrant
      const hasPathPattern = !!filters.pathPattern;
      const searchLimit = hasPathPattern ? limit * 3 : limit;

      const results = await this.client.search(this.collectionName, {
        vector: queryVector,
        filter: {
          must: mustConditions,
        },
        limit: searchLimit,
        with_payload: true,
      });

      let mappedResults = results.map((result) => ({
        id: result.id as string,
        score: result.score,
        payload: result.payload as unknown as ChunkPayload,
      }));

      // Apply glob pattern filtering using minimatch
      if (filters.pathPattern) {
        mappedResults = mappedResults.filter((r) =>
          minimatch(r.payload.path, filters.pathPattern!, { matchBase: true })
        );
      }

      // Limit results after filtering
      return mappedResults.slice(0, limit);
    } catch (error) {
      throw new QdrantStorageError(
        `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        QdrantErrorCode.SEARCH_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get chunks by their IDs
   */
  async getChunks(chunkIds: string[]): Promise<Map<string, ChunkPayload>> {
    if (!this.initialized) {
      throw new QdrantStorageError(
        'Storage not initialized',
        QdrantErrorCode.COLLECTION_ERROR
      );
    }

    if (chunkIds.length === 0) {
      return new Map();
    }

    try {
      const results = await this.client.retrieve(this.collectionName, {
        ids: chunkIds,
        with_payload: true,
      });

      const chunks = new Map<string, ChunkPayload>();
      for (const result of results) {
        chunks.set(
          result.id as string,
          result.payload as unknown as ChunkPayload
        );
      }
      return chunks;
    } catch (error) {
      throw new QdrantStorageError(
        `Failed to get chunks: ${error instanceof Error ? error.message : String(error)}`,
        QdrantErrorCode.SEARCH_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if chunks exist by their IDs
   */
  async chunksExist(chunkIds: string[]): Promise<Set<string>> {
    if (!this.initialized) {
      throw new QdrantStorageError(
        'Storage not initialized',
        QdrantErrorCode.COLLECTION_ERROR
      );
    }

    if (chunkIds.length === 0) {
      return new Set();
    }

    const existingIds = new Set<string>();
    const uncachedIds: string[] = [];

    // Check cache first
    for (const id of chunkIds) {
      const cached = this.chunkExistsCache.get(id);
      if (cached !== undefined) {
        if (cached) {
          existingIds.add(id);
        }
      } else {
        uncachedIds.push(id);
      }
    }

    // If all were cached, return early
    if (uncachedIds.length === 0) {
      return existingIds;
    }

    try {
      // Query Qdrant for uncached IDs
      const results = await this.client.retrieve(this.collectionName, {
        ids: uncachedIds,
        with_payload: false,
      });

      // Build set of found IDs
      const foundIds = new Set(results.map((r) => r.id as string));

      // Update cache for all uncached IDs
      for (const id of uncachedIds) {
        const exists = foundIds.has(id);
        this.chunkExistsCache.set(id, exists);
        if (exists) {
          existingIds.add(id);
        }
      }

      return existingIds;
    } catch (error) {
      throw new QdrantStorageError(
        `Failed to check chunk existence: ${error instanceof Error ? error.message : String(error)}`,
        QdrantErrorCode.SEARCH_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete chunks by their IDs
   * Used during garbage collection
   */
  async deleteChunks(chunkIds: string[]): Promise<void> {
    if (!this.initialized) {
      throw new QdrantStorageError(
        'Storage not initialized',
        QdrantErrorCode.COLLECTION_ERROR
      );
    }

    if (chunkIds.length === 0) return;

    try {
      await this.client.delete(this.collectionName, {
        wait: true,
        points: chunkIds,
      });

      // Invalidate cache for deleted chunks
      for (const chunkId of chunkIds) {
        this.chunkExistsCache.delete(chunkId);
      }
    } catch (error) {
      throw new QdrantStorageError(
        `Failed to delete chunks: ${error instanceof Error ? error.message : String(error)}`,
        QdrantErrorCode.UPSERT_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete all chunks belonging to a repository
   * Used for index reset
   */
  async deleteByRepoId(repoId: string): Promise<number> {
    if (!this.initialized) {
      throw new QdrantStorageError(
        'Storage not initialized',
        QdrantErrorCode.COLLECTION_ERROR
      );
    }

    try {
      // Get count before deletion for reporting
      const countBefore = await this.client.count(this.collectionName, {
        filter: {
          must: [{ key: 'repo_id', match: { value: repoId } }],
        },
        exact: true,
      });

      // Delete all points with matching repo_id
      await this.client.delete(this.collectionName, {
        wait: true,
        filter: {
          must: [{ key: 'repo_id', match: { value: repoId } }],
        },
      });

      return countBefore.count;
    } catch (error) {
      throw new QdrantStorageError(
        `Failed to delete chunks for repo ${repoId}: ${error instanceof Error ? error.message : String(error)}`,
        QdrantErrorCode.UPSERT_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get collection statistics
   */
  async getStats(): Promise<{
    pointCount: number;
    segmentCount: number;
    dimensions: number;
  }> {
    if (!this.initialized) {
      throw new QdrantStorageError(
        'Storage not initialized',
        QdrantErrorCode.COLLECTION_ERROR
      );
    }

    try {
      const info = await this.client.getCollection(this.collectionName);
      return {
        pointCount: info.points_count ?? 0,
        segmentCount: info.segments_count ?? 0,
        dimensions: this.dimensions,
      };
    } catch (error) {
      throw new QdrantStorageError(
        `Failed to get stats: ${error instanceof Error ? error.message : String(error)}`,
        QdrantErrorCode.COLLECTION_ERROR,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Close the client connection
   */
  async close(): Promise<void> {
    // QdrantClient doesn't have an explicit close method
    // Just mark as not initialized
    this.initialized = false;
  }
}
