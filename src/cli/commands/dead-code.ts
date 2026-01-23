/**
 * CLI command: dead-code
 *
 * Find unused exported symbols and potentially dead internal code.
 * This is a key differentiator from LSP - cross-file dead code detection.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { FindDeadCodeOutput, DeadSymbolInfo } from '../../sqi/types.js';
import { parseReposOption, resolveRepoIdentifiers, resolveGroupRepos } from '../repo-filter.js';

/**
 * Dead code command options
 */
interface DeadCodeOptions {
  commit?: string;
  json?: boolean;
  exported?: boolean;
  limit?: number;
  excludeTests?: boolean;
  allRepos?: boolean;
  repos?: string[];
  group?: string;
}

/**
 * Callable symbol kinds (functions, methods, classes that can be instantiated)
 */
const CALLABLE_KINDS = ['function', 'method', 'class', 'constructor'];

/**
 * Type definition kinds (interfaces, types that define structure but aren't called)
 */
const TYPE_DEFINITION_KINDS = ['interface', 'type_alias'];

/**
 * Check if a file path looks like a test file
 */
function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('/tests/') ||
    filePath.includes('/test/') ||
    filePath.includes('/__tests__/') ||
    filePath.includes('/fixtures/') ||
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.includes('_test.')
  );
}

/**
 * Categorized dead symbols for better output
 */
interface CategorizedSymbols {
  deadCode: DeadSymbolInfo[];      // Callable code that's never called
  unusedTypes: DeadSymbolInfo[];   // Type definitions that are never referenced
  testFixtures: DeadSymbolInfo[];  // Symbols in test files
}

/**
 * Categorize dead symbols by type and location
 */
function categorizeSymbols(symbols: DeadSymbolInfo[], excludeTests: boolean): CategorizedSymbols {
  const result: CategorizedSymbols = {
    deadCode: [],
    unusedTypes: [],
    testFixtures: [],
  };

  for (const s of symbols) {
    if (isTestFile(s.file_path)) {
      if (!excludeTests) {
        result.testFixtures.push(s);
      }
    } else if (CALLABLE_KINDS.includes(s.kind)) {
      result.deadCode.push(s);
    } else if (TYPE_DEFINITION_KINDS.includes(s.kind)) {
      result.unusedTypes.push(s);
    } else {
      // Other kinds (constants, etc.) go to deadCode
      result.deadCode.push(s);
    }
  }

  return result;
}

/**
 * Format dead code results for human-readable output
 */
function formatDeadCode(result: FindDeadCodeOutput, excludeTests: boolean, isMultiRepo: boolean): void {
  if (!result.success) {
    console.error(`Error: ${result.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  if (result.dead_symbols.length === 0) {
    console.log('\nNo dead code detected.');
    console.log('All top-level symbols have at least one usage.\n');
    return;
  }

  // Categorize symbols
  const categorized = categorizeSymbols(result.dead_symbols, excludeTests);
  const totalShown = categorized.deadCode.length + categorized.unusedTypes.length + categorized.testFixtures.length;

  if (totalShown === 0) {
    console.log('\nNo dead code detected (after filtering).');
    console.log('All top-level symbols have at least one usage.\n');
    return;
  }

  const reposNote = isMultiRepo ? ' (across repos)' : '';
  console.log(`\n=== Dead Code Detection${reposNote} ===\n`);

  // Dead callable code (functions, methods, classes)
  if (categorized.deadCode.length > 0) {
    console.log(`\x1b[31m■ Unused Code (${categorized.deadCode.length})\x1b[0m`);
    console.log('  Functions, methods, and classes that are never called:');
    formatSymbolList(categorized.deadCode, isMultiRepo);
  }

  // Unused type definitions
  if (categorized.unusedTypes.length > 0) {
    if (categorized.deadCode.length > 0) console.log('');
    console.log(`\x1b[33m■ Unused Type Definitions (${categorized.unusedTypes.length})\x1b[0m`);
    console.log('  Interfaces and type aliases with no references (may be public API):');
    formatSymbolList(categorized.unusedTypes, isMultiRepo);
  }

  // Test fixtures
  if (categorized.testFixtures.length > 0) {
    if (categorized.deadCode.length > 0 || categorized.unusedTypes.length > 0) console.log('');
    console.log(`\x1b[36m■ Test Fixtures (${categorized.testFixtures.length})\x1b[0m`);
    console.log('  Symbols in test files (expected, used for testing):');
    formatSymbolList(categorized.testFixtures, isMultiRepo);
  }

  // Summary
  console.log('');
  console.log('─'.repeat(50));
  console.log(`Summary: ${categorized.deadCode.length} unused code, ${categorized.unusedTypes.length} unused types, ${categorized.testFixtures.length} test fixtures`);

  if (categorized.deadCode.length > 0) {
    console.log('\n💡 Tip: Unused code can likely be safely removed.');
  }
  if (categorized.unusedTypes.length > 0) {
    console.log('💡 Tip: Unused types may be intentional exports for library consumers.');
  }
  console.log('');
}

/**
 * Format a list of symbols
 */
function formatSymbolList(symbols: DeadSymbolInfo[], showRepo: boolean = false): void {
  if (showRepo) {
    // Group by repo
    const byRepo = new Map<string, DeadSymbolInfo[]>();
    for (const s of symbols) {
      const repoKey = s.repo_name ?? 'unknown';
      const existing = byRepo.get(repoKey) ?? [];
      existing.push(s);
      byRepo.set(repoKey, existing);
    }

    for (const [repoName, repoSymbols] of byRepo) {
      console.log(`   📦 ${repoName}:`);
      for (const s of repoSymbols) {
        const kindLabel = `[${s.kind}]`.padEnd(12);
        console.log(`      ${s.file_path}:${s.start_line}  ${kindLabel} ${s.name}`);
      }
    }
  } else {
    for (const s of symbols) {
      const kindLabel = `[${s.kind}]`.padEnd(12);
      console.log(`   ${s.file_path}:${s.start_line}  ${kindLabel} ${s.name}`);
    }
  }
}

/**
 * Execute the dead-code command
 */
async function executeDeadCode(path: string | undefined, options: DeadCodeOptions): Promise<void> {
  const isJson = options.json === true;
  const allRepos = options.allRepos === true;
  const reposFilter = parseReposOption(options.repos);
  const groupFilter = options.group;
  const isMultiRepo = allRepos || reposFilter.length > 0 || groupFilter !== undefined;

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

        const findDeadCodeInput: Parameters<typeof queryEngine.findDeadCode>[0] = {};

        if (groupFilter !== undefined) {
          const resolved = resolveGroupRepos(context.metadata, groupFilter);
          findDeadCodeInput.repo_ids = resolved.repoIds;
        } else if (allRepos) {
          findDeadCodeInput.all_repos = true;
        } else if (reposFilter.length > 0) {
          const resolved = resolveRepoIdentifiers(context.metadata, reposFilter);
          findDeadCodeInput.repo_ids = resolved.repoIds;
        } else if (repoContext) {
          findDeadCodeInput.repo_path = repoContext.repoPath;
          findDeadCodeInput.commit = repoContext.commitSha;
        }

        if (options.exported !== undefined) {
          findDeadCodeInput.exported_only = options.exported;
        }
        if (options.limit !== undefined) {
          findDeadCodeInput.limit = options.limit;
        }
        const result = await queryEngine.findDeadCode(findDeadCodeInput);

        // Filter test fixtures if requested
        if (options.excludeTests) {
          result.dead_symbols = result.dead_symbols.filter((s) => !isTestFile(s.file_path));
          result.exported_count = result.dead_symbols.filter((s) => s.is_exported).length;
          result.unexported_count = result.dead_symbols.filter((s) => !s.is_exported).length;
        }

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          formatDeadCode(result, options.excludeTests ?? false, isMultiRepo);
        }
      },
      { skipEmbeddings: true, skipVectors: true }
    );
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the dead-code command with the program
 */
export function registerDeadCodeCommand(program: Command): void {
  program
    .command('dead-code')
    .description('Find unused exported symbols and potentially dead code')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to analyze (default: HEAD)')
    .option('--exported', 'Only show unused exported symbols')
    .option('--limit <n>', 'Maximum number of results', parseInt)
    .option('--exclude-tests', 'Exclude test files and fixtures from results')
    .option('--json', 'Output in JSON format')
    .option('--all-repos', 'Search across all indexed repositories')
    .option('--repos <names...>', 'Search only in specific repositories (by name)')
    .option('-g, --group <name>', 'Search repositories in named group')
    .action(async (path: string | undefined, options: DeadCodeOptions) => {
      await executeDeadCode(path, options);
    });
}
