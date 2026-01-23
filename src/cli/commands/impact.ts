/**
 * CLI command: impact
 *
 * Analyze the impact of changing a symbol - what breaks if you modify it.
 * This is a key differentiator from LSP - transitive impact analysis.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { ChangeImpactOutput, ImpactInfo } from '../../sqi/types.js';
import { parseReposOption, resolveRepoIdentifiers } from '../repo-filter.js';

/**
 * Impact command options
 */
interface ImpactOptions {
  commit?: string;
  json?: boolean;
  depth?: number;
  allRepos?: boolean;
  repos?: string[];
}

/**
 * Format impact analysis results for human-readable output
 */
function formatImpact(result: ChangeImpactOutput, symbolName: string, isMultiRepo: boolean): void {
  if (!result.success) {
    console.error(`Error: ${result.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  const reposNote = isMultiRepo ? ' (across repos)' : '';
  console.log(`\n=== Change Impact Analysis${reposNote} ===\n`);

  if (result.symbol) {
    const s = result.symbol;
    const repoPrefix = isMultiRepo && s.repo_name ? `[${s.repo_name}] ` : '';
    console.log(`Symbol: ${s.qualified_name} (${s.kind})`);
    console.log(`Location: ${repoPrefix}${s.file_path}:${s.start_line}-${s.end_line}`);
  } else {
    console.log(`Symbol: ${symbolName}`);
  }

  console.log('');

  // Direct usages
  if (result.direct_usages.length > 0) {
    console.log(`Direct Impact (${result.direct_usages.length} usages):`);

    if (isMultiRepo) {
      // Group by repo
      const byRepo = new Map<string, typeof result.direct_usages>();
      for (const usage of result.direct_usages) {
        const repoKey = usage.repo_name ?? 'unknown';
        const existing = byRepo.get(repoKey) ?? [];
        existing.push(usage);
        byRepo.set(repoKey, existing);
      }

      for (const [repoName, usages] of byRepo) {
        console.log(`   📦 ${repoName} (${usages.length} usages):`);
        for (const usage of usages.slice(0, 10)) {
          const typeLabel = `[${usage.usage_type}]`.padEnd(10);
          const inSymbol = usage.enclosing_symbol ? `  in ${usage.enclosing_symbol}` : '';
          console.log(`      ${usage.file_path}:${usage.line}  ${typeLabel}${inSymbol}`);
        }
        if (usages.length > 10) {
          console.log(`      ... and ${usages.length - 10} more`);
        }
      }
    } else {
      for (const usage of result.direct_usages.slice(0, 15)) {
        const typeLabel = `[${usage.usage_type}]`.padEnd(10);
        const inSymbol = usage.enclosing_symbol ? `  in ${usage.enclosing_symbol}` : '';
        console.log(`   ${usage.file_path}:${usage.line}  ${typeLabel}${inSymbol}`);
      }
      if (result.direct_usages.length > 15) {
        console.log(`   ... and ${result.direct_usages.length - 15} more`);
      }
    }
  } else {
    console.log('Direct Impact: None (no direct usages found)');
  }

  console.log('');

  // Transitive impact
  if (result.transitive_impact.length > 0) {
    console.log(`Transitive Impact (${result.transitive_impact.length} symbols affected):`);
    
    // Group by depth
    const byDepth = new Map<number, ImpactInfo[]>();
    for (const impact of result.transitive_impact) {
      const existing = byDepth.get(impact.depth) ?? [];
      existing.push(impact);
      byDepth.set(impact.depth, existing);
    }

    for (const [depth, impacts] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
      console.log(`   Depth ${depth}:`);
      for (const impact of impacts.slice(0, 10)) {
        console.log(`      ${impact.qualified_name} (${impact.file_path}:${impact.start_line})`);
      }
      if (impacts.length > 10) {
        console.log(`      ... and ${impacts.length - 10} more at this depth`);
      }
    }
  } else {
    console.log('Transitive Impact: None');
  }

  console.log('');

  // Summary and warnings
  if (result.total_affected > 0) {
    console.log('Breaking Changes Warning:');
    console.log(`   Changing this symbol affects ${result.total_affected} other symbols`);
    
    if (result.direct_usages.length > 0) {
      const callCount = result.direct_usages.filter((u) => u.usage_type === 'call').length;
      const typeRefCount = result.direct_usages.filter((u) => u.usage_type === 'type_ref').length;
      
      if (callCount > 0) {
        console.log(`   Changing parameters affects ${callCount} direct callers`);
      }
      if (typeRefCount > 0) {
        console.log(`   Changing return type affects ${typeRefCount} type references`);
      }
    }
  } else {
    console.log('This symbol appears to be a leaf node with no dependents.');
  }

  console.log('');
}

/**
 * Execute the impact command
 */
async function executeImpact(
  symbolName: string,
  path: string | undefined,
  options: ImpactOptions
): Promise<void> {
  const isJson = options.json === true;
  const allRepos = options.allRepos === true;
  const reposFilter = parseReposOption(options.repos);
  const isMultiRepo = allRepos || reposFilter.length > 0;

  try {
    // For multi-repo search, skip repo context detection
    let repoContext: { repoPath: string; commitSha: string } | undefined;

    if (!isMultiRepo) {
      repoContext = await detectRepoContext(path, options.commit);
    }

    // Run with context
    await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        const changeImpactInput: Parameters<typeof queryEngine.analyzeChangeImpact>[0] = {
          symbol_name: symbolName,
        };

        if (allRepos) {
          changeImpactInput.all_repos = true;
        } else if (reposFilter.length > 0) {
          const resolved = resolveRepoIdentifiers(context.metadata, reposFilter);
          changeImpactInput.repo_ids = resolved.repoIds;
        } else if (repoContext) {
          changeImpactInput.repo_path = repoContext.repoPath;
          changeImpactInput.commit = repoContext.commitSha;
        }

        if (options.depth !== undefined) {
          changeImpactInput.max_depth = options.depth;
        }
        const result = await queryEngine.analyzeChangeImpact(changeImpactInput);

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          formatImpact(result, symbolName, isMultiRepo);
        }
      },
      { skipEmbeddings: true, skipVectors: true }
    );
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the impact command with the program
 */
export function registerImpactCommand(program: Command): void {
  program
    .command('impact')
    .description('Analyze the impact of changing a symbol')
    .argument('<symbol>', 'Name of the symbol to analyze')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to analyze (default: HEAD)')
    .option('--depth <n>', 'Maximum depth for transitive analysis (default: 3)', parseInt)
    .option('--json', 'Output in JSON format')
    .option('--all-repos', 'Analyze impact across all indexed repositories')
    .option('--repos <names...>', 'Analyze only in specific repositories (by name)')
    .action(async (symbolName: string, path: string | undefined, options: ImpactOptions) => {
      await executeImpact(symbolName, path, options);
    });
}
