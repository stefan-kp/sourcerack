/**
 * MCP tool: dependency_graph
 *
 * Build a module-level dependency graph from imports.
 */

import { MetadataStorage } from '../../storage/metadata.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { DependencyGraphInput, DependencyGraphOutput } from '../../sqi/types.js';

type DependencyGraphInputWithOptionalCommit = Omit<DependencyGraphInput, 'commit'> & {
  commit?: string;
};

/**
 * Handle dependency_graph tool call
 */
export async function handleDependencyGraph(
  input: DependencyGraphInputWithOptionalCommit,
  metadata: MetadataStorage
): Promise<DependencyGraphOutput> {
  try {
    const queryEngine = createStructuredQueryEngine(metadata);
    const normalizedInput: DependencyGraphInput = {
      ...input,
      commit: input.commit ?? 'HEAD',
    };
    return await queryEngine.getDependencyGraph(normalizedInput);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
