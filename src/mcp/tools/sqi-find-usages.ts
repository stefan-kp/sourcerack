/**
 * MCP tool: find_usages
 *
 * Finds all usages/references of a symbol using the Structured Query Index.
 */

import { MetadataStorage } from '../../storage/metadata.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { FindUsagesInput, FindUsagesOutput } from '../../sqi/types.js';

/**
 * Handle find_usages tool call
 */
export async function handleFindUsages(
  input: FindUsagesInput,
  metadata: MetadataStorage
): Promise<FindUsagesOutput> {
  try {
    const queryEngine = createStructuredQueryEngine(metadata);
    return await queryEngine.findUsages(input);
  } catch (error) {
    return {
      success: false,
      usages: [],
      total_count: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
