/**
 * CLI commands: imports and importers
 *
 * Analyze import relationships using the Structured Query Index.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError, ExitCode } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { ImportInfo } from '../../sqi/types.js';
import { parseReposOption, resolveRepoIdentifiers, resolveGroupRepos } from '../repo-filter.js';

/**
 * Command options
 */
interface ImportsOptions {
  commit?: string;
  json?: boolean;
}

interface ImportersOptions {
  commit?: string;
  json?: boolean;
  allRepos?: boolean;
  repos?: string[];
  group?: string;
}

/**
 * Format import info for display
 */
function formatImport(imp: ImportInfo): string {
  const typeBadge = `[${imp.import_type}]`;
  let line = `  ${typeBadge} ${imp.module_specifier}`;

  if (imp.resolved_path) {
    line += ` → ${imp.resolved_path}`;
  }

  line += ` (line ${imp.line})`;

  if (imp.bindings.length > 0) {
    const bindings = imp.bindings
      .map((b) => {
        let bind = b.imported_name;
        if (b.local_name !== b.imported_name) {
          bind += ` as ${b.local_name}`;
        }
        if (b.is_type_only) {
          bind = `type ${bind}`;
        }
        return bind;
      })
      .join(', ');
    line += `\n    { ${bindings} }`;
  }

  return line;
}

/**
 * Execute the imports command
 */
async function executeImports(
  filePath: string,
  repoPath: string | undefined,
  options: ImportsOptions
): Promise<void> {
  const isJson = options.json === true;

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(repoPath, options.commit);

    // Run with context
    const result = await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        return await queryEngine.findImports({
          repo_path: repoContext.repoPath,
          commit: repoContext.commitSha,
          file_path: filePath,
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
    } else if (result.imports.length === 0) {
      console.log(`No imports found in: ${filePath}`);
    } else {
      console.log(`\nImports in ${filePath} (${result.imports.length}):\n`);

      // Group by import type
      const esImports = result.imports.filter((i) => i.import_type === 'es_import');
      const commonjsImports = result.imports.filter((i) => i.import_type === 'commonjs');
      const otherImports = result.imports.filter(
        (i) => !['es_import', 'commonjs'].includes(i.import_type)
      );

      if (esImports.length > 0) {
        console.log('ES Modules:');
        for (const imp of esImports) {
          console.log(formatImport(imp));
        }
        console.log('');
      }

      if (commonjsImports.length > 0) {
        console.log('CommonJS:');
        for (const imp of commonjsImports) {
          console.log(formatImport(imp));
        }
        console.log('');
      }

      if (otherImports.length > 0) {
        console.log('Other:');
        for (const imp of otherImports) {
          console.log(formatImport(imp));
        }
        console.log('');
      }
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Execute the importers command
 */
async function executeImporters(
  moduleName: string,
  repoPath: string | undefined,
  options: ImportersOptions
): Promise<void> {
  const isJson = options.json === true;
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

        const input: Parameters<typeof queryEngine.findImporters>[0] = {
          module: moduleName,
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

        return await queryEngine.findImporters(input);
      },
      { skipEmbeddings: true, skipVectors: true }
    );

    // Output results
    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(ExitCode.GENERAL_ERROR);
    } else if (result.importers.length === 0) {
      console.log(`No files import: ${moduleName}`);
    } else {
      const reposNote = isMultiRepo ? ' (across repos)' : '';
      console.log(`\nFiles importing "${moduleName}" (${result.importers.length})${reposNote}:\n`);

      if (isMultiRepo) {
        // Group by repo
        const byRepo = new Map<string, typeof result.importers>();
        for (const importer of result.importers) {
          const repoKey = importer.repo_name ?? 'unknown';
          const existing = byRepo.get(repoKey) ?? [];
          existing.push(importer);
          byRepo.set(repoKey, existing);
        }

        for (const [repoName, importers] of byRepo) {
          console.log(`📦 ${repoName} (${importers.length} files)`);
          for (const importer of importers) {
            console.log(`  📄 ${importer.file_path}:${importer.line}`);
            if (importer.bindings.length > 0) {
              const bindings = importer.bindings
                .map((b) => {
                  let bind = b.imported_name;
                  if (b.local_name !== b.imported_name) {
                    bind += ` as ${b.local_name}`;
                  }
                  return bind;
                })
                .join(', ');
              console.log(`     { ${bindings} }`);
            }
          }
          console.log('');
        }
      } else {
        for (const importer of result.importers) {
          console.log(`📄 ${importer.file_path}:${importer.line}`);
          if (importer.bindings.length > 0) {
            const bindings = importer.bindings
              .map((b) => {
                let bind = b.imported_name;
                if (b.local_name !== b.imported_name) {
                  bind += ` as ${b.local_name}`;
                }
                return bind;
              })
              .join(', ');
            console.log(`   { ${bindings} }`);
          }
        }
        console.log('');
      }
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the dependencies command
 */
export function registerDependenciesCommand(program: Command): void {
  program
    .command('dependencies')
    .alias('deps')
    .description('Show dependencies of a file (what does this file import?)')
    .argument('<file>', 'File path to analyze')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('--json', 'Output in JSON format')
    .action(async (filePath: string, repoPath: string | undefined, options: ImportsOptions) => {
      await executeImports(filePath, repoPath, options);
    });
}

/**
 * Register the dependents command
 */
export function registerDependentsCommand(program: Command): void {
  program
    .command('dependents')
    .description('Show dependents of a module (who imports this module?)')
    .argument('<module>', 'Module specifier to search for (e.g., "@/utils", "lodash")')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('--json', 'Output in JSON format')
    .option('--all-repos', 'Search across all indexed repositories')
    .option('--repos <names...>', 'Search only in specific repositories (by name)')
    .option('-g, --group <name>', 'Search repositories in named group')
    .action(async (moduleName: string, repoPath: string | undefined, options: ImportersOptions) => {
      await executeImporters(moduleName, repoPath, options);
    });
}
