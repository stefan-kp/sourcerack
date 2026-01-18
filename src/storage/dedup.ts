/**
 * Chunk deduplication for SourceRack
 *
 * Implements deterministic chunk ID generation based on content hash.
 * Chunk ID = SHA256(language + ":" + path + ":" + symbol + ":" + normalized_content)
 */

import { createHash } from 'node:crypto';
import { CodeChunk } from '../parser/types.js';

/**
 * Normalize code content for consistent hashing
 *
 * - Removes trailing whitespace from lines
 * - Normalizes line endings to \n
 * - Removes empty lines at start/end
 */
export function normalizeContent(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Convert hex string to UUID format (8-4-4-4-12)
 */
function hexToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Generate deterministic chunk ID
 *
 * Formula: SHA256(language + ":" + path + ":" + symbol + ":" + normalized_content)
 * Output is formatted as UUID for Qdrant compatibility.
 *
 * @param chunk - Code chunk
 * @returns UUID-formatted string (derived from SHA256 hash)
 */
export function generateChunkId(chunk: CodeChunk): string {
  const normalizedContent = normalizeContent(chunk.content);

  const hashInput = [
    chunk.language,
    chunk.path,
    chunk.symbol,
    normalizedContent,
  ].join(':');

  const hash = createHash('sha256').update(hashInput).digest('hex');
  // Format as UUID for Qdrant compatibility (8-4-4-4-12)
  return hexToUuid(hash);
}

/**
 * Generate chunk IDs for multiple chunks
 */
export function generateChunkIds(chunks: CodeChunk[]): Map<CodeChunk, string> {
  const ids = new Map<CodeChunk, string>();
  for (const chunk of chunks) {
    ids.set(chunk, generateChunkId(chunk));
  }
  return ids;
}

/**
 * Check if two chunks are identical (same content hash)
 */
export function chunksAreIdentical(chunk1: CodeChunk, chunk2: CodeChunk): boolean {
  return generateChunkId(chunk1) === generateChunkId(chunk2);
}

/**
 * Deduplicate chunks by content
 * Returns unique chunks with their IDs
 */
export function deduplicateChunks(
  chunks: CodeChunk[]
): { chunk: CodeChunk; id: string }[] {
  const seen = new Map<string, { chunk: CodeChunk; id: string }>();

  for (const chunk of chunks) {
    const id = generateChunkId(chunk);
    if (!seen.has(id)) {
      seen.set(id, { chunk, id });
    }
  }

  return Array.from(seen.values());
}

/**
 * Get chunk IDs that are new (not in existing set)
 */
export function getNewChunkIds(
  chunks: CodeChunk[],
  existingIds: Set<string>
): { chunk: CodeChunk; id: string }[] {
  const newChunks: { chunk: CodeChunk; id: string }[] = [];

  for (const chunk of chunks) {
    const id = generateChunkId(chunk);
    if (!existingIds.has(id)) {
      newChunks.push({ chunk, id });
    }
  }

  return newChunks;
}
