/**
 * Configuration schema for SourceRack
 *
 * Validates configuration using Zod and provides TypeScript types.
 */

import { z } from 'zod';
import { getDefaultDatabasePath } from './paths.js';

/**
 * Qdrant vector database configuration
 */
export const QdrantConfigSchema = z.object({
  url: z.string().url().default('http://localhost:6333'),
  collection: z.string().min(1).default('sourcerack'),
  apiKey: z.string().optional(),
});

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
  qdrant: QdrantConfigSchema.default({}),
  embedding: EmbeddingConfigSchema.default({}),
  indexing: IndexingConfigSchema.default({}),
  query: QueryConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  gc: GCConfigSchema.default({}),
  storage: StorageConfigSchema.default({}),
});

/**
 * TypeScript types derived from schemas
 */
export type QdrantConfig = z.infer<typeof QdrantConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
export type QueryConfig = z.infer<typeof QueryConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type GCConfig = z.infer<typeof GCConfigSchema>;
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
export type SourceRackConfig = z.infer<typeof SourceRackConfigSchema>;

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
