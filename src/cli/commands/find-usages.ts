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
import type { UsageInfo, ExtractedUsage, FuzzyUsageMatch } from '../../sqi/types.js';
import { getDirtySymbols, flattenDirtyUsages } from '../../dirty/index.js';
import { parseReposOption, resolveRepoIdentifiers, resolveGroupRepos } from '../repo-filter.js';

/**
 * Command options
 */
interface FindUsagesOptions {
  commit?: string;
  file?: string;
  json?: boolean;
  dirty?: boolean;
  fuzzy?: boolean;
  allRepos?: boolean;
  repos?: string[];
  group?: string;
}

/**
 * Format usage info for display
 */
function formatUsageInfo(usage: UsageInfo, showRepo = false): string {
  const repoPrefix = showRepo && usage.repo_name ? `[${usage.repo_name}] ` : '';
  const location = `${repoPrefix}${usage.file_path}:${usage.line}:${usage.column}`;
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
  repoPath: string | undefined,
  options: FindUsagesOptions
): Promise<void> {
  const isJson = options.json === true;
  const includeDirty = options.dirty ?? true; // Default: include dirty files
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

    // Get dirty file usages if enabled (only for single repo)
    let dirtyUsages: UsageInfo[] = [];
    let dirtyFilePaths = new Set<string>();

    if (includeDirty && repoContext) {
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

        const input: Parameters<typeof queryEngine.findUsages>[0] = {
          symbol_name: symbolName,
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

        if (options.file) {
          input.file_path = options.file;
        }
        if (options.fuzzy) {
          input.fuzzy = true;
        }

        return await queryEngine.findUsages(input);
      },
      { skipEmbeddings: true, skipVectors: true }
    );

    // Merge results: dirty usages replace DB usages for the same file
    let allUsages: UsageInfo[] = [];
    const fuzzyMatches: FuzzyUsageMatch[] = result.fuzzy_matches ?? [];

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
      const output: {
        success: boolean;
        usages: UsageInfo[];
        total_count: number;
        dirty_files_checked: number;
        fuzzy_matches?: FuzzyUsageMatch[];
        error?: string;
      } = {
        success: result.success || dirtyUsages.length > 0,
        usages: allUsages,
        total_count: allUsages.length,
        dirty_files_checked: includeDirty ? dirtyFilePaths.size : 0,
      };
      if (fuzzyMatches.length > 0) {
        output.fuzzy_matches = fuzzyMatches;
      }
      if (!result.success && result.error) {
        output.error = result.error;
      }
      console.log(JSON.stringify(output, null, 2));
    } else if (!result.success && dirtyUsages.length === 0 && fuzzyMatches.length === 0) {
      console.error(`Error: ${result.error}`);
      process.exit(ExitCode.GENERAL_ERROR);
    } else if (allUsages.length === 0 && fuzzyMatches.length === 0) {
      console.log(`No usages found for: ${symbolName}`);
    } else {
      // Print exact matches
      if (allUsages.length > 0) {
        const dirtyNote = dirtyFilePaths.size > 0 ? ` (including ${dirtyFilePaths.size} uncommitted file(s))` : '';
        const reposNote = isMultiRepo ? ' (across repos)' : '';
        console.log(`Found ${allUsages.length} exact usage(s) of "${symbolName}"${dirtyNote}${reposNote}:\n`);

        // Group by repo (if multi-repo) then by file
        if (isMultiRepo) {
          const byRepo = new Map<string, UsageInfo[]>();
          for (const usage of allUsages) {
            const repoKey = usage.repo_name ?? 'unknown';
            const existing = byRepo.get(repoKey) ?? [];
            existing.push(usage);
            byRepo.set(repoKey, existing);
          }

          for (const [repoName, repoUsages] of byRepo) {
            console.log(`📦 ${repoName} (${repoUsages.length} usages)`);

            // Group by file within repo
            const byFile = new Map<string, UsageInfo[]>();
            for (const usage of repoUsages) {
              const existing = byFile.get(usage.file_path) ?? [];
              existing.push(usage);
              byFile.set(usage.file_path, existing);
            }

            for (const [filePath, usages] of byFile) {
              console.log(`  📄 ${filePath} (${usages.length} usages)`);
              for (const usage of usages) {
                console.log('  ' + formatUsageInfo(usage, false));
              }
            }
            console.log('');
          }
        } else {
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
              console.log(formatUsageInfo(usage, false));
            }
            console.log('');
          }
        }
      } else if (options.fuzzy) {
        console.log(`No exact usages found for "${symbolName}"\n`);
      }

      // Print fuzzy matches
      if (fuzzyMatches.length > 0) {
        console.log(`Similar symbol usages (fuzzy):\n`);
        for (const match of fuzzyMatches) {
          const similarity = Math.round(match.similarity * 100);
          console.log(`🔍 "${match.symbol_name}" (${similarity}% similar) - ${match.usages.length} usage(s):`);

          // Group by file
          const byFile = new Map<string, UsageInfo[]>();
          for (const usage of match.usages) {
            const existing = byFile.get(usage.file_path) ?? [];
            existing.push(usage);
            byFile.set(usage.file_path, existing);
          }

          for (const [filePath, usages] of byFile) {
            console.log(`  📄 ${filePath}`);
            for (const usage of usages) {
              const loc = `${usage.line}:${usage.column}`;
              const typeBadge = `[${usage.usage_type}]`;
              let line = `    ${loc}  ${typeBadge}`;
              if (usage.enclosing_symbol) {
                line += `  in ${usage.enclosing_symbol}`;
              }
              console.log(line);
            }
          }
          console.log('');
        }
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
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('-f, --file <path>', 'Limit search to a specific file')
    .option('--json', 'Output in JSON format')
    .option('--no-dirty', 'Exclude uncommitted changes from results')
    .option('--fuzzy', 'Include fuzzy matches (similar symbol names)')
    .option('--all-repos', 'Search across all indexed repositories')
    .option('--repos <names...>', 'Search only in specific repositories (by name)')
    .option('-g, --group <name>', 'Search repositories in named group')
    .action(async (symbolName: string, repoPath: string | undefined, options: FindUsagesOptions) => {
      await executeFindUsages(symbolName, repoPath, options);
    });
}
