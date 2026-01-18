/**
 * CLI command: status
 *
 * Get the indexing status for a repository or specific commit.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import {
  formatStatus,
  formatCommitList,
  type StatusOutputDisplay,
  type CommitDisplayInfo,
} from '../output.js';
import { handleError } from '../errors.js';

/**
 * Status command options
 */
interface StatusOptions {
  commit?: string;
  all?: boolean;
  json?: boolean;
}

/**
 * Execute the status command
 */
async function executeStatus(path: string | undefined, options: StatusOptions): Promise<void> {
  const isJson = options.json === true;
  const showAll = options.all === true;

  try {
    // Detect repository context (use provided commit or HEAD)
    const repoContext = await detectRepoContext(path, options.commit);

    // Run with context (skip embeddings and vectors for status checks)
    await withContext(
      (context) => {
        // Get repository record
        const repo = context.metadata.getRepositoryByPath(repoContext.repoPath);

        if (showAll) {
          // Show all indexed commits for this repository
          if (repo === null) {
            const emptyList: CommitDisplayInfo[] = [];
            formatCommitList('(not registered)', emptyList, { json: isJson });
            return Promise.resolve();
          }

          // Get all indexed commits
          const commits = context.metadata.listIndexedCommits(repo.id);

          const displayCommits: CommitDisplayInfo[] = commits.map((c) => {
            const info: CommitDisplayInfo = {
              commitSha: c.commit_sha,
              status: c.status,
              indexedAt: c.indexed_at,
              chunkCount: c.chunk_count,
            };
            return info;
          });

          formatCommitList(repo.name, displayCommits, { json: isJson });
          return Promise.resolve();
        } else {
          // Show status for specific commit
          if (repo === null) {
            const output: StatusOutputDisplay = {
              status: 'not_indexed',
              commitSha: repoContext.commitSha,
            };
            formatStatus(output, { json: isJson });
            return Promise.resolve();
          }

          // Get indexed commit record
          const indexedCommit = context.metadata.getIndexedCommit(
            repo.id,
            repoContext.commitSha
          );

          if (indexedCommit === null) {
            const output: StatusOutputDisplay = {
              status: 'not_indexed',
              repoId: repo.id,
              commitSha: repoContext.commitSha,
            };
            formatStatus(output, { json: isJson });
            return Promise.resolve();
          }

          // Build status output
          const output: StatusOutputDisplay = {
            status: indexedCommit.status,
            repoId: repo.id,
            commitSha: repoContext.commitSha,
          };
          if (indexedCommit.status === 'complete') {
            output.indexedAt = indexedCommit.indexed_at;
            output.chunkCount = indexedCommit.chunk_count;
          }

          formatStatus(output, { json: isJson });
          return Promise.resolve();
        }
      },
      { skipEmbeddings: true, skipVectors: true }
    );
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the status command with the program
 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Get the indexing status for a repository')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Check status for specific commit (default: HEAD)')
    .option('-a, --all', 'Show all indexed commits for this repository')
    .option('--json', 'Output in JSON format')
    .action(async (path: string | undefined, options: StatusOptions) => {
      await executeStatus(path, options);
    });
}
