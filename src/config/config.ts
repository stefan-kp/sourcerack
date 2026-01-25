/**
 * Configuration loader for SourceRack
 *
 * Loads configuration from file, applies environment variable overrides,
 * and validates the result against the schema.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import {
  SourceRackConfig,
  SourceRackConfigSchema,
  ProjectConfigSchema,
  DEFAULT_CONFIG,
  validateConfig,
  type ProjectConfig,
  type BoostConfig,
  type SqiBoostConfig,
} from './schema.js';
import {
  detectFramework,
  FRAMEWORK_PRESETS,
  getBoostConfigForFramework,
} from './frameworks.js';

/**
 * Configuration file names to search for in project directories (in order of priority)
 */
const CONFIG_FILE_NAMES = [
  'sourcerack.config.json',
  'sourcerack.json',
  '.sourcerackrc.json',
];

/**
 * Global configuration directory and file
 */
const GLOBAL_CONFIG_DIR = join(homedir(), '.sourcerack');
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json');

/**
 * Map of environment variable names to configuration paths
 * All environment variables use the SOURCERACK_ prefix.
 */
const ENV_MAPPINGS: Record<string, string[]> = {
  // Qdrant
  SOURCERACK_QDRANT_URL: ['qdrant', 'url'],
  SOURCERACK_QDRANT_COLLECTION: ['qdrant', 'collection'],
  SOURCERACK_QDRANT_API_KEY: ['qdrant', 'apiKey'],
  // Embedding
  SOURCERACK_EMBEDDING_ENABLED: ['embedding', 'enabled'],
  SOURCERACK_EMBEDDING_PROVIDER: ['embedding', 'provider'],
  SOURCERACK_EMBEDDING_MODEL: ['embedding', 'model'],
  SOURCERACK_EMBEDDING_BATCH_SIZE: ['embedding', 'batchSize'],
  SOURCERACK_EMBEDDING_REMOTE_URL: ['embedding', 'remoteUrl'],
  SOURCERACK_EMBEDDING_REMOTE_API_KEY: ['embedding', 'remoteApiKey'],
  // Query
  SOURCERACK_QUERY_DEFAULT_LIMIT: ['query', 'defaultLimit'],
  SOURCERACK_QUERY_MAX_LIMIT: ['query', 'maxLimit'],
  // Logging
  SOURCERACK_LOG_LEVEL: ['logging', 'level'],
  SOURCERACK_LOG_FILE: ['logging', 'file'],
  SOURCERACK_LOG_PRETTY: ['logging', 'pretty'],
  // GC
  SOURCERACK_GC_RETENTION_DAYS: ['gc', 'retentionDays'],
  // Storage
  SOURCERACK_DATABASE_PATH: ['storage', 'databasePath'],
};

/**
 * Deep merge two objects
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key as keyof T];
    const targetValue = result[key as keyof T];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key as keyof T] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key as keyof T] = sourceValue as T[keyof T];
    }
  }

  return result;
}

/**
 * Set a nested value in an object using a path array
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (key === undefined) continue;
    if (current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1];
  if (lastKey !== undefined) {
    current[lastKey] = value;
  }
}

/**
 * Parse environment variable value to appropriate type
 */
function parseEnvValue(value: string, path: string[]): unknown {
  // Boolean values
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  // Numeric values for known numeric fields
  const numericPaths = [
    'embedding.batchSize',
    'query.defaultLimit',
    'query.maxLimit',
    'gc.retentionDays',
    'indexing.chunkSize.min',
    'indexing.chunkSize.max',
  ];

  const pathString = path.join('.');
  if (numericPaths.includes(pathString)) {
    const num = parseInt(value, 10);
    if (!isNaN(num)) return num;
  }

  return value;
}

/**
 * Load configuration from environment variables
 */
function loadEnvConfig(): Partial<SourceRackConfig> {
  const config: Record<string, unknown> = {};

  for (const [envKey, path] of Object.entries(ENV_MAPPINGS)) {
    const value = process.env[envKey];
    if (value !== undefined && value !== '') {
      setNestedValue(config, path, parseEnvValue(value, path));
    }
  }

  return config as Partial<SourceRackConfig>;
}

/**
 * Find configuration file in specified directory or up the directory tree,
 * falling back to global config in ~/.sourcerack/config.json
 */
function findConfigFile(startDir: string = process.cwd()): string | null {
  let currentDir = resolve(startDir);
  const root = resolve('/');

  // First, search up the directory tree for project-local config
  while (currentDir !== root) {
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = resolve(currentDir, fileName);
      if (existsSync(filePath)) {
        return filePath;
      }
    }
    currentDir = resolve(currentDir, '..');
  }

  // Fall back to global config
  if (existsSync(GLOBAL_CONFIG_FILE)) {
    return GLOBAL_CONFIG_FILE;
  }

  return null;
}

/**
 * Load configuration from a JSON file
 */
function loadFileConfig(filePath: string): Partial<SourceRackConfig> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Partial<SourceRackConfig>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load configuration from ${filePath}: ${message}`);
  }
}

/**
 * Configuration loader options
 */
export interface LoadConfigOptions {
  /** Explicit path to configuration file */
  configPath?: string;
  /** Directory to start searching for config file */
  searchDir?: string;
  /** Skip loading from file */
  skipFile?: boolean;
  /** Skip environment variable overrides */
  skipEnv?: boolean;
  /** Additional configuration to merge */
  overrides?: Partial<SourceRackConfig>;
}

/**
 * Load and validate SourceRack configuration
 *
 * Configuration is loaded in the following order (later overrides earlier):
 * 1. Default configuration
 * 2. Configuration file (if found)
 * 3. Environment variables
 * 4. Explicit overrides
 *
 * @param options - Loading options
 * @returns Validated configuration
 */
export function loadConfig(options: LoadConfigOptions = {}): SourceRackConfig {
  let config: Record<string, unknown> = { ...DEFAULT_CONFIG };

  // Load from file
  if (options.skipFile !== true) {
    const configPath = options.configPath ?? findConfigFile(options.searchDir);
    if (configPath !== null) {
      const fileConfig = loadFileConfig(configPath);
      config = deepMerge(config, fileConfig as Record<string, unknown>);
    }
  }

  // Apply environment variable overrides
  if (options.skipEnv !== true) {
    const envConfig = loadEnvConfig();
    config = deepMerge(config, envConfig as Record<string, unknown>);
  }

  // Apply explicit overrides
  if (options.overrides !== undefined) {
    config = deepMerge(config, options.overrides as Record<string, unknown>);
  }

  // Validate and return
  return validateConfig(config);
}

/**
 * Get the default configuration
 */
export function getDefaultConfig(): SourceRackConfig {
  return DEFAULT_CONFIG;
}

/**
 * Create a configuration instance with partial overrides
 */
export function createConfig(overrides: Partial<SourceRackConfig>): SourceRackConfig {
  return SourceRackConfigSchema.parse(deepMerge({ ...DEFAULT_CONFIG }, overrides));
}


/**
 * Get the path to the global configuration directory (~/.sourcerack)
 */
export function getGlobalConfigDir(): string {
  return GLOBAL_CONFIG_DIR;
}

/**
 * Get the path to the global configuration file (~/.sourcerack/config.json)
 */
export function getGlobalConfigPath(): string {
  return GLOBAL_CONFIG_FILE;
}

/**
 * Project configuration file names to search for
 */
const PROJECT_CONFIG_FILE_NAMES = [
  'sourcerack.config.json',
  'sourcerack.json',
  '.sourcerackrc.json',
];

/**
 * Find project-specific configuration file
 */
function findProjectConfigFile(startDir: string = process.cwd()): string | null {
  let currentDir = resolve(startDir);
  const root = resolve('/');

  while (currentDir !== root) {
    for (const fileName of PROJECT_CONFIG_FILE_NAMES) {
      const filePath = resolve(currentDir, fileName);
      if (existsSync(filePath)) {
        return filePath;
      }
    }
    currentDir = resolve(currentDir, '..');
  }

  return null;
}

/**
 * Load project-specific configuration if available
 *
 * @param projectPath - Path to project directory (default: cwd)
 * @returns Project config if found, null otherwise
 */
export function loadProjectConfig(projectPath: string = process.cwd()): ProjectConfig | null {
  const configPath = findProjectConfigFile(projectPath);
  if (!configPath) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    return ProjectConfigSchema.parse(parsed);
  } catch {
    // Invalid config file - ignore and return null
    return null;
  }
}

/**
 * Get effective boost configuration for a project
 *
 * Priority:
 * 1. Project-specific boost config (from sourcerack.config.json)
 * 2. Framework-detected defaults
 * 3. Global defaults
 *
 * @param projectPath - Path to project directory
 * @returns Effective boost configuration
 */
export function getEffectiveBoostConfig(projectPath: string = process.cwd()): BoostConfig {
  // Try to load project config first
  const projectConfig = loadProjectConfig(projectPath);
  if (projectConfig?.boost) {
    // Project has explicit boost config
    if (projectConfig.framework !== 'auto' && projectConfig.framework !== 'custom') {
      // Merge framework defaults with custom overrides
      return getBoostConfigForFramework(projectConfig.framework, projectConfig.boost);
    }
    return projectConfig.boost;
  }

  // Try framework detection
  const detected = detectFramework(projectPath);
  if (detected.preset !== 'custom') {
    return FRAMEWORK_PRESETS[detected.preset];
  }

  // Fall back to generic defaults
  return {
    enabled: true,
    penalties: [],
    bonuses: [],
  };
}

/**
 * Get SQI boosting configuration for a project
 *
 * @param projectPath - Path to project directory
 * @returns SQI boost settings per command
 */
export function getSqiBoostConfig(projectPath: string = process.cwd()): SqiBoostConfig {
  const projectConfig = loadProjectConfig(projectPath);
  if (projectConfig?.sqiBoosting) {
    return projectConfig.sqiBoosting;
  }

  // Default SQI boost settings
  return {
    findDef: true,
    findUsages: false,
    callGraph: true,
    query: true,
  };
}
