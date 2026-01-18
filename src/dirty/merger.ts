/**
 * Merge dirty symbols with database symbols
 *
 * Handles the logic of combining on-the-fly parsed symbols with
 * persisted database symbols, giving priority to dirty versions.
 */

import { ExtractedSymbol, ExtractedUsage, SymbolRecord, UsageRecord } from '../sqi/types.js';
import { MergeOptions } from './types.js';

/**
 * Merge dirty symbols with database symbols
 *
 * - Symbols from dirty files replace symbols from the same file in the DB
 * - Symbols from deleted files are excluded
 * - All other DB symbols are preserved
 */
export function mergeSymbols(
  dbSymbols: SymbolRecord[],
  dirtySymbols: ExtractedSymbol[],
  options: MergeOptions
): ExtractedSymbol[] {
  const { dirtyFilePaths, deletedFilePaths } = options;
  const merged: ExtractedSymbol[] = [];

  // Add DB symbols that are NOT from dirty or deleted files
  for (const symbol of dbSymbols) {
    if (!dirtyFilePaths.has(symbol.file_path) && !deletedFilePaths.has(symbol.file_path)) {
      // Convert SymbolRecord to ExtractedSymbol
      merged.push({
        name: symbol.name,
        qualified_name: symbol.qualified_name,
        symbol_kind: symbol.symbol_kind,
        file_path: symbol.file_path,
        start_line: symbol.start_line,
        end_line: symbol.end_line,
        visibility: symbol.visibility ?? undefined,
        is_async: symbol.is_async,
        is_static: symbol.is_static,
        is_exported: symbol.is_exported,
        return_type: symbol.return_type ?? undefined,
        content_hash: symbol.content_hash,
      });
    }
  }

  // Add all dirty symbols
  merged.push(...dirtySymbols);

  return merged;
}

/**
 * Merge dirty usages with database usages
 *
 * Same logic as mergeSymbols - dirty files replace DB data
 * Note: DB usages lose the enclosing_symbol_qualified_name as it's stored as an ID
 */
export function mergeUsages(
  dbUsages: UsageRecord[],
  dirtyUsages: ExtractedUsage[],
  options: MergeOptions
): ExtractedUsage[] {
  const { dirtyFilePaths, deletedFilePaths } = options;
  const merged: ExtractedUsage[] = [];

  // Add DB usages that are NOT from dirty or deleted files
  for (const usage of dbUsages) {
    if (!dirtyFilePaths.has(usage.file_path) && !deletedFilePaths.has(usage.file_path)) {
      // Convert UsageRecord to ExtractedUsage
      // Note: enclosing_symbol_qualified_name is not available from UsageRecord
      // (it's stored as enclosing_symbol_id which needs separate lookup)
      merged.push({
        symbol_name: usage.symbol_name,
        file_path: usage.file_path,
        line: usage.line,
        column: usage.column,
        usage_type: usage.usage_type,
      });
    }
  }

  // Add all dirty usages
  merged.push(...dirtyUsages);

  return merged;
}

/**
 * Filter symbols to exclude those from deleted files
 */
export function filterDeletedSymbols<T extends { file_path: string }>(
  symbols: T[],
  deletedFilePaths: Set<string>
): T[] {
  return symbols.filter((s) => !deletedFilePaths.has(s.file_path));
}

/**
 * Filter usages to exclude those from deleted files
 */
export function filterDeletedUsages<T extends { file_path: string }>(
  usages: T[],
  deletedFilePaths: Set<string>
): T[] {
  return usages.filter((u) => !deletedFilePaths.has(u.file_path));
}
