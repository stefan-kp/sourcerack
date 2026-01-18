/**
 * Embedding provider interface and factory for SourceRack
 */

import {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingError,
  EmbeddingErrorCode,
} from './types.js';
import { FastEmbedProvider } from './local.js';
import { RemoteEmbeddingProvider } from './remote.js';

/** Default remote embedding service URL (Docker service) */
const DEFAULT_REMOTE_URL = 'http://localhost:8080/embed';

/**
 * Create an embedding provider based on configuration
 *
 * fastembed is the default provider but is NOT mandatory.
 * The provider abstraction allows swapping to other local or remote providers.
 *
 * @param config - Provider configuration
 * @returns Embedding provider instance
 */
export async function createEmbeddingProvider(
  config: EmbeddingProviderConfig
): Promise<EmbeddingProvider> {
  let provider: EmbeddingProvider;

  switch (config.provider) {
    case 'fastembed':
      provider = new FastEmbedProvider(config.model, config.batchSize);
      break;
    case 'remote': {
      const url = config.remoteUrl ?? DEFAULT_REMOTE_URL;
      provider = new RemoteEmbeddingProvider(
        url,
        config.remoteApiKey,
        384, // Default dimensions for MiniLM
        512, // Default max tokens
        config.batchSize
      );
      break;
    }
    default:
      throw new EmbeddingError(
        `Unknown embedding provider: ${config.provider as string}`,
        EmbeddingErrorCode.NOT_INITIALIZED
      );
  }

  await provider.initialize();
  return provider;
}

/**
 * Get default embedding provider configuration
 */
export function getDefaultEmbeddingConfig(): EmbeddingProviderConfig {
  return {
    provider: 'fastembed',
    model: 'all-MiniLM-L6-v2',
    batchSize: 32,
  };
}
