/**
 * CLI command: setup
 *
 * Interactive setup for SourceRack configuration and Claude Code skill installation.
 */

import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { handleError } from '../errors.js';
import { getGlobalConfigDir, getGlobalConfigPath } from '../../config/config.js';
import { generateSkillContent, SKILL_VERSION } from '../skill-template.js';

/**
 * Setup command options
 */
interface SetupOptions {
  yes?: boolean;
  updateSkill?: boolean;
  json?: boolean;
}

/**
 * Prompt for user input
 */
async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue?: string
): Promise<string> {
  return new Promise((resolve) => {
    const defaultSuffix = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${defaultSuffix}: `, (answer) => {
      resolve(answer.trim() ?? defaultValue ?? '');
    });
  });
}

/**
 * Prompt for yes/no
 */
async function promptYesNo(
  rl: ReturnType<typeof createInterface>,
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
 * Check if Docker is available
 */
async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['--version'], { stdio: 'pipe' });
    proc.on('close', (code) => { resolve(code === 0); });
    proc.on('error', () => { resolve(false); });
  });
}

/**
 * Check if Qdrant is running at the given URL
 */
async function isQdrantRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/collections`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start Qdrant using Docker
 */
async function startQdrantDocker(): Promise<boolean> {
  return new Promise((resolve) => {
    console.log('\nStarting Qdrant via Docker...');
    const proc = spawn(
      'docker',
      ['run', '-d', '--name', 'qdrant', '-p', '6333:6333', '-p', '6334:6334', 'qdrant/qdrant'],
      { stdio: 'inherit' }
    );
    proc.on('close', (code) => {
      if (code === 0) {
        console.log('✓ Qdrant container started');
        resolve(true);
      } else {
        // Maybe container already exists, try to start it
        const startProc = spawn('docker', ['start', 'qdrant'], { stdio: 'inherit' });
        startProc.on('close', (startCode) => {
          if (startCode === 0) {
            console.log('✓ Existing Qdrant container started');
            resolve(true);
          } else {
            console.log('✗ Failed to start Qdrant container');
            resolve(false);
          }
        });
        startProc.on('error', () => { resolve(false); });
      }
    });
    proc.on('error', () => { resolve(false); });
  });
}

/**
 * Check if Claude Code is installed
 */
function isClaudeCodeInstalled(): boolean {
  const claudeDir = join(homedir(), '.claude');
  return existsSync(claudeDir);
}

/**
 * Get Claude Code skills directory
 */
function getSkillsDir(): string {
  return join(homedir(), '.claude', 'skills');
}

/**
 * Get skill directory path (new structure: skills/sourcerack/)
 */
function getSkillDir(): string {
  return join(getSkillsDir(), 'sourcerack');
}

/**
 * Get skill file path (new structure: skills/sourcerack/SKILL.md)
 */
function getSkillPath(): string {
  return join(getSkillDir(), 'SKILL.md');
}

/**
 * Get legacy skill file path (old structure: skills/sourcerack.md)
 */
function getLegacySkillPath(): string {
  return join(getSkillsDir(), 'sourcerack.md');
}

/**
 * Check if skill is installed and get version
 * Checks both new (SKILL.md) and legacy (sourcerack.md) locations
 */
function getInstalledSkillVersion(): string | null {
  // Check new location first
  const skillPath = getSkillPath();
  if (existsSync(skillPath)) {
    try {
      const content = readFileSync(skillPath, 'utf-8');
      // New format doesn't have version in frontmatter, check for SKILL_VERSION marker
      const match = /version:\s*(\d+\.\d+\.\d+)/.exec(content);
      if (match?.[1]) {
        return match[1];
      }
      // If no version found but file exists, it's the new format (0.2.0+)
      return SKILL_VERSION;
    } catch {
      return null;
    }
  }

  // Check legacy location
  const legacyPath = getLegacySkillPath();
  if (existsSync(legacyPath)) {
    try {
      const content = readFileSync(legacyPath, 'utf-8');
      const match = /version:\s*(\d+\.\d+\.\d+)/.exec(content);
      return match?.[1] ?? '0.0.0';
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Install or update the Claude Code skill
 */
function installSkill(): { migrated: boolean } {
  const skillDir = getSkillDir();
  const skillPath = getSkillPath();
  const legacyPath = getLegacySkillPath();
  let migrated = false;

  // Create skill directory if needed (new structure: skills/sourcerack/)
  if (!existsSync(skillDir)) {
    mkdirSync(skillDir, { recursive: true });
  }

  // Remove legacy skill file if it exists
  if (existsSync(legacyPath)) {
    try {
      unlinkSync(legacyPath);
      migrated = true;
    } catch {
      // Ignore errors removing legacy file
    }
  }

  // Write SKILL.md file
  const content = generateSkillContent();
  writeFileSync(skillPath, content, 'utf-8');

  return { migrated };
}

/**
 * Execute the setup command
 */
async function executeSetup(options: SetupOptions): Promise<void> {
  const isJson = options.json === true;
  const autoYes = options.yes === true;
  const updateSkillOnly = options.updateSkill === true;

  try {
    // Handle --update-skill flag
    if (updateSkillOnly) {
      if (!isClaudeCodeInstalled()) {
        console.log('Claude Code is not installed. Skipping skill update.');
        return;
      }
      const { migrated } = installSkill();
      console.log(`✓ Claude Code skill updated to version ${SKILL_VERSION}`);
      console.log(`  Location: ${getSkillPath()}`);
      if (migrated) {
        console.log('  (Migrated from legacy format)');
      }
      return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('\n🔧 SourceRack Setup\n');

    // Configuration values
    let enableEmbeddings = true;
    let qdrantUrl = 'http://localhost:6333';
    let collectionName = 'sourcerack';
    let installClaudeSkill = isClaudeCodeInstalled();
    let startQdrant = false;

    if (!autoYes) {
      // Ask about embeddings
      enableEmbeddings = await promptYesNo(
        rl,
        'Enable semantic embeddings? (requires Qdrant)',
        true
      );

      if (enableEmbeddings) {
        // Ask about Qdrant URL
        qdrantUrl = await prompt(rl, 'Qdrant URL', 'http://localhost:6333');
        collectionName = await prompt(rl, 'Collection name', 'sourcerack');

        // Check if Qdrant is already running
        const qdrantRunning = await isQdrantRunning(qdrantUrl);
        if (qdrantRunning) {
          console.log('✓ Qdrant is already running');
        } else {
          // Check if Docker is available and offer to start Qdrant
          const dockerAvailable = await isDockerAvailable();
          if (dockerAvailable) {
            startQdrant = await promptYesNo(
              rl,
              'Qdrant is not running. Start Qdrant via Docker?',
              true
            );
          } else {
            console.log('\nNote: Docker not found. You\'ll need to start Qdrant manually.');
            console.log('  Run: docker run -d -p 6333:6333 qdrant/qdrant');
          }
        }
      }

      // Ask about Claude Code skill (only if Claude Code is installed)
      if (isClaudeCodeInstalled()) {
        installClaudeSkill = await promptYesNo(
          rl,
          'Install Claude Code skill?',
          true
        );
      } else {
        console.log('\nNote: Claude Code not detected. Skipping skill installation.');
        installClaudeSkill = false;
      }
    }

    rl.close();

    // Start Qdrant if requested
    if (startQdrant) {
      await startQdrantDocker();
    }

    // Create config directory
    const configDir = getGlobalConfigDir();
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Build config
    const config = {
      embedding: {
        enabled: enableEmbeddings,
        provider: 'fastembed' as const,
        model: 'all-MiniLM-L6-v2',
        batchSize: 32,
      },
      qdrant: {
        url: qdrantUrl,
        collectionName: collectionName,
      },
      logging: {
        level: 'info' as const,
        pretty: true,
      },
    };

    // Write config
    const configPath = getGlobalConfigPath();
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            success: true,
            configPath,
            skillInstalled: installClaudeSkill,
            skillPath: installClaudeSkill ? getSkillPath() : null,
          },
          null,
          2
        )
      );
    } else {
      console.log('\n✓ Configuration saved');
      console.log(`  Location: ${configPath}`);

      // Install Claude Code skill if requested
      if (installClaudeSkill) {
        const { migrated } = installSkill();
        console.log('\n✓ Claude Code skill installed');
        console.log(`  Location: ${getSkillPath()}`);
        if (migrated) {
          console.log('  (Migrated from legacy format)');
        }
      }

      console.log('\n📋 Next steps:');
      let stepNum = 1;
      if (enableEmbeddings && !startQdrant) {
        // Only show Docker command if we didn't start Qdrant
        const qdrantRunning = await isQdrantRunning(qdrantUrl);
        if (!qdrantRunning) {
          console.log(`  ${stepNum}. Start Qdrant: docker run -d -p 6333:6333 qdrant/qdrant`);
          stepNum++;
        }
      }
      if (enableEmbeddings) {
        console.log(`  ${stepNum}. Index a repository: sourcerack index /path/to/repo`);
        stepNum++;
        console.log(`  ${stepNum}. Search: sourcerack query "your search"`);
      } else {
        console.log(`  ${stepNum}. Index a repository: sourcerack index /path/to/repo`);
        console.log('     (SQI-only mode - use find-def and find-usages commands)');
        stepNum++;
        console.log(`  ${stepNum}. Search: sourcerack find-def MyClass`);
      }
      console.log('');
    }
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Check for skill updates and print warning if available
 * Call this from other commands to notify users
 */
export function checkSkillUpdate(): void {
  if (!isClaudeCodeInstalled()) {
    return;
  }

  const installed = getInstalledSkillVersion();
  if (installed === null) {
    // Skill not installed, don't nag
    return;
  }

  if (installed !== SKILL_VERSION) {
    console.error(
      `\n⚠️  A newer SourceRack skill is available (${installed} → ${SKILL_VERSION}).`
    );
    console.error('   Run: sourcerack setup --update-skill\n');
  }
}

/**
 * Register the setup command with the program
 */
export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Interactive setup for SourceRack configuration')
    .option('-y, --yes', 'Accept all defaults without prompting')
    .option('--update-skill', 'Update Claude Code skill only')
    .option('--json', 'Output in JSON format')
    .action(async (options: SetupOptions) => {
      await executeSetup(options);
    });
}
