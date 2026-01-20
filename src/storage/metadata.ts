/**
 * SQLite metadata storage for SourceRack
 *
 * Stores repository registry, indexed commit state, chunk references,
 * and GC candidate tracking. Implements the data model from data-model.md.
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import {
  RepositoryRecord,
  IndexedCommitRecord,
  GCCandidateRecord,
  RepositoryWithStats,
  StorageError,
  StorageErrorCode,
  EmbeddingStatus,
} from './types.js';
import { SQIStorage, CREATE_SQI_TABLES } from '../sqi/storage.js';

/**
 * Schema version for migrations
 * Increment this when adding new tables/columns
 */
const SCHEMA_VERSION = 4;;;

/**
 * SQL statements for schema creation
 */
const CREATE_TABLES = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- Repository registry
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexed commits tracking
CREATE TABLE IF NOT EXISTS indexed_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'complete', 'failed')),
  embedding_status TEXT NOT NULL DEFAULT 'complete' CHECK (embedding_status IN ('none', 'pending', 'complete')),
  UNIQUE(repo_id, commit_sha)
);

-- Chunk references (deduplication)
-- Tracks which chunks belong to which commits
CREATE TABLE IF NOT EXISTS chunk_refs (
  chunk_id TEXT NOT NULL,
  commit_id INTEGER NOT NULL REFERENCES indexed_commits(id) ON DELETE CASCADE,
  PRIMARY KEY (chunk_id, commit_id)
);

-- GC candidates
CREATE TABLE IF NOT EXISTS gc_candidates (
  commit_id INTEGER PRIMARY KEY REFERENCES indexed_commits(id) ON DELETE CASCADE,
  orphaned_at TEXT NOT NULL DEFAULT (datetime('now')),
  eligible_for_gc_at TEXT NOT NULL
);

-- File blob tracking for file-level deduplication
CREATE TABLE IF NOT EXISTS file_blobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id INTEGER NOT NULL REFERENCES indexed_commits(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  UNIQUE(commit_id, file_path)
);

-- Blob to chunks mapping for quick lookup
CREATE TABLE IF NOT EXISTS blob_chunks (
  blob_sha TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  PRIMARY KEY (blob_sha, chunk_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_indexed_commits_repo ON indexed_commits(repo_id);
CREATE INDEX IF NOT EXISTS idx_indexed_commits_status ON indexed_commits(status);
CREATE INDEX IF NOT EXISTS idx_chunk_refs_chunk ON chunk_refs(chunk_id);
CREATE INDEX IF NOT EXISTS idx_chunk_refs_commit ON chunk_refs(commit_id);
CREATE INDEX IF NOT EXISTS idx_gc_eligible ON gc_candidates(eligible_for_gc_at);
CREATE INDEX IF NOT EXISTS idx_file_blobs_sha ON file_blobs(blob_sha);
CREATE INDEX IF NOT EXISTS idx_file_blobs_commit ON file_blobs(commit_id);
`;;;

/**
 * Metadata storage class
 */
export class MetadataStorage {
  private db: DatabaseType;
  private closed = false;

  private constructor(db: DatabaseType) {
    this.db = db;
  }

  /**
   * Create and initialize a metadata storage instance
   *
   * @param databasePath - Path to SQLite database file
   * @returns Initialized MetadataStorage
   */
  static create(databasePath: string): MetadataStorage {
    const absolutePath = resolve(databasePath);

    // Ensure parent directory exists
    const parentDir = dirname(absolutePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    try {
      const db = new Database(absolutePath);

      // Enable WAL mode for better concurrent access
      db.pragma('journal_mode = WAL');

      // Enable foreign keys
      db.pragma('foreign_keys = ON');

      // Create tables
      db.exec(CREATE_TABLES);

      // Check/set schema version and run migrations
      const versionResult = db
        .prepare('SELECT version FROM schema_version LIMIT 1')
        .get() as { version: number } | undefined;

      if (versionResult === undefined) {
        // Fresh database - create all tables including SQI
        db.exec(CREATE_SQI_TABLES);
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
          SCHEMA_VERSION
        );
      } else if (versionResult.version < SCHEMA_VERSION) {
        // Run migrations
        MetadataStorage.runMigrations(db, versionResult.version, SCHEMA_VERSION);
      }

      return new MetadataStorage(db);
    } catch (error) {
      throw new StorageError(
        `Failed to initialize database at ${absolutePath}`,
        StorageErrorCode.INIT_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Run database migrations
   */
  private static runMigrations(
    db: DatabaseType,
    fromVersion: number,
    toVersion: number
  ): void {
    // Migration from v1 to v2: Add SQI tables
    if (fromVersion < 2 && toVersion >= 2) {
      db.exec(CREATE_SQI_TABLES);
    }

    // Migration from v2 to v3: Add embedding_status to indexed_commits
    if (fromVersion < 3 && toVersion >= 3) {
      db.exec(`
        ALTER TABLE indexed_commits 
        ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'complete' 
        CHECK (embedding_status IN ('none', 'pending', 'complete'))
      `);
    }

    // Migration from v3 to v4: Add file_blobs and blob_chunks tables
    if (fromVersion < 4 && toVersion >= 4) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_blobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          commit_id INTEGER NOT NULL REFERENCES indexed_commits(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          blob_sha TEXT NOT NULL,
          UNIQUE(commit_id, file_path)
        );

        CREATE TABLE IF NOT EXISTS blob_chunks (
          blob_sha TEXT NOT NULL,
          chunk_id TEXT NOT NULL,
          PRIMARY KEY (blob_sha, chunk_id)
        );

        CREATE INDEX IF NOT EXISTS idx_file_blobs_sha ON file_blobs(blob_sha);
        CREATE INDEX IF NOT EXISTS idx_file_blobs_commit ON file_blobs(commit_id);
      `);
    }

    // Update schema version
    db.prepare('UPDATE schema_version SET version = ?').run(toVersion);
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  /**
   * Get SQI storage instance for structured queries
   */
  getSQIStorage(): SQIStorage {
    return new SQIStorage(this.db);
  }

  /**
   * Get raw database for advanced operations
   */
  getDatabase(): DatabaseType {
    return this.db;
  }

  // ==================== Repository Operations ====================

  /**
   * Register a repository
   */
  registerRepository(id: string, path: string, name: string): RepositoryRecord {
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO repositories (id, path, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, path, name, now, now);

      return {
        id,
        path,
        name,
        created_at: now,
        updated_at: now,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed')) {
        throw new StorageError(
          `Repository already registered: ${path}`,
          StorageErrorCode.DUPLICATE,
          error instanceof Error ? error : undefined
        );
      }
      throw new StorageError(
        `Failed to register repository: ${path}`,
        StorageErrorCode.QUERY_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get repository by ID
   */
  getRepositoryById(id: string): RepositoryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE id = ?')
      .get(id) as RepositoryRecord | undefined;

    return row ?? null;
  }

  /**
   * Get repository by path
   */
  getRepositoryByPath(path: string): RepositoryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE path = ?')
      .get(path) as RepositoryRecord | undefined;

    return row ?? null;
  }

  /**
   * List all repositories
   */
  listRepositories(): RepositoryRecord[] {
    return this.db
      .prepare('SELECT * FROM repositories ORDER BY name')
      .all() as RepositoryRecord[];
  }

  /**
   * List repositories with indexed commit counts
   */
  listRepositoriesWithStats(): RepositoryWithStats[] {
    return this.db
      .prepare(
        `SELECT r.*, COUNT(ic.id) as indexed_commit_count
         FROM repositories r
         LEFT JOIN indexed_commits ic ON r.id = ic.repo_id AND ic.status = 'complete'
         GROUP BY r.id
         ORDER BY r.name`
      )
      .all() as RepositoryWithStats[];
  }

  /**
   * Delete a repository and all associated data
   */
  deleteRepository(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM repositories WHERE id = ?')
      .run(id);

    return result.changes > 0;
  }

  // ==================== Indexed Commit Operations ====================

  /**
   * Start indexing a commit (creates record with 'in_progress' status)
   */
  startIndexing(
    repoId: string,
    commitSha: string,
    embeddingStatus: EmbeddingStatus = 'complete'
  ): IndexedCommitRecord {
    const now = new Date().toISOString();

    try {
      const result = this.db
        .prepare(
          `INSERT INTO indexed_commits (repo_id, commit_sha, indexed_at, status, embedding_status)
           VALUES (?, ?, ?, 'in_progress', ?)`
        )
        .run(repoId, commitSha, now, embeddingStatus);

      return {
        id: result.lastInsertRowid as number,
        repo_id: repoId,
        commit_sha: commitSha,
        indexed_at: now,
        chunk_count: 0,
        status: 'in_progress',
        embedding_status: embeddingStatus,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed')) {
        throw new StorageError(
          `Commit already indexed: ${commitSha}`,
          StorageErrorCode.DUPLICATE,
          error instanceof Error ? error : undefined
        );
      }
      throw new StorageError(
        `Failed to start indexing: ${commitSha}`,
        StorageErrorCode.QUERY_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Complete indexing a commit
   */
  completeIndexing(commitId: number, chunkCount: number): void {
    this.db
      .prepare(
        `UPDATE indexed_commits
         SET status = 'complete', chunk_count = ?, indexed_at = datetime('now')
         WHERE id = ?`
      )
      .run(chunkCount, commitId);
  }


  /**
   * Update embedding status for a commit
   */
  updateEmbeddingStatus(commitId: number, status: EmbeddingStatus): void {
    this.db
      .prepare(
        `UPDATE indexed_commits SET embedding_status = ? WHERE id = ?`
      )
      .run(status, commitId);
  }

  /**
   * Mark indexing as failed
   */
  failIndexing(commitId: number): void {
    this.db
      .prepare(
        `UPDATE indexed_commits SET status = 'failed' WHERE id = ?`
      )
      .run(commitId);
  }

  /**
   * Get indexed commit by repo and SHA
   */
  getIndexedCommit(
    repoId: string,
    commitSha: string
  ): IndexedCommitRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM indexed_commits WHERE repo_id = ? AND commit_sha = ?'
      )
      .get(repoId, commitSha) as IndexedCommitRecord | undefined;

    return row ?? null;
  }

  /**
   * Get indexed commit by ID
   */
  getIndexedCommitById(id: number): IndexedCommitRecord | null {
    const row = this.db
      .prepare('SELECT * FROM indexed_commits WHERE id = ?')
      .get(id) as IndexedCommitRecord | undefined;

    return row ?? null;
  }

  /**
   * Check if a commit is indexed and complete
   */
  isCommitIndexed(repoId: string, commitSha: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM indexed_commits
         WHERE repo_id = ? AND commit_sha = ? AND status = 'complete'`
      )
      .get(repoId, commitSha);

    return row !== undefined;
  }

  /**
   * List indexed commits for a repository
   */
  listIndexedCommits(repoId: string): IndexedCommitRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM indexed_commits
         WHERE repo_id = ?
         ORDER BY indexed_at DESC`
      )
      .all(repoId) as IndexedCommitRecord[];
  }

  /**
   * Delete an indexed commit record
   */
  deleteIndexedCommit(id: number): boolean {
    const result = this.db
      .prepare('DELETE FROM indexed_commits WHERE id = ?')
      .run(id);

    return result.changes > 0;
  }

  /**
   * Delete all indexed commits and chunk references for a repository
   * Used for index reset
   * @returns Number of commits deleted
   */
  deleteAllCommitsForRepo(repoId: string): number {
    // Get all commit IDs first
    const commits = this.db
      .prepare('SELECT id FROM indexed_commits WHERE repo_id = ?')
      .all(repoId) as { id: number }[];

    if (commits.length === 0) {
      return 0;
    }

    // Delete in transaction
    const deleteAll = this.db.transaction(() => {
      // Delete chunk references for all commits
      for (const commit of commits) {
        this.db
          .prepare('DELETE FROM chunk_refs WHERE commit_id = ?')
          .run(commit.id);
      }

      // Delete all commits
      const result = this.db
        .prepare('DELETE FROM indexed_commits WHERE repo_id = ?')
        .run(repoId);

      return result.changes;
    });

    return deleteAll();
  }

  // ==================== Chunk Reference Operations ====================

  /**
   * Add chunk references for a commit
   */
  addChunkRefs(commitId: number, chunkIds: string[]): void {
    if (chunkIds.length === 0) return;

    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO chunk_refs (chunk_id, commit_id) VALUES (?, ?)'
    );

    const insertMany = this.db.transaction((chunks: string[]) => {
      for (const chunkId of chunks) {
        stmt.run(chunkId, commitId);
      }
    });

    insertMany(chunkIds);
  }

  /**
   * Get chunk IDs for a commit
   */
  getChunkIdsForCommit(commitId: number): string[] {
    const rows = this.db
      .prepare('SELECT chunk_id FROM chunk_refs WHERE commit_id = ?')
      .all(commitId) as { chunk_id: string }[];

    return rows.map((r) => r.chunk_id);
  }

  /**
   * Get chunk count for a repository + commit combination
   */
  getCommitChunkCount(repoId: string, commitSha: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(cr.chunk_id) as count
         FROM chunk_refs cr
         JOIN indexed_commits ic ON cr.commit_id = ic.id
         WHERE ic.repo_id = ? AND ic.commit_sha = ?`
      )
      .get(repoId, commitSha) as { count: number };

    return row.count;
  }

  /**
   * Get reference count for a chunk
   */
  getChunkRefCount(chunkId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM chunk_refs WHERE chunk_id = ?')
      .get(chunkId) as { count: number };

    return row.count;
  }

  /**
   * Get all chunks with zero references (orphaned)
   */
  getOrphanedChunkIds(): string[] {
    // Chunks that have no references in chunk_refs
    // This requires comparing against all known chunk_ids
    const rows = this.db
      .prepare(
        `SELECT DISTINCT chunk_id FROM chunk_refs
         WHERE chunk_id NOT IN (
           SELECT chunk_id FROM chunk_refs
           GROUP BY chunk_id
           HAVING COUNT(*) > 0
         )`
      )
      .all() as { chunk_id: string }[];

    return rows.map((r) => r.chunk_id);
  }

  /**
   * Delete chunk references for a commit
   */
  deleteChunkRefsForCommit(commitId: number): number {
    const result = this.db
      .prepare('DELETE FROM chunk_refs WHERE commit_id = ?')
      .run(commitId);

    return result.changes;
  }

  /**
   * Get chunks that are only referenced by specified commits
   */
  getChunksOnlyInCommits(commitIds: number[]): string[] {
    if (commitIds.length === 0) return [];

    const placeholders = commitIds.map(() => '?').join(',');

    const rows = this.db
      .prepare(
        `SELECT chunk_id FROM chunk_refs
         WHERE commit_id IN (${placeholders})
         GROUP BY chunk_id
         HAVING COUNT(DISTINCT commit_id) = (
           SELECT COUNT(DISTINCT commit_id)
           FROM chunk_refs cr2
           WHERE cr2.chunk_id = chunk_refs.chunk_id
         )`
      )
      .all(...commitIds) as { chunk_id: string }[];

    return rows.map((r) => r.chunk_id);
  }


  // ==================== File Blob Operations ====================

  /**
   * Store file blob mappings for a commit
   */
  storeFileBlobs(
    commitId: number,
    blobs: { filePath: string; blobSha: string }[]
  ): void {
    if (blobs.length === 0) return;

    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO file_blobs (commit_id, file_path, blob_sha) VALUES (?, ?, ?)'
    );

    const insertMany = this.db.transaction(
      (items: { filePath: string; blobSha: string }[]) => {
        for (const item of items) {
          stmt.run(commitId, item.filePath, item.blobSha);
        }
      }
    );

    insertMany(blobs);
  }

  /**
   * Get blob SHAs for files in a commit
   */
  getFileBlobs(commitId: number): Map<string, string> {
    const rows = this.db
      .prepare('SELECT file_path, blob_sha FROM file_blobs WHERE commit_id = ?')
      .all(commitId) as { file_path: string; blob_sha: string }[];

    const result = new Map<string, string>();
    for (const row of rows) {
      result.set(row.file_path, row.blob_sha);
    }
    return result;
  }

  /**
   * Store blob to chunks mapping
   */
  storeBlobChunks(blobSha: string, chunkIds: string[]): void {
    if (chunkIds.length === 0) return;

    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO blob_chunks (blob_sha, chunk_id) VALUES (?, ?)'
    );

    const insertMany = this.db.transaction((ids: string[]) => {
      for (const chunkId of ids) {
        stmt.run(blobSha, chunkId);
      }
    });

    insertMany(chunkIds);
  }


  /**
   * Delete blob_chunks entries for the given blob SHAs.
   * Used to clean up orphaned entries when chunks no longer exist in Qdrant.
   */
  deleteBlobChunks(blobShas: string[]): void {
    if (blobShas.length === 0) return;

    const placeholders = blobShas.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM blob_chunks WHERE blob_sha IN (${placeholders})`)
      .run(...blobShas);
  }

  /**
   * Get chunk IDs for a set of blob SHAs
   */
  getChunksForBlobs(blobShas: string[]): Map<string, string[]> {
    if (blobShas.length === 0) return new Map();

    const result = new Map<string, string[]>();
    const placeholders = blobShas.map(() => '?').join(',');

    const rows = this.db
      .prepare(
        `SELECT blob_sha, chunk_id FROM blob_chunks WHERE blob_sha IN (${placeholders})`
      )
      .all(...blobShas) as { blob_sha: string; chunk_id: string }[];

    for (const row of rows) {
      const existing = result.get(row.blob_sha) ?? [];
      existing.push(row.chunk_id);
      result.set(row.blob_sha, existing);
    }

    return result;
  }

  /**
   * Check if a blob has been indexed before (has chunk mappings)
   */
  isBlobIndexed(blobSha: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM blob_chunks WHERE blob_sha = ? LIMIT 1')
      .get(blobSha);

    return row !== undefined;
  }

  /**
   * Get all indexed blob SHAs (for checking which blobs have chunks)
   */
  getIndexedBlobs(blobShas: string[]): Set<string> {
    if (blobShas.length === 0) return new Set();

    const placeholders = blobShas.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT blob_sha FROM blob_chunks WHERE blob_sha IN (${placeholders})`
      )
      .all(...blobShas) as { blob_sha: string }[];

    return new Set(rows.map((r) => r.blob_sha));
  }

  // ==================== GC Candidate Operations ====================

  /**
   * Mark a commit as a GC candidate
   */
  markAsGCCandidate(commitId: number, retentionDays: number): void {
    const now = new Date();
    const eligibleAt = new Date(
      now.getTime() + retentionDays * 24 * 60 * 60 * 1000
    );

    this.db
      .prepare(
        `INSERT OR REPLACE INTO gc_candidates (commit_id, orphaned_at, eligible_for_gc_at)
         VALUES (?, datetime('now'), ?)`
      )
      .run(commitId, eligibleAt.toISOString());
  }

  /**
   * Remove a commit from GC candidates (e.g., if it becomes reachable again)
   */
  removeFromGCCandidates(commitId: number): boolean {
    const result = this.db
      .prepare('DELETE FROM gc_candidates WHERE commit_id = ?')
      .run(commitId);

    return result.changes > 0;
  }

  /**
   * Get all commits eligible for GC
   */
  getEligibleForGC(): GCCandidateRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM gc_candidates
         WHERE eligible_for_gc_at <= datetime('now')
         ORDER BY eligible_for_gc_at`
      )
      .all() as GCCandidateRecord[];
  }

  /**
   * Get all GC candidates (including not yet eligible)
   */
  getAllGCCandidates(): GCCandidateRecord[] {
    return this.db
      .prepare('SELECT * FROM gc_candidates ORDER BY eligible_for_gc_at')
      .all() as GCCandidateRecord[];
  }

  // ==================== Utility Methods ====================

  /**
   * Run a function in a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Get database statistics
   */
  getStats(): {
    repositories: number;
    indexedCommits: number;
    chunkRefs: number;
    gcCandidates: number;
  } {
    const repos = this.db
      .prepare('SELECT COUNT(*) as count FROM repositories')
      .get() as { count: number };
    const commits = this.db
      .prepare('SELECT COUNT(*) as count FROM indexed_commits')
      .get() as { count: number };
    const refs = this.db
      .prepare('SELECT COUNT(*) as count FROM chunk_refs')
      .get() as { count: number };
    const gc = this.db
      .prepare('SELECT COUNT(*) as count FROM gc_candidates')
      .get() as { count: number };

    return {
      repositories: repos.count,
      indexedCommits: commits.count,
      chunkRefs: refs.count,
      gcCandidates: gc.count,
    };
  }
}

/**
 * Create a metadata storage instance
 * Convenience function for MetadataStorage.create()
 */
export function createMetadataStorage(databasePath: string): MetadataStorage {
  return MetadataStorage.create(databasePath);
}
