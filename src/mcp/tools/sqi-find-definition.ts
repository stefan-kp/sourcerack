/**
 * MCP tool: find_definition
 *
 * Finds symbol definitions by name using the Structured Query Index.
 */

import { MetadataStorage } from '../../storage/metadata.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { FindDefinitionInput, FindDefinitionOutput } from '../../sqi/types.js';

/**
 * Handle find_definition tool call
 */
export async function handleFindDefinition(
  input: FindDefinitionInput,
  metadata: MetadataStorage
): Promise<FindDefinitionOutput> {
  try {
    const queryEngine = createStructuredQueryEngine(metadata);
    return await queryEngine.findDefinition(input);
  } catch (error) {
    return {
      success: false,
      definitions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
