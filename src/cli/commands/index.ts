/**
 * CLI command: index
 *
 * Index a codebase at a specific commit for semantic search.
 */

import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { formatIndexResult } from '../output.js';
import { createProgressDisplay } from '../progress.js';
import { handleError, ExitCode } from '../errors.js';
import { GitAdapter } from '../../git/adapter.js';
import { createIndexer } from '../../indexer/indexer.js';
import type { IndexingOptions } from '../../indexer/types.js';

/**
 * Index command options
 */
interface IndexOptions {
  commit?: string;
  branch?: string;
  json?: boolean;
  quiet?: boolean;
  reset?: boolean;
  force?: boolean;
  sqi?: boolean;
}

/**
 * Reset result for JSON output
 */
interface ResetResult {
  success: boolean;
  repoPath: string;
  repoId: string;
  chunksDeleted: number;
  commitsDeleted: number;
}

/**
 * Execute reset for a repository
 */
async function executeReset(path: string | undefined, options: IndexOptions): Promise<void> {
  const isJson = options.json === true;
  const isQuiet = options.quiet === true;

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(path, options.commit);

    // Run with full context
    const result = await withContext(async (context) => {
      // Get repository record
      const repo = context.metadata.getRepositoryByPath(repoContext.repoPath);
      if (repo === null) {
        if (!isQuiet && !isJson) {
          console.log(`⚠️  Repository not indexed: ${repoContext.repoPath}`);
        }
        return {
          success: true,
          repoPath: repoContext.repoPath,
          repoId: '',
          chunksDeleted: 0,
          commitsDeleted: 0,
        } as ResetResult;
      }

      if (!isQuiet && !isJson) {
        console.log(`🗑️  Resetting index for: ${repo.name}`);
        console.log(`   Path: ${repoContext.repoPath}`);
        console.log(`   ID: ${repo.id}`);
      }

      // Delete vectors from Qdrant
      const chunksDeleted = await context.vectors.deleteByRepoId(repo.id);

      if (!isQuiet && !isJson) {
        console.log(`   Deleted ${chunksDeleted} chunks from vector store`);
      }

      // Delete metadata (commits and chunk refs)
      const commitsDeleted = context.metadata.deleteAllCommitsForRepo(repo.id);

      if (!isQuiet && !isJson) {
        console.log(`   Deleted ${commitsDeleted} commit records from metadata`);
      }

      return {
        success: true,
        repoPath: repoContext.repoPath,
        repoId: repo.id,
        chunksDeleted,
        commitsDeleted,
      } as ResetResult;
    });

    // Output result
    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!isQuiet) {
      console.log(`\n✅ Index reset complete`);
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Execute the index command
 */
async function executeIndex(path: string | undefined, options: IndexOptions): Promise<void> {
  const isJson = options.json === true;
  const isQuiet = options.quiet === true;

  // Handle reset flag
  if (options.reset === true) {
    return executeReset(path, options);
  }

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(path, options.commit);

    // Create progress display
    const progress = createProgressDisplay({ quiet: isQuiet, json: isJson });

    // Run with full context
    const result = await withContext(async (context) => {
      // Create Git adapter
      const git = await GitAdapter.create(repoContext.repoPath);

      // Get or create repository record
      let repo = context.metadata.getRepositoryByPath(repoContext.repoPath);
      if (repo === null) {
        const repoInfo = git.getRepositoryInfo();
        const repoId = randomUUID();
        repo = context.metadata.registerRepository(repoId, repoContext.repoPath, repoInfo.name);
      }
      const indexer = createIndexer(
        git,
        context.metadata,
        context.vectors,
        context.embeddings
      );

      // Build indexing options
      const indexingOptions: IndexingOptions = {
        repoPath: repoContext.repoPath,
        repoId: repo.id,
        commitSha: repoContext.commitSha,
        onProgress: progress.createCallback(),
        force: options.force === true,
        skipEmbeddings: options.sqi === true,
      };
      if (options.branch !== undefined) {
        indexingOptions.branch = options.branch;
      } else if (repoContext.branch !== undefined) {
        indexingOptions.branch = repoContext.branch;
      }

      // Run indexing
      const result = await indexer.indexCommit(indexingOptions);

      // Ensure progress display is cleaned up
      progress.finish();

      return result;
    });

    // Format and output result
    formatIndexResult(result, { json: isJson, quiet: isQuiet });

    // Exit with appropriate code
    if (!result.success) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the index command with the program
 */
export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .description('Index a codebase at a specific commit for semantic search')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit, branch, or tag to index (default: HEAD)')
    .option('-b, --branch <name>', 'Branch label for reference')
    .option('--reset', 'Delete all indexed data for this repository')
    .option('--force', 'Force re-indexing even if commit was already indexed')
    .option('--sqi', 'SQI-only mode: skip embeddings (no Qdrant needed)')
    .option('--json', 'Output in JSON format')
    .option('-q, --quiet', 'Suppress progress output')
    .action(async (path: string | undefined, options: IndexOptions) => {
      await executeIndex(path, options);
    });
}
