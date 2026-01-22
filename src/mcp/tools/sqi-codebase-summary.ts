/**
 * MCP tool: codebase_summary
 *
 * Provides a structured overview of an indexed codebase.
 */

import { MetadataStorage } from '../../storage/metadata.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { CodebaseSummaryInput, CodebaseSummaryOutput } from '../../sqi/types.js';

type CodebaseSummaryInputWithOptionalCommit = Omit<CodebaseSummaryInput, 'commit'> & {
  commit?: string;
};

/**
 * Handle codebase_summary tool call
 */
export async function handleCodebaseSummary(
  input: CodebaseSummaryInputWithOptionalCommit,
  metadata: MetadataStorage
): Promise<CodebaseSummaryOutput> {
  try {
    const queryEngine = createStructuredQueryEngine(metadata);
    const normalizedInput: CodebaseSummaryInput = {
      ...input,
      commit: input.commit ?? 'HEAD',
    };
    return await queryEngine.codebaseSummary(normalizedInput);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
