/**
 * CLI context manager
 *
 * Provides shared component initialization for CLI commands.
 * Mirrors the MCP server initialization pattern from src/mcp/server.ts.
 */

import { MetadataStorage } from '../storage/metadata.js';
import type { VectorStorage } from '../storage/vector-storage.js';
import { createVectorStorage, detectProviderFromConfig, getDefaultVectorDatabasePath } from '../storage/vector-factory.js';
import { createEmbeddingProvider } from '../embeddings/provider.js';
import { loadConfig, type LoadConfigOptions } from '../config/config.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { SourceRackConfig } from '../config/schema.js';
import { ConnectionError } from './errors.js';

/**
 * CLI context containing all initialized components
 */
export interface CLIContext {
  /** Loaded configuration */
  config: SourceRackConfig;
  /** Metadata storage (SQLite) */
  metadata: MetadataStorage;
  /** Vector storage (SQLite-VSS or Qdrant) */
  vectors: VectorStorage;
  /** Embedding provider */
  embeddings: EmbeddingProvider;
  /** Close all connections */
  close(): Promise<void>;
}

/**
 * Options for creating CLI context
 */
export interface CreateContextOptions extends LoadConfigOptions {
  /** Skip embedding provider initialization (for commands that don't need it) */
  skipEmbeddings?: boolean;
  /** Skip vector storage initialization (for commands that don't need it) */
  skipVectors?: boolean;
}

/**
 * Create CLI context with all components initialized
 *
 * @param options - Context creation options
 * @returns Initialized CLI context
 */
export async function createCLIContext(
  options: CreateContextOptions = {}
): Promise<CLIContext> {
  // Load configuration
  const config = loadConfig(options);

  // Initialize metadata storage
  const metadata = MetadataStorage.create(config.storage.databasePath);

  // Initialize embedding provider (unless skipped)
  let embeddings: EmbeddingProvider | undefined;
  if (options.skipEmbeddings !== true) {
    const embeddingConfig: {
      provider: 'fastembed' | 'remote';
      model: string;
      batchSize: number;
      remoteUrl?: string;
      remoteApiKey?: string;
    } = {
      provider: config.embedding.provider,
      model: config.embedding.model,
      batchSize: config.embedding.batchSize,
    };
    if (config.embedding.remoteUrl !== undefined && config.embedding.remoteUrl !== '') {
      embeddingConfig.remoteUrl = config.embedding.remoteUrl;
    }
    if (config.embedding.remoteApiKey !== undefined && config.embedding.remoteApiKey !== '') {
      embeddingConfig.remoteApiKey = config.embedding.remoteApiKey;
    }

    embeddings = await createEmbeddingProvider(embeddingConfig);
  }

  // Initialize vector storage (unless skipped)
  let vectors: VectorStorage | undefined;
  if (options.skipVectors !== true) {
    const provider = detectProviderFromConfig(config);

    // Log deprecation warning if using legacy qdrant config
    if (!config.vectorStorage?.provider && config.qdrant?.url && config.qdrant.url !== 'http://localhost:6333') {
      console.warn('⚠️  Deprecation warning: Using legacy qdrant config. Please migrate to vectorStorage.provider and vectorStorage.qdrant');
    }

    try {
      if (provider === 'qdrant') {
        // Use Qdrant
        const qdrantConfig = config.vectorStorage?.qdrant ?? config.qdrant;
        const qdrantOptions: Parameters<typeof createVectorStorage>[0] = {
          provider: 'qdrant',
          dimensions: embeddings?.dimensions ?? 384,
          qdrantUrl: qdrantConfig.url,
          qdrantCollection: qdrantConfig.collection,
        };
        if (qdrantConfig.apiKey) {
          qdrantOptions.qdrantApiKey = qdrantConfig.apiKey;
        }
        vectors = await createVectorStorage(qdrantOptions);
      } else {
        // Default: SQLite-VSS
        vectors = await createVectorStorage({
          provider: 'sqlite-vss',
          dimensions: embeddings?.dimensions ?? 384,
          databasePath: config.vectorStorage?.sqliteVss?.databasePath ?? getDefaultVectorDatabasePath(),
        });
      }
    } catch (error) {
      metadata.close();
      if (provider === 'qdrant') {
        const url = config.vectorStorage?.qdrant?.url ?? config.qdrant.url;
        const hint = url.includes('localhost')
          ? '\n\nHint: Start Qdrant with: npm run qdrant:start'
          : '';
        throw new ConnectionError(
          `Failed to connect to Qdrant at ${url}${hint}`,
          error instanceof Error ? error : undefined
        );
      }
      throw new ConnectionError(
        `Failed to initialize vector storage: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  // Create context object - we use type assertions here because the caller
  // is responsible for ensuring they don't access vectors/embeddings when skipped.
  // If skipVectors or skipEmbeddings was true, these will be undefined but
  // commands that use them should not have set those flags.
  const context: CLIContext = {
    config,
    metadata,
    vectors: vectors as unknown as VectorStorage,
    embeddings: embeddings as unknown as EmbeddingProvider,
    async close(): Promise<void> {
      metadata.close();
      if (vectors) {
        await vectors.close();
      }
    },
  };

  return context;
}

/**
 * Run a function with CLI context, ensuring cleanup on exit
 *
 * @param fn - Function to run with context
 * @param options - Context creation options
 */
export async function withContext<T>(
  fn: (context: CLIContext) => Promise<T>,
  options: CreateContextOptions = {}
): Promise<T> {
  const context = await createCLIContext(options);
  try {
    return await fn(context);
  } finally {
    await context.close();
  }
}
