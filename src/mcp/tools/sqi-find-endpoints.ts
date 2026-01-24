/**
 * MCP Tool: find_endpoints
 *
 * Find API endpoints in the codebase.
 */

import { MetadataStorage } from '../../storage/metadata.js';
import { createStructuredQueryEngine } from '../../sqi/query.js';
import type { FindEndpointsInput, FindEndpointsOutput } from '../../sqi/extractors/api/types.js';

/**
 * Handle find_endpoints tool call
 */
export async function handleFindEndpoints(
  input: FindEndpointsInput,
  metadata: MetadataStorage
): Promise<FindEndpointsOutput> {
  const queryEngine = createStructuredQueryEngine(metadata);
  return queryEngine.findEndpoints(input);
}
