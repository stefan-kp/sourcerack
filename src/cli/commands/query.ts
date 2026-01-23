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
import { parseReposOption, resolveRepoIdentifiers, resolveGroupRepos } from '../repo-filter.js';

/**
 * Query command options
 */
interface QueryOptions {
  commit?: string;
  limit?: string;
  language?: string;
  pathPattern?: string;
  json?: boolean;
  allRepos?: boolean;
  repos?: string[];
  group?: string;
}

/**
 * Execute the query command
 */
async function executeQuery(searchQuery: string, repoPath: string | undefined, options: QueryOptions): Promise<void> {
  const isJson = options.json === true;
  const allRepos = options.allRepos === true;
  const reposFilter = parseReposOption(options.repos);
  const groupFilter = options.group;
  const isMultiRepo = allRepos || reposFilter.length > 0 || groupFilter !== undefined;

  try {
    // Parse limit
    const limit = options.limit !== undefined ? parseInt(options.limit, 10) : 10;
    if (isNaN(limit) || limit < 1) {
      console.error('Error: --limit must be a positive integer');
      process.exit(ExitCode.INVALID_ARGS);
    }

    // For multi-repo search, skip repo context detection
    let repoContext: { repoPath: string; commitSha: string } | undefined;

    if (!isMultiRepo) {
      repoContext = await detectRepoContext(repoPath, options.commit);
    }

    // Run with context
    const output = await withContext(async (context) => {
      // Create query orchestrator
      const queryOrchestrator = createQueryOrchestrator(
        context.metadata,
        context.vectors,
        context.embeddings
      );

      if (isMultiRepo) {
        // Cross-repo search: query specified or all indexed repositories
        let repos = context.metadata.listRepositories();

        // Filter by --group if specified (takes precedence over --repos)
        if (groupFilter !== undefined) {
          const resolved = resolveGroupRepos(context.metadata, groupFilter);
          const filterSet = new Set(resolved.repoIds);
          repos = repos.filter((r) => filterSet.has(r.id));
        } else if (reposFilter.length > 0) {
          // Filter by --repos if specified
          const resolved = resolveRepoIdentifiers(context.metadata, reposFilter);
          const filterSet = new Set(resolved.repoIds);
          repos = repos.filter((r) => filterSet.has(r.id));
        }
        if (repos.length === 0) {
          return {
            success: false,
            indexed: false,
            results: [],
            totalCount: 0,
            error: 'No repositories indexed. Run "sourcerack index" first.',
          } as QueryOutputDisplay;
        }

        const allResults: QueryResultDisplay[] = [];
        let anyIndexed = false;
        const limitPerRepo = Math.ceil(limit / repos.length);

        for (const repo of repos) {
          // Get latest indexed commit
          const commits = context.metadata.listIndexedCommits(repo.id);
          const latestCommit = commits.find((c: { status: string }) => c.status === 'complete');
          if (!latestCommit) continue;

          anyIndexed = true;

          const queryOptions: Parameters<typeof queryOrchestrator.query>[0] = {
            repoId: repo.id,
            commitSha: latestCommit.commit_sha,
            query: searchQuery,
            limit: limitPerRepo,
          };
          if (options.language !== undefined) {
            queryOptions.language = options.language;
          }
          if (options.pathPattern !== undefined) {
            queryOptions.pathPattern = options.pathPattern;
          }

          try {
            const result = await queryOrchestrator.query(queryOptions);
            if (result.success) {
              for (const r of result.results) {
                allResults.push({
                  id: r.id,
                  score: r.score,
                  path: r.path,
                  symbol: r.symbol,
                  symbolType: r.symbolType,
                  language: r.language,
                  startLine: r.startLine,
                  endLine: r.endLine,
                  content: r.content,
                  repoName: repo.name,
                  repoPath: repo.path,
                });
              }
            }
          } catch {
            // Skip repos that fail (might not have embeddings)
          }
        }

        // Sort by score and apply final limit
        allResults.sort((a, b) => b.score - a.score);
        const limitedResults = allResults.slice(0, limit);

        return {
          success: anyIndexed,
          indexed: anyIndexed,
          results: limitedResults,
          totalCount: allResults.length,
        } as QueryOutputDisplay;
      }

      // Single repo search
      const repo = context.metadata.getRepositoryByPath(repoContext!.repoPath);
      if (repo === null) {
        exitWithAgentError(
          AgentErrors.repoNotIndexed(repoContext!.repoPath),
          ExitCode.NOT_INDEXED,
          isJson
        );
      }

      // Build query options
      const queryOptions: Parameters<typeof queryOrchestrator.query>[0] = {
        repoId: repo.id,
        commitSha: repoContext!.commitSha,
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
        AgentErrors.repoNotIndexed(repoContext?.repoPath ?? 'unknown'),
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
    formatQueryResults(output, { json: isJson, allRepos: isMultiRepo });

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
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('-n, --limit <n>', 'Maximum results (default: 10)')
    .option('-l, --language <lang>', 'Filter by programming language')
    .option('--path-pattern <pattern>', 'Filter by path pattern (e.g., "src/api/*")')
    .option('--json', 'Output in JSON format')
    .option('--all-repos', 'Search across all indexed repositories')
    .option('--repos <names...>', 'Search only in specific repositories (by name)')
    .option('-g, --group <name>', 'Search repositories in named group')
    .action(async (searchQuery: string, repoPath: string | undefined, options: QueryOptions) => {
      await executeQuery(searchQuery, repoPath, options);
    });
}
