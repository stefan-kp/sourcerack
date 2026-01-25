/**
 * SQLite-vec vector storage for SourceRack
 *
 * Provides vector storage and semantic search using SQLite with sqlite-vec extension.
 * This is the default storage backend - no Docker required.
 *
 * Uses vec0 virtual tables for efficient kNN search.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { minimatch } from 'minimatch';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EmbeddingVector } from '../embeddings/types.js';
import {
  type VectorStorage,
  type ChunkPayload,
  type SearchResult,
  type SearchFilters,
  type ChunkUpsert,
  type VectorStorageStats,
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
 * SQLite-vec configuration
 */
export interface SqliteVssConfig {
  /** Path to the SQLite database file */
  databasePath: string;
  /** Vector dimensions (derived from embedding provider) */
  dimensions: number;
}

/**
 * SQLite-vec storage implementation
 *
 * Uses sqlite-vec extension for efficient vector search.
 * Two-table design:
 * - vec_embeddings: vec0 virtual table for vector storage and kNN search
 * - chunk_metadata: regular table for payload/metadata
 */
export class SqliteVssStorage implements VectorStorage {
  private db: Database.Database | null = null;
  private databasePath: string;
  private dimensions: number;
  private initialized = false;
  private chunkExistsCache: LRUCache<string, boolean>;

  constructor(config: SqliteVssConfig) {
    if (!config.databasePath) {
      throw new VectorStorageError(
        'Database path is required',
        VectorStorageErrorCode.INVALID_CONFIG
      );
    }
    if (!config.dimensions || config.dimensions <= 0) {
      throw new VectorStorageError(
        'Vector dimensions must be positive',
        VectorStorageErrorCode.INVALID_CONFIG
      );
    }

    this.databasePath = config.databasePath;
    this.dimensions = config.dimensions;
    this.chunkExistsCache = new LRUCache<string, boolean>(50000);
  }

  /**
   * Initialize the SQLite database with sqlite-vec extension
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure directory exists
      const dir = dirname(this.databasePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Open database
      this.db = new Database(this.databasePath);

      // Load sqlite-vec extension
      sqliteVec.load(this.db);

      // Configure for performance
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');

      // Create schema
      this.createSchema();

      this.initialized = true;
    } catch (error) {
      throw new VectorStorageError(
        `Failed to initialize SQLite-vec: ${error instanceof Error ? error.message : String(error)}`,
        VectorStorageErrorCode.CONNECTION_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Create database schema with vec0 virtual table
   */
  private createSchema(): void {
    if (!this.db) return;

    // Check if we need to migrate from old schema
    const hasOldTable = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='vector_chunks'"
      )
      .get();

    if (hasOldTable) {
      // Migrate from old schema
      this.migrateFromOldSchema();
    }

    // Check if we need to migrate from L2 to Cosine distance
    const hasOldVecTable = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_embeddings'"
      )
      .get();

    if (hasOldVecTable) {
      // Check if it's the old L2 table (no distance_metric)
      // We can detect this by checking the table schema
      const tableInfo = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_embeddings'")
        .get() as { sql: string } | undefined;

      // If it doesn't have distance_metric=cosine, migrate
      if (tableInfo && !tableInfo.sql.includes('distance_metric=cosine')) {
        this.migrateToCosineSimilarity();
      }
    } else {
      // Create vec0 virtual table for embeddings with COSINE distance
      // This gives us 0-1 similarity scores like other vector DBs
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
          embedding float[${this.dimensions}] distance_metric=cosine
        )
      `);
    }

    // Create metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_metadata (
        id TEXT PRIMARY KEY,
        rowid_ref INTEGER UNIQUE,
        repo_id TEXT NOT NULL,
        commits TEXT NOT NULL,
        branches TEXT NOT NULL,
        path TEXT NOT NULL,
        symbol TEXT,
        symbol_type TEXT,
        language TEXT NOT NULL,
        content_type TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        content TEXT NOT NULL,
        is_exported INTEGER
      )
    `);

    // Create indexes for efficient filtering
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunk_metadata_repo_id ON chunk_metadata(repo_id);
      CREATE INDEX IF NOT EXISTS idx_chunk_metadata_language ON chunk_metadata(language);
      CREATE INDEX IF NOT EXISTS idx_chunk_metadata_content_type ON chunk_metadata(content_type);
      CREATE INDEX IF NOT EXISTS idx_chunk_metadata_path ON chunk_metadata(path);
      CREATE INDEX IF NOT EXISTS idx_chunk_metadata_rowid_ref ON chunk_metadata(rowid_ref);
    `);
  }

  /**
   * Migrate from L2 distance to Cosine similarity
   * This requires recreating the vec0 table
   */
  private migrateToCosineSimilarity(): void {
    if (!this.db) return;

    console.log('Migrating vector storage from L2 to Cosine similarity...');
    console.log('This requires re-indexing. Please run: sourcerack index --force');

    // Drop the old L2-based table
    this.db.exec('DROP TABLE IF EXISTS vec_embeddings');

    // Create new table with Cosine distance
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
        embedding float[${this.dimensions}] distance_metric=cosine
      )
    `);

    // Clear metadata since vectors are gone
    this.db.exec('DELETE FROM chunk_metadata');

    console.log('Migration complete. Vector data cleared.');
  }

  /**
   * Migrate from old vector_chunks table to new schema
   */
  private migrateFromOldSchema(): void {
    if (!this.db) return;

    // Check if new tables already exist
    const hasNewTable = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_metadata'"
      )
      .get();

    if (hasNewTable) {
      // Already migrated, just drop old table
      this.db.exec('DROP TABLE IF EXISTS vector_chunks');
      return;
    }

    console.log('Migrating vector storage to sqlite-vec format...');

    // Old schema had embedding as BLOB, we need to re-insert into vec0
    // For now, just drop the old table - user needs to re-index
    this.db.exec('DROP TABLE IF EXISTS vector_chunks');

    console.log(
      'Migration complete. Please re-index your repositories with: sourcerack index'
    );
  }

  /**
   * Check if storage is ready
   */
  isReady(): boolean {
    return this.initialized && this.db !== null;
  }

  /**
   * Ensure storage is initialized
   */
  private ensureReady(): void {
    if (!this.initialized || !this.db) {
      throw new VectorStorageError(
        'Storage not initialized',
        VectorStorageErrorCode.NOT_INITIALIZED
      );
    }
  }

  /**
   * Convert EmbeddingVector to Float32Array for sqlite-vec
   * sqlite-vec expects vectors as Float32Array
   */
  private toFloat32Array(vector: EmbeddingVector): Float32Array {
    return new Float32Array(vector);
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
    this.ensureReady();
    if (chunks.length === 0) return;

    try {
      const insertVec = this.db!.prepare(`
        INSERT INTO vec_embeddings(rowid, embedding)
        VALUES (?, ?)
      `);

      const updateVec = this.db!.prepare(`
        UPDATE vec_embeddings SET embedding = ? WHERE rowid = ?
      `);

      const insertMeta = this.db!.prepare(`
        INSERT OR REPLACE INTO chunk_metadata (
          id, rowid_ref, repo_id, commits, branches, path, symbol, symbol_type,
          language, content_type, start_line, end_line, content, is_exported
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const getExisting = this.db!.prepare(`
        SELECT rowid_ref FROM chunk_metadata WHERE id = ?
      `);

      const getMaxRowid = this.db!.prepare(`
        SELECT COALESCE(MAX(rowid_ref), 0) as max_rowid FROM chunk_metadata
      `);

      const transaction = this.db!.transaction((items: ChunkUpsert[]) => {
        // Get current max rowid
        const maxResult = getMaxRowid.get() as { max_rowid: number | null };
        let nextRowid = (maxResult.max_rowid ?? 0) + 1;

        for (const chunk of items) {
          const embedding = this.toFloat32Array(chunk.vector);

          // Check if chunk already exists
          const existing = getExisting.get(chunk.id) as
            | { rowid_ref: number }
            | undefined;

          let rowidRef: number;
          if (existing) {
            // Update existing embedding
            rowidRef = existing.rowid_ref;
            updateVec.run(embedding, BigInt(rowidRef));
          } else {
            // Insert new embedding with explicit BigInt rowid
            rowidRef = nextRowid;
            nextRowid += 1;
            insertVec.run(BigInt(rowidRef), embedding);
          }

          // Upsert metadata
          insertMeta.run(
            chunk.id,
            rowidRef,
            chunk.payload.repo_id,
            JSON.stringify(chunk.payload.commits),
            JSON.stringify(chunk.payload.branches),
            chunk.payload.path,
            chunk.payload.symbol,
            chunk.payload.symbol_type,
            chunk.payload.language,
            chunk.payload.content_type,
            chunk.payload.start_line,
            chunk.payload.end_line,
            chunk.payload.content,
            chunk.payload.is_exported ? 1 : 0
          );
        }
      });

      transaction(chunks);

      // Update cache
      for (const chunk of chunks) {
        this.chunkExistsCache.set(chunk.id, true);
      }
    } catch (error) {
      throw new VectorStorageError(
        `Failed to upsert chunks: ${error instanceof Error ? error.message : String(error)}`,
        VectorStorageErrorCode.UPSERT_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Add a commit reference to an existing chunk
   */
  async addCommitToChunk(chunkId: string, commitSha: string): Promise<void> {
    this.ensureReady();

    try {
      const row = this.db!.prepare(
        'SELECT commits FROM chunk_metadata WHERE id = ?'
      ).get(chunkId) as { commits: string } | undefined;

      if (!row) {
        throw new VectorStorageError(
          `Chunk not found: ${chunkId}`,
          VectorStorageErrorCode.UPSERT_FAILED
        );
      }

      const commits: string[] = JSON.parse(row.commits);
      if (!commits.includes(commitSha)) {
        commits.push(commitSha);
        this.db!.prepare(
          'UPDATE chunk_metadata SET commits = ? WHERE id = ?'
        ).run(JSON.stringify(commits), chunkId);
      }
    } catch (error) {
      if (error instanceof VectorStorageError) throw error;
      throw new VectorStorageError(
        `Failed to add commit to chunk: ${error instanceof Error ? error.message : String(error)}`,
        VectorStorageErrorCode.UPSERT_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Semantic search within a specific commit
   *
   * Uses sqlite-vec's kNN search for efficient vector similarity.
   * Post-filters results by metadata constraints.
   */
  async search(
    queryVector: EmbeddingVector,
    filters: SearchFilters,
    limit: number = 10
  ): Promise<SearchResult[]> {
    this.ensureReady();

    try {
      // Convert query vector
      const queryEmbedding = this.toFloat32Array(queryVector);

      // We fetch more candidates than needed because we'll filter by metadata
      // The vec0 kNN search doesn't support WHERE clauses directly
      const hasPathPattern = !!filters.pathPattern;
      const fetchLimit = Math.max(limit * 5, 100); // Fetch more for filtering

      // Perform kNN search using vec0
      // This returns rowids sorted by distance (ascending)
      const knnResults = this.db!.prepare(`
        SELECT
          rowid,
          distance
        FROM vec_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(queryEmbedding, fetchLimit) as { rowid: number; distance: number }[];

      if (knnResults.length === 0) {
        return [];
      }

      // Get rowids for metadata lookup
      const rowids = knnResults.map((r) => r.rowid);
      const distanceMap = new Map(knnResults.map((r) => [r.rowid, r.distance]));

      // Build metadata filter query
      const conditions: string[] = ['rowid_ref IN (' + rowids.join(',') + ')'];
      const params: (string | number)[] = [];

      conditions.push('repo_id = ?');
      params.push(filters.repo_id);

      // Commit filter
      conditions.push("commits LIKE ?");
      params.push(`%"${filters.commit}"%`);

      if (filters.language) {
        conditions.push('language = ?');
        params.push(filters.language);
      }

      // Content type filter
      if (!filters.includeAllContentTypes) {
        if (filters.contentType) {
          const types = Array.isArray(filters.contentType)
            ? filters.contentType
            : [filters.contentType];
          conditions.push(
            `content_type IN (${types.map(() => '?').join(', ')})`
          );
          params.push(...types);
        } else {
          conditions.push('content_type = ?');
          params.push('code');
        }
      }

      const whereClause = conditions.join(' AND ');

      // Fetch metadata for matching chunks
      const metaRows = this.db!.prepare(`
        SELECT id, rowid_ref, repo_id, commits, branches, path, symbol, symbol_type,
               language, content_type, start_line, end_line, content, is_exported
        FROM chunk_metadata
        WHERE ${whereClause}
      `).all(...params) as {
        id: string;
        rowid_ref: number;
        repo_id: string;
        commits: string;
        branches: string;
        path: string;
        symbol: string | null;
        symbol_type: string | null;
        language: string;
        content_type: string;
        start_line: number | null;
        end_line: number | null;
        content: string;
        is_exported: number | null;
      }[];

      // Build results with scores
      // With Cosine distance: 0 = identical, 2 = opposite
      // Convert to similarity: similarity = 1 - (distance / 2)
      // This gives us 0-1 range like other vector DBs
      const results: SearchResult[] = [];
      for (const row of metaRows) {
        const distance = distanceMap.get(row.rowid_ref);
        if (distance === undefined) continue;

        // Convert Cosine distance to similarity score (0-1 range)
        // Cosine distance is in [0, 2], similarity is 1 - (distance / 2)
        const score = 1 - (distance / 2);

        results.push({
          id: row.id,
          score,
          payload: {
            repo_id: row.repo_id,
            commits: JSON.parse(row.commits),
            branches: JSON.parse(row.branches),
            path: row.path,
            symbol: row.symbol ?? '',
            symbol_type: row.symbol_type ?? '',
            language: row.language,
            content_type: row.content_type as 'code' | 'docs' | 'config',
            start_line: row.start_line ?? 0,
            end_line: row.end_line ?? 0,
            content: row.content,
            is_exported: row.is_exported === 1,
          },
        });
      }

      // Sort by score descending (sqlite-vec sorted by distance ascending)
      results.sort((a, b) => b.score - a.score);

      // Apply path pattern filter
      let filteredResults = results;
      if (hasPathPattern && filters.pathPattern) {
        filteredResults = results.filter((r) =>
          minimatch(r.payload.path, filters.pathPattern!, { matchBase: true })
        );
      }

      return filteredResults.slice(0, limit);
    } catch (error) {
      throw new VectorStorageError(
        `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        VectorStorageErrorCode.SEARCH_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get chunks by their IDs
   */
  async getChunks(chunkIds: string[]): Promise<Map<string, ChunkPayload>> {
    this.ensureReady();
    if (chunkIds.length === 0) return new Map();

    try {
      const placeholders = chunkIds.map(() => '?').join(', ');
      const stmt = this.db!.prepare(`
        SELECT id, repo_id, commits, branches, path, symbol, symbol_type,
               language, content_type, start_line, end_line, content, is_exported
        FROM chunk_metadata
        WHERE id IN (${placeholders})
      `);

      const rows = stmt.all(...chunkIds) as {
        id: string;
        repo_id: string;
        commits: string;
        branches: string;
        path: string;
        symbol: string | null;
        symbol_type: string | null;
        language: string;
        content_type: string;
        start_line: number | null;
        end_line: number | null;
        content: string;
        is_exported: number | null;
      }[];

      const result = new Map<string, ChunkPayload>();
      for (const row of rows) {
        result.set(row.id, {
          repo_id: row.repo_id,
          commits: JSON.parse(row.commits),
          branches: JSON.parse(row.branches),
          path: row.path,
          symbol: row.symbol ?? '',
          symbol_type: row.symbol_type ?? '',
          language: row.language,
          content_type: row.content_type as 'code' | 'docs' | 'config',
          start_line: row.start_line ?? 0,
          end_line: row.end_line ?? 0,
          content: row.content,
          is_exported: row.is_exported === 1,
        });
      }

      return result;
    } catch (error) {
      throw new VectorStorageError(
        `Failed to get chunks: ${error instanceof Error ? error.message : String(error)}`,
        VectorStorageErrorCode.SEARCH_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if chunks exist by their IDs
   */
  async chunksExist(chunkIds: string[]): Promise<Set<string>> {
    this.ensureReady();
    if (chunkIds.length === 0) return new Set();

    const existingIds = new Set<string>();
    const uncachedIds: string[] = [];

    // Check cache first
    for (const id of chunkIds) {
      const cached = this.chunkExistsCache.get(id);
      if (cached !== undefined) {
        if (cached) existingIds.add(id);
      } else {
        uncachedIds.push(id);
      }
    }

    if (uncachedIds.length === 0) return existingIds;

    try {
      const placeholders = uncachedIds.map(() => '?').join(', ');
      const stmt = this.db!.prepare(`
        SELECT id FROM chunk_metadata WHERE id IN (${placeholders})
      `);

      const rows = stmt.all(...uncachedIds) as { id: string }[];
      const foundIds = new Set(rows.map((r) => r.id));

      // Update cache
      for (const id of uncachedIds) {
        const exists = foundIds.has(id);
        this.chunkExistsCache.set(id, exists);
        if (exists) existingIds.add(id);
      }

      return existingIds;
    } catch (error) {
      throw new VectorStorageError(
        `Failed to check chunk existence: ${error instanceof Error ? error.message : String(error)}`,
        VectorStorageErrorCode.SEARCH_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete chunks by their IDs
   */
  async deleteChunks(chunkIds: string[]): Promise<void> {
    this.ensureReady();
    if (chunkIds.length === 0) return;

    try {
      // Get rowids for the chunks
      const placeholders = chunkIds.map(() => '?').join(', ');
      const rowids = this.db!.prepare(`
        SELECT rowid_ref FROM chunk_metadata WHERE id IN (${placeholders})
      `)
        .all(...chunkIds)
        .map((r) => (r as { rowid_ref: number }).rowid_ref);

      // Delete from vec_embeddings
      if (rowids.length > 0) {
        const rowidPlaceholders = rowids.map(() => '?').join(', ');
        this.db!.prepare(`
          DELETE FROM vec_embeddings WHERE rowid IN (${rowidPlaceholders})
        `).run(...rowids);
      }

      // Delete from metadata
      this.db!.prepare(`
        DELETE FROM chunk_metadata WHERE id IN (${placeholders})
      `).run(...chunkIds);

      // Invalidate cache
      for (const id of chunkIds) {
        this.chunkExistsCache.delete(id);
      }
    } catch (error) {
      throw new VectorStorageError(
        `Failed to delete chunks: ${error instanceof Error ? error.message : String(error)}`,
        VectorStorageErrorCode.UPSERT_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete all chunks belonging to a repository
   */
  async deleteByRepoId(repoId: string): Promise<number> {
    this.ensureReady();

    try {
      // Get rowids for the repo
      const rowids = this.db!.prepare(`
        SELECT rowid_ref FROM chunk_metadata WHERE repo_id = ?
      `)
        .all(repoId)
        .map((r) => (r as { rowid_ref: number }).rowid_ref);

      const countBefore = rowids.length;

      // Delete from vec_embeddings
      if (rowids.length > 0) {
        const placeholders = rowids.map(() => '?').join(', ');
        this.db!.prepare(`
          DELETE FROM vec_embeddings WHERE rowid IN (${placeholders})
        `).run(...rowids);
      }

      // Delete from metadata
      this.db!.prepare('DELETE FROM chunk_metadata WHERE repo_id = ?').run(
        repoId
      );

      // Clear cache
      this.chunkExistsCache.clear();

      return countBefore;
    } catch (error) {
      throw new VectorStorageError(
        `Failed to delete chunks for repo ${repoId}: ${error instanceof Error ? error.message : String(error)}`,
        VectorStorageErrorCode.UPSERT_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<VectorStorageStats> {
    this.ensureReady();

    try {
      const countRow = this.db!.prepare(
        'SELECT COUNT(*) as count FROM chunk_metadata'
      ).get() as { count: number };

      return {
        pointCount: countRow.count,
        segmentCount: 1, // SQLite doesn't have segments
        dimensions: this.dimensions,
      };
    } catch (error) {
      throw new VectorStorageError(
        `Failed to get stats: ${error instanceof Error ? error.message : String(error)}`,
        VectorStorageErrorCode.COLLECTION_ERROR,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
    this.chunkExistsCache.clear();
  }
}
