/**
 * Hybrid Search for SourceRack
 *
 * Combines Vector Search (semantic) with SQI Search (structural)
 * using Reciprocal Rank Fusion (RRF) for optimal results.
 *
 * This gives us the best of both worlds:
 * - Vector search finds semantically similar code (intent-based)
 * - SQI search finds structurally matching symbols (name-based)
 *
 * RRF formula: score(d) = Σ 1/(k + rank_i(d))
 * where k is typically 60 and rank_i is the position in each list
 */

import type { SearchResult } from '../storage/vector-storage.js';
import type { SymbolRecord } from '../sqi/types.js';

/**
 * Hybrid search result that can come from either source
 */
export interface HybridSearchResult {
  /** Unique identifier (chunk ID or symbol ID) */
  id: string;
  /** Combined RRF score */
  score: number;
  /** File path */
  filePath: string;
  /** Start line */
  startLine: number;
  /** End line */
  endLine: number;
  /** Content snippet (from vector) or symbol name (from SQI) */
  content?: string;
  /** Symbol name if from SQI */
  symbolName?: string;
  /** Symbol kind if from SQI */
  symbolKind?: string;
  /** Source of result */
  source: 'vector' | 'sqi' | 'both';
  /** Original vector score (if available) */
  vectorScore?: number;
  /** Original SQI score (if available) */
  sqiScore?: number;
}

/**
 * Configuration for hybrid search
 */
export interface HybridSearchConfig {
  /** RRF constant k (default: 60) */
  k?: number;
  /** Weight for vector results (default: 1.0) */
  vectorWeight?: number;
  /** Weight for SQI results (default: 1.0) */
  sqiWeight?: number;
  /** Enable structural boosting (default: true) */
  enableBoosting?: boolean;
}

/**
 * Boost rules for structural boosting
 */
export interface BoostRule {
  /** Pattern to match against file path (substring match) */
  pattern: string;
  /** Multiplicative factor (< 1 = penalty, > 1 = bonus) */
  factor: number;
}

/**
 * Boost configuration
 */
export interface BoostConfig {
  /** Patterns that reduce score */
  penalties: BoostRule[];
  /** Patterns that increase score */
  bonuses: BoostRule[];
}

/**
 * Default boost configuration
 * Penalizes test files, boosts source files
 */
export const DEFAULT_BOOST_CONFIG: BoostConfig = {
  penalties: [
    // Test files by name pattern
    { pattern: '_test.', factor: 0.5 },
    { pattern: '.test.', factor: 0.5 },
    { pattern: '.spec.', factor: 0.5 },
    { pattern: '_spec.', factor: 0.5 },
    // Test directories - both inner and root-level
    { pattern: '/test/', factor: 0.5 },
    { pattern: '/tests/', factor: 0.5 },
    { pattern: 'tests/', factor: 0.5 },     // Root-level tests/
    { pattern: '/__tests__/', factor: 0.5 },
    // Mock/fixture files
    { pattern: '/mock/', factor: 0.4 },
    { pattern: '/mocks/', factor: 0.4 },
    { pattern: '/fixture/', factor: 0.4 },
    { pattern: '/fixtures/', factor: 0.4 },
    { pattern: '.mock.', factor: 0.4 },
    // Generated/minified files
    { pattern: '.min.', factor: 0.3 },
    { pattern: '.generated.', factor: 0.4 },
    { pattern: '/generated/', factor: 0.4 },
    { pattern: '/dist/', factor: 0.4 },
    { pattern: '/build/', factor: 0.4 },
  ],
  bonuses: [
    { pattern: '/src/', factor: 1.2 },      // Increased from 1.1
    { pattern: '/lib/', factor: 1.15 },
    { pattern: '/app/', factor: 1.15 },
    { pattern: '/core/', factor: 1.2 },     // Increased from 1.15
    { pattern: '/internal/', factor: 1.1 },
    { pattern: '/pkg/', factor: 1.1 },      // Go convention
    { pattern: '/cmd/', factor: 1.1 },      // Go convention
  ],
};

/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Combines multiple ranked lists into a single list using the formula:
 * RRF(d) = Σ 1/(k + rank_i(d))
 *
 * @param k - RRF constant (typically 60)
 * @param limit - Maximum results to return
 * @param lists - Ranked result lists with their weights
 * @returns Merged and re-ranked results
 */
export function reciprocalRankFusion(
  k: number,
  limit: number,
  ...lists: Array<{ results: HybridSearchResult[]; weight: number }>
): HybridSearchResult[] {
  const scores = new Map<string, number>();
  const resultMap = new Map<string, HybridSearchResult>();

  for (const { results, weight } of lists) {
    for (let rank = 0; rank < results.length; rank++) {
      const result = results[rank];
      if (!result) continue;

      const rrfScore = weight / (k + rank + 1);
      const existingScore = scores.get(result.id) ?? 0;
      scores.set(result.id, existingScore + rrfScore);

      // Merge result info if already exists
      const existing = resultMap.get(result.id);
      if (existing) {
        // Mark as coming from both sources
        existing.source = 'both';
        // Keep the better scores from each source
        if (result.vectorScore !== undefined && existing.vectorScore === undefined) {
          existing.vectorScore = result.vectorScore;
        }
        if (result.sqiScore !== undefined) {
          existing.sqiScore = result.sqiScore;
        }
        // Prefer content from vector results (more context)
        if (result.content && !existing.content) {
          existing.content = result.content;
        }
        // Keep symbol info from SQI
        if (result.symbolName && !existing.symbolName) {
          existing.symbolName = result.symbolName;
          if (result.symbolKind) {
            existing.symbolKind = result.symbolKind;
          }
        }
      } else {
        resultMap.set(result.id, { ...result });
      }
    }
  }

  // Build final results with combined scores
  const merged: HybridSearchResult[] = [];
  for (const [id, score] of scores.entries()) {
    const result = resultMap.get(id);
    if (result) {
      merged.push({ ...result, score });
    }
  }

  // Sort by combined score (descending)
  merged.sort((a, b) => b.score - a.score);

  // Return top results
  return merged.slice(0, limit);
}

/**
 * Apply structural boosting to results based on file path patterns
 *
 * @param results - Search results to boost
 * @param config - Boost configuration
 * @returns Results with adjusted scores, re-sorted
 */
export function applyStructuralBoosting(
  results: HybridSearchResult[],
  config: BoostConfig = DEFAULT_BOOST_CONFIG
): HybridSearchResult[] {
  // Apply boost factors
  const boosted = results.map((result) => {
    let factor = 1.0;

    // Apply penalties
    for (const rule of config.penalties) {
      if (result.filePath.includes(rule.pattern)) {
        factor *= rule.factor;
      }
    }

    // Apply bonuses
    for (const rule of config.bonuses) {
      if (result.filePath.includes(rule.pattern)) {
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
 * Convert vector search results to hybrid format
 */
export function vectorResultsToHybrid(
  results: SearchResult[]
): HybridSearchResult[] {
  return results.map((r) => ({
    id: r.id,
    score: r.score,
    filePath: r.payload.path,
    startLine: r.payload.start_line,
    endLine: r.payload.end_line,
    content: r.payload.content,
    source: 'vector' as const,
    vectorScore: r.score,
  }));
}

/**
 * Convert SQI symbol results to hybrid format
 * Uses fuzzy similarity score if available, otherwise position-based scoring
 */
export function sqiResultsToHybrid(
  symbols: Array<{ symbol: SymbolRecord; similarity?: number }>,
  defaultScore = 1.0
): HybridSearchResult[] {
  return symbols.map((s, index) => ({
    // Use composite ID to avoid collision with chunk IDs
    id: `sqi:${s.symbol.id}`,
    // Use similarity if available, otherwise decay by position
    score: s.similarity ?? defaultScore * Math.pow(0.95, index),
    filePath: s.symbol.file_path,
    startLine: s.symbol.start_line,
    endLine: s.symbol.end_line,
    symbolName: s.symbol.name,
    symbolKind: s.symbol.symbol_kind,
    source: 'sqi' as const,
    sqiScore: s.similarity ?? defaultScore * Math.pow(0.95, index),
  }));
}

/**
 * Extract search terms from a query for SQI symbol matching
 * Removes common words and extracts potential symbol names
 */
export function extractSearchTerms(query: string): string[] {
  // Common words to filter out
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once',
    'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
    'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but',
    'if', 'or', 'because', 'until', 'while', 'although', 'though',
    'find', 'search', 'look', 'show', 'get', 'what', 'which', 'who',
    'function', 'class', 'method', 'variable', 'const', 'let', 'var',
    'def', 'async', 'await', 'return', 'import', 'export', 'from',
    'code', 'file', 'files', 'logic', 'implementation', 'handle',
    'handler', 'handles', 'handling',
  ]);

  // Split query into words
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stopWords.has(w));

  // Also extract camelCase/PascalCase parts
  const camelParts: string[] = [];
  for (const word of words) {
    // Split camelCase: "getUserData" -> ["get", "user", "data"]
    const parts = word
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(' ')
      .filter((p) => p.length >= 2 && !stopWords.has(p));
    camelParts.push(...parts);
  }

  // Deduplicate
  return [...new Set([...words, ...camelParts])];
}
