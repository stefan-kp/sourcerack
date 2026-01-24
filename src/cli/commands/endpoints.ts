/**
 * CLI command: endpoints
 *
 * List and search API endpoints in indexed codebases.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError, ExitCode, AgentErrors, exitWithAgentError } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import { parseReposOption, resolveRepoIdentifiers, resolveGroupRepos } from '../repo-filter.js';
import type { EndpointInfo, HttpMethod, Framework } from '../../sqi/extractors/api/types.js';

/**
 * Command options
 */
interface EndpointsOptions {
  commit?: string;
  method?: string;
  pathPattern?: string;
  framework?: string;
  json?: boolean;
  allRepos?: boolean;
  repos?: string[];
  group?: string;
}

/**
 * Format endpoint info for display
 */
function formatEndpointInfo(endpoint: EndpointInfo, showRepo: boolean = false): string {
  const repoPrefix = showRepo && endpoint.repo_name ? `[${endpoint.repo_name}] ` : '';
  const location = `${repoPrefix}${endpoint.file_path}:${endpoint.start_line}`;

  // Method badge with color hint (terminal-safe)
  const methodBadge = `[${endpoint.http_method}]`;

  // Framework badge
  const frameworkBadge = `(${endpoint.framework})`;

  let line = `${methodBadge} ${endpoint.path}  ${frameworkBadge}`;
  line += `\n    └─ ${location}`;

  // Add handler name if present
  if (endpoint.handler_name) {
    line += `\n    └─ handler: ${endpoint.handler_name}`;
  }

  // Add summary if present
  if (endpoint.summary) {
    line += `\n    └─ ${endpoint.summary}`;
  }

  // Add params if present
  if (endpoint.params.length > 0) {
    const paramStrs = endpoint.params.map((p) => {
      let s = p.name;
      if (p.type) s += `: ${p.type}`;
      if (!p.required) s += '?';
      return s;
    });
    line += `\n    └─ params: ${paramStrs.join(', ')}`;
  }

  // Add response model if present
  if (endpoint.response_model) {
    line += `\n    └─ response: ${endpoint.response_model}`;
  }

  return line;
}

/**
 * Group endpoints by path prefix
 */
function groupByPathPrefix(endpoints: EndpointInfo[]): Map<string, EndpointInfo[]> {
  const groups = new Map<string, EndpointInfo[]>();

  for (const endpoint of endpoints) {
    // Extract first path segment as prefix
    const parts = endpoint.path.split('/').filter(Boolean);
    const prefix = parts.length > 0 ? `/${parts[0]}` : '/';

    const existing = groups.get(prefix) ?? [];
    existing.push(endpoint);
    groups.set(prefix, existing);
  }

  return groups;
}

/**
 * Execute the endpoints command
 */
async function executeEndpoints(
  repoPath: string | undefined,
  options: EndpointsOptions
): Promise<void> {
  const isJson = options.json === true;
  const allRepos = options.allRepos === true;
  const reposFilter = parseReposOption(options.repos);
  const groupFilter = options.group;
  const isMultiRepo = allRepos || reposFilter.length > 0 || groupFilter !== undefined;

  try {
    // For multi-repo search, skip repo context detection
    let repoContext: { repoPath: string; commitSha: string } | undefined;

    if (!isMultiRepo) {
      repoContext = await detectRepoContext(repoPath, options.commit);
    }

    // Run with context
    const result = await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        const input: Parameters<typeof queryEngine.findEndpoints>[0] = {};

        if (groupFilter !== undefined) {
          const resolved = resolveGroupRepos(context.metadata, groupFilter);
          input.repo_ids = resolved.repoIds;
        } else if (allRepos) {
          input.all_repos = true;
        } else if (reposFilter.length > 0) {
          const resolved = resolveRepoIdentifiers(context.metadata, reposFilter);
          input.repo_ids = resolved.repoIds;
        } else if (repoContext) {
          input.repo_path = repoContext.repoPath;
          input.commit = repoContext.commitSha;
        }

        if (options.method) {
          input.method = options.method.toUpperCase() as HttpMethod;
        }
        if (options.pathPattern) {
          input.path_pattern = options.pathPattern;
        }
        if (options.framework) {
          input.framework = options.framework as Framework;
        }

        return await queryEngine.findEndpoints(input);
      },
      { skipEmbeddings: true, skipVectors: true }
    );

    // Output results
    if (isJson) {
      const output = {
        success: result.success,
        endpoints: result.endpoints,
        total_count: result.total_count,
        error: result.error,
      };
      console.log(JSON.stringify(output, null, 2));
    } else if (!result.success) {
      if (result.error?.includes('not indexed') || result.error?.includes('not registered')) {
        exitWithAgentError(
          AgentErrors.repoNotIndexed(repoContext?.repoPath ?? 'unknown'),
          ExitCode.NOT_INDEXED,
          isJson
        );
      }
      console.error(`Error: ${result.error}`);
      process.exit(ExitCode.GENERAL_ERROR);
    } else if (result.endpoints.length === 0) {
      console.log('No API endpoints found.');
      if (options.method || options.pathPattern || options.framework) {
        console.log('\nTry broadening your search by removing filters.');
      }
    } else {
      const reposNote = isMultiRepo ? ' (across repos)' : '';
      console.log(`Found ${result.total_count} API endpoint(s)${reposNote}:\n`);

      if (isMultiRepo) {
        // Group by repo
        const byRepo = new Map<string, EndpointInfo[]>();
        for (const endpoint of result.endpoints) {
          const repoKey = endpoint.repo_name ?? 'unknown';
          const existing = byRepo.get(repoKey) ?? [];
          existing.push(endpoint);
          byRepo.set(repoKey, existing);
        }

        for (const [repoName, endpoints] of byRepo) {
          console.log(`📦 ${repoName}`);
          for (const endpoint of endpoints) {
            console.log('  ' + formatEndpointInfo(endpoint, false).split('\n').join('\n  '));
            console.log('');
          }
        }
      } else {
        // Group by path prefix for better readability
        const groups = groupByPathPrefix(result.endpoints);

        for (const [prefix, endpoints] of groups) {
          if (groups.size > 1) {
            console.log(`📁 ${prefix}`);
          }
          for (const endpoint of endpoints) {
            const indent = groups.size > 1 ? '  ' : '';
            console.log(indent + formatEndpointInfo(endpoint, false).split('\n').join('\n' + indent));
            console.log('');
          }
        }
      }

      // Show summary
      const methods = new Map<string, number>();
      const frameworks = new Map<string, number>();
      for (const endpoint of result.endpoints) {
        methods.set(endpoint.http_method, (methods.get(endpoint.http_method) ?? 0) + 1);
        frameworks.set(endpoint.framework, (frameworks.get(endpoint.framework) ?? 0) + 1);
      }

      console.log('Summary:');
      console.log(`  Methods: ${Array.from(methods.entries()).map(([m, c]) => `${m}(${c})`).join(', ')}`);
      console.log(`  Frameworks: ${Array.from(frameworks.entries()).map(([f, c]) => `${f}(${c})`).join(', ')}`);
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the endpoints command
 */
export function registerEndpointsCommand(program: Command): void {
  program
    .command('endpoints')
    .description('List and search API endpoints in indexed codebases')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('-m, --method <method>', 'Filter by HTTP method (GET, POST, PUT, PATCH, DELETE)')
    .option('-p, --path-pattern <pattern>', 'Filter by path pattern (supports * wildcards)')
    .option('-f, --framework <framework>', 'Filter by framework (express, fastapi, flask, rails, nestjs, mcp)')
    .option('--json', 'Output in JSON format')
    .option('--all-repos', 'Search across all indexed repositories')
    .option('--repos <names...>', 'Search only in specific repositories (by name)')
    .option('-g, --group <name>', 'Search repositories in named group')
    .action(async (repoPath: string | undefined, options: EndpointsOptions) => {
      await executeEndpoints(repoPath, options);
    });
}
