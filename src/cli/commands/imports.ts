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

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(repoPath, options.commit);

    // Run with context
    const result = await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        return await queryEngine.findImporters({
          repo_path: repoContext.repoPath,
          commit: repoContext.commitSha,
          module: moduleName,
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
    } else if (result.importers.length === 0) {
      console.log(`No files import: ${moduleName}`);
    } else {
      console.log(`\nFiles importing "${moduleName}" (${result.importers.length}):\n`);

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
    .action(async (moduleName: string, repoPath: string | undefined, options: ImportersOptions) => {
      await executeImporters(moduleName, repoPath, options);
    });
}
