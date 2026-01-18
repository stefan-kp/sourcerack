/**
 * Usage-to-Definition Linker for SQI
 *
 * Links usage records to their corresponding symbol definitions
 * and enclosing symbols after extraction is complete.
 */

import { SQIStorage } from '../storage.js';
import { SymbolRecord, UsageRecord } from '../types.js';

/**
 * Options for linking usages
 */
export interface LinkingOptions {
  /** Link to definitions */
  linkDefinitions?: boolean;
  /** Link to enclosing symbols */
  linkEnclosing?: boolean;
}

/**
 * Result of linking operation
 */
export interface LinkingResult {
  /** Number of usages linked to definitions */
  definitionsLinked: number;
  /** Number of usages linked to enclosing symbols */
  enclosingLinked: number;
  /** Number of usages that could not be linked */
  unlinked: number;
}

/**
 * Usage-to-Definition Linker
 *
 * Performs post-extraction linking of usages to their definitions.
 * This is a separate pass because all symbols need to be extracted first.
 */
export class UsageLinker {
  private sqi: SQIStorage;

  constructor(sqi: SQIStorage) {
    this.sqi = sqi;
  }

  /**
   * Link all usages for a commit
   */
  linkCommit(
    commitId: number,
    options: LinkingOptions = { linkDefinitions: true, linkEnclosing: true }
  ): LinkingResult {
    let definitionsLinked = 0;
    let enclosingLinked = 0;
    let unlinked = 0;

    // Build symbol lookup maps
    const symbolsByName = this.buildSymbolNameMap(commitId);
    const symbolsByQualifiedName = this.buildSymbolQualifiedNameMap(commitId);
    const symbolsByLocation = this.buildSymbolLocationMap(commitId);

    // Get all usages for this commit
    const usages = this.getAllUsagesForCommit(commitId);

    for (const usage of usages) {
      let linkedDefinition = false;
      
      // Link to definition
      if (options.linkDefinitions) {
        const definition = this.findDefinitionForUsage(
          usage,
          symbolsByName,
          symbolsByQualifiedName
        );
        if (definition) {
          this.sqi.linkUsageToDefinition(usage.id, definition.id);
          definitionsLinked++;
          linkedDefinition = true;
        }
      }

      // Link to enclosing symbol
      if (options.linkEnclosing) {
        const enclosing = this.findEnclosingSymbol(usage, symbolsByLocation);
        if (enclosing) {
          this.sqi.linkUsageToEnclosing(usage.id, enclosing.id);
          enclosingLinked++;
        }
      }

      if (!linkedDefinition && options.linkDefinitions) {
        unlinked++;
      }
    }

    return {
      definitionsLinked,
      enclosingLinked,
      unlinked,
    };
  }

  /**
   * Link usages for a specific file
   */
  linkFile(
    commitId: number,
    filePath: string,
    options: LinkingOptions = { linkDefinitions: true, linkEnclosing: true }
  ): LinkingResult {
    let definitionsLinked = 0;
    let enclosingLinked = 0;
    let unlinked = 0;

    // Build symbol lookup maps (for entire commit, definitions may be in other files)
    const symbolsByName = this.buildSymbolNameMap(commitId);
    const symbolsByQualifiedName = this.buildSymbolQualifiedNameMap(commitId);
    const symbolsByLocation = this.buildSymbolLocationMap(commitId, filePath);

    // Get usages for this file
    const usages = this.sqi.getUsagesInFile(commitId, filePath);

    for (const usage of usages) {
      let linkedDefinition = false;
      
      // Link to definition
      if (options.linkDefinitions) {
        const definition = this.findDefinitionForUsage(
          usage,
          symbolsByName,
          symbolsByQualifiedName
        );
        if (definition) {
          this.sqi.linkUsageToDefinition(usage.id, definition.id);
          definitionsLinked++;
          linkedDefinition = true;
        }
      }

      // Link to enclosing symbol
      if (options.linkEnclosing) {
        const enclosing = this.findEnclosingSymbol(usage, symbolsByLocation);
        if (enclosing) {
          this.sqi.linkUsageToEnclosing(usage.id, enclosing.id);
          enclosingLinked++;
        }
      }

      if (!linkedDefinition && options.linkDefinitions) {
        unlinked++;
      }
    }

    return {
      definitionsLinked,
      enclosingLinked,
      unlinked,
    };
  }

  // ==================== Private Methods ====================

  /**
   * Build symbol lookup by name
   */
  private buildSymbolNameMap(commitId: number): Map<string, SymbolRecord[]> {
    const map = new Map<string, SymbolRecord[]>();

    // Get all symbols for commit
    // Note: This could be optimized with a direct query
    const stats = this.sqi.getCommitStats(commitId);
    if (stats.symbols === 0) return map;

    // Use pattern search to get all symbols
    const allSymbols = this.sqi.findSymbolsByPattern(commitId, '%');

    for (const symbol of allSymbols) {
      const existing = map.get(symbol.name) ?? [];
      existing.push(symbol);
      map.set(symbol.name, existing);
    }

    return map;
  }

  /**
   * Build symbol lookup by qualified name
   */
  private buildSymbolQualifiedNameMap(
    commitId: number
  ): Map<string, SymbolRecord> {
    const map = new Map<string, SymbolRecord>();

    // Get all symbols for commit
    const allSymbols = this.sqi.findSymbolsByPattern(commitId, '%');

    for (const symbol of allSymbols) {
      map.set(symbol.qualified_name, symbol);
    }

    return map;
  }

  /**
   * Build symbol location map for finding enclosing symbols
   * Maps: file_path -> array of symbols sorted by start_line
   */
  private buildSymbolLocationMap(
    commitId: number,
    filePath?: string
  ): Map<string, SymbolRecord[]> {
    const map = new Map<string, SymbolRecord[]>();

    // Get all symbols or symbols for specific file
    let symbols: SymbolRecord[];
    if (filePath) {
      symbols = this.sqi.getSymbolsInFile(commitId, filePath);
    } else {
      symbols = this.sqi.findSymbolsByPattern(commitId, '%');
    }

    // Group by file and sort by start line
    for (const symbol of symbols) {
      const existing = map.get(symbol.file_path) ?? [];
      existing.push(symbol);
      map.set(symbol.file_path, existing);
    }

    // Sort each file's symbols by start line descending
    // (so we can find the innermost enclosing symbol)
    for (const [, fileSymbols] of map) {
      fileSymbols.sort((a, b) => b.start_line - a.start_line);
    }

    return map;
  }

  /**
   * Get all usages for a commit
   */
  private getAllUsagesForCommit(commitId: number): UsageRecord[] {
    // Get usages from all files
    // This is a simplified approach - could be optimized with direct query
    const allUsages: UsageRecord[] = [];

    // Get all unique file paths with usages
    // For now, we'll use a direct query approach
    const symbolsByFile = this.buildSymbolLocationMap(commitId);

    for (const [filePath] of symbolsByFile) {
      const fileUsages = this.sqi.getUsagesInFile(commitId, filePath);
      allUsages.push(...fileUsages);
    }

    // Also get usages from files without symbols
    // This requires a different approach - for now we accept this limitation

    return allUsages;
  }

  /**
   * Find definition for a usage
   */
  private findDefinitionForUsage(
    usage: UsageRecord,
    symbolsByName: Map<string, SymbolRecord[]>,
    _symbolsByQualifiedName: Map<string, SymbolRecord>
  ): SymbolRecord | null {
    // First try exact name match
    const candidates = symbolsByName.get(usage.symbol_name);
    if (!candidates || candidates.length === 0) {
      return null;
    }

    // If only one candidate, use it
    if (candidates.length === 1) {
      return candidates[0]!;
    }

    // Multiple candidates - apply heuristics

    // 1. Prefer symbols in the same file
    const sameFile = candidates.filter((c) => c.file_path === usage.file_path);
    if (sameFile.length === 1) {
      return sameFile[0]!;
    }

    // 2. Prefer exported symbols
    const exported = candidates.filter((c) => c.is_exported);
    if (exported.length === 1) {
      return exported[0]!;
    }

    // 3. Prefer symbols defined before the usage (in same file)
    if (sameFile.length > 0) {
      const definedBefore = sameFile
        .filter((c) => c.start_line < usage.line)
        .sort((a, b) => b.start_line - a.start_line);
      if (definedBefore.length > 0) {
        return definedBefore[0]!;
      }
    }

    // 4. Return first candidate (could be enhanced with import analysis)
    return candidates[0]!;
  }

  /**
   * Find enclosing symbol for a usage
   */
  private findEnclosingSymbol(
    usage: UsageRecord,
    symbolsByLocation: Map<string, SymbolRecord[]>
  ): SymbolRecord | null {
    const fileSymbols = symbolsByLocation.get(usage.file_path);
    if (!fileSymbols || fileSymbols.length === 0) {
      return null;
    }

    // Find innermost symbol that contains this usage
    // Symbols are sorted by start_line descending
    for (const symbol of fileSymbols) {
      if (
        symbol.start_line <= usage.line &&
        symbol.end_line >= usage.line
      ) {
        return symbol;
      }
    }

    return null;
  }
}

/**
 * Create a usage linker
 */
export function createUsageLinker(sqi: SQIStorage): UsageLinker {
  return new UsageLinker(sqi);
}
