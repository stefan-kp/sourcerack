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
import {
  extractSearchTerms,
  DEFAULT_BOOST_CONFIG as DEFAULT_STRUCTURAL_BOOST_CONFIG,
  type BoostConfig as StructuralBoostConfig,
} from '../search/hybrid.js';
import type { SQIStorage } from '../sqi/storage.js';

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
  /** Enable hybrid search (vector + SQI with RRF fusion) */
  hybrid?: boolean;
  /** Enable structural boosting (penalize test files, boost source files) */
  boost?: boolean;
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
  private sqi: SQIStorage | null;
  private structuralBoostConfig: StructuralBoostConfig;

  constructor(
    metadata: MetadataStorage,
    vectors: VectorStorage,
    embeddings: EmbeddingProvider,
    config: QueryConfig = DEFAULT_QUERY_CONFIG,
    sqi: SQIStorage | null = null,
    structuralBoostConfig: StructuralBoostConfig = DEFAULT_STRUCTURAL_BOOST_CONFIG
  ) {
    this.metadata = metadata;
    this.vectors = vectors;
    this.embeddings = embeddings;
    this.config = config;
    this.sqi = sqi;
    this.structuralBoostConfig = structuralBoostConfig;
  }

  /**
   * Execute a semantic search query
   */
  async query(options: QueryOptions): Promise<QueryResult> {
    const { repoId, commitSha, query, language, pathPattern, cursor, contentType, includeAllContentTypes, hybrid, boost } = options;

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
      let results: SearchResult[];

      // Hybrid search: combine vector search with SQI symbol search
      if (hybrid && this.sqi) {
        // For hybrid search, apply boost BEFORE fusion so it affects ranking
        results = await this.executeHybridSearch(
          query,
          queryVector,
          filters,
          searchLimit,
          repoId,
          commitSha,
          boost
        );
      } else {
        // Vector-only search
        results = await this.vectors.search(queryVector, filters, searchLimit);

        // Apply structural boosting if enabled (for non-hybrid)
        if (boost) {
          results = this.applyStructuralBoost(results);
        }
      }

      // Apply symbol boosting and re-rank
      // Skip this when structural boost is enabled, as symbol name matching
      // can elevate test utilities (e.g., createMockVector) over real implementations
      if (!boost) {
        results = reRankResults(results, parsedQuery);
      }

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
   * Calculate boost factor for a file path
   */
  private getBoostFactor(filePath: string): number {
    let factor = 1.0;

    // Apply penalties
    for (const rule of this.structuralBoostConfig.penalties) {
      if (filePath.includes(rule.pattern)) {
        factor *= rule.factor;
      }
    }

    // Apply bonuses
    for (const rule of this.structuralBoostConfig.bonuses) {
      if (filePath.includes(rule.pattern)) {
        factor *= rule.factor;
      }
    }

    return factor;
  }

  /**
   * Apply structural boosting to search results
   * Penalizes test files, boosts source files
   */
  private applyStructuralBoost(results: SearchResult[]): SearchResult[] {
    const boosted = results.map((result) => {
      let factor = 1.0;
      const filePath = result.payload.path;

      // Apply penalties
      for (const rule of this.structuralBoostConfig.penalties) {
        if (filePath.includes(rule.pattern)) {
          factor *= rule.factor;
        }
      }

      // Apply bonuses
      for (const rule of this.structuralBoostConfig.bonuses) {
        if (filePath.includes(rule.pattern)) {
          factor *= rule.factor;
        }
      }

      return {
        ...result,
        score: result.score * factor,
      };
    });

    // Re-sort by adjusted score
    boosted.sort((a, b) => b.score - a.score);
    return boosted;
  }

  /**
   * Execute hybrid search combining vector and SQI results with RRF
   *
   * Uses Reciprocal Rank Fusion to combine:
   * - Vector search results (semantic similarity)
   * - SQI symbol matches (structural, name-based)
   */
  private async executeHybridSearch(
    query: string,
    queryVector: EmbeddingVector,
    filters: SearchFilters,
    limit: number,
    repoId: string,
    commitSha: string,
    applyBoost = false
  ): Promise<SearchResult[]> {
    // Get commit ID for SQI queries
    const commitRecord = this.metadata.getIndexedCommit(repoId, commitSha);
    if (!commitRecord) {
      // Fall back to vector-only search
      let results = await this.vectors.search(queryVector, filters, limit);
      if (applyBoost) {
        results = this.applyStructuralBoost(results);
      }
      return results;
    }

    // Execute vector search (async) and SQI search (sync)
    let vectorResults = await this.vectors.search(queryVector, filters, limit);
    const sqiResults = this.executeSqiSearch(query, commitRecord.id, limit);

    // Apply structural boosting to vector results BEFORE fusion
    // This ensures test files are ranked lower before RRF combines the lists
    if (applyBoost) {
      vectorResults = this.applyStructuralBoost(vectorResults);
    }

    // If no SQI results, return vector results directly (already boosted)
    if (sqiResults.length === 0) {
      return vectorResults;
    }

    // Build maps for vector results:
    // 1. By exact file+line for direct matches
    // 2. By file for finding overlapping ranges
    const vectorByKey = new Map<string, SearchResult>();
    const vectorByFile = new Map<string, SearchResult[]>();
    for (const result of vectorResults) {
      const key = `${result.payload.path}:${result.payload.start_line}`;
      vectorByKey.set(key, result);

      // Also index by file for range lookups
      const fileResults = vectorByFile.get(result.payload.path) ?? [];
      fileResults.push(result);
      vectorByFile.set(result.payload.path, fileResults);
    }

    // Helper to find a vector result that overlaps with a given line range
    const findOverlappingVectorResult = (
      filePath: string,
      startLine: number,
      endLine: number
    ): SearchResult | undefined => {
      const fileResults = vectorByFile.get(filePath);
      if (!fileResults) return undefined;

      // Find a result whose range overlaps with the SQI symbol
      return fileResults.find((r) => {
        const vStart = r.payload.start_line;
        const vEnd = r.payload.end_line;
        // Check for overlap: ranges overlap if one starts before the other ends
        return vStart <= endLine && vEnd >= startLine;
      });
    };

    // Apply RRF scoring with weights
    // Vector search is semantic (understands intent), SQI is structural (matches names)
    // We weight vector higher (2.0) because:
    // 1. Vector understands "error handling" means handleError(), not a property named "error"
    // 2. SQI is good for boosting results that also match symbol names, but shouldn't dominate
    const k = 60; // Standard RRF constant
    const vectorWeight = 2.0; // Weight for vector (semantic) results
    const sqiWeight = 1.0;    // Weight for SQI (structural) results
    const scores = new Map<string, { score: number; result: SearchResult }>();

    // Add vector results with weighted RRF scores
    for (let rank = 0; rank < vectorResults.length; rank++) {
      const result = vectorResults[rank];
      if (!result) continue;
      const key = `${result.payload.path}:${result.payload.start_line}`;
      const rrfScore = vectorWeight / (k + rank + 1);
      scores.set(key, { score: rrfScore, result });
    }

    // Apply structural boosting to SQI results if enabled
    // We need to boost SQI results too, otherwise test files with matching symbol names dominate
    let rankedSqiResults = sqiResults;
    if (applyBoost) {
      // Sort SQI results by boosted similarity score
      // This combines the similarity with the path-based boost factor
      rankedSqiResults = [...sqiResults]
        .map((r) => ({
          ...r,
          boostedSimilarity: r.similarity * this.getBoostFactor(r.symbol.file_path),
        }))
        .sort((a, b) => b.boostedSimilarity - a.boostedSimilarity);
    }

    // Add SQI results with weighted RRF scores, merging with vector results if overlap
    for (let rank = 0; rank < rankedSqiResults.length; rank++) {
      const sqiResult = rankedSqiResults[rank];
      if (!sqiResult) continue;

      // When boosting is enabled, skip SQI results from test files entirely
      // This prevents test utilities (e.g., createMockVector) from dominating
      // when their names happen to match search terms
      const boostFactor = this.getBoostFactor(sqiResult.symbol.file_path);
      if (applyBoost && boostFactor < 0.6) {
        // Skip results from penalized paths (tests, mocks, fixtures)
        continue;
      }

      const key = `${sqiResult.symbol.file_path}:${sqiResult.symbol.start_line}`;
      const rrfScore = sqiWeight / (k + rank + 1);

      const existing = scores.get(key);
      if (existing) {
        // Merge scores - this symbol was found by both methods
        existing.score += rrfScore;
      } else {
        // Try to find a vector result for this file:
        // 1. First check exact line match
        // 2. Then check for overlapping ranges (symbol might span multiple chunks)
        let vectorResult = vectorByKey.get(key);
        if (!vectorResult) {
          vectorResult = findOverlappingVectorResult(
            sqiResult.symbol.file_path,
            sqiResult.symbol.start_line,
            sqiResult.symbol.end_line
          );
        }

        if (vectorResult) {
          // Use the vector result (has real content) but update symbol info from SQI
          scores.set(key, {
            score: rrfScore,
            result: {
              ...vectorResult,
              payload: {
                ...vectorResult.payload,
                symbol: sqiResult.symbol.name,
                symbol_type: sqiResult.symbol.symbol_kind,
              },
            },
          });
        } else {
          // Create a synthetic result from SQI data (no vector content available)
          scores.set(key, {
            score: rrfScore,
            result: {
              id: `sqi:${sqiResult.symbol.id}`,
              score: sqiResult.similarity ?? 0.5,
              payload: {
                repo_id: repoId,
                commits: [commitSha],
                branches: [],
                path: sqiResult.symbol.file_path,
                symbol: sqiResult.symbol.name,
                symbol_type: sqiResult.symbol.symbol_kind,
                language: '',
                content_type: 'code',
                start_line: sqiResult.symbol.start_line,
                end_line: sqiResult.symbol.end_line,
                content: `// Symbol: ${sqiResult.symbol.qualified_name}`,
              },
            },
          });
        }
      }
    }

    // Sort by combined RRF score and return
    const merged = Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ score, result }) => ({ ...result, score }));

    return merged;
  }

  /**
   * Execute SQI symbol search based on query terms
   * Returns symbols matching the query terms with similarity scores
   *
   * Only searches for "meaningful" symbol types (functions, classes, methods, etc.)
   * Excludes properties, variables, and other low-level symbols that don't
   * represent the actual code implementation.
   */
  private executeSqiSearch(
    query: string,
    commitId: number,
    limit: number
  ): Array<{ symbol: { id: number; name: string; qualified_name: string; symbol_kind: string; file_path: string; start_line: number; end_line: number }; similarity: number }> {
    if (!this.sqi) {
      return [];
    }

    // Extract search terms from the query
    const terms = extractSearchTerms(query);
    if (terms.length === 0) {
      return [];
    }

    // Symbol kinds that represent meaningful code blocks (not properties/variables)
    const MEANINGFUL_SYMBOL_KINDS = new Set([
      'function',
      'method',
      'class',
      'interface',
      'type',
      'enum',
      'module',
      'namespace',
      'struct',
      'trait',
      'impl',
      // Language-specific
      'def',           // Python
      'func',          // Go
      'fn',            // Rust
      'sub',           // Perl/VB
      'proc',          // Pascal
      'constructor',
      'destructor',
      'getter',
      'setter',
    ]);

    // Filter function to check if symbol kind is meaningful
    const isMeaningfulSymbol = (kind: string): boolean => {
      const normalizedKind = kind.toLowerCase();
      return MEANINGFUL_SYMBOL_KINDS.has(normalizedKind);
    };

    // Search for each term and combine results
    type SqiSearchResult = { symbol: { id: number; name: string; qualified_name: string; symbol_kind: string; file_path: string; start_line: number; end_line: number }; similarity: number };
    const allResults: SqiSearchResult[] = [];
    const seenIds = new Set<number>();

    for (const term of terms) {
      // Use fuzzy search for better recall
      const fuzzyResults = this.sqi.findSymbolsFuzzy(commitId, term, {
        minSimilarity: 0.4, // Increased from 0.3 for better precision
        limit: Math.ceil(limit * 2 / terms.length), // Fetch more to filter
      });

      for (const result of fuzzyResults) {
        // Skip non-meaningful symbol types (properties, variables, etc.)
        if (!isMeaningfulSymbol(result.symbol.symbol_kind)) {
          continue;
        }
        if (!seenIds.has(result.symbol.id)) {
          seenIds.add(result.symbol.id);
          allResults.push({
            symbol: {
              id: result.symbol.id,
              name: result.symbol.name,
              qualified_name: result.symbol.qualified_name,
              symbol_kind: result.symbol.symbol_kind,
              file_path: result.symbol.file_path,
              start_line: result.symbol.start_line,
              end_line: result.symbol.end_line,
            },
            similarity: result.similarity,
          });
        }
      }

      // Also try exact pattern match for substrings
      const pattern = `%${term}%`;
      const patternResults = this.sqi.findSymbolsByPattern(commitId, pattern);
      for (const symbol of patternResults.slice(0, Math.ceil(limit * 2 / terms.length))) {
        // Skip non-meaningful symbol types
        if (!isMeaningfulSymbol(symbol.symbol_kind)) {
          continue;
        }
        if (!seenIds.has(symbol.id)) {
          seenIds.add(symbol.id);
          allResults.push({
            symbol: {
              id: symbol.id,
              name: symbol.name,
              qualified_name: symbol.qualified_name,
              symbol_kind: symbol.symbol_kind,
              file_path: symbol.file_path,
              start_line: symbol.start_line,
              end_line: symbol.end_line,
            },
            similarity: 0.5, // Default similarity for pattern matches
          });
        }
      }
    }

    // Sort by similarity and limit
    allResults.sort((a, b) => b.similarity - a.similarity);
    return allResults.slice(0, limit);
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
  config?: QueryConfig,
  sqi?: SQIStorage | null,
  structuralBoostConfig?: StructuralBoostConfig
): QueryOrchestrator {
  return new QueryOrchestrator(metadata, vectors, embeddings, config, sqi ?? null, structuralBoostConfig);
}
