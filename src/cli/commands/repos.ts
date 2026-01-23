/**
 * CLI command: repos
 *
 * List all registered repositories with their indexed commit counts.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { formatRepositories, type RepoDisplayInfo } from '../output.js';
import { handleError } from '../errors.js';

/**
 * Repos command options
 */
interface ReposOptions {
  json?: boolean;
}

/**
 * Execute the repos command
 */
async function executeRepos(options: ReposOptions): Promise<void> {
  const isJson = options.json === true;

  try {
    // Run with context (skip embeddings and vectors for listing)
    await withContext(
      (context) => {
        // Get all repositories with stats
        const repos = context.metadata.listRepositoriesWithStats();

        const displayRepos: RepoDisplayInfo[] = repos.map((r) => ({
          id: r.id,
          name: r.name,
          path: r.path,
          indexedCommitCount: r.indexed_commit_count,
          embeddingsCompleteCount: r.embeddings_complete_count,
          embeddingsNoneCount: r.embeddings_none_count,
        }));

        formatRepositories(displayRepos, { json: isJson });
        return Promise.resolve();
      },
      { skipEmbeddings: true, skipVectors: true }
    );
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the repos command with the program
 */
export function registerReposCommand(program: Command): void {
  program
    .command('repos')
    .description('List all registered repositories')
    .option('--json', 'Output in JSON format')
    .action(async (options: ReposOptions) => {
      await executeRepos(options);
    });
}
