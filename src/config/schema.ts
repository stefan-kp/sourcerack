/**
 * Configuration schema for SourceRack
 *
 * Validates configuration using Zod and provides TypeScript types.
 */

import { z } from 'zod';
import { getDefaultDatabasePath } from './paths.js';

/**
 * Vector storage provider enum
 */
export const VectorProviderSchema = z.enum(['sqlite-vss', 'qdrant']);

/**
 * SQLite-VSS configuration
 */
export const SqliteVssConfigSchema = z.object({
  databasePath: z.string().optional(), // Default: ~/.sourcerack/vectors.db
});

/**
 * Qdrant vector database configuration
 */
export const QdrantConfigSchema = z.object({
  url: z.string().url().default('http://localhost:6333'),
  collection: z.string().min(1).default('sourcerack'),
  apiKey: z.string().optional(),
});

/**
 * Vector storage configuration
 *
 * Supports multiple backends:
 * - sqlite-vss (default): Single-file SQLite database, no Docker required
 * - qdrant: Qdrant vector database server
 */
export const VectorStorageConfigSchema = z.object({
  provider: VectorProviderSchema.default('sqlite-vss'),
  sqliteVss: SqliteVssConfigSchema.default({}),
  qdrant: QdrantConfigSchema.optional(),
}).default({});

/**
 * Embedding provider configuration
 * Dimensions are derived from the provider/model, not hardcoded.
 */
export const EmbeddingConfigSchema = z.object({
  enabled: z.boolean().default(true), // Enable/disable embedding generation
  provider: z.enum(['fastembed', 'remote']).default('fastembed'),
  model: z.string().default('all-MiniLM-L6-v2'),
  batchSize: z.number().int().min(1).max(256).default(32),
  // Remote provider settings (optional)
  remoteUrl: z.string().url().optional(),
  remoteApiKey: z.string().optional(),
});

/**
 * Indexing configuration
 */
export const IndexingConfigSchema = z.object({
  chunkSize: z.object({
    min: z.number().int().min(64).default(512),
    max: z.number().int().max(4096).default(1024),
  }).default({}),
  languages: z.array(z.string()).default([
    'javascript',
    'typescript',
    'python',
    'go',
    'rust',
    'java',
    'c',
    'cpp',
  ]),
  excludePatterns: z.array(z.string()).default([
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/*.min.js',
  ]),
});

/**
 * Query configuration
 */
export const QueryConfigSchema = z.object({
  defaultLimit: z.number().int().min(1).max(100).default(50),
  maxLimit: z.number().int().min(1).max(500).default(100),
});

/**
 * Logging configuration (FR-011)
 */
export const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  file: z.string().optional(),
  pretty: z.boolean().default(false),
});

/**
 * Garbage collection configuration
 */
export const GCConfigSchema = z.object({
  retentionDays: z.number().int().min(1).default(30),
});

/**
 * Repository group configuration
 *
 * Groups allow organizing repositories into logical collections
 * for easier multi-repo operations.
 */
export const RepoGroupSchema = z.object({
  /** Repository paths or names in this group */
  repos: z.array(z.string()).min(1),
  /** Optional description of the group */
  description: z.string().optional(),
});

/**
 * Groups configuration
 */
export const GroupsConfigSchema = z.object({
  /** Named repository groups */
  groups: z.record(z.string(), RepoGroupSchema).default({}),
  /** Default group to use when no group is specified */
  defaultGroup: z.string().optional(),
});

/**
 * Boost rule configuration
 */
export const BoostRuleSchema = z.object({
  /** Pattern to match against file path (substring match) */
  pattern: z.string(),
  /** Multiplicative factor (< 1 = penalty, > 1 = bonus) */
  factor: z.number().min(0.1).max(3.0),
});

/**
 * Boost configuration for search result ranking
 */
export const BoostConfigSchema = z.object({
  /** Enable structural boosting (default: true) */
  enabled: z.boolean().default(true),
  /** Patterns that reduce score (test files, generated code) */
  penalties: z.array(BoostRuleSchema).default([]),
  /** Patterns that increase score (source directories) */
  bonuses: z.array(BoostRuleSchema).default([]),
});

/**
 * SQI boosting configuration per command
 */
export const SqiBoostConfigSchema = z.object({
  /** Enable boosting for find-def command */
  findDef: z.boolean().default(true),
  /** Enable boosting for find-usages command */
  findUsages: z.boolean().default(false),
  /** Enable boosting for call-graph command */
  callGraph: z.boolean().default(true),
  /** Enable boosting for semantic query command */
  query: z.boolean().default(true),
});

/**
 * Framework-specific presets
 */
export const FrameworkPresetSchema = z.enum([
  'auto',       // Auto-detect
  'rails',      // Ruby on Rails
  'nodejs',     // Node.js / Express / Nest.js
  'go',         // Go
  'python',     // Python / Django / Flask
  'java',       // Java / Spring
  'rust',       // Rust
  'custom',     // User-defined
]);

/**
 * Project configuration (stored in project's sourcerack.config.json)
 */
export const ProjectConfigSchema = z.object({
  /** Framework preset for boost patterns */
  framework: FrameworkPresetSchema.default('auto'),
  /** Custom boost configuration (overrides framework defaults) */
  boost: BoostConfigSchema.optional(),
  /** SQI boosting per command */
  sqiBoosting: SqiBoostConfigSchema.default({}),
  /** Priority source directories (highest priority first) */
  priorityDirs: z.array(z.string()).default([]),
});

/**
 * SQLite metadata storage configuration
 *
 * Default location is cross-platform:
 * - macOS/Linux: ~/.sourcerack/metadata.db
 * - Windows: %LOCALAPPDATA%\sourcerack\metadata.db
 */
export const StorageConfigSchema = z.object({
  databasePath: z.string().default(getDefaultDatabasePath()),
});

/**
 * Complete SourceRack configuration schema
 */
export const SourceRackConfigSchema = z.object({
  vectorStorage: VectorStorageConfigSchema, // NEW: Vector storage configuration
  qdrant: QdrantConfigSchema.default({}), // DEPRECATED: Use vectorStorage.qdrant instead
  embedding: EmbeddingConfigSchema.default({}),
  indexing: IndexingConfigSchema.default({}),
  query: QueryConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  gc: GCConfigSchema.default({}),
  storage: StorageConfigSchema.default({}),
  // Repository groups for organizing multi-repo workflows
  groups: z.record(z.string(), RepoGroupSchema).default({}),
  defaultGroup: z.string().optional(),
});

/**
 * TypeScript types derived from schemas
 */
export type VectorProvider = z.infer<typeof VectorProviderSchema>;
export type SqliteVssConfig = z.infer<typeof SqliteVssConfigSchema>;
export type QdrantConfig = z.infer<typeof QdrantConfigSchema>;
export type VectorStorageConfig = z.infer<typeof VectorStorageConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
export type QueryConfig = z.infer<typeof QueryConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type GCConfig = z.infer<typeof GCConfigSchema>;
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
export type RepoGroup = z.infer<typeof RepoGroupSchema>;
export type SourceRackConfig = z.infer<typeof SourceRackConfigSchema>;
export type BoostRule = z.infer<typeof BoostRuleSchema>;
export type BoostConfig = z.infer<typeof BoostConfigSchema>;
export type SqiBoostConfig = z.infer<typeof SqiBoostConfigSchema>;
export type FrameworkPreset = z.infer<typeof FrameworkPresetSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * Default configuration (all defaults applied)
 */
export const DEFAULT_CONFIG: SourceRackConfig = SourceRackConfigSchema.parse({});

/**
 * Validate and parse configuration object
 * @param config - Raw configuration object
 * @returns Validated and typed configuration
 * @throws ZodError if validation fails
 */
export function validateConfig(config: unknown): SourceRackConfig {
  return SourceRackConfigSchema.parse(config);
}

/**
 * Safe validation that returns result object instead of throwing
 * @param config - Raw configuration object
 * @returns Result object with success/error
 */
export function safeValidateConfig(config: unknown): z.SafeParseReturnType<unknown, SourceRackConfig> {
  return SourceRackConfigSchema.safeParse(config);
}
