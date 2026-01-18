/**
 * MCP tool: query_code
 *
 * Performs semantic search within an indexed commit.
 */

import { GitAdapter } from '../../git/adapter.js';
import { MetadataStorage } from '../../storage/metadata.js';
import { QdrantStorage } from '../../storage/qdrant.js';
import type { EmbeddingProvider } from '../../embeddings/types.js';
import {
  createQueryOrchestrator,
  type PaginationCursor,
} from '../../indexer/query.js';
import type { QueryCodeInput, QueryCodeOutput, CodeSnippet } from '../types.js';

/**
 * Encode cursor to string for MCP transport
 */
function encodeCursor(cursor: PaginationCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

/**
 * Decode cursor from string
 */
function decodeCursor(encoded: string): PaginationCursor | undefined {
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf-8');
    return JSON.parse(json) as PaginationCursor;
  } catch {
    return undefined;
  }
}

/**
 * Handle query_code tool call
 */
export async function handleQueryCode(
  input: QueryCodeInput,
  metadata: MetadataStorage,
  vectors: QdrantStorage,
  embeddings: EmbeddingProvider
): Promise<QueryCodeOutput> {
  const { repo_path, commit, query, limit, cursor, language, path_pattern } =
    input;

  try {
    // Create Git adapter to resolve commit
    const git = await GitAdapter.create(repo_path);

    // Resolve commit SHA
    let commitSha: string;
    try {
      commitSha = await git.resolveRef(commit);
    } catch {
      return {
        success: false,
        indexed: false,
        results: [],
        total_count: 0,
        next_cursor: null,
        error: `Cannot resolve commit: ${commit}`,
      };
    }

    // Get repository record
    const repo = metadata.getRepositoryByPath(repo_path);
    if (!repo) {
      return {
        success: false,
        indexed: false,
        results: [],
        total_count: 0,
        next_cursor: null,
        error: 'Repository not registered. Please index the codebase first.',
      };
    }

    // Create query orchestrator
    const queryOrchestrator = createQueryOrchestrator(
      metadata,
      vectors,
      embeddings
    );

    // Decode cursor if provided
    const paginationCursor = cursor ? decodeCursor(cursor) : undefined;

    // Build query options carefully
    const queryOptions: {
      repoId: string;
      commitSha: string;
      query: string;
      limit?: number;
      language?: string;
      pathPattern?: string;
      cursor?: PaginationCursor;
    } = {
      repoId: repo.id,
      commitSha,
      query,
    };
    if (limit !== undefined) {
      queryOptions.limit = limit;
    }
    if (language) {
      queryOptions.language = language;
    }
    if (path_pattern) {
      queryOptions.pathPattern = path_pattern;
    }
    if (paginationCursor) {
      queryOptions.cursor = paginationCursor;
    }

    // Execute query
    const result = await queryOrchestrator.query(queryOptions);

    // Format results
    const snippets: CodeSnippet[] = result.results.map((r) => ({
      id: r.id,
      score: r.score,
      path: r.path,
      symbol: r.symbol,
      symbol_type: r.symbolType,
      language: r.language,
      start_line: r.startLine,
      end_line: r.endLine,
      content: r.content,
    }));

    // Encode next cursor
    const nextCursor = result.nextCursor
      ? encodeCursor(result.nextCursor)
      : null;

    const output: QueryCodeOutput = {
      success: result.success,
      indexed: result.isIndexed,
      results: snippets,
      total_count: result.totalCount,
      next_cursor: nextCursor,
    };
    if (result.error) {
      output.error = result.error;
    }

    return output;
  } catch (error) {
    return {
      success: false,
      indexed: false,
      results: [],
      total_count: 0,
      next_cursor: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
