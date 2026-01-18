/**
 * CLI command: find-usages
 *
 * Find all usages/references of a symbol using the Structured Query Index.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError, ExitCode } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { UsageInfo, ExtractedUsage } from '../../sqi/types.js';
import { getDirtySymbols, flattenDirtyUsages } from '../../dirty/index.js';

/**
 * Command options
 */
interface FindUsagesOptions {
  path?: string;
  commit?: string;
  file?: string;
  json?: boolean;
  dirty?: boolean;
}

/**
 * Format usage info for display
 */
function formatUsageInfo(usage: UsageInfo): string {
  const location = `${usage.file_path}:${usage.line}:${usage.column}`;
  const typeBadge = `[${usage.usage_type}]`;

  let line = `${location}  ${typeBadge}`;

  if (usage.enclosing_symbol) {
    line += `  in ${usage.enclosing_symbol}`;
  }

  if (usage.context_snippet) {
    const snippet = usage.context_snippet.split('\n').map((l) => `    │ ${l}`).join('\n');
    line += `\n${snippet}`;
  }

  return line;
}

/**
 * Convert ExtractedUsage to UsageInfo for display
 */
function extractedUsageToInfo(usage: ExtractedUsage): UsageInfo {
  return {
    file_path: usage.file_path,
    line: usage.line,
    column: usage.column,
    usage_type: usage.usage_type,
    enclosing_symbol: usage.enclosing_symbol_qualified_name,
    context_snippet: '', // Not available from on-the-fly parsing
  };
}

/**
 * Execute the find-usages command
 */
async function executeFindUsages(
  symbolName: string,
  options: FindUsagesOptions
): Promise<void> {
  const isJson = options.json === true;
  const includeDirty = options.dirty ?? true; // Default: include dirty files

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(options.path, options.commit);

    // Get dirty file usages if enabled
    let dirtyUsages: UsageInfo[] = [];
    let dirtyFilePaths = new Set<string>();

    if (includeDirty) {
      try {
        const dirty = await getDirtySymbols(repoContext.repoPath);
        dirtyFilePaths = dirty.dirtyFilePaths;

        // Filter dirty usages matching the search
        const allDirtyUsages = flattenDirtyUsages(dirty.symbols);
        const matchingDirty = allDirtyUsages.filter((u) => {
          const nameMatch = u.symbol_name === symbolName;
          const fileMatch = !options.file || u.file_path === options.file;
          return nameMatch && fileMatch;
        });

        dirtyUsages = matchingDirty.map(extractedUsageToInfo);
      } catch {
        // Ignore dirty file errors (e.g., not a git repo)
      }
    }

    // Run with context
    const result = await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        return await queryEngine.findUsages({
          repo_path: repoContext.repoPath,
          commit: repoContext.commitSha,
          symbol_name: symbolName,
          file_path: options.file,
        });
      },
      { skipEmbeddings: true, skipVectors: true }
    );

    // Merge results: dirty usages replace DB usages for the same file
    let allUsages: UsageInfo[] = [];

    if (result.success) {
      // Filter out DB usages from dirty files (they're replaced)
      const dbUsages = result.usages.filter(
        (u) => !dirtyFilePaths.has(u.file_path)
      );
      allUsages = [...dbUsages, ...dirtyUsages];
    } else if (dirtyUsages.length > 0) {
      // Even if DB query failed, we may have dirty results
      allUsages = dirtyUsages;
    }

    // Output results
    if (isJson) {
      const output = {
        success: result.success || dirtyUsages.length > 0,
        usages: allUsages,
        total_count: allUsages.length,
        dirty_files_checked: includeDirty ? dirtyFilePaths.size : 0,
        error: result.success ? undefined : result.error,
      };
      console.log(JSON.stringify(output, null, 2));
    } else if (!result.success && dirtyUsages.length === 0) {
      console.error(`Error: ${result.error}`);
      process.exit(ExitCode.GENERAL_ERROR);
    } else if (allUsages.length === 0) {
      console.log(`No usages found for: ${symbolName}`);
    } else {
      const dirtyNote = dirtyFilePaths.size > 0 ? ` (including ${dirtyFilePaths.size} uncommitted file(s))` : '';
      console.log(`Found ${allUsages.length} usage(s) of "${symbolName}"${dirtyNote}:\n`);

      // Group by file
      const byFile = new Map<string, UsageInfo[]>();
      for (const usage of allUsages) {
        const existing = byFile.get(usage.file_path) ?? [];
        existing.push(usage);
        byFile.set(usage.file_path, existing);
      }

      for (const [filePath, usages] of byFile) {
        console.log(`📄 ${filePath} (${usages.length} usages)`);
        for (const usage of usages) {
          console.log(formatUsageInfo(usage));
        }
        console.log('');
      }
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the find-usages command
 */
export function registerFindUsagesCommand(program: Command): void {
  program
    .command('find-usages')
    .description('Find all usages/references of a symbol')
    .argument('<symbol>', 'Symbol name to find usages for')
    .option('-p, --path <path>', 'Repository path (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('-f, --file <path>', 'Limit search to a specific file')
    .option('--json', 'Output in JSON format')
    .option('--no-dirty', 'Exclude uncommitted changes from results')
    .action(async (symbolName: string, options: FindUsagesOptions) => {
      await executeFindUsages(symbolName, options);
    });
}
