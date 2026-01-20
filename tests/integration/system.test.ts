/**
 * System Integration Tests
 *
 * End-to-end tests that verify the complete indexing and search pipeline
 * using realistic TypeScript and Ruby repositories.
 *
 * These tests require:
 * - A running Qdrant instance
 * - Git repositories at /tmp/claude/typescript-sample and /tmp/claude/ruby-sample
 *
 * Skip with SKIP_INTEGRATION_TESTS=1 if dependencies are not available.
 *
 * Setup test repositories:
 *   npm run test:setup-fixtures (or see tests/fixtures/repos/ for source files)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { GitAdapter } from '../../src/git/adapter.js';
import { MetadataStorage } from '../../src/storage/metadata.js';
import { QdrantStorage } from '../../src/storage/qdrant.js';
import { FastEmbedProvider } from '../../src/embeddings/local.js';
import { createIndexer } from '../../src/indexer/indexer.js';
import type { IndexingProgressEvent } from '../../src/indexer/types.js';

// Skip integration tests if dependencies are not available
const SKIP_TESTS = process.env.SKIP_INTEGRATION_TESTS === '1';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

// Test paths
const TYPESCRIPT_REPO_PATH = '/tmp/claude/typescript-sample';
const RUBY_REPO_PATH = '/tmp/claude/ruby-sample';

// Test collection name (unique per test run)
const TEST_COLLECTION = `test_system_${Date.now()}`;

// Test vector dimensions (matching all-MiniLM-L6-v2)
const DIMENSIONS = 384;

describe.skipIf(SKIP_TESTS)('System Integration Tests', () => {
  let metadata: MetadataStorage;
  let vectors: QdrantStorage;
  let embeddings: FastEmbedProvider;
  let tempDbPath: string;

  beforeAll(async () => {
    // Check if test repos exist
    if (!fs.existsSync(TYPESCRIPT_REPO_PATH)) {
      console.warn(`TypeScript test repo not found at ${TYPESCRIPT_REPO_PATH}`);
      console.warn('Run: cp -R tests/fixtures/repos/typescript-sample /tmp/claude/ && cd /tmp/claude/typescript-sample && git init && git add . && git commit -m "init"');
    }
    if (!fs.existsSync(RUBY_REPO_PATH)) {
      console.warn(`Ruby test repo not found at ${RUBY_REPO_PATH}`);
      console.warn('Run: cp -R tests/fixtures/repos/ruby-sample /tmp/claude/ && cd /tmp/claude/ruby-sample && git init && git add . && git commit -m "init"');
    }

    // Initialize storage
    tempDbPath = `/tmp/claude/test-system-${Date.now()}.db`;
    metadata = MetadataStorage.create(tempDbPath);

    vectors = new QdrantStorage({
      url: QDRANT_URL,
      collectionName: TEST_COLLECTION,
      dimensions: DIMENSIONS,
    });
    await vectors.initialize();

    embeddings = new FastEmbedProvider('all-MiniLM-L6-v2', 32);
    await embeddings.initialize();
  });

  afterAll(async () => {
    // Clean up Qdrant collection
    if (vectors?.isReady()) {
      try {
        const { QdrantClient } = await import('@qdrant/js-client-rest');
        const client = new QdrantClient({ url: QDRANT_URL });
        await client.deleteCollection(TEST_COLLECTION);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clean up temp db
    if (tempDbPath && fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  describe('TypeScript Repository Indexing', () => {
    let git: GitAdapter;
    let repoId: string;
    let commitSha: string;

    beforeAll(async () => {
      if (!fs.existsSync(TYPESCRIPT_REPO_PATH)) {
        return; // Skip if repo doesn't exist
      }

      git = await GitAdapter.create(TYPESCRIPT_REPO_PATH);
      commitSha = execSync('git rev-parse HEAD', { cwd: TYPESCRIPT_REPO_PATH })
        .toString()
        .trim();

      repoId = randomUUID();
      metadata.registerRepository(repoId, TYPESCRIPT_REPO_PATH, 'typescript-sample');
    });

    it.skipIf(!fs.existsSync(TYPESCRIPT_REPO_PATH))('should index TypeScript repository', async () => {
      const indexer = createIndexer(git, metadata, vectors, embeddings, 16);
      const progressEvents: IndexingProgressEvent[] = [];

      const result = await indexer.indexCommit({
        repoPath: TYPESCRIPT_REPO_PATH,
        repoId,
        commitSha,
        branch: 'main',
        onProgress: (event) => progressEvents.push(event),
      });

      expect(result.success).toBe(true);
      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(result.filesProcessed).toBeGreaterThan(0);

      // Verify progress events
      const eventTypes = progressEvents.map(e => e.type);
      expect(eventTypes).toContain('started');
      expect(eventTypes).toContain('completed');

      console.log(`Indexed ${result.filesProcessed} TS files, created ${result.chunksCreated} chunks`);
    });

    it.skipIf(!fs.existsSync(TYPESCRIPT_REPO_PATH))('should extract TypeScript symbols', async () => {
      const sqiStorage = metadata.getSQIStorage();
      const commitRecord = metadata.getIndexedCommit(repoId, commitSha);
      expect(commitRecord).toBeDefined();

      // Get stats for this commit
      const stats = sqiStorage.getCommitStats(commitRecord!.id);
      expect(stats.symbols).toBeGreaterThan(0);

      // Find specific symbols
      const userModelClasses = sqiStorage.findSymbolsByName(commitRecord!.id, 'UserModel', 'class');
      expect(userModelClasses.length).toBeGreaterThan(0);
      expect(userModelClasses[0].file_path).toContain('user.ts');

      const userServiceClasses = sqiStorage.findSymbolsByName(commitRecord!.id, 'UserService', 'class');
      expect(userServiceClasses.length).toBeGreaterThan(0);
      expect(userServiceClasses[0].file_path).toContain('user-service.ts');

      // Find interfaces
      const userInterfaces = sqiStorage.findSymbolsByName(commitRecord!.id, 'User', 'interface');
      expect(userInterfaces.length).toBeGreaterThan(0);

      // Find functions using pattern
      const helperFunctions = sqiStorage.findSymbolsByPattern(commitRecord!.id, '%', 'function');
      expect(helperFunctions.length).toBeGreaterThan(0);

      console.log(`Found ${stats.symbols} TypeScript symbols`);
    });

    it.skipIf(!fs.existsSync(TYPESCRIPT_REPO_PATH))('should search TypeScript code semantically', async () => {
      // Generate embedding for search query
      const queryEmbedding = await embeddings.embed('user authentication');

      const results = await vectors.search(queryEmbedding, {
        repo_id: repoId,
        commit: commitSha,
        includeAllContentTypes: true,
      });

      expect(results.length).toBeGreaterThan(0);
      // Results should contain user-related code
      const userRelatedResults = results.filter(r =>
        r.payload.content?.toLowerCase().includes('user') ||
        r.payload.symbol?.toLowerCase().includes('user')
      );
      expect(userRelatedResults.length).toBeGreaterThan(0);

      console.log(`Search returned ${results.length} results, ${userRelatedResults.length} user-related`);
    });
  });

  describe('Ruby Repository Indexing', () => {
    let git: GitAdapter;
    let repoId: string;
    let commitSha: string;

    beforeAll(async () => {
      if (!fs.existsSync(RUBY_REPO_PATH)) {
        return;
      }

      git = await GitAdapter.create(RUBY_REPO_PATH);
      commitSha = execSync('git rev-parse HEAD', { cwd: RUBY_REPO_PATH })
        .toString()
        .trim();

      repoId = randomUUID();
      metadata.registerRepository(repoId, RUBY_REPO_PATH, 'ruby-sample');
    });

    it.skipIf(!fs.existsSync(RUBY_REPO_PATH))('should index Ruby repository', async () => {
      const indexer = createIndexer(git, metadata, vectors, embeddings, 16);
      const progressEvents: IndexingProgressEvent[] = [];

      const result = await indexer.indexCommit({
        repoPath: RUBY_REPO_PATH,
        repoId,
        commitSha,
        branch: 'main',
        onProgress: (event) => progressEvents.push(event),
      });

      expect(result.success).toBe(true);
      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(result.filesProcessed).toBeGreaterThan(0);

      console.log(`Indexed ${result.filesProcessed} Ruby files, created ${result.chunksCreated} chunks`);
    });

    it.skipIf(!fs.existsSync(RUBY_REPO_PATH))('should extract Ruby symbols', async () => {
      const sqiStorage = metadata.getSQIStorage();
      const commitRecord = metadata.getIndexedCommit(repoId, commitSha);
      expect(commitRecord).toBeDefined();

      const stats = sqiStorage.getCommitStats(commitRecord!.id);
      expect(stats.symbols).toBeGreaterThan(0);

      // Find Ruby classes
      const userClasses = sqiStorage.findSymbolsByName(commitRecord!.id, 'User', 'class');
      expect(userClasses.length).toBeGreaterThan(0);
      expect(userClasses[0].file_path).toContain('user.rb');

      const roleClasses = sqiStorage.findSymbolsByName(commitRecord!.id, 'Role', 'class');
      expect(roleClasses.length).toBeGreaterThan(0);

      // Find modules
      const modules = sqiStorage.findSymbolsByPattern(commitRecord!.id, '%', 'module');
      const moduleNames = modules.map(m => m.name);
      expect(moduleNames).toContain('Models');
      expect(moduleNames).toContain('Services');
      expect(moduleNames).toContain('Errors');

      // Find methods
      const methods = sqiStorage.findSymbolsByPattern(commitRecord!.id, '%', 'method');
      expect(methods.length).toBeGreaterThan(0);

      console.log(`Found ${stats.symbols} Ruby symbols, ${modules.length} modules, ${methods.length} methods`);
    });

    it.skipIf(!fs.existsSync(RUBY_REPO_PATH))('should track Ruby mixin usages', async () => {
      const sqiStorage = metadata.getSQIStorage();
      const commitRecord = metadata.getIndexedCommit(repoId, commitSha);
      expect(commitRecord).toBeDefined();

      // Get usages for Comparable mixin
      const comparableUsages = sqiStorage.findUsagesByName(commitRecord!.id, 'Comparable');

      // Should include Comparable mixin usage
      const comparableUsage = comparableUsages.find(u => u.usage_type === 'extend');
      expect(comparableUsage).toBeDefined();

      console.log(`Found ${comparableUsages.length} Comparable usages`);
    });

    it.skipIf(!fs.existsSync(RUBY_REPO_PATH))('should search Ruby code semantically', async () => {
      const queryEmbedding = await embeddings.embed('user repository database');

      const results = await vectors.search(queryEmbedding, {
        repo_id: repoId,
        commit: commitSha,
        includeAllContentTypes: true,
      });

      expect(results.length).toBeGreaterThan(0);

      console.log(`Ruby search returned ${results.length} results`);
    });
  });

  describe('Cross-Repository Search', () => {
    it.skipIf(!fs.existsSync(TYPESCRIPT_REPO_PATH) || !fs.existsSync(RUBY_REPO_PATH))(
      'should find similar code patterns across languages',
      async () => {
        // Search for validation logic which exists in both repos
        const queryEmbedding = await embeddings.embed('email validation check format');

        // Search with a minimal filter that still requires repo_id (search API requirement)
        // We'll run separate searches for each repo and combine
        const tsRepoId = Array.from(metadata.listRepositories()).find(
          r => r.name === 'typescript-sample'
        )?.repo_id;
        const rubyRepoId = Array.from(metadata.listRepositories()).find(
          r => r.name === 'ruby-sample'
        )?.repo_id;

        const tsCommit = tsRepoId
          ? execSync('git rev-parse HEAD', { cwd: TYPESCRIPT_REPO_PATH }).toString().trim()
          : '';
        const rubyCommit = rubyRepoId
          ? execSync('git rev-parse HEAD', { cwd: RUBY_REPO_PATH }).toString().trim()
          : '';

        const tsResults = tsRepoId
          ? await vectors.search(queryEmbedding, {
              repo_id: tsRepoId,
              commit: tsCommit,
              includeAllContentTypes: true,
            }, 10)
          : [];

        const rubyResults = rubyRepoId
          ? await vectors.search(queryEmbedding, {
              repo_id: rubyRepoId,
              commit: rubyCommit,
              includeAllContentTypes: true,
            }, 10)
          : [];

        console.log(`Cross-repo search: ${tsResults.length} TS results, ${rubyResults.length} Ruby results`);

        // Both languages have email validation
        if (tsResults.length > 0 && rubyResults.length > 0) {
          expect(tsResults.some(r => r.payload.content?.includes('email'))).toBe(true);
          expect(rubyResults.some(r => r.payload.content?.includes('email'))).toBe(true);
        }
      }
    );
  });
});
