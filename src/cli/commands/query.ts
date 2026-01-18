/**
 * CLI command: query
 *
 * Search for code semantically within an indexed commit.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { formatQueryResults, type QueryOutputDisplay, type QueryResultDisplay } from '../output.js';
import { handleError, ExitCode, AgentErrors, exitWithAgentError } from '../errors.js';
import { createQueryOrchestrator } from '../../indexer/query.js';

/**
 * Query command options
 */
interface QueryOptions {
  path?: string;
  commit?: string;
  limit?: string;
  language?: string;
  pathPattern?: string;
  json?: boolean;
}

/**
 * Execute the query command
 */
async function executeQuery(searchQuery: string, options: QueryOptions): Promise<void> {
  const isJson = options.json === true;

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(options.path, options.commit);

    // Parse limit
    const limit = options.limit !== undefined ? parseInt(options.limit, 10) : 10;
    if (isNaN(limit) || limit < 1) {
      console.error('Error: --limit must be a positive integer');
      process.exit(ExitCode.INVALID_ARGS);
    }

    // Run with context
    const output = await withContext(async (context) => {
      // Get repository record
      const repo = context.metadata.getRepositoryByPath(repoContext.repoPath);
      if (repo === null) {
        exitWithAgentError(
          AgentErrors.repoNotIndexed(repoContext.repoPath),
          ExitCode.NOT_INDEXED,
          isJson
        );
      }

      // Create query orchestrator
      const queryOrchestrator = createQueryOrchestrator(
        context.metadata,
        context.vectors,
        context.embeddings
      );

      // Build query options
      const queryOptions: {
        repoId: string;
        commitSha: string;
        query: string;
        limit?: number;
        language?: string;
        pathPattern?: string;
      } = {
        repoId: repo.id,
        commitSha: repoContext.commitSha,
        query: searchQuery,
        limit,
      };
      if (options.language !== undefined) {
        queryOptions.language = options.language;
      }
      if (options.pathPattern !== undefined) {
        queryOptions.pathPattern = options.pathPattern;
      }

      // Execute query
      const result = await queryOrchestrator.query(queryOptions);

      // Map results to display format
      const displayResults: QueryResultDisplay[] = result.results.map((r) => ({
        id: r.id,
        score: r.score,
        path: r.path,
        symbol: r.symbol,
        symbolType: r.symbolType,
        language: r.language,
        startLine: r.startLine,
        endLine: r.endLine,
        content: r.content,
      }));

      const output: QueryOutputDisplay = {
        success: result.success,
        indexed: result.isIndexed,
        results: displayResults,
        totalCount: result.totalCount,
      };
      if (result.error !== undefined) {
        output.error = result.error;
      }

      return output;
    });

    // Handle not indexed case with agent-friendly error
    if (!output.indexed) {
      exitWithAgentError(
        AgentErrors.repoNotIndexed(repoContext.repoPath),
        ExitCode.NOT_INDEXED,
        isJson
      );
    }

    // Handle no results case with agent-friendly error
    if (output.success && output.results.length === 0) {
      exitWithAgentError(
        AgentErrors.noResults(searchQuery),
        ExitCode.SUCCESS,  // Not an error, just no results
        isJson
      );
    }

    // Format and output results
    formatQueryResults(output, { json: isJson });

    // Exit with appropriate code
    if (!output.success) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the query command with the program
 */
export function registerQueryCommand(program: Command): void {
  program
    .command('query')
    .description('Search for code semantically within an indexed commit')
    .argument('<search-query>', 'Natural language search query')
    .option('-p, --path <path>', 'Repository path (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('-n, --limit <n>', 'Maximum results (default: 10)')
    .option('-l, --language <lang>', 'Filter by programming language')
    .option('--path-pattern <pattern>', 'Filter by path pattern (e.g., "src/api/*")')
    .option('--json', 'Output in JSON format')
    .action(async (searchQuery: string, options: QueryOptions) => {
      await executeQuery(searchQuery, options);
    });
}
