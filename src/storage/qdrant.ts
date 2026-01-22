/**
 * Qdrant vector store client for SourceRack
 *
 * Provides vector storage and semantic search capabilities.
 * Dimensions are derived from the embedding provider configuration,
 * not hardcoded.
 *
 * This is an optional backend - requires Docker/Qdrant server.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { minimatch } from 'minimatch';
import type { EmbeddingVector } from '../embeddings/types.js';
import {
  type VectorStorage,
  type ChunkPayload,
  type SearchResult,
  type SearchFilters,
  type ChunkUpsert,
  VectorStorageError,
  VectorStorageErrorCode,
} from './vector-storage.js';

// Re-export types for backward compatibility
export {
  type ChunkPayload,
  type SearchResult,
  type SearchFilters,
  type ChunkUpsert,
  type ContentType,
  getContentType,
  VectorStorageError,
  VectorStorageErrorCode,
} from './vector-storage.js';

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
 * Qdrant storage error (deprecated, use VectorStorageError)
 * @deprecated Use VectorStorageError instead
 */
export class QdrantStorageError extends VectorStorageError {
  constructor(
    message: string,
    code: QdrantErrorCode,
    cause?: Error
  ) {
    // Map old codes to new codes
    const mappedCode = {
      [QdrantErrorCode.CONNECTION_FAILED]: VectorStorageErrorCode.CONNECTION_FAILED,
      [QdrantErrorCode.COLLECTION_ERROR]: VectorStorageErrorCode.COLLECTION_ERROR,
      [QdrantErrorCode.UPSERT_FAILED]: VectorStorageErrorCode.UPSERT_FAILED,
      [QdrantErrorCode.SEARCH_FAILED]: VectorStorageErrorCode.SEARCH_FAILED,
      [QdrantErrorCode.INVALID_CONFIG]: VectorStorageErrorCode.INVALID_CONFIG,
    }[code];
    super(message, mappedCode, cause);
    this.name = 'QdrantStorageError';
  }
}

/**
 * Qdrant error codes (deprecated, use VectorStorageErrorCode)
 * @deprecated Use VectorStorageErrorCode instead
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
 *
 * Implements VectorStorage interface for Qdrant backend.
 */
export class QdrantStorage implements VectorStorage {
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
