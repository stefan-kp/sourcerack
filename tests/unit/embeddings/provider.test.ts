import { describe, it, expect, beforeEach } from 'vitest';
import { FastEmbedProvider } from '../../../src/embeddings/local.js';
import {
  createEmbeddingProvider,
  getDefaultEmbeddingConfig,
} from '../../../src/embeddings/provider.js';

describe('Embedding Provider', () => {
  describe('FastEmbedProvider', () => {
    let provider: FastEmbedProvider;

    beforeEach(async () => {
      provider = new FastEmbedProvider('all-MiniLM-L6-v2', 32);
      await provider.initialize();
    });

    it('should have correct name', () => {
      expect(provider.name).toBe('fastembed');
    });

    it('should have correct dimensions', () => {
      expect(provider.dimensions).toBe(384);
    });

    it('should be ready after initialization', () => {
      expect(provider.isReady()).toBe(true);
    });

    it('should generate embedding for single text', async () => {
      const vector = await provider.embed('Hello, world!');

      expect(Array.isArray(vector)).toBe(true);
      expect(vector).toHaveLength(384);
      // All values should be numbers
      expect(vector.every((v) => typeof v === 'number')).toBe(true);
    });

    it('should generate embeddings for batch', async () => {
      const texts = ['Hello', 'World', 'Test'];
      const vectors = await provider.embedBatch(texts);

      expect(vectors).toHaveLength(3);
      expect(vectors[0]).toHaveLength(384);
      expect(vectors[1]).toHaveLength(384);
      expect(vectors[2]).toHaveLength(384);
    });

    it('should return empty array for empty batch', async () => {
      const vectors = await provider.embedBatch([]);
      expect(vectors).toHaveLength(0);
    });

    it('should generate normalized vectors', async () => {
      const vector = await provider.embed('Test text');

      // Calculate magnitude
      const magnitude = Math.sqrt(
        vector.reduce((sum, val) => sum + val * val, 0)
      );

      // Should be approximately 1 (unit vector)
      expect(magnitude).toBeCloseTo(1, 5);
    });
  });

  describe('createEmbeddingProvider', () => {
    it('should create fastembed provider', async () => {
      const config = getDefaultEmbeddingConfig();
      const provider = await createEmbeddingProvider(config);

      expect(provider.name).toBe('fastembed');
      expect(provider.isReady()).toBe(true);
    });

    it('should respect custom configuration', async () => {
      const provider = await createEmbeddingProvider({
        provider: 'fastembed',
        model: 'bge-base-en-v1.5',
        batchSize: 16,
      });

      expect(provider.dimensions).toBe(768);
    });
  });

  describe('getDefaultEmbeddingConfig', () => {
    it('should return default configuration', () => {
      const config = getDefaultEmbeddingConfig();

      expect(config.provider).toBe('fastembed');
      expect(config.model).toBe('all-MiniLM-L6-v2');
      expect(config.batchSize).toBe(32);
    });
  });
});
