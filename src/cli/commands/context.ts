/**
 * CLI command: context
 *
 * Get rich context about a specific symbol.
 * Everything an agent needs to understand and work with a symbol.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { detectRepoContext } from '../git-detect.js';
import { handleError } from '../errors.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { GetSymbolContextOutput } from '../../sqi/types.js';

/**
 * Context command options
 */
interface ContextOptions {
  commit?: string;
  json?: boolean;
  maxUsages?: number;
  noSource?: boolean;
  noUsages?: boolean;
}

/**
 * Format context for human-readable output
 */
function formatContext(result: GetSymbolContextOutput): void {
  if (!result.success || !result.context) {
    console.error(`Error: ${result.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  const ctx = result.context;
  const sym = ctx.symbol;

  console.log('\n=== Symbol Context ===\n');

  // Symbol info
  console.log('Symbol:');
  console.log(`   Name:      ${sym.name}`);
  console.log(`   Qualified: ${sym.qualified_name}`);
  console.log(`   Kind:      ${sym.kind}`);
  console.log(`   File:      ${sym.file_path}:${sym.start_line}-${sym.end_line}`);

  if (sym.visibility) {
    console.log(`   Visibility: ${sym.visibility}`);
  }
  if (sym.is_exported) {
    console.log(`   Exported:  yes`);
  }
  if (sym.is_async) {
    console.log(`   Async:     yes`);
  }
  if (sym.return_type) {
    console.log(`   Returns:   ${sym.return_type}`);
  }

  // Parameters
  if (sym.parameters && sym.parameters.length > 0) {
    console.log('\nParameters:');
    for (const p of sym.parameters) {
      const opt = p.optional ? '?' : '';
      const type = p.type ? `: ${p.type}` : '';
      console.log(`   ${p.name}${opt}${type}`);
    }
  }

  // Docstring
  if (sym.docstring) {
    console.log('\nDocumentation:');
    const lines = sym.docstring.split('\n').slice(0, 5);
    for (const line of lines) {
      console.log(`   ${line}`);
    }
    if (sym.docstring.split('\n').length > 5) {
      console.log('   ...');
    }
  }

  // Source code
  if (ctx.source_code) {
    console.log('\nSource Code:');
    const lines = ctx.source_code.split('\n');
    const maxLines = 20;
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
      console.log(`   ${(sym.start_line + i).toString().padStart(4)} | ${lines[i]}`);
    }
    if (lines.length > maxLines) {
      console.log(`   ... (${lines.length - maxLines} more lines)`);
    }
  }

  // Usages
  if (ctx.usages.length > 0) {
    console.log(`\nUsages (${ctx.usages.length}):`);
    for (const u of ctx.usages.slice(0, 10)) {
      console.log(`   [${u.usage_type}] ${u.file_path}:${u.line}`);
      if (u.context_snippet) {
        const snippet = u.context_snippet.split('\n')[0]?.trim() ?? '';
        if (snippet) {
          console.log(`         ${snippet.substring(0, 60)}${snippet.length > 60 ? '...' : ''}`);
        }
      }
    }
    if (ctx.usages.length > 10) {
      console.log(`   ... and ${ctx.usages.length - 10} more`);
    }
  }

  // Imports used
  if (ctx.imports_used.length > 0) {
    console.log('\nImports Used:');
    for (const imp of ctx.imports_used.slice(0, 10)) {
      console.log(`   ${imp}`);
    }
  }

  // Imported by
  if (ctx.imported_by.length > 0) {
    console.log('\nImported By:');
    for (const file of ctx.imported_by) {
      console.log(`   ${file}`);
    }
  }

  // Related symbols
  if (ctx.related_symbols.length > 0) {
    console.log('\nRelated Symbols (same file):');
    for (const rs of ctx.related_symbols.slice(0, 5)) {
      console.log(`   ${rs.name} (${rs.kind}) - line ${rs.start_line}`);
    }
    if (ctx.related_symbols.length > 5) {
      console.log(`   ... and ${ctx.related_symbols.length - 5} more`);
    }
  }

  console.log('');
}

/**
 * Execute the context command
 */
async function executeContext(
  symbolName: string,
  path: string | undefined,
  options: ContextOptions
): Promise<void> {
  const isJson = options.json === true;

  try {
    // Detect repository context
    const repoContext = await detectRepoContext(path, options.commit);

    // Run with context
    await withContext(
      async (context) => {
        const queryEngine = createStructuredQueryEngine(context.metadata);

        const result = await queryEngine.getSymbolContext({
          repo_path: repoContext.repoPath,
          commit: repoContext.commitSha,
          symbol_name: symbolName,
          include_usages: options.noUsages !== true,
          include_source: options.noSource !== true,
          max_usages: options.maxUsages ?? 20,
        });

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          formatContext(result);
        }
      },
      { skipEmbeddings: true, skipVectors: true }
    );
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the context command with the program
 */
export function registerContextCommand(program: Command): void {
  program
    .command('context')
    .description('Get rich context about a specific symbol')
    .argument('<symbol>', 'Name of the symbol to get context for')
    .argument('[path]', 'Path to the repository (default: current directory)')
    .option('-c, --commit <ref>', 'Commit to search (default: HEAD)')
    .option('--max-usages <n>', 'Maximum number of usages to return', parseInt)
    .option('--no-source', 'Skip source code')
    .option('--no-usages', 'Skip usages')
    .option('--json', 'Output in JSON format')
    .action(async (symbolName: string, path: string | undefined, options: ContextOptions) => {
      await executeContext(symbolName, path, options);
    });
}
