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

/**
 * Impact command options
 */
interface ImpactOptions {
  commit?: string;
  json?: boolean;
  depth?: number;
}

/**
 * Format impact analysis results for human-readable output
 */
function formatImpact(result: ChangeImpactOutput, symbolName: string): void {
  if (!result.success) {
    console.error(`Error: ${result.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  console.log('\n=== Change Impact Analysis ===\n');

  if (result.symbol) {
    const s = result.symbol;
    console.log(`Symbol: ${s.qualified_name} (${s.kind})`);
    console.log(`Location: ${s.file_path}:${s.start_line}-${s.end_line}`);
  } else {
    console.log(`Symbol: ${symbolName}`);
  }

  console.log('');

  // Direct usages
  if (result.direct_usages.length > 0) {
    console.log(`Direct Impact (${result.direct_usages.length} usages):`);
    for (const usage of result.direct_usages.slice(0, 15)) {
      const typeLabel = `[${usage.usage_type}]`.padEnd(10);
      const inSymbol = usage.enclosing_symbol ? `  in ${usage.enclosing_symbol}` : '';
      console.log(`   ${usage.file_path}:${usage.line}  ${typeLabel}${inSymbol}`);
    }
    if (result.direct_usages.length > 15) {
      console.log(`   ... and ${result.direct_usages.length - 15} more`);
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

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(path, options.commit);

    // Run with context
    await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        const changeImpactInput: {
          repo_path: string;
          commit: string;
          symbol_name: string;
          max_depth?: number;
        } = {
          repo_path: repoContext.repoPath,
          commit: repoContext.commitSha,
          symbol_name: symbolName,
        };
        if (options.depth !== undefined) {
          changeImpactInput.max_depth = options.depth;
        }
        const result = await queryEngine.analyzeChangeImpact(changeImpactInput);

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          formatImpact(result, symbolName);
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
    .action(async (symbolName: string, path: string | undefined, options: ImpactOptions) => {
      await executeImpact(symbolName, path, options);
    });
}
