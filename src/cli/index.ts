#!/usr/bin/env node
/**
 * SourceRack CLI entry point
 *
 * Provides command-line interface for semantic code intelligence operations.
 */

import { Command } from 'commander';
import { registerIndexCommand } from './commands/index.js';
import { registerQueryCommand } from './commands/query.js';
import { registerStatusCommand } from './commands/status.js';
import { registerReposCommand } from './commands/repos.js';
import { registerGCCommand } from './commands/gc.js';
// SQI commands
import { registerFindDefCommand } from './commands/find-definition.js';
import { registerFindUsagesCommand } from './commands/find-usages.js';
import { registerHierarchyCommand } from './commands/hierarchy.js';
import { registerImportsCommand, registerImportersCommand } from './commands/imports.js';
import { registerSetupCommand } from './commands/setup.js';
// Agent-focused commands
import { registerSummaryCommand } from './commands/summary.js';
import { registerContextCommand } from './commands/context.js';

/**
 * Create and configure the CLI program
 */
function createProgram(): Command {
  const program = new Command();

  program
    .name('sourcerack')
    .description('Local Semantic Code Intelligence Platform')
    .version('0.1.0');

  // Register all commands
  registerIndexCommand(program);
  registerQueryCommand(program);
  registerStatusCommand(program);
  registerReposCommand(program);
  registerGCCommand(program);

  // SQI commands
  registerFindDefCommand(program);
  registerFindUsagesCommand(program);
  registerHierarchyCommand(program);
  registerImportsCommand(program);
  registerImportersCommand(program);

  // Setup command
  registerSetupCommand(program);

  // Agent-focused commands
  registerSummaryCommand(program);
  registerContextCommand(program);

  return program;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const program = createProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    // Commander handles most errors, but catch any unexpected ones
    console.error('Fatal error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run the CLI
void main();
