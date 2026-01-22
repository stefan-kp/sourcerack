/**
 * MCP tool: change_impact
 *
 * Analyze the impact of changing a symbol via the SQI index.
 */

import { MetadataStorage } from '../../storage/metadata.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { ChangeImpactInput, ChangeImpactOutput } from '../../sqi/types.js';

type ChangeImpactInputWithOptionalCommit = Omit<ChangeImpactInput, 'commit'> & {
  commit?: string;
};

/**
 * Handle change_impact tool call
 */
export async function handleChangeImpact(
  input: ChangeImpactInputWithOptionalCommit,
  metadata: MetadataStorage
): Promise<ChangeImpactOutput> {
  try {
    const queryEngine = createStructuredQueryEngine(metadata);
    const normalizedInput: ChangeImpactInput = {
      ...input,
      commit: input.commit ?? 'HEAD',
    };
    return await queryEngine.analyzeChangeImpact(normalizedInput);
  } catch (error) {
    return {
      success: false,
      direct_usages: [],
      transitive_impact: [],
      total_affected: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
