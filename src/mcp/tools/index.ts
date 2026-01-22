/**
 * MCP tool: index_codebase
 *
 * Indexes a codebase at a specific commit for semantic search.
 */

import { randomUUID } from 'node:crypto';
import { GitAdapter } from '../../git/adapter.js';
import { MetadataStorage } from '../../storage/metadata.js';
import type { VectorStorage } from '../../storage/vector-storage.js';
import type { EmbeddingProvider } from '../../embeddings/types.js';
import { createIndexer } from '../../indexer/indexer.js';
import type { IndexCodebaseInput, IndexCodebaseOutput } from '../types.js';

/**
 * Handle index_codebase tool call
 */
export async function handleIndexCodebase(
  input: IndexCodebaseInput,
  metadata: MetadataStorage,
  vectors: VectorStorage,
  embeddings: EmbeddingProvider
): Promise<IndexCodebaseOutput> {
  const { repo_path, commit, branch } = input;

  try {
    // Create Git adapter
    const git = await GitAdapter.create(repo_path);

    // Resolve commit SHA
    let commitSha: string;
    try {
      commitSha = await git.resolveRef(commit);
    } catch {
      return {
        success: false,
        repo_id: '',
        commit_sha: commit,
        files_processed: 0,
        chunks_created: 0,
        chunks_reused: 0,
        duration_ms: 0,
        error: `Cannot resolve commit: ${commit}`,
      };
    }

    // Get or create repository record
    let repo = metadata.getRepositoryByPath(repo_path);
    if (!repo) {
      const repoInfo = git.getRepositoryInfo();
      const repoId = randomUUID();
      repo = metadata.registerRepository(repoId, repo_path, repoInfo.name);
    }

    // Create indexer and run
    const indexer = createIndexer(git, metadata, vectors, embeddings);

    const indexingOptions: {
      repoPath: string;
      repoId: string;
      commitSha: string;
      branch?: string;
    } = {
      repoPath: repo_path,
      repoId: repo.id,
      commitSha,
    };
    if (branch) {
      indexingOptions.branch = branch;
    }

    const result = await indexer.indexCommit(indexingOptions);

    const output: IndexCodebaseOutput = {
      success: result.success,
      repo_id: result.repoId,
      commit_sha: result.commitSha,
      files_processed: result.filesProcessed,
      chunks_created: result.chunksCreated,
      chunks_reused: result.chunksReused,
      duration_ms: result.durationMs,
    };
    if (result.error) {
      output.error = result.error;
    }

    return output;
  } catch (error) {
    return {
      success: false,
      repo_id: '',
      commit_sha: commit,
      files_processed: 0,
      chunks_created: 0,
      chunks_reused: 0,
      duration_ms: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
