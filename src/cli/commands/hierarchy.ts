/**
 * CLI command: hierarchy
 *
 * Show symbol hierarchy using the Structured Query Index.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError, ExitCode } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { SymbolInfo } from '../../sqi/types.js';

/**
 * Command options
 */
interface HierarchyOptions {
  commit?: string;
  direction?: 'children' | 'parents' | 'both';
  depth?: string;
  json?: boolean;
}

/**
 * Format symbol for tree display
 */
function formatSymbol(symbol: SymbolInfo, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  const kindBadge = `[${symbol.kind}]`;
  let line = `${prefix}${kindBadge} ${symbol.name}`;

  if (symbol.return_type) {
    line += `: ${symbol.return_type}`;
  }

  if (symbol.visibility) {
    line += ` (${symbol.visibility})`;
  }

  return line;
}

/**
 * Execute the hierarchy command
 */
async function executeHierarchy(
  symbolName: string,
  repoPath: string | undefined,
  options: HierarchyOptions
): Promise<void> {
  const isJson = options.json === true;
  const direction = options.direction ?? 'both';

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(repoPath, options.commit);

    // Run with context
    const result = await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        return await queryEngine.findHierarchy({
          repo_path: repoContext.repoPath,
          commit: repoContext.commitSha,
          symbol_name: symbolName,
          direction,
        });
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
      // Print symbol
      console.log(`\nSymbol: ${result.symbol.qualified_name}`);
      console.log(`Location: ${result.symbol.file_path}:${result.symbol.start_line}`);
      console.log(`Kind: ${result.symbol.kind}`);

      if (result.symbol.docstring) {
        console.log(`\nDocumentation:`);
        console.log(`  ${result.symbol.docstring}`);
      }

      // Print parents
      if (result.parents && result.parents.length > 0) {
        console.log(`\nParent Chain:`);
        for (let i = 0; i < result.parents.length; i++) {
          console.log(`${'  '.repeat(i)}└─ ${result.parents[i]}`);
        }
      }

      // Print children
      if (result.children && result.children.length > 0) {
        console.log(`\nChildren (${result.children.length}):`);
        for (const child of result.children) {
          console.log(formatSymbol(child, 1));
          if (child.parameters && child.parameters.length > 0) {
            const params = child.parameters
              .map((p) => `${p.name}${p.type ? `: ${p.type}` : ''}`)
              .join(', ');
            console.log(`    (${params})`);
          }
        }
      }

      console.log('');
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the hierarchy command
 */
export function registerHierarchyCommand(program: Command): void {
  program
    .command('hierarchy')
    .description('Show symbol hierarchy (children/parents)')
    .argument('<symbol>', 'Symbol name to show hierarchy for')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option(
      '-d, --direction <dir>',
      'Direction: children, parents, or both (default: both)',
      'both'
    )
    .option('--depth <n>', 'Maximum depth to traverse (default: unlimited)')
    .option('--json', 'Output in JSON format')
    .action(async (symbolName: string, repoPath: string | undefined, options: HierarchyOptions) => {
      await executeHierarchy(symbolName, repoPath, options);
    });
}
