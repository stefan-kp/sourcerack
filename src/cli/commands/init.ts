/**
 * CLI command: init
 *
 * Initialize project-specific SourceRack configuration with framework detection
 * and customizable boost settings.
 *
 * Features:
 * - Auto-detect framework (Rails, Node.js, Go, Python, Java, Rust)
 * - Configure vector storage (SQLite-VSS or Qdrant)
 * - Set priority source directories
 * - Configure SQI boosting per command
 */

import { Command } from 'commander';
import { createInterface, Interface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import { handleError } from '../errors.js';
import {
  detectFramework,
  FRAMEWORK_PRESETS,
  FRAMEWORK_PRIORITY_DIRS,
} from '../../config/frameworks.js';
import type {
  FrameworkPreset,
  BoostConfig,
  SqiBoostConfig,
  VectorProvider,
} from '../../config/schema.js';

/**
 * Init command options
 */
interface InitOptions {
  yes?: boolean;
  force?: boolean;
  json?: boolean;
}

/**
 * Prompt for user input
 */
async function prompt(
  rl: Interface,
  question: string,
  defaultValue?: string
): Promise<string> {
  return new Promise((resolve) => {
    const defaultSuffix = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${defaultSuffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt for yes/no
 */
async function promptYesNo(
  rl: Interface,
  question: string,
  defaultYes = true
): Promise<boolean> {
  const defaultSuffix = defaultYes ? ' [Y/n]' : ' [y/N]';
  return new Promise((resolve) => {
    rl.question(`${question}${defaultSuffix}: `, (answer) => {
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') {
        resolve(defaultYes);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}

/**
 * Prompt for selection from options
 */
async function promptSelect<T extends string>(
  rl: Interface,
  question: string,
  options: Array<{ value: T; label: string }>,
  defaultValue: T
): Promise<T> {
  console.log(`\n${question}`);
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!;
    const isDefault = opt.value === defaultValue;
    const marker = isDefault ? chalk.green('*') : ' ';
    console.log(`  ${marker} ${i + 1}. ${opt.label}${isDefault ? chalk.dim(' (default)') : ''}`);
  }

  return new Promise((resolve) => {
    const defaultIndex = options.findIndex((o) => o.value === defaultValue) + 1;
    rl.question(`Select [1-${options.length}, default: ${defaultIndex}]: `, (answer) => {
      const trimmed = answer.trim();
      if (trimmed === '') {
        resolve(defaultValue);
        return;
      }
      const index = parseInt(trimmed, 10) - 1;
      if (index >= 0 && index < options.length) {
        const selected = options[index];
        resolve(selected ? selected.value : defaultValue);
      } else {
        resolve(defaultValue);
      }
    });
  });
}

/**
 * Generate project config file content
 */
function generateProjectConfig(config: {
  framework: FrameworkPreset;
  vectorStorage: VectorProvider;
  boost: BoostConfig;
  sqiBoosting: SqiBoostConfig;
  priorityDirs: string[];
  qdrantUrl?: string;
}): string {
  const projectConfig: Record<string, unknown> = {
    $schema: 'https://sourcerack.dev/schema/project-config.json',
    framework: config.framework,
    vectorStorage: {
      provider: config.vectorStorage,
    },
    boost: config.boost,
    sqiBoosting: config.sqiBoosting,
    priorityDirs: config.priorityDirs,
  };

  // Add Qdrant URL if using Qdrant
  if (config.vectorStorage === 'qdrant' && config.qdrantUrl) {
    (projectConfig.vectorStorage as Record<string, unknown>).qdrant = {
      url: config.qdrantUrl,
    };
  }

  return JSON.stringify(projectConfig, null, 2) + '\n';
}

/**
 * Execute the init command
 */
async function executeInit(projectPath: string | undefined, options: InitOptions): Promise<void> {
  const isJson = options.json === true;
  const autoYes = options.yes === true;
  const force = options.force === true;

  try {
    // Resolve project path
    const resolvedPath = resolve(projectPath ?? process.cwd());

    if (!existsSync(resolvedPath)) {
      console.error(chalk.red(`Directory not found: ${resolvedPath}`));
      process.exit(1);
    }

    // Check for existing config
    const configPath = join(resolvedPath, 'sourcerack.config.json');
    if (existsSync(configPath) && !force) {
      if (autoYes) {
        console.log(chalk.yellow(`Config already exists: ${configPath}`));
        console.log('Use --force to overwrite.');
        return;
      }
    }

    console.log(chalk.bold('\n🔧 SourceRack Project Init\n'));
    console.log(`Project: ${chalk.cyan(resolvedPath)}\n`);

    // Detect framework
    const detected = detectFramework(resolvedPath);
    console.log(`Detected framework: ${chalk.green(detected.displayName)}`);

    let framework: FrameworkPreset = detected.preset;
    let vectorStorage: VectorProvider = 'sqlite-vss';
    let qdrantUrl = 'http://localhost:6333';
    let priorityDirs: string[] = FRAMEWORK_PRIORITY_DIRS[framework] ?? [];
    let sqiBoosting: SqiBoostConfig = {
      findDef: true,
      findUsages: false,
      callGraph: true,
      query: true,
    };
    let boost: BoostConfig = FRAMEWORK_PRESETS[framework];

    if (!autoYes) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        // Confirm framework
        framework = await promptSelect<FrameworkPreset>(
          rl,
          'Select framework preset:',
          [
            { value: 'rails', label: 'Ruby on Rails' },
            { value: 'nodejs', label: 'Node.js / TypeScript' },
            { value: 'go', label: 'Go' },
            { value: 'python', label: 'Python / Django / Flask' },
            { value: 'java', label: 'Java / Spring' },
            { value: 'rust', label: 'Rust' },
            { value: 'custom', label: 'Custom (no preset)' },
          ],
          detected.preset
        );

        // Update boost and priority dirs based on framework
        boost = FRAMEWORK_PRESETS[framework];
        priorityDirs = FRAMEWORK_PRIORITY_DIRS[framework] ?? [];

        // Vector storage selection
        console.log(chalk.bold('\n📦 Vector Storage\n'));
        vectorStorage = await promptSelect<VectorProvider>(
          rl,
          'Select vector storage backend:',
          [
            { value: 'sqlite-vss', label: 'SQLite-VSS (local file, no Docker required)' },
            { value: 'qdrant', label: 'Qdrant (external server, more scalable)' },
          ],
          'sqlite-vss'
        );

        if (vectorStorage === 'qdrant') {
          qdrantUrl = await prompt(rl, '\nQdrant URL', 'http://localhost:6333');
        }

        // Priority directories
        console.log(chalk.bold('\n📂 Priority Directories\n'));
        console.log(chalk.dim('These directories will be boosted in search results.'));
        const defaultDirs = priorityDirs.join(', ') || 'none';
        console.log(chalk.dim(`Framework default: ${defaultDirs}`));

        const customDirs = await prompt(
          rl,
          'Custom priority dirs (comma-separated, or empty for defaults)',
          ''
        );
        if (customDirs.trim()) {
          priorityDirs = customDirs.split(',').map((d) => d.trim()).filter(Boolean);
        }

        // SQI Boosting configuration
        console.log(chalk.bold('\n⚡ SQI Boosting (per command)\n'));
        console.log(chalk.dim('Enable boosting to penalize test files in results.'));

        sqiBoosting.findDef = await promptYesNo(rl, 'Enable boosting for find-def', true);
        sqiBoosting.findUsages = await promptYesNo(rl, 'Enable boosting for find-usages', false);
        sqiBoosting.callGraph = await promptYesNo(rl, 'Enable boosting for call-graph', true);
        sqiBoosting.query = await promptYesNo(rl, 'Enable boosting for query (semantic search)', true);

        // Custom boost patterns
        console.log(chalk.bold('\n🎯 Custom Boost Patterns\n'));
        const addCustomBoost = await promptYesNo(
          rl,
          'Add custom penalty/bonus patterns?',
          false
        );

        if (addCustomBoost) {
          // Penalty patterns
          const penaltyInput = await prompt(
            rl,
            'Penalty patterns (comma-separated, e.g., "/vendor/,_mock.")',
            ''
          );
          if (penaltyInput.trim()) {
            const patterns = penaltyInput.split(',').map((p) => p.trim()).filter(Boolean);
            for (const pattern of patterns) {
              boost.penalties.push({ pattern, factor: 0.5 });
            }
          }

          // Bonus patterns
          const bonusInput = await prompt(
            rl,
            'Bonus patterns (comma-separated, e.g., "/domain/,/core/")',
            ''
          );
          if (bonusInput.trim()) {
            const patterns = bonusInput.split(',').map((p) => p.trim()).filter(Boolean);
            for (const pattern of patterns) {
              boost.bonuses.push({ pattern, factor: 1.2 });
            }
          }
        }

        rl.close();
      } catch {
        rl.close();
        throw new Error('Init cancelled');
      }
    }

    // Generate config
    const configParams: Parameters<typeof generateProjectConfig>[0] = {
      framework,
      vectorStorage,
      boost,
      sqiBoosting,
      priorityDirs,
    };
    if (vectorStorage === 'qdrant') {
      configParams.qdrantUrl = qdrantUrl;
    }
    const configContent = generateProjectConfig(configParams);

    // Check if config exists and needs confirmation
    if (existsSync(configPath) && !force && !autoYes) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const overwrite = await promptYesNo(
        rl,
        `\nConfig file exists. Overwrite ${configPath}?`,
        false
      );
      rl.close();
      if (!overwrite) {
        console.log(chalk.yellow('Init cancelled.'));
        return;
      }
    }

    // Write config file
    writeFileSync(configPath, configContent, 'utf-8');

    if (isJson) {
      console.log(JSON.stringify({
        success: true,
        configPath,
        framework,
        vectorStorage,
      }, null, 2));
    } else {
      console.log(chalk.green('\n✓ Configuration saved'));
      console.log(`  Location: ${chalk.cyan(configPath)}`);

      console.log(chalk.bold('\n📋 Configuration Summary:\n'));
      console.log(`  Framework:      ${chalk.cyan(framework)}`);
      console.log(`  Vector Storage: ${chalk.cyan(vectorStorage)}`);
      if (vectorStorage === 'qdrant') {
        console.log(`  Qdrant URL:     ${chalk.cyan(qdrantUrl)}`);
      }
      console.log(`  Priority Dirs:  ${chalk.cyan(priorityDirs.join(', ') || 'none')}`);
      console.log('');
      console.log(`  SQI Boosting:`);
      console.log(`    find-def:     ${sqiBoosting.findDef ? chalk.green('enabled') : chalk.yellow('disabled')}`);
      console.log(`    find-usages:  ${sqiBoosting.findUsages ? chalk.green('enabled') : chalk.yellow('disabled')}`);
      console.log(`    call-graph:   ${sqiBoosting.callGraph ? chalk.green('enabled') : chalk.yellow('disabled')}`);
      console.log(`    query:        ${sqiBoosting.query ? chalk.green('enabled') : chalk.yellow('disabled')}`);

      console.log(chalk.bold('\n📋 Next steps:\n'));
      console.log('  1. Index the repository:');
      console.log(chalk.cyan(`     sourcerack index ${resolvedPath}`));
      console.log('');
      console.log('  2. Search for code:');
      console.log(chalk.cyan(`     sourcerack query "your search"`));
      console.log('');
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the init command with the program
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize project-specific configuration with framework detection')
    .argument('[path]', 'Path to the project (default: current directory)')
    .option('-y, --yes', 'Accept all defaults without prompting')
    .option('--force', 'Overwrite existing configuration')
    .option('--json', 'Output in JSON format')
    .addHelpText('after', `
Examples:
  sourcerack init                 Initialize in current directory
  sourcerack init /path/to/repo   Initialize specific project
  sourcerack init -y              Use auto-detected defaults
  sourcerack init --force         Overwrite existing config

Framework Detection:
  SourceRack automatically detects your framework and applies
  optimized boost patterns for search results:

  - Ruby on Rails:  Boosts app/, lib/; penalizes spec/, test/
  - Node.js:        Boosts src/, lib/; penalizes dist/, __tests__/
  - Go:             Boosts cmd/, internal/, pkg/; penalizes _test.go
  - Python:         Boosts src/, core/; penalizes tests/, __pycache__/
  - Java:           Boosts src/main/; penalizes test/, target/
  - Rust:           Boosts src/; penalizes tests/, target/

Configuration File:
  Creates sourcerack.config.json in the project root with:
  - framework: Detected or selected framework preset
  - vectorStorage: SQLite-VSS (default) or Qdrant
  - boost: Penalty/bonus patterns for result ranking
  - sqiBoosting: Per-command boosting settings
  - priorityDirs: High-priority source directories
`)
    .action(async (path: string | undefined, options: InitOptions) => {
      await executeInit(path, options);
    });
}
