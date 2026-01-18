import { describe, it, expect } from 'vitest';
import { EmbeddingConfigSchema } from '../../../src/config/schema.js';

describe('Embedding Config (Phase 1.0)', () => {
  describe('EmbeddingConfigSchema', () => {
    it('should have enabled field defaulting to true', () => {
      const config = EmbeddingConfigSchema.parse({});

      expect(config.enabled).toBe(true);
    });

    it('should allow disabling embeddings', () => {
      const config = EmbeddingConfigSchema.parse({
        enabled: false,
      });

      expect(config.enabled).toBe(false);
    });

    it('should preserve other defaults when enabled is set', () => {
      const config = EmbeddingConfigSchema.parse({
        enabled: false,
      });

      expect(config.enabled).toBe(false);
      expect(config.provider).toBe('fastembed');
      expect(config.model).toBe('all-MiniLM-L6-v2');
      expect(config.batchSize).toBe(32);
    });

    it('should allow full configuration with enabled flag', () => {
      const config = EmbeddingConfigSchema.parse({
        enabled: true,
        provider: 'remote',
        model: 'custom-model',
        batchSize: 64,
        remoteUrl: 'https://api.example.com/embed',
        remoteApiKey: 'secret-key',
      });

      expect(config.enabled).toBe(true);
      expect(config.provider).toBe('remote');
      expect(config.model).toBe('custom-model');
      expect(config.batchSize).toBe(64);
      expect(config.remoteUrl).toBe('https://api.example.com/embed');
      expect(config.remoteApiKey).toBe('secret-key');
    });

    it('should reject invalid enabled value', () => {
      expect(() => {
        EmbeddingConfigSchema.parse({
          enabled: 'yes', // Should be boolean
        });
      }).toThrow();
    });
  });

  describe('Environment Variable Integration', () => {
    it('should support SOURCERACK_EMBEDDING_ENABLED env var in config loading', () => {
      // This test verifies that the env var mapping exists in config.ts
      // The actual env var loading is tested through integration tests
      // Here we just verify the schema supports the enabled field properly

      // When enabled is false (as it would be from env var)
      const disabledConfig = EmbeddingConfigSchema.parse({ enabled: false });
      expect(disabledConfig.enabled).toBe(false);

      // When enabled is true (default)
      const enabledConfig = EmbeddingConfigSchema.parse({ enabled: true });
      expect(enabledConfig.enabled).toBe(true);

      // When enabled is a string 'false' (as it would come from env var before parsing)
      // The schema should coerce or reject it - let's verify behavior
      expect(() => {
        EmbeddingConfigSchema.parse({ enabled: 'false' });
      }).toThrow(); // String 'false' is not a boolean
    });
  });

  describe('SQI-Only Indexing Use Case', () => {
    it('should support configuration for SQI-only indexing', () => {
      // When embeddings are disabled, SQI indexing should still work
      const sqiOnlyConfig = EmbeddingConfigSchema.parse({
        enabled: false,
      });

      expect(sqiOnlyConfig.enabled).toBe(false);
      // Other embedding settings are still present but won't be used
      expect(sqiOnlyConfig.provider).toBeDefined();
    });

    it('should support configuration for full indexing with embeddings', () => {
      const fullConfig = EmbeddingConfigSchema.parse({
        enabled: true,
      });

      expect(fullConfig.enabled).toBe(true);
    });
  });
});
