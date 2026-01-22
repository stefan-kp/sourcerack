/**
 * Vector storage factory for SourceRack
 *
 * Creates the appropriate vector storage implementation based on configuration.
 * Default: SQLite-VSS (no Docker required)
 * Optional: Qdrant (requires Docker or server)
 */

import { getDataDir } from '../config/paths.js';
import { join } from 'node:path';
import type { VectorStorage } from './vector-storage.js';
import { SqliteVssStorage } from './sqlite-vss.js';
import { QdrantStorage } from './qdrant.js';

/**
 * Supported vector storage providers
 */
export type VectorProvider = 'sqlite-vss' | 'qdrant';

/**
 * Options for creating vector storage
 */
export interface CreateVectorStorageOptions {
  /** Vector storage provider (default: 'sqlite-vss') */
  provider?: VectorProvider;
  /** Vector dimensions (required) */
  dimensions: number;

  // SQLite-VSS options
  /** Path to SQLite database file (default: ~/.sourcerack/vectors.db) */
  databasePath?: string;

  // Qdrant options
  /** Qdrant server URL */
  qdrantUrl?: string;
  /** Qdrant collection name */
  qdrantCollection?: string;
  /** Qdrant API key (for cloud deployments) */
  qdrantApiKey?: string;
}

/**
 * Get default SQLite-VSS database path
 */
export function getDefaultVectorDatabasePath(): string {
  return join(getDataDir(), 'vectors.db');
}

/**
 * Create vector storage instance based on configuration
 *
 * @param options - Storage configuration options
 * @returns Initialized vector storage instance
 */
export async function createVectorStorage(
  options: CreateVectorStorageOptions
): Promise<VectorStorage> {
  const provider = options.provider ?? 'sqlite-vss';

  let storage: VectorStorage;

  if (provider === 'qdrant') {
    // Validate Qdrant options
    if (!options.qdrantUrl) {
      throw new Error('Qdrant URL is required when using qdrant provider');
    }

    const qdrantConfig: {
      url: string;
      collectionName: string;
      dimensions: number;
      apiKey?: string;
    } = {
      url: options.qdrantUrl,
      collectionName: options.qdrantCollection ?? 'sourcerack',
      dimensions: options.dimensions,
    };
    if (options.qdrantApiKey) {
      qdrantConfig.apiKey = options.qdrantApiKey;
    }

    storage = new QdrantStorage(qdrantConfig);
  } else {
    // Default: SQLite-VSS
    storage = new SqliteVssStorage({
      databasePath: options.databasePath ?? getDefaultVectorDatabasePath(),
      dimensions: options.dimensions,
    });
  }

  await storage.initialize();
  return storage;
}

/**
 * Detect provider from legacy configuration
 *
 * For backward compatibility: if qdrant.url is set but vectorStorage.provider is not,
 * use Qdrant as the provider.
 *
 * @param config - Configuration object with potential legacy fields
 * @returns Detected provider
 */
export function detectProviderFromConfig(config: {
  vectorStorage?: { provider?: VectorProvider };
  qdrant?: { url?: string };
}): VectorProvider {
  // Explicit provider takes precedence
  if (config.vectorStorage?.provider) {
    return config.vectorStorage.provider;
  }

  // Auto-detect: if qdrant.url is set (and not default localhost), use Qdrant
  if (config.qdrant?.url && config.qdrant.url !== 'http://localhost:6333') {
    return 'qdrant';
  }

  // Check environment variable
  const envProvider = process.env.SOURCERACK_VECTOR_PROVIDER;
  if (envProvider === 'qdrant' || envProvider === 'sqlite-vss') {
    return envProvider;
  }

  // Default: SQLite-VSS
  return 'sqlite-vss';
}
