/**
 * Embedding types for SourceRack
 */

/**
 * Embedding vector (array of floats)
 */
export type EmbeddingVector = number[];

/**
 * Result of embedding a single text
 */
export interface EmbeddingResult {
  /** The embedded text */
  text: string;
  /** The embedding vector */
  vector: EmbeddingVector;
  /** Number of tokens in text (if available) */
  tokenCount?: number;
}

/**
 * Embedding provider interface
 */
export interface EmbeddingProvider {
  /** Provider name */
  readonly name: string;

  /** Vector dimensions (e.g., 384 for all-MiniLM-L6-v2) */
  readonly dimensions: number;

  /** Maximum tokens per text */
  readonly maxTokens: number;

  /**
   * Generate embedding for a single text
   */
  embed(text: string): Promise<EmbeddingVector>;

  /**
   * Generate embeddings for multiple texts (batched)
   */
  embedBatch(texts: string[]): Promise<EmbeddingVector[]>;

  /**
   * Initialize the provider (load model, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Check if provider is ready
   */
  isReady(): boolean;
}

/**
 * Embedding provider configuration
 */
export interface EmbeddingProviderConfig {
  /** Provider type */
  provider: 'fastembed' | 'remote';
  /** Model name */
  model: string;
  /** Batch size for embeddings */
  batchSize: number;
  /** Remote provider URL (if applicable) */
  remoteUrl?: string;
  /** Remote provider API key (if applicable) */
  remoteApiKey?: string;
}

/**
 * Embedding error
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly code: EmbeddingErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/**
 * Embedding error codes
 */
export enum EmbeddingErrorCode {
  /** Provider not initialized */
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  /** Embedding generation failed */
  EMBEDDING_FAILED = 'EMBEDDING_FAILED',
  /** Text too long */
  TEXT_TOO_LONG = 'TEXT_TOO_LONG',
  /** Rate limited */
  RATE_LIMITED = 'RATE_LIMITED',
  /** Network error (for remote providers) */
  NETWORK_ERROR = 'NETWORK_ERROR',
}
