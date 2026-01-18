import { describe, it, expect } from 'vitest';
import {
  normalizeContent,
  generateChunkId,
  chunksAreIdentical,
  deduplicateChunks,
  getNewChunkIds,
} from '../../../src/storage/dedup.js';
import { CodeChunk } from '../../../src/parser/types.js';

describe('Deduplication', () => {
  const createChunk = (overrides: Partial<CodeChunk> = {}): CodeChunk => ({
    path: 'test.ts',
    symbol: 'testFunction',
    symbolType: 'function',
    language: 'typescript',
    startLine: 1,
    endLine: 5,
    content: 'function test() { return 42; }',
    ...overrides,
  });

  describe('normalizeContent', () => {
    it('should remove trailing whitespace', () => {
      const content = 'line 1   \nline 2  ';
      expect(normalizeContent(content)).toBe('line 1\nline 2');
    });

    it('should normalize line endings', () => {
      const content = 'line 1\r\nline 2\rline 3';
      expect(normalizeContent(content)).toBe('line 1\nline 2\rline 3');
    });

    it('should trim leading/trailing empty lines', () => {
      const content = '\n\ncode\n\n';
      expect(normalizeContent(content)).toBe('code');
    });
  });

  describe('generateChunkId', () => {
    it('should generate UUID format string', () => {
      const chunk = createChunk();
      const id = generateChunkId(chunk);

      // UUID format: 8-4-4-4-12 hex characters
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    });

    it('should be deterministic', () => {
      const chunk = createChunk();
      const id1 = generateChunkId(chunk);
      const id2 = generateChunkId(chunk);

      expect(id1).toBe(id2);
    });

    it('should differ for different content', () => {
      const chunk1 = createChunk({ content: 'function a() {}' });
      const chunk2 = createChunk({ content: 'function b() {}' });

      expect(generateChunkId(chunk1)).not.toBe(generateChunkId(chunk2));
    });

    it('should differ for different paths', () => {
      const chunk1 = createChunk({ path: 'file1.ts' });
      const chunk2 = createChunk({ path: 'file2.ts' });

      expect(generateChunkId(chunk1)).not.toBe(generateChunkId(chunk2));
    });

    it('should differ for different symbols', () => {
      const chunk1 = createChunk({ symbol: 'func1' });
      const chunk2 = createChunk({ symbol: 'func2' });

      expect(generateChunkId(chunk1)).not.toBe(generateChunkId(chunk2));
    });

    it('should differ for different languages', () => {
      const chunk1 = createChunk({ language: 'typescript' });
      const chunk2 = createChunk({ language: 'javascript' });

      expect(generateChunkId(chunk1)).not.toBe(generateChunkId(chunk2));
    });

    it('should be same for whitespace-normalized content', () => {
      const chunk1 = createChunk({ content: 'function test() {}  ' });
      const chunk2 = createChunk({ content: 'function test() {}' });

      expect(generateChunkId(chunk1)).toBe(generateChunkId(chunk2));
    });
  });

  describe('chunksAreIdentical', () => {
    it('should return true for identical chunks', () => {
      const chunk1 = createChunk();
      const chunk2 = createChunk();

      expect(chunksAreIdentical(chunk1, chunk2)).toBe(true);
    });

    it('should return false for different chunks', () => {
      const chunk1 = createChunk({ content: 'a' });
      const chunk2 = createChunk({ content: 'b' });

      expect(chunksAreIdentical(chunk1, chunk2)).toBe(false);
    });
  });

  describe('deduplicateChunks', () => {
    it('should remove duplicates', () => {
      const chunks = [
        createChunk({ content: 'same' }),
        createChunk({ content: 'same' }),
        createChunk({ content: 'different' }),
      ];

      const deduplicated = deduplicateChunks(chunks);
      expect(deduplicated).toHaveLength(2);
    });

    it('should return IDs with chunks', () => {
      const chunks = [createChunk()];
      const deduplicated = deduplicateChunks(chunks);

      // UUID format: 8-4-4-4-12 hex characters
      expect(deduplicated[0]?.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      expect(deduplicated[0]?.chunk).toBeDefined();
    });
  });

  describe('getNewChunkIds', () => {
    it('should return only new chunks', () => {
      const existingId = generateChunkId(createChunk({ content: 'existing' }));
      const existingIds = new Set([existingId]);

      const chunks = [
        createChunk({ content: 'existing' }),
        createChunk({ content: 'new' }),
      ];

      const newChunks = getNewChunkIds(chunks, existingIds);
      expect(newChunks).toHaveLength(1);
      expect(newChunks[0]?.chunk.content).toBe('new');
    });

    it('should return empty array when all chunks exist', () => {
      const chunk = createChunk();
      const existingIds = new Set([generateChunkId(chunk)]);

      const newChunks = getNewChunkIds([chunk], existingIds);
      expect(newChunks).toHaveLength(0);
    });
  });
});
