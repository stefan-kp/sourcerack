/**
 * MCP tool: list_repositories
 *
 * Lists all registered repositories with indexed commit counts.
 */

import { MetadataStorage } from '../../storage/metadata.js';
import type { ListRepositoriesOutput, RepositoryInfo } from '../types.js';

/**
 * Handle list_repositories tool call
 */
export function handleListRepositories(
  metadata: MetadataStorage
): ListRepositoriesOutput {
  const repos = metadata.listRepositoriesWithStats();

  const repositories: RepositoryInfo[] = repos.map((r) => ({
    id: r.id,
    name: r.name,
    path: r.path,
    indexed_commit_count: r.indexed_commit_count,
  }));

  return {
    repositories,
  };
}
