/**
 * Query orchestrator for SourceRack
 *
 * Handles semantic search queries with:
 * - Commit-scoped search (FR-002)
 * - Indexed commit validation (FR-003)
 * - Result limiting (FR-013)
 * - Cursor-based pagination for stable ordering
 * - Symbol-name boosting for better ranking
 * - Query-intent routing (definition vs usage)
 */

import { MetadataStorage } from '../storage/metadata.js';
import type { VectorStorage, SearchResult, SearchFilters, ContentType } from '../storage/vector-storage.js';
import type { EmbeddingProvider, EmbeddingVector } from '../embeddings/types.js';

/**
 * Query intent detected from the query text
 */
export type QueryIntent = 'definition' | 'usage' | 'general';

/**
 * Parsed query with extracted intent and terms
 */
export interface ParsedQuery {
  /** Original query text */
  original: string;
  /** Cleaned query for embedding (keywords removed) */
  forEmbedding: string;
  /** Detected intent */
  intent: QueryIntent;
  /** Symbol names extracted from query */
  symbolTerms: string[];
  /** Symbol types mentioned (class, function, method, etc.) */
  symbolTypes: string[];
  /** Content types to search (default: ['code']) */
  contentTypes: ContentType[];
}

/**
 * Query options
 */
export interface QueryOptions {
  /** Repository ID */
  repoId: string;
  /** Commit SHA to search within */
  commitSha: string;
  /** Search query text */
  query: string;
  /** Maximum results to return (default: 50) */
  limit?: number;
  /** Optional language filter */
  language?: string;
  /** Optional path pattern filter */
  pathPattern?: string;
  /** Optional content type filter */
  contentType?: ContentType | ContentType[];
  /** Include all content types (overrides contentType) */
  includeAllContentTypes?: boolean;
  /** Pagination cursor for subsequent pages */
  cursor?: PaginationCursor;
}

/**
 * Pagination cursor for stable traversal
 * Uses (score, chunk_id) pair for deterministic ordering
 */
export interface PaginationCursor {
  /** Score of last result */
  lastScore: number;
  /** ID of last result */
  lastId: string;
}

/**
 * Query result
 */
export interface QueryResult {
  /** Whether the query was successful */
  success: boolean;
  /** Whether the commit is indexed */
  isIndexed: boolean;
  /** Search results */
  results: SearchResultItem[];
  /** Total count of matching results (for pagination UI) */
  totalCount: number;
  /** Next page cursor (null if no more pages) */
  nextCursor: PaginationCursor | null;
  /** Error message (if query failed) */
  error?: string;
}

/**
 * Individual search result item
 */
export interface SearchResultItem {
  /** Chunk ID */
  id: string;
  /** Relevance score (0-1, higher is better) */
  score: number;
  /** File path */
  path: string;
  /** Symbol name */
  symbol: string;
  /** Symbol type */
  symbolType: string;
  /** Programming language */
  language: string;
  /** Start line number */
  startLine: number;
  /** End line number */
  endLine: number;
  /** Source code content */
  content: string;
}

/**
 * Query configuration
 */
export interface QueryConfig {
  /** Default result limit */
  defaultLimit: number;
  /** Hard upper bound for results */
  maxLimit: number;
}

/**
 * Default query configuration
 */
export const DEFAULT_QUERY_CONFIG: QueryConfig = {
  defaultLimit: 50,
  maxLimit: 100,
};

/**
 * Query error
 */
export class QueryError extends Error {
  constructor(
    message: string,
    public readonly code: QueryErrorCode
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

/**
 * Query error codes
 */
export enum QueryErrorCode {
  /** Commit not indexed */
  NOT_INDEXED = 'NOT_INDEXED',
  /** Invalid query parameters */
  INVALID_PARAMS = 'INVALID_PARAMS',
  /** Limit exceeded */
  LIMIT_EXCEEDED = 'LIMIT_EXCEEDED',
  /** Embedding failed */
  EMBEDDING_FAILED = 'EMBEDDING_FAILED',
  /** Search failed */
  SEARCH_FAILED = 'SEARCH_FAILED',
}

/**
 * Keywords indicating definition intent
 */
const DEFINITION_KEYWORDS = [
  'definition', 'defined', 'where is', 'find',
  'declaration', 'declared', 'implementation', 'implements',
  'source', 'code for', 'show me',
];

/**
 * Keywords indicating usage intent
 */
const USAGE_KEYWORDS = [
  'usage', 'used', 'uses', 'using', 'how to use',
  'called', 'calls', 'calling', 'invoked', 'invokes',
  'reference', 'references', 'referencing',
  'example', 'examples',
];

/**
 * Symbol type keywords and their mapping to symbol_type values
 */
const SYMBOL_TYPE_KEYWORDS: Record<string, string[]> = {
  'class': ['class', 'class_definition', 'class_declaration'],
  'function': ['function', 'function_definition', 'function_declaration', 'arrow_function'],
  'method': ['method', 'method_definition', 'function_definition'],
  'interface': ['interface', 'interface_declaration', 'type_alias'],
  'type': ['type', 'type_alias', 'type_definition'],
  'variable': ['variable', 'variable_declaration', 'lexical_declaration'],
  'constant': ['constant', 'const', 'variable_declaration'],
  'enum': ['enum', 'enum_declaration'],
  'module': ['module', 'module_declaration', 'namespace'],
  'struct': ['struct', 'struct_definition', 'struct_declaration'],
  'trait': ['trait', 'trait_definition'],
  'impl': ['impl', 'impl_item'],
};

/**
 * Content type keywords
 */
const CONTENT_TYPE_KEYWORDS: Record<ContentType, string[]> = {
  'code': ['code', 'source', 'implementation'],
  'docs': ['docs', 'documentation', 'readme', 'markdown', 'comment', 'comments'],
  'config': ['config', 'configuration', 'settings', 'yaml', 'json', 'toml'],
};

/**
 * Parse a query to extract intent, symbol terms, and content types
 */
export function parseQuery(query: string): ParsedQuery {
  const lowerQuery = query.toLowerCase();
  const words = query.split(/\s+/);

  // Detect intent
  let intent: QueryIntent = 'general';
  if (DEFINITION_KEYWORDS.some(kw => lowerQuery.includes(kw))) {
    intent = 'definition';
  } else if (USAGE_KEYWORDS.some(kw => lowerQuery.includes(kw))) {
    intent = 'usage';
  }

  // Extract symbol types mentioned
  const symbolTypes: string[] = [];
  for (const [keyword, types] of Object.entries(SYMBOL_TYPE_KEYWORDS)) {
    if (lowerQuery.includes(keyword)) {
      symbolTypes.push(...types);
    }
  }

  // Extract content types
  let contentTypes: ContentType[] = ['code']; // Default to code
  for (const [type, keywords] of Object.entries(CONTENT_TYPE_KEYWORDS)) {
    if (keywords.some(kw => lowerQuery.includes(kw))) {
      if (type === 'docs' || type === 'config') {
        contentTypes = [type as ContentType];
      }
    }
  }

  // Extract potential symbol names (CamelCase or snake_case words)
  const symbolTerms: string[] = [];
  for (const word of words) {
    // Skip common keywords
    if (DEFINITION_KEYWORDS.some(kw => word.toLowerCase() === kw)) continue;
    if (USAGE_KEYWORDS.some(kw => word.toLowerCase() === kw)) continue;
    if (Object.keys(SYMBOL_TYPE_KEYWORDS).includes(word.toLowerCase())) continue;

    // Check if it looks like a symbol name
    if (
      /^[A-Z][a-zA-Z0-9]*$/.test(word) || // CamelCase
      /^[a-z][a-zA-Z0-9]*$/.test(word) ||  // camelCase
      /^[a-z_][a-z0-9_]*$/i.test(word)     // snake_case
    ) {
      symbolTerms.push(word);
    }
  }

  // Clean query for embedding (remove intent keywords)
  let forEmbedding = query;
  for (const kw of [...DEFINITION_KEYWORDS, ...USAGE_KEYWORDS]) {
    forEmbedding = forEmbedding.replace(new RegExp(kw, 'gi'), '').trim();
  }
  forEmbedding = forEmbedding.replace(/\s+/g, ' ').trim();
  if (!forEmbedding) {
    forEmbedding = query; // Fallback to original if everything was removed
  }

  return {
    original: query,
    forEmbedding,
    intent,
    symbolTerms,
    symbolTypes: [...new Set(symbolTypes)], // Deduplicate
    contentTypes,
  };
}

/**
 * Boosting configuration
 */
interface BoostConfig {
  /** Boost for exact symbol name match */
  exactSymbolMatch: number;
  /** Boost for partial symbol name match */
  partialSymbolMatch: number;
  /** Boost for symbol type match */
  symbolTypeMatch: number;
  /** Boost for definition intent + definition symbol type */
  definitionIntentMatch: number;
  /** Boost for exported symbols (when available in payload) */
  exportedSymbol: number;
  /** Boost for top-level symbol kinds (class, interface) */
  topLevelSymbolKind: number;
  /** Boost for symbols in index files */
  indexFile: number;
}

const DEFAULT_BOOST_CONFIG: BoostConfig = {
  exactSymbolMatch: 0.5,
  partialSymbolMatch: 0.2,
  symbolTypeMatch: 0.15,
  definitionIntentMatch: 0.1,
  exportedSymbol: 0.10,
  topLevelSymbolKind: 0.05,
  indexFile: 0.05,
};

/**
 * Calculate boost score for a search result based on parsed query
 */
/**
 * Check if the file path is an index file
 */
function isIndexFile(path: string): boolean {
  const filename = path.split('/').pop() ?? '';
  return /^index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filename);
}

/**
 * Check if the symbol type is a top-level kind (class, interface, type)
 */
function isTopLevelSymbolKind(symbolType: string): boolean {
  const typeLower = symbolType.toLowerCase();
  return (
    typeLower.includes('class') ||
    typeLower.includes('interface') ||
    typeLower.includes('type') ||
    typeLower.includes('struct') ||
    typeLower.includes('enum')
  );
}

function calculateBoost(
  result: SearchResult,
  parsedQuery: ParsedQuery,
  config: BoostConfig = DEFAULT_BOOST_CONFIG
): number {
  let boost = 0;
  const symbolLower = result.payload.symbol.toLowerCase();
  const symbolType = result.payload.symbol_type.toLowerCase();

  // Symbol name matching
  for (const term of parsedQuery.symbolTerms) {
    const termLower = term.toLowerCase();
    if (symbolLower === termLower) {
      boost += config.exactSymbolMatch;
    } else if (symbolLower.includes(termLower) || termLower.includes(symbolLower)) {
      boost += config.partialSymbolMatch;
    }
  }

  // Symbol type matching
  if (parsedQuery.symbolTypes.length > 0) {
    for (const type of parsedQuery.symbolTypes) {
      if (symbolType.includes(type.toLowerCase())) {
        boost += config.symbolTypeMatch;
        break;
      }
    }
  }

  // Definition intent boost
  if (parsedQuery.intent === 'definition') {
    // Boost definition-like symbol types
    if (
      symbolType.includes('definition') ||
      symbolType.includes('declaration') ||
      symbolType.includes('class') ||
      symbolType.includes('function') ||
      symbolType.includes('method')
    ) {
      boost += config.definitionIntentMatch;
    }
  }

  // Symbol importance ranking boosts
  // Boost top-level symbol kinds (class, interface, type, struct, enum)
  if (isTopLevelSymbolKind(symbolType)) {
    boost += config.topLevelSymbolKind;
  }

  // Boost symbols in index files (entry points are more important)
  if (isIndexFile(result.payload.path)) {
    boost += config.indexFile;
  }

  // Boost exported symbols (when is_exported is available in payload)
  // This requires extending ChunkPayload to include is_exported field
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payloadWithExported = result.payload as any;
  if (payloadWithExported.is_exported === true) {
    boost += config.exportedSymbol;
  }

  return boost;
}

/**
 * Re-rank search results based on symbol boosting
 */
function reRankResults(
  results: SearchResult[],
  parsedQuery: ParsedQuery
): SearchResult[] {
  // Calculate boosted scores
  const boostedResults = results.map(result => {
    const boost = calculateBoost(result, parsedQuery);
    const boostedScore = Math.min(1, result.score + boost);
    return { ...result, score: boostedScore, _originalScore: result.score };
  });

  // Sort by boosted score (descending)
  boostedResults.sort((a, b) => b.score - a.score);

  return boostedResults;
}

/**
 * Query orchestrator
 */
export class QueryOrchestrator {
  private metadata: MetadataStorage;
  private vectors: VectorStorage;
  private embeddings: EmbeddingProvider;
  private config: QueryConfig;

  constructor(
    metadata: MetadataStorage,
    vectors: VectorStorage,
    embeddings: EmbeddingProvider,
    config: QueryConfig = DEFAULT_QUERY_CONFIG
  ) {
    this.metadata = metadata;
    this.vectors = vectors;
    this.embeddings = embeddings;
    this.config = config;
  }

  /**
   * Execute a semantic search query
   */
  async query(options: QueryOptions): Promise<QueryResult> {
    const { repoId, commitSha, query, language, pathPattern, cursor, contentType, includeAllContentTypes } = options;

    // Validate and apply limit
    const requestedLimit = options.limit ?? this.config.defaultLimit;

    if (requestedLimit <= 0) {
      throw new QueryError(
        'Result limit must be positive',
        QueryErrorCode.INVALID_PARAMS
      );
    }

    if (requestedLimit > this.config.maxLimit) {
      throw new QueryError(
        `Result limit ${requestedLimit} exceeds maximum allowed ${this.config.maxLimit}`,
        QueryErrorCode.LIMIT_EXCEEDED
      );
    }

    // Check if commit is indexed
    const isIndexed = this.metadata.isCommitIndexed(repoId, commitSha);

    if (!isIndexed) {
      return {
        success: false,
        isIndexed: false,
        results: [],
        totalCount: 0,
        nextCursor: null,
        error: `Commit ${commitSha.slice(0, 8)} is not indexed. Run 'sourcerack index' to index this commit.`,
      };
    }

    try {
      // Parse query to extract intent and boost terms
      const parsedQuery = parseQuery(query);

      // Generate query embedding (use cleaned query for better embedding)
      const queryVector = await this.embeddings.embed(parsedQuery.forEmbedding);

      // Build search filters
      const filters: SearchFilters = {
        repo_id: repoId,
        commit: commitSha,
      };
      if (language) {
        filters.language = language;
      }
      if (pathPattern) {
        filters.pathPattern = pathPattern;
      }

      // Content type filtering
      if (includeAllContentTypes) {
        filters.includeAllContentTypes = true;
      } else if (contentType) {
        filters.contentType = contentType;
      } else {
        // Use parsed query's content types (defaults to 'code')
        filters.contentType = parsedQuery.contentTypes;
      }

      // Execute search
      // Request more results than limit for re-ranking and pagination
      // We need extra results because re-ranking may change the order
      const searchLimit = Math.min(requestedLimit * 3, this.config.maxLimit);
      let results = await this.vectors.search(queryVector, filters, searchLimit);

      // Apply symbol boosting and re-rank
      results = reRankResults(results, parsedQuery);

      // Apply cursor-based filtering for pagination
      if (cursor) {
        results = this.applyCursor(results, cursor);
      }

      // Determine if there are more pages
      const hasMore = results.length > requestedLimit;
      if (hasMore) {
        results = results.slice(0, requestedLimit);
      }

      // Calculate next cursor
      let nextCursor: PaginationCursor | null = null;
      if (hasMore && results.length > 0) {
        const lastResult = results[results.length - 1];
        if (lastResult) {
          nextCursor = {
            lastScore: lastResult.score,
            lastId: lastResult.id,
          };
        }
      }

      // Format results
      const formattedResults = results.map((r) => this.formatResult(r));

      // Get total count for pagination UI
      // Note: This is an approximation based on search results
      // For exact count, would need a separate count query
      const totalCount = await this.estimateTotalCount(
        queryVector,
        filters,
        results.length,
        hasMore
      );

      return {
        success: true,
        isIndexed: true,
        results: formattedResults,
        totalCount,
        nextCursor,
      };
    } catch (error) {
      if (error instanceof QueryError) {
        throw error;
      }

      throw new QueryError(
        `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        QueryErrorCode.SEARCH_FAILED
      );
    }
  }

  /**
   * Apply cursor-based filtering to results
   * Filters out results that should appear before the cursor position
   */
  private applyCursor(
    results: SearchResult[],
    cursor: PaginationCursor
  ): SearchResult[] {
    // Find the position after the cursor
    let foundCursor = false;
    const filteredResults: SearchResult[] = [];

    for (const result of results) {
      if (foundCursor) {
        filteredResults.push(result);
        continue;
      }

      // Check if this is the cursor position
      if (result.score === cursor.lastScore && result.id === cursor.lastId) {
        foundCursor = true;
        continue;
      }

      // If score is lower than cursor, we're past the cursor position
      if (result.score < cursor.lastScore) {
        foundCursor = true;
        filteredResults.push(result);
      }
    }

    return filteredResults;
  }

  /**
   * Estimate total count of matching results
   * Uses a larger search to get an approximation
   */
  private async estimateTotalCount(
    queryVector: EmbeddingVector,
    filters: SearchFilters,
    currentCount: number,
    hasMore: boolean
  ): Promise<number> {
    if (!hasMore) {
      return currentCount;
    }

    // Do a larger search to estimate total
    // This is a trade-off between accuracy and performance
    try {
      const largerResults = await this.vectors.search(
        queryVector,
        filters,
        this.config.maxLimit
      );
      return largerResults.length;
    } catch {
      // If estimation fails, return current count
      return currentCount;
    }
  }

  /**
   * Format a search result to the output schema
   */
  private formatResult(result: SearchResult): SearchResultItem {
    return {
      id: result.id,
      score: result.score,
      path: result.payload.path,
      symbol: result.payload.symbol,
      symbolType: result.payload.symbol_type,
      language: result.payload.language,
      startLine: result.payload.start_line,
      endLine: result.payload.end_line,
      content: result.payload.content,
    };
  }

  /**
   * Check if a commit is indexed
   */
  isCommitIndexed(repoId: string, commitSha: string): boolean {
    return this.metadata.isCommitIndexed(repoId, commitSha);
  }

  /**
   * Get the indexing status of a commit
   */
  getIndexingStatus(
    repoId: string,
    commitSha: string
  ): 'indexed' | 'in_progress' | 'not_indexed' {
    const commit = this.metadata.getIndexedCommit(repoId, commitSha);

    if (!commit) {
      return 'not_indexed';
    }

    if (commit.status === 'complete') {
      return 'indexed';
    }

    if (commit.status === 'in_progress') {
      return 'in_progress';
    }

    return 'not_indexed';
  }
}

/**
 * Create a query orchestrator
 */
export function createQueryOrchestrator(
  metadata: MetadataStorage,
  vectors: VectorStorage,
  embeddings: EmbeddingProvider,
  config?: QueryConfig
): QueryOrchestrator {
  return new QueryOrchestrator(metadata, vectors, embeddings, config);
}
