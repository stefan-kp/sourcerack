/**
 * MCP tools: find_imports and find_importers
 *
 * Analyzes import relationships using the Structured Query Index.
 */

import { MetadataStorage } from '../../storage/metadata.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type {
  FindImportsInput,
  FindImportsOutput,
  FindImportersInput,
  FindImportersOutput,
} from '../../sqi/types.js';

/**
 * Handle find_imports tool call
 * Returns all imports for a given file.
 */
export async function handleFindImports(
  input: FindImportsInput,
  metadata: MetadataStorage
): Promise<FindImportsOutput> {
  try {
    const queryEngine = createStructuredQueryEngine(metadata);
    return await queryEngine.findImports(input);
  } catch (error) {
    return {
      success: false,
      imports: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle find_importers tool call
 * Returns all files that import a given module.
 */
export async function handleFindImporters(
  input: FindImportersInput,
  metadata: MetadataStorage
): Promise<FindImportersOutput> {
  try {
    const queryEngine = createStructuredQueryEngine(metadata);
    return await queryEngine.findImporters(input);
  } catch (error) {
    return {
      success: false,
      importers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
