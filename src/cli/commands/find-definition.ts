/**
 * CLI command: find-def
 *
 * Find symbol definitions by name using the Structured Query Index.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError, ExitCode, AgentErrors, exitWithAgentError } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { SymbolKind, SymbolInfo, ExtractedSymbol, FuzzyMatch } from '../../sqi/types.js';
import { getDirtySymbols, flattenDirtySymbols } from '../../dirty/index.js';

/**
 * Command options
 */
interface FindDefOptions {
  commit?: string;
  type?: string;
  json?: boolean;
  dirty?: boolean;
  fuzzy?: boolean;
}

/**
 * Format symbol info for display
 */
function formatSymbolInfo(symbol: SymbolInfo, showDetails: boolean = false): string {
  const location = `${symbol.file_path}:${symbol.start_line}`;
  const kindBadge = `[${symbol.kind}]`;
  const asyncBadge = symbol.is_async ? 'async ' : '';
  const staticBadge = symbol.is_static ? 'static ' : '';
  const exportBadge = symbol.is_exported ? 'exported ' : '';
  const visibility = symbol.visibility ? `${symbol.visibility} ` : '';

  let line = `${location}  ${kindBadge} ${visibility}${exportBadge}${staticBadge}${asyncBadge}${symbol.qualified_name}`;

  if (symbol.return_type) {
    line += `: ${symbol.return_type}`;
  }

  if (showDetails && symbol.parameters && symbol.parameters.length > 0) {
    const params = symbol.parameters
      .map((p) => {
        let param = p.name;
        if (p.type) param += `: ${p.type}`;
        if (p.optional) param += '?';
        return param;
      })
      .join(', ');
    line += `(${params})`;
  }

  if (showDetails && symbol.docstring) {
    line += `\n    ${symbol.docstring.slice(0, 100)}${symbol.docstring.length > 100 ? '...' : ''}`;
  }

  return line;
}

/**
 * Convert ExtractedSymbol to SymbolInfo for display
 */
function extractedSymbolToInfo(symbol: ExtractedSymbol): SymbolInfo {
  return {
    name: symbol.name,
    qualified_name: symbol.qualified_name,
    kind: symbol.symbol_kind,
    file_path: symbol.file_path,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    visibility: symbol.visibility,
    is_async: symbol.is_async ?? false,
    is_static: symbol.is_static ?? false,
    is_exported: symbol.is_exported ?? true,
    return_type: symbol.return_type,
    parameters: symbol.parameters?.map((p) => ({
      name: p.name,
      type: p.type_annotation,
      optional: p.is_optional,
    })),
    docstring: symbol.docstring?.description,
  };
}

/**
 * Execute the find-def command
 */
async function executeFindDef(
  symbolName: string,
  repoPath: string | undefined,
  options: FindDefOptions
): Promise<void> {
  const isJson = options.json === true;
  const includeDirty = options.dirty ?? true; // Default: include dirty files

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(repoPath, options.commit);

    // Get dirty file symbols if enabled
    let dirtyDefinitions: SymbolInfo[] = [];
    let dirtyFilePaths = new Set<string>();

    if (includeDirty) {
      try {
        const dirty = await getDirtySymbols(repoContext.repoPath);
        dirtyFilePaths = dirty.dirtyFilePaths;

        // Filter dirty symbols matching the search
        const dirtySymbols = flattenDirtySymbols(dirty.symbols);
        const matchingDirty = dirtySymbols.filter((s) => {
          const nameMatch = s.name === symbolName || s.qualified_name.endsWith(`.${symbolName}`);
          const kindMatch = !options.type || s.symbol_kind === (options.type as SymbolKind);
          return nameMatch && kindMatch;
        });

        dirtyDefinitions = matchingDirty.map(extractedSymbolToInfo);
      } catch {
        // Ignore dirty file errors (e.g., not a git repo)
      }
    }

    // Run with context
    const result = await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        const input: Parameters<typeof queryEngine.findDefinition>[0] = {
          repo_path: repoContext.repoPath,
          commit: repoContext.commitSha,
          symbol_name: symbolName,
        };
        if (options.type) {
          input.symbol_kind = options.type as SymbolKind;
        }
        if (options.fuzzy) {
          input.fuzzy = true;
        }
        return await queryEngine.findDefinition(input);
      },
      { skipEmbeddings: true, skipVectors: true }
    );

    // Merge results: dirty symbols replace DB symbols for the same file
    let allDefinitions: SymbolInfo[] = [];

    if (result.success) {
      // Filter out DB definitions from dirty files (they're replaced)
      const dbDefinitions = result.definitions.filter(
        (def) => !dirtyFilePaths.has(def.file_path)
      );
      allDefinitions = [...dbDefinitions, ...dirtyDefinitions];
    } else if (dirtyDefinitions.length > 0) {
      // Even if DB query failed, we may have dirty results
      allDefinitions = dirtyDefinitions;
    }

    // Get fuzzy matches
    const fuzzyMatches: FuzzyMatch[] = result.fuzzy_matches ?? [];

    // Output results
    if (isJson) {
      const output = {
        success: result.success || dirtyDefinitions.length > 0,
        definitions: allDefinitions,
        fuzzy_matches: fuzzyMatches,
        dirty_files_checked: includeDirty ? dirtyFilePaths.size : 0,
        error: result.success ? undefined : result.error,
      };
      console.log(JSON.stringify(output, null, 2));
    } else if (!result.success && dirtyDefinitions.length === 0) {
      // Check if it's a not-indexed error
      if (result.error?.includes('not indexed') || result.error?.includes('not registered')) {
        exitWithAgentError(
          AgentErrors.repoNotIndexed(repoContext.repoPath),
          ExitCode.NOT_INDEXED,
          isJson
        );
      }
      console.error(`Error: ${result.error}`);
      process.exit(ExitCode.GENERAL_ERROR);
    } else if (allDefinitions.length === 0 && fuzzyMatches.length === 0) {
      exitWithAgentError(
        AgentErrors.symbolNotFound(symbolName),
        ExitCode.NOT_FOUND,
        isJson
      );
    } else {
      // Print exact matches
      if (allDefinitions.length > 0) {
        const dirtyNote = dirtyFilePaths.size > 0 ? ` (including ${dirtyFilePaths.size} uncommitted file(s))` : '';
        console.log(`Found ${allDefinitions.length} exact match(es) for "${symbolName}"${dirtyNote}:\n`);
        for (const def of allDefinitions) {
          console.log(formatSymbolInfo(def, true));
          console.log('');
        }
      } else if (fuzzyMatches.length > 0) {
        console.log(`No exact matches for "${symbolName}"\n`);
      }

      // Print fuzzy matches
      if (fuzzyMatches.length > 0) {
        console.log(`Similar matches (fuzzy):\n`);
        for (const match of fuzzyMatches) {
          const similarity = Math.round(match.similarity * 100);
          console.log(`${formatSymbolInfo(match.symbol, true)}  (${similarity}% similar)`);
          console.log('');
        }
      }
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the find-def command
 */
export function registerFindDefCommand(program: Command): void {
  program
    .command('find-def')
    .description('Find symbol definitions by name')
    .argument('<symbol>', 'Symbol name to find (e.g., "MyClass", "handleRequest")')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('-t, --type <kind>', 'Filter by symbol type (function, class, method, interface)')
    .option('--json', 'Output in JSON format')
    .option('--no-dirty', 'Exclude uncommitted changes from results')
    .option('--fuzzy', 'Include fuzzy matches (similar symbol names)')
    .action(async (symbolName: string, repoPath: string | undefined, options: FindDefOptions) => {
      await executeFindDef(symbolName, repoPath, options);
    });
}
