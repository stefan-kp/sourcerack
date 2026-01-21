/**
 * CLI command: summary
 *
 * Get a comprehensive overview of an indexed codebase.
 * This is a key differentiator - what agents need to understand a codebase.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { CodebaseSummaryOutput } from '../../sqi/types.js';

/**
 * Summary command options
 */
interface SummaryOptions {
  commit?: string;
  json?: boolean;
  modules?: number;
  hotspots?: number;
  noDeps?: boolean;
  noHotspots?: boolean;
}

/**
 * Format summary for human-readable output
 */
function formatSummary(result: CodebaseSummaryOutput): void {
  if (!result.success || !result.summary) {
    console.error(`Error: ${result.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  const s = result.summary;

  console.log('\n=== Codebase Summary ===\n');

  // Basic stats
  console.log('Statistics:');
  console.log(`   Files:   ${s.total_files}`);
  console.log(`   Symbols: ${s.total_symbols}`);
  console.log(`   Usages:  ${s.total_usages}`);
  console.log(`   Imports: ${s.total_imports}`);

  // Languages
  if (s.languages.length > 0) {
    console.log('\nLanguages:');
    for (const lang of s.languages) {
      const bar = '#'.repeat(Math.ceil(lang.percentage / 5));
      console.log(`   ${lang.language.padEnd(12)} ${String(lang.percentage).padStart(3)}% ${bar} (${lang.file_count} files, ${lang.symbol_count} symbols)`);
    }
  }

  // Modules
  if (s.modules.length > 0) {
    console.log('\nMain Modules:');
    for (const mod of s.modules) {
      console.log(`   ${mod.path}/`);
      console.log(`      ${mod.file_count} files, ${mod.symbol_count} symbols`);
      if (mod.main_symbols.length > 0) {
        console.log(`      Main: ${mod.main_symbols.join(', ')}`);
      }
    }
  }

  // Entry points
  if (s.entry_points.length > 0) {
    console.log('\nEntry Points:');
    for (const ep of s.entry_points) {
      console.log(`   [${ep.type}] ${ep.file_path}`);
      if (ep.exports.length > 0) {
        console.log(`         exports: ${ep.exports.slice(0, 5).join(', ')}${ep.exports.length > 5 ? '...' : ''}`);
      }
    }
  }

  // Hotspots
  if (s.hotspots.length > 0) {
    console.log('\nHotspots (most used):');
    for (const hs of s.hotspots) {
      console.log(`   ${hs.name} (${hs.kind}) - ${hs.usage_count} usages`);
      console.log(`      ${hs.file_path}`);
    }
  }

  // Dependencies
  if (s.dependencies.length > 0) {
    console.log('\nExternal Dependencies:');
    for (const dep of s.dependencies.slice(0, 10)) {
      console.log(`   ${dep.name} (${dep.import_count} imports)`);
    }
  }

  // Symbol breakdown
  if (s.symbol_breakdown.length > 0) {
    console.log('\nSymbol Types:');
    for (const sb of s.symbol_breakdown) {
      console.log(`   ${sb.kind.padEnd(15)} ${sb.count}`);
    }
  }

  console.log('');
}

/**
 * Execute the summary command
 */
async function executeSummary(path: string | undefined, options: SummaryOptions): Promise<void> {
  const isJson = options.json === true;

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(path, options.commit);

    // Run with context
    await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        const result = await queryEngine.codebaseSummary({
          repo_path: repoContext.repoPath,
          commit: repoContext.commitSha,
          include_hotspots: options.noHotspots !== true,
          include_dependencies: options.noDeps !== true,
          max_modules: options.modules ?? 10,
          max_hotspots: options.hotspots ?? 10,
        });

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          formatSummary(result);
        }
      },
      { skipEmbeddings: true, skipVectors: true }
    );
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the summary command with the program
 */
export function registerSummaryCommand(program: Command): void {
  program
    .command('summary')
    .description('Get a comprehensive overview of an indexed codebase')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to analyze (default: HEAD)')
    .option('--modules <n>', 'Maximum number of modules to show', parseInt)
    .option('--hotspots <n>', 'Maximum number of hotspots to show', parseInt)
    .option('--no-deps', 'Skip external dependencies analysis')
    .option('--no-hotspots', 'Skip hotspot analysis')
    .option('--json', 'Output in JSON format')
    .action(async (path: string | undefined, options: SummaryOptions) => {
      await executeSummary(path, options);
    });
}
