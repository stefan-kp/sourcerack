/**
 * MCP tool: get_index_status
 *
 * Returns the indexing status for a specific commit.
 */

import { GitAdapter } from '../../git/adapter.js';
import { MetadataStorage } from '../../storage/metadata.js';
import type { GetIndexStatusInput, GetIndexStatusOutput } from '../types.js';

/**
 * Handle get_index_status tool call
 */
export async function handleGetIndexStatus(
  input: GetIndexStatusInput,
  metadata: MetadataStorage
): Promise<GetIndexStatusOutput> {
  const { repo_path, commit } = input;

  try {
    // Create Git adapter to resolve commit
    const git = await GitAdapter.create(repo_path);

    // Resolve commit SHA
    let commitSha: string;
    try {
      commitSha = await git.resolveRef(commit);
    } catch {
      return {
        status: 'not_indexed',
        commit_sha: commit,
      };
    }

    // Get repository record
    const repo = metadata.getRepositoryByPath(repo_path);
    if (!repo) {
      return {
        status: 'not_indexed',
        commit_sha: commitSha,
      };
    }

    // Get indexed commit record
    const indexedCommit = metadata.getIndexedCommit(repo.id, commitSha);

    if (!indexedCommit) {
      return {
        status: 'not_indexed',
        repo_id: repo.id,
        commit_sha: commitSha,
      };
    }

    // Map status
    let status: GetIndexStatusOutput['status'];
    switch (indexedCommit.status) {
      case 'complete':
        status = 'complete';
        break;
      case 'in_progress':
        status = 'in_progress';
        break;
      case 'failed':
        status = 'failed';
        break;
      default:
        status = 'not_indexed';
    }

    const output: GetIndexStatusOutput = {
      status,
      repo_id: repo.id,
      commit_sha: commitSha,
    };
    if (status === 'complete') {
      output.indexed_at = indexedCommit.indexed_at;
      output.chunk_count = indexedCommit.chunk_count;
    }

    return output;
  } catch (error) {
    return {
      status: 'not_indexed',
      commit_sha: commit,
    };
  }
}
