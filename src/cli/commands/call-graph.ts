/**
 * CLI command: call-graph
 *
 * Show the call graph for a symbol: who calls it (callers) and what it calls (callees).
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError, ExitCode } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { CallGraphSymbolInfo, SymbolInfo } from '../../sqi/types.js';
import { parseReposOption, resolveRepoIdentifiers, resolveGroupRepos } from '../repo-filter.js';

/**
 * Command options
 */
interface CallGraphOptions {
  commit?: string;
  json?: boolean;
  direction?: 'callers' | 'callees' | 'both';
  allRepos?: boolean;
  repos?: string[];
  group?: string;
}

/**
 * Format a symbol for display
 */
function formatSymbol(sym: CallGraphSymbolInfo, indent: string, showRepo = false): string {
  const repoPrefix = showRepo && sym.repo_name ? `[${sym.repo_name}] ` : '';
  const location = `${repoPrefix}${sym.file_path}:${sym.start_line}`;
  return `${indent}├─ ${sym.name} (${sym.kind}) @ ${location}`;
}

/**
 * Format the call graph as ASCII tree
 */
function formatCallGraphTree(
  symbol: SymbolInfo,
  callers: CallGraphSymbolInfo[] | undefined,
  callees: CallGraphSymbolInfo[] | undefined,
  showRepo: boolean
): string {
  const lines: string[] = [];

  // Header with symbol info
  const symbolLocation = `${symbol.file_path}:${symbol.start_line}`;
  lines.push(`📍 ${symbol.qualified_name} (${symbol.kind})`);
  lines.push(`   @ ${symbolLocation}`);
  lines.push('');

  // Callers section (who calls this symbol?)
  if (callers !== undefined) {
    if (callers.length > 0) {
      lines.push(`📥 Callers (${callers.length}) - who calls ${symbol.name}?`);
      for (const caller of callers) {
        lines.push(formatSymbol(caller, '   ', showRepo));
      }
    } else {
      lines.push(`📥 Callers (0) - no one calls ${symbol.name}`);
    }
    lines.push('');
  }

  // Callees section (what does this symbol call?)
  if (callees !== undefined) {
    if (callees.length > 0) {
      lines.push(`📤 Callees (${callees.length}) - what does ${symbol.name} call?`);
      for (const callee of callees) {
        lines.push(formatSymbol(callee, '   ', showRepo));
      }
    } else {
      lines.push(`📤 Callees (0) - ${symbol.name} doesn't call any tracked symbols`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Execute the call-graph command
 */
async function executeCallGraph(
  symbolName: string,
  repoPath: string | undefined,
  options: CallGraphOptions
): Promise<void> {
  const isJson = options.json === true;
  const direction = options.direction ?? 'both';
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

        const input: Parameters<typeof queryEngine.getCallGraph>[0] = {
          symbol_name: symbolName,
          direction,
        };

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

        return await queryEngine.getCallGraph(input);
      },
      { skipEmbeddings: true, skipVectors: true }
    );

    // Output results
    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(ExitCode.GENERAL_ERROR);
    } else if (!result.symbol) {
      console.log(`Symbol not found: ${symbolName}`);
    } else {
      console.log(formatCallGraphTree(result.symbol, result.callers, result.callees, isMultiRepo));
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the call-graph command
 */
export function registerCallGraphCommand(program: Command): void {
  program
    .command('call-graph')
    .description('Show call graph: who calls a symbol (callers) and what it calls (callees)')
    .argument('<symbol>', 'Symbol name to analyze')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('-d, --direction <dir>', 'Direction: callers, callees, or both (default: both)', 'both')
    .option('--json', 'Output in JSON format')
    .option('--all-repos', 'Search across all indexed repositories')
    .option('--repos <names...>', 'Search only in specific repositories (by name)')
    .option('-g, --group <name>', 'Search repositories in named group')
    .action(async (symbolName: string, repoPath: string | undefined, options: CallGraphOptions) => {
      await executeCallGraph(symbolName, repoPath, options);
    });
}
