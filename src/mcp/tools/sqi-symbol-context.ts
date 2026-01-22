/**
 * MCP tool: get_symbol_context
 *
 * Returns rich context for a symbol (docs, source, usages, related symbols).
 */

import { MetadataStorage } from '../../storage/metadata.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { GetSymbolContextInput, GetSymbolContextOutput } from '../../sqi/types.js';

type GetSymbolContextInputWithOptionalCommit = Omit<GetSymbolContextInput, 'commit'> & {
  commit?: string;
};

/**
 * Handle get_symbol_context tool call
 */
export async function handleGetSymbolContext(
  input: GetSymbolContextInputWithOptionalCommit,
  metadata: MetadataStorage
): Promise<GetSymbolContextOutput> {
  try {
    const queryEngine = createStructuredQueryEngine(metadata);
    const normalizedInput: GetSymbolContextInput = {
      ...input,
      commit: input.commit ?? 'HEAD',
    };
    return await queryEngine.getSymbolContext(normalizedInput);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
