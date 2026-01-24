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
import { SymbolKind } from '../../sqi/types.js';
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
  strict?: boolean;
  framework?: string;
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
 * Framework convention patterns
 * These symbols are typically used by convention, not explicit calls
 */
interface FrameworkPatterns {
  name: string;
  filePaths: RegExp[];
  classPatterns: RegExp[];
  methodPatterns: RegExp[];
}

const RAILS_PATTERNS: FrameworkPatterns = {
  name: 'rails',
  filePaths: [
    /app\/controllers\/.*_controller\.rb$/,
    /app\/decorators\/.*_decorator\.rb$/,
    /app\/jobs\/.*_job\.rb$/,
    /app\/mailers\/.*_mailer\.rb$/,
    /app\/serializers\/.*_serializer\.rb$/,
    /app\/services\/.*_service\.rb$/,
    /app\/workers\/.*_worker\.rb$/,
    /app\/channels\/.*_channel\.rb$/,
    /app\/helpers\/.*_helper\.rb$/,
    /app\/presenters\/.*_presenter\.rb$/,
    /app\/policies\/.*_policy\.rb$/,
    /app\/validators\/.*_validator\.rb$/,
    /app\/uploaders\/.*_uploader\.rb$/,
    /app\/models\/.*\.rb$/,  // ActiveRecord models
    /db\/migrate\/.*\.rb$/,  // Migrations
  ],
  classPatterns: [
    /Controller$/,
    /Decorator$/,
    /Job$/,
    /Mailer$/,
    /Serializer$/,
    /Service$/,
    /Worker$/,
    /Channel$/,
    /Helper$/,
    /Presenter$/,
    /Policy$/,
    /Validator$/,
    /Uploader$/,
  ],
  methodPatterns: [
    // Standard controller actions
    /^(index|show|new|create|edit|update|destroy)$/,
    // Callbacks
    /^(before_|after_|around_)/,
    // ActiveRecord
    /^(save|validate|destroy)$/,
  ],
};

const DJANGO_PATTERNS: FrameworkPatterns = {
  name: 'django',
  filePaths: [
    /views\.py$/,
    /models\.py$/,
    /serializers\.py$/,
    /admin\.py$/,
    /forms\.py$/,
    /signals\.py$/,
    /management\/commands\/.*\.py$/,
    /migrations\/.*\.py$/,
  ],
  classPatterns: [
    /View$/,
    /ViewSet$/,
    /Serializer$/,
    /Admin$/,
    /Form$/,
    /Model$/,
    /Command$/,
  ],
  methodPatterns: [
    /^(get|post|put|patch|delete|head|options)$/,
    /^(list|create|retrieve|update|partial_update|destroy)$/,
    /^(clean|save|validate)/,
  ],
};

const EXPRESS_PATTERNS: FrameworkPatterns = {
  name: 'express',
  filePaths: [
    /routes?\/.*\.(ts|js)$/,
    /controllers?\/.*\.(ts|js)$/,
    /middleware\/.*\.(ts|js)$/,
    /handlers?\/.*\.(ts|js)$/,
  ],
  classPatterns: [
    /Controller$/,
    /Handler$/,
    /Middleware$/,
  ],
  methodPatterns: [],
};

const NESTJS_PATTERNS: FrameworkPatterns = {
  name: 'nestjs',
  filePaths: [
    /\.controller\.(ts|js)$/,
    /\.service\.(ts|js)$/,
    /\.module\.(ts|js)$/,
    /\.guard\.(ts|js)$/,
    /\.interceptor\.(ts|js)$/,
    /\.pipe\.(ts|js)$/,
    /\.filter\.(ts|js)$/,
    /\.decorator\.(ts|js)$/,
    /\.gateway\.(ts|js)$/,
    /\.resolver\.(ts|js)$/,
  ],
  classPatterns: [
    /Controller$/,
    /Service$/,
    /Module$/,
    /Guard$/,
    /Interceptor$/,
    /Pipe$/,
    /Filter$/,
    /Gateway$/,
    /Resolver$/,
  ],
  methodPatterns: [],
};

const FASTAPI_PATTERNS: FrameworkPatterns = {
  name: 'fastapi',
  filePaths: [
    /routers?\/.*\.py$/,
    /endpoints?\/.*\.py$/,
    /api\/.*\.py$/,
  ],
  classPatterns: [],
  methodPatterns: [],
};

const FRAMEWORK_PATTERNS: FrameworkPatterns[] = [
  RAILS_PATTERNS,
  DJANGO_PATTERNS,
  EXPRESS_PATTERNS,
  NESTJS_PATTERNS,
  FASTAPI_PATTERNS,
];

/**
 * Detect which framework a symbol belongs to based on its file path
 */
function detectFramework(filePath: string): FrameworkPatterns | undefined {
  for (const framework of FRAMEWORK_PATTERNS) {
    for (const pattern of framework.filePaths) {
      if (pattern.test(filePath)) {
        return framework;
      }
    }
  }
  return undefined;
}

/**
 * Check if a symbol matches framework conventions (used by convention, not explicit calls)
 */
function isFrameworkConventionSymbol(
  symbol: DeadSymbolInfo,
  frameworkFilter?: string
): { isConvention: boolean; framework?: string } {
  const framework = detectFramework(symbol.file_path);

  if (!framework) {
    return { isConvention: false };
  }

  // If a specific framework filter is set, only consider that framework
  if (frameworkFilter && framework.name !== frameworkFilter) {
    return { isConvention: false };
  }

  // Check class name patterns
  if (symbol.kind === SymbolKind.CLASS) {
    for (const pattern of framework.classPatterns) {
      if (pattern.test(symbol.name)) {
        return { isConvention: true, framework: framework.name };
      }
    }
    // For Rails models and migrations, the file path is enough
    if (framework.name === 'rails') {
      if (symbol.file_path.includes('app/models/') || symbol.file_path.includes('db/migrate/')) {
        return { isConvention: true, framework: framework.name };
      }
    }
  }

  // Check method name patterns
  if (symbol.kind === SymbolKind.METHOD || symbol.kind === SymbolKind.FUNCTION) {
    for (const pattern of framework.methodPatterns) {
      if (pattern.test(symbol.name)) {
        return { isConvention: true, framework: framework.name };
      }
    }
  }

  // If file matches framework path, likely convention-based
  // This catches things like view functions, route handlers, etc.
  return { isConvention: true, framework: framework.name };
}

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
 * Framework convention symbol with detected framework
 */
interface FrameworkSymbol extends DeadSymbolInfo {
  detectedFramework: string;
}

/**
 * Categorized dead symbols for better output
 */
interface CategorizedSymbols {
  deadCode: DeadSymbolInfo[];           // Callable code that's never called
  unusedTypes: DeadSymbolInfo[];        // Type definitions that are never referenced
  testFixtures: DeadSymbolInfo[];       // Symbols in test files
  frameworkConventions: FrameworkSymbol[]; // Symbols used by framework conventions
}

/**
 * Categorize dead symbols by type and location
 */
function categorizeSymbols(
  symbols: DeadSymbolInfo[],
  excludeTests: boolean,
  strictMode: boolean,
  frameworkFilter?: string
): CategorizedSymbols {
  const result: CategorizedSymbols = {
    deadCode: [],
    unusedTypes: [],
    testFixtures: [],
    frameworkConventions: [],
  };

  for (const s of symbols) {
    // Check test files first
    if (isTestFile(s.file_path)) {
      if (!excludeTests) {
        result.testFixtures.push(s);
      }
      continue;
    }

    // Check framework conventions (unless strict mode)
    if (!strictMode) {
      const conventionCheck = isFrameworkConventionSymbol(s, frameworkFilter);
      if (conventionCheck.isConvention && conventionCheck.framework) {
        result.frameworkConventions.push({
          ...s,
          detectedFramework: conventionCheck.framework,
        });
        continue;
      }
    }

    // Categorize by symbol kind
    if (CALLABLE_KINDS.includes(s.kind)) {
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
function formatDeadCode(
  result: FindDeadCodeOutput,
  excludeTests: boolean,
  isMultiRepo: boolean,
  strictMode: boolean,
  frameworkFilter?: string
): void {
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
  const categorized = categorizeSymbols(result.dead_symbols, excludeTests, strictMode, frameworkFilter);
  const totalShown =
    categorized.deadCode.length +
    categorized.unusedTypes.length +
    categorized.testFixtures.length +
    (strictMode ? 0 : categorized.frameworkConventions.length);

  if (totalShown === 0) {
    console.log('\nNo dead code detected (after filtering).');
    console.log('All top-level symbols have at least one usage.\n');
    return;
  }

  const reposNote = isMultiRepo ? ' (across repos)' : '';
  const modeNote = strictMode ? ' [strict mode]' : '';
  console.log(`\n=== Dead Code Detection${reposNote}${modeNote} ===\n`);

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

  // Framework conventions (only shown when not in strict mode and there are excluded items)
  if (!strictMode && categorized.frameworkConventions.length > 0) {
    const hasOtherSections =
      categorized.deadCode.length > 0 ||
      categorized.unusedTypes.length > 0 ||
      categorized.testFixtures.length > 0;
    if (hasOtherSections) console.log('');

    // Group by framework
    const byFramework = new Map<string, FrameworkSymbol[]>();
    for (const s of categorized.frameworkConventions) {
      const existing = byFramework.get(s.detectedFramework) ?? [];
      existing.push(s);
      byFramework.set(s.detectedFramework, existing);
    }

    console.log(`\x1b[90m■ Framework Conventions (${categorized.frameworkConventions.length} excluded)\x1b[0m`);
    console.log('  Symbols used by framework conventions (not explicit calls):');
    for (const [framework, symbols] of byFramework) {
      console.log(`   [${framework}] ${symbols.length} symbol${symbols.length !== 1 ? 's' : ''}`);
    }
    console.log('  \x1b[90mUse --strict to include these in dead code analysis.\x1b[0m');
  }

  // Summary
  console.log('');
  console.log('─'.repeat(50));
  const summaryParts = [
    `${categorized.deadCode.length} unused code`,
    `${categorized.unusedTypes.length} unused types`,
    `${categorized.testFixtures.length} test fixtures`,
  ];
  if (!strictMode && categorized.frameworkConventions.length > 0) {
    summaryParts.push(`${categorized.frameworkConventions.length} framework conventions (excluded)`);
  }
  console.log(`Summary: ${summaryParts.join(', ')}`);

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
  const strictMode = options.strict === true;
  const frameworkFilter = options.framework;
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
          // For JSON output, include framework convention info
          const categorized = categorizeSymbols(
            result.dead_symbols,
            options.excludeTests ?? false,
            strictMode,
            frameworkFilter
          );
          const jsonResult = {
            ...result,
            categorized: {
              dead_code: categorized.deadCode,
              unused_types: categorized.unusedTypes,
              test_fixtures: categorized.testFixtures,
              framework_conventions: strictMode ? [] : categorized.frameworkConventions,
            },
            strict_mode: strictMode,
          };
          console.log(JSON.stringify(jsonResult, null, 2));
        } else {
          formatDeadCode(result, options.excludeTests ?? false, isMultiRepo, strictMode, frameworkFilter);
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
    .option('--strict', 'Include framework convention symbols (controllers, jobs, etc.) in analysis')
    .option('--framework <name>', 'Only consider a specific framework (rails, django, express, nestjs, fastapi)')
    .action(async (path: string | undefined, options: DeadCodeOptions) => {
      await executeDeadCode(path, options);
    });
}
