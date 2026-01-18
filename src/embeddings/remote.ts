/**
 * Remote embedding provider for SourceRack
 *
 * HTTP-based embedding provider that calls a remote API.
 * Works with the bundled Docker embedding service or any compatible endpoint.
 *
 * Expected API format:
 * - POST /embed
 * - Body: { "texts": ["text1", "text2", ...] }
 * - Response: { "embeddings": [[...], [...]], "dimensions": 384 }
 */

import {
  EmbeddingProvider,
  EmbeddingVector,
  EmbeddingError,
  EmbeddingErrorCode,
} from './types.js';

/**
 * Response format from the embedding API
 */
interface EmbedResponse {
  embeddings: number[][];
  dimensions: number;
  error?: string;
}

/**
 * Remote embedding provider
 *
 * Calls a remote HTTP API for embedding generation.
 * Compatible with the bundled Docker embedding service.
 */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'remote';
  readonly dimensions: number;
  readonly maxTokens: number;

  private url: string;
  private apiKey: string | undefined;
  private initialized = false;
  private batchSize: number;

  constructor(
    url: string,
    apiKey?: string,
    dimensions: number = 384,
    maxTokens: number = 512,
    batchSize: number = 32
  ) {
    this.url = url;
    this.apiKey = apiKey;
    this.dimensions = dimensions;
    this.maxTokens = maxTokens;
    this.batchSize = batchSize;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Verify the remote endpoint is reachable by calling /health or /info
    try {
      const infoUrl = this.url.replace(/\/embed\/?$/, '/info');
      const response = await fetch(infoUrl, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        // Try health endpoint as fallback
        const healthUrl = this.url.replace(/\/embed\/?$/, '/health');
        const healthResponse = await fetch(healthUrl, {
          method: 'GET',
          headers: this.getHeaders(),
        });

        if (!healthResponse.ok) {
          throw new Error(`Health check failed: ${healthResponse.status}`);
        }
      }

      this.initialized = true;
    } catch (error) {
      throw new EmbeddingError(
        `Failed to connect to embedding service at ${this.url}: ${error instanceof Error ? error.message : String(error)}`,
        EmbeddingErrorCode.NOT_INITIALIZED,
        error instanceof Error ? error : undefined
      );
    }
  }

  isReady(): boolean {
    return this.initialized;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  async embed(text: string): Promise<EmbeddingVector> {
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
      const results: EmbeddingVector[] = [];

      // Process in batches
      for (let i = 0; i < texts.length; i += this.batchSize) {
        const batch = texts.slice(i, i + this.batchSize);
        const batchResults = await this.embedBatchRequest(batch);
        results.push(...batchResults);
      }

      return results;
    } catch (error) {
      if (error instanceof EmbeddingError) {
        throw error;
      }
      throw new EmbeddingError(
        `Embedding request failed: ${error instanceof Error ? error.message : String(error)}`,
        EmbeddingErrorCode.EMBEDDING_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Make a single batch request to the embedding API
   */
  private async embedBatchRequest(texts: string[]): Promise<EmbeddingVector[]> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ texts }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new EmbeddingError(
        `Embedding API error (${response.status}): ${errorText}`,
        EmbeddingErrorCode.EMBEDDING_FAILED
      );
    }

    const data = (await response.json()) as EmbedResponse;

    if (data.error) {
      throw new EmbeddingError(
        `Embedding API returned error: ${data.error}`,
        EmbeddingErrorCode.EMBEDDING_FAILED
      );
    }

    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new EmbeddingError(
        'Invalid response format: missing embeddings array',
        EmbeddingErrorCode.EMBEDDING_FAILED
      );
    }

    if (data.embeddings.length !== texts.length) {
      throw new EmbeddingError(
        `Embedding count mismatch: expected ${texts.length}, got ${data.embeddings.length}`,
        EmbeddingErrorCode.EMBEDDING_FAILED
      );
    }

    return data.embeddings;
  }
}
