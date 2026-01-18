/**
 * MCP tool: find_hierarchy
 *
 * Finds symbol hierarchy (children and parents) using the Structured Query Index.
 */

import { MetadataStorage } from '../../storage/metadata.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { FindHierarchyInput, FindHierarchyOutput } from '../../sqi/types.js';

/**
 * Handle find_hierarchy tool call
 */
export async function handleFindHierarchy(
  input: FindHierarchyInput,
  metadata: MetadataStorage
): Promise<FindHierarchyOutput> {
  try {
    const queryEngine = createStructuredQueryEngine(metadata);
    return await queryEngine.findHierarchy(input);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
