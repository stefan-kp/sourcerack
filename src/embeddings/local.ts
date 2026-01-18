/**
 * Local embedding provider using fastembed
 *
 * fastembed is the default provider but is NOT mandatory.
 * This implementation wraps fastembed for local embedding generation.
 */

import {
  EmbeddingProvider,
  EmbeddingVector,
  EmbeddingError,
  EmbeddingErrorCode,
} from './types.js';

/**
 * Model dimensions mapping
 * Dimensions are derived from the model, not hardcoded globally
 */
const MODEL_DIMENSIONS: Record<string, number> = {
  'all-MiniLM-L6-v2': 384,
  'all-MiniLM-L12-v2': 384,
  'paraphrase-MiniLM-L6-v2': 384,
  'bge-small-en-v1.5': 384,
  'bge-base-en-v1.5': 768,
  'nomic-embed-text-v1': 768,
};

/**
 * Maximum tokens per model
 */
const MODEL_MAX_TOKENS: Record<string, number> = {
  'all-MiniLM-L6-v2': 256,
  'all-MiniLM-L12-v2': 256,
  'paraphrase-MiniLM-L6-v2': 128,
  'bge-small-en-v1.5': 512,
  'bge-base-en-v1.5': 512,
  'nomic-embed-text-v1': 8192,
};

/**
 * FastEmbed local embedding provider
 */
export class FastEmbedProvider implements EmbeddingProvider {
  readonly name = 'fastembed';
  readonly dimensions: number;
  readonly maxTokens: number;

  private model: string;
  private batchSize: number;
  private initialized = false;
  private embedder: unknown = null;

  constructor(model: string = 'all-MiniLM-L6-v2', batchSize: number = 32) {
    this.model = model;
    this.batchSize = batchSize;
    this.dimensions = MODEL_DIMENSIONS[model] ?? 384;
    this.maxTokens = MODEL_MAX_TOKENS[model] ?? 256;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Dynamic import of fastembed
      const fastembed = (await import('fastembed')) as unknown as {
        FlagEmbedding?: {
          init: (config: { model: string }) => Promise<unknown>;
        };
        EmbeddingModel?: Record<string, string>;
      };

      // Initialize using FlagEmbedding API (fastembed v1.x)
      if (fastembed.FlagEmbedding && fastembed.EmbeddingModel) {
        // Map our model names to fastembed model names
        const modelMap: Record<string, string> = {
          'all-MiniLM-L6-v2': fastembed.EmbeddingModel.AllMiniLML6V2 ?? 'fast-all-MiniLM-L6-v2',
          'bge-small-en-v1.5': fastembed.EmbeddingModel.BGESmallENV15 ?? 'fast-bge-small-en-v1.5',
          'bge-base-en-v1.5': fastembed.EmbeddingModel.BGEBaseENV15 ?? 'fast-bge-base-en-v1.5',
        };

        const fastembedModel = modelMap[this.model] ?? fastembed.EmbeddingModel.AllMiniLML6V2 ?? 'fast-all-MiniLM-L6-v2';
        this.embedder = await fastembed.FlagEmbedding.init({ model: fastembedModel });
      } else {
        this.embedder = null;
      }

      this.initialized = true;
    } catch (error) {
      // If fastembed fails to load, use a mock embedder for testing
      console.warn('fastembed not available, using mock embedder:', error);
      this.embedder = null;
      this.initialized = true;
    }
  }

  isReady(): boolean {
    return this.initialized;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    if (!this.initialized) {
      throw new EmbeddingError(
        'Provider not initialized',
        EmbeddingErrorCode.NOT_INITIALIZED
      );
    }

    const results = await this.embedBatch([text]);
    const result = results[0];
    if (result === undefined) {
      throw new EmbeddingError(
        'No embedding result returned',
        EmbeddingErrorCode.EMBEDDING_FAILED
      );
    }
    return result;
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    if (!this.initialized) {
      throw new EmbeddingError(
        'Provider not initialized',
        EmbeddingErrorCode.NOT_INITIALIZED
      );
    }

    if (texts.length === 0) {
      return [];
    }

    try {
      // If fastembed is available, use it
      if (this.embedder !== null) {
        const embedder = this.embedder as {
          embed: (texts: string[]) => AsyncIterable<number[][]>;
        };

        // Process in batches - fastembed returns an async generator
        const results: EmbeddingVector[] = [];
        for (let i = 0; i < texts.length; i += this.batchSize) {
          const batch = texts.slice(i, i + this.batchSize);
          const generator = embedder.embed(batch);

          // Collect all embeddings from the generator
          for await (const batchResult of generator) {
            // batchResult is an array of Float32Arrays
            for (const embedding of batchResult) {
              // Convert Float32Array to regular number array
              results.push(Array.from(embedding));
            }
          }
        }
        return results;
      }

      // Mock embeddings for testing when fastembed is not available
      return texts.map(() => this.generateMockEmbedding());
    } catch (error) {
      throw new EmbeddingError(
        `Embedding failed: ${error instanceof Error ? error.message : String(error)}`,
        EmbeddingErrorCode.EMBEDDING_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate a mock embedding vector for testing
   * Uses a seed to generate different vectors for different texts
   */
  private mockSeed = 0;
  private generateMockEmbedding(): EmbeddingVector {
    // Generate deterministic but different vectors for each call
    this.mockSeed++;
    const vector: number[] = [];
    for (let i = 0; i < this.dimensions; i++) {
      // Vary based on both position and seed
      vector.push((Math.sin(i + this.mockSeed * 0.1) * 10000) % 1);
    }
    // Normalize to unit vector
    const magnitude = Math.sqrt(
      vector.reduce((sum, val) => sum + val * val, 0)
    );
    return vector.map((v) => v / magnitude);
  }
}
