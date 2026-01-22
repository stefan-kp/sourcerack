/**
 * Structured Query Engine for SQI
 *
 * Provides high-level query operations on the Structured Query Index,
 * implementing find_definition, find_usages, find_hierarchy, and find_imports.
 */

import { GitAdapter } from '../git/adapter.js';
import { posix as path } from 'node:path';
import { MetadataStorage } from '../storage/metadata.js';
import { SQIStorage } from './storage.js';
import {
  SymbolKind,
  SymbolInfo,
  UsageInfo,
  UsageType,
  ImportInfo,
  ImportBindingInfo,
  ParameterInfo,
  FindDefinitionInput,
  FindDefinitionOutput,
  FindUsagesInput,
  FindUsagesOutput,
  FindHierarchyInput,
  FindHierarchyOutput,
  FindImportsInput,
  FindImportsOutput,
  FindImportersInput,
  FindImportersOutput,
  SymbolRecord,
  UsageRecord,
  FuzzyMatch,
  FuzzyUsageMatch,
  CodebaseSummaryInput,
  CodebaseSummaryOutput,
  LanguageStats,
  ModuleStats,
  HotspotInfo,
  EntryPointInfo,
  DependencyInfo,
  DependencyGraphInput,
  DependencyGraphOutput,
  DependencyEdge,
  GetSymbolContextInput,
  GetSymbolContextOutput,
  FindDeadCodeInput,
  FindDeadCodeOutput,
  DeadSymbolInfo,
  ChangeImpactInput,
  ChangeImpactOutput,
  ImpactInfo,
} from './types.js';

/**
 * Structured Query Engine
 *
 * Provides semantic code queries based on the SQI index.
 */
export class StructuredQueryEngine {
  private metadata: MetadataStorage;
  private sqi: SQIStorage;

  constructor(metadata: MetadataStorage) {
    this.metadata = metadata;
    this.sqi = metadata.getSQIStorage();
  }

  // ==================== Find Definition ====================

  /**
   * Find symbol definitions by name
   */
  async findDefinition(input: FindDefinitionInput): Promise<FindDefinitionOutput> {
    try {
      // Resolve commit and get commit ID
      const { commitId, error } = await this.resolveCommit(
        input.repo_path,
        input.commit
      );
      if (error || !commitId) {
        return { success: false, definitions: [], error };
      }

      // Use fuzzy search if requested
      if (input.fuzzy) {
        const fuzzyOptions: Parameters<typeof this.sqi.findSymbolsWithFuzzy>[2] = {
          minSimilarity: input.min_similarity ?? 0.3,
          fuzzyLimit: 10,
        };
        if (input.symbol_kind) {
          fuzzyOptions.kind = input.symbol_kind;
        }
        const result = this.sqi.findSymbolsWithFuzzy(commitId, input.symbol_name, fuzzyOptions);

        const definitions = result.exact.map((s) => this.symbolRecordToInfo(s));
        const fuzzy_matches: FuzzyMatch[] = result.fuzzy.map((f) => ({
          symbol: this.symbolRecordToInfo(f.symbol),
          similarity: f.similarity,
        }));

        return {
          success: true,
          definitions,
          fuzzy_matches,
        };
      }

      // Find symbols by exact name
      const symbols = this.sqi.findSymbolsByName(
        commitId,
        input.symbol_name,
        input.symbol_kind
      );

      // Map to SymbolInfo
      const definitions = symbols.map((s) => this.symbolRecordToInfo(s));

      return {
        success: true,
        definitions,
      };
    } catch (error) {
      return {
        success: false,
        definitions: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Find symbols by qualified name
   */
  async findByQualifiedName(
    repoPath: string,
    commit: string,
    qualifiedName: string
  ): Promise<FindDefinitionOutput> {
    try {
      const { commitId, error } = await this.resolveCommit(repoPath, commit);
      if (error || !commitId) {
        return { success: false, definitions: [], error };
      }

      const symbols = this.sqi.findSymbolsByQualifiedName(commitId, qualifiedName);
      const definitions = symbols.map((s) => this.symbolRecordToInfo(s));

      return { success: true, definitions };
    } catch (error) {
      return {
        success: false,
        definitions: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Find symbols matching a pattern
   */
  async findByPattern(
    repoPath: string,
    commit: string,
    pattern: string,
    kind?: SymbolKind
  ): Promise<FindDefinitionOutput> {
    try {
      const { commitId, error } = await this.resolveCommit(repoPath, commit);
      if (error || !commitId) {
        return { success: false, definitions: [], error };
      }

      const symbols = this.sqi.findSymbolsByPattern(commitId, pattern, kind);
      const definitions = symbols.map((s) => this.symbolRecordToInfo(s));

      return { success: true, definitions };
    } catch (error) {
      return {
        success: false,
        definitions: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==================== Find Usages ====================

  /**
   * Find usages of a symbol
   */
  async findUsages(input: FindUsagesInput): Promise<FindUsagesOutput> {
    try {
      const { commitId, error, git } = await this.resolveCommit(
        input.repo_path,
        input.commit
      );
      if (error || !commitId || !git) {
        return { success: false, usages: [], total_count: 0, error };
      }

      // Helper to convert usage records to UsageInfo with context
      const recordsToUsageInfo = async (records: UsageRecord[]): Promise<UsageInfo[]> => {
        const usages: UsageInfo[] = [];
        for (const record of records) {
          // Get context snippet
          let contextSnippet = '';
          try {
            const { content } = await git.readFileAtCommit(
              input.commit,
              record.file_path
            );
            contextSnippet = this.sqi.getContextSnippet(content, record.line, 1);
          } catch {
            // File might not exist, skip context
          }

          // Get enclosing symbol name
          let enclosingSymbol: string | undefined;
          if (record.enclosing_symbol_id) {
            const enclosing = this.sqi.getSymbolById(record.enclosing_symbol_id);
            if (enclosing) {
              enclosingSymbol = enclosing.qualified_name;
            }
          }

          usages.push({
            file_path: record.file_path,
            line: record.line,
            column: record.column,
            usage_type: record.usage_type,
            context_snippet: contextSnippet,
            enclosing_symbol: enclosingSymbol,
          });
        }
        return usages;
      };

      // Fuzzy search mode
      if (input.fuzzy) {
        const fuzzyOptions: { filePath?: string; minSimilarity?: number; fuzzyLimit?: number } = {
          minSimilarity: input.min_similarity ?? 0.3,
          fuzzyLimit: 5,
        };
        if (input.file_path) {
          fuzzyOptions.filePath = input.file_path;
        }

        const result = this.sqi.findUsagesWithFuzzy(commitId, input.symbol_name, fuzzyOptions);

        const usages = await recordsToUsageInfo(result.exact);

        // Build fuzzy matches
        const fuzzyMatches: FuzzyUsageMatch[] = [];
        for (const match of result.fuzzy) {
          const matchUsages = await recordsToUsageInfo(match.usages);
          fuzzyMatches.push({
            symbol_name: match.symbolName,
            similarity: match.similarity,
            usages: matchUsages,
          });
        }

        const output: FindUsagesOutput = {
          success: true,
          usages,
          total_count: usages.length,
        };
        if (fuzzyMatches.length > 0) {
          output.fuzzy_matches = fuzzyMatches;
        }
        return output;
      }

      // Standard exact search
      const usageRecords = this.sqi.findUsagesByName(
        commitId,
        input.symbol_name,
        input.file_path
      );

      const usages = await recordsToUsageInfo(usageRecords);

      return {
        success: true,
        usages,
        total_count: usages.length,
      };
    } catch (error) {
      return {
        success: false,
        usages: [],
        total_count: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==================== Find Hierarchy ====================

  /**
   * Find symbol hierarchy (children, parents)
   */
  async findHierarchy(input: FindHierarchyInput): Promise<FindHierarchyOutput> {
    try {
      const { commitId, error } = await this.resolveCommit(
        input.repo_path,
        input.commit
      );
      if (error || !commitId) {
        return { success: false, error };
      }

      // Find the symbol
      const symbols = this.sqi.findSymbolsByName(commitId, input.symbol_name);
      if (symbols.length === 0) {
        return {
          success: false,
          error: `Symbol not found: ${input.symbol_name}`,
        };
      }

      // Use first match (could enhance to handle multiple)
      const symbol = symbols[0]!;
      const symbolInfo = this.symbolRecordToInfo(symbol);

      const result: FindHierarchyOutput = {
        success: true,
        symbol: symbolInfo,
      };

      // Get children if requested
      if (input.direction === 'children' || input.direction === 'both') {
        const children = this.sqi.getChildSymbols(symbol.id);
        result.children = children.map((c) => this.symbolRecordToInfo(c));
      }

      // Get parents if requested
      if (input.direction === 'parents' || input.direction === 'both') {
        const parents: string[] = [];

        // Walk up the parent chain
        let currentParentId = symbol.parent_symbol_id;
        while (currentParentId) {
          const parent = this.sqi.getSymbolById(currentParentId);
          if (parent) {
            parents.push(parent.qualified_name);
            currentParentId = parent.parent_symbol_id;
          } else {
            break;
          }
        }

        result.parents = parents;
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==================== Find Imports ====================

  /**
   * Find imports for a file
   */
  async findImports(input: FindImportsInput): Promise<FindImportsOutput> {
    try {
      const { commitId, error } = await this.resolveCommit(
        input.repo_path,
        input.commit
      );
      if (error || !commitId) {
        return { success: false, imports: [], error: error ?? 'Unknown error resolving commit' };
      }

      // Get imports for file
      const importRecords = this.sqi.getImportsForFile(commitId, input.file_path);

      // Build import info with bindings
      const imports: ImportInfo[] = importRecords.map((record) => {
        const bindings = this.sqi.getImportBindings(record.id);
        return {
          file_path: record.file_path,
          line: record.line,
          import_type: record.import_type,
          module_specifier: record.module_specifier,
          resolved_path: record.resolved_path ?? undefined,
          bindings: bindings.map((b) => ({
            imported_name: b.imported_name,
            local_name: b.local_name,
            is_type_only: b.is_type_only === 1,
          })),
        };
      });

      return { success: true, imports };
    } catch (error) {
      return {
        success: false,
        imports: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Find files importing a module
   */
  async findImporters(input: FindImportersInput): Promise<FindImportersOutput> {
    try {
      const { commitId, error } = await this.resolveCommit(
        input.repo_path,
        input.commit
      );
      if (error || !commitId) {
        return { success: false, importers: [], error: error ?? 'Unknown error resolving commit' };
      }

      // Find imports matching module
      const importRecords = this.sqi.findImportersByPattern(
        commitId,
        `%${input.module}%`
      );

      // Build importer info
      const importers = importRecords.map((record) => {
        const bindings = this.sqi.getImportBindings(record.id);
        return {
          file_path: record.file_path,
          line: record.line,
          bindings: bindings.map((b): ImportBindingInfo => ({
            imported_name: b.imported_name,
            local_name: b.local_name,
            is_type_only: b.is_type_only === 1,
          })),
        };
      });

      return { success: true, importers };
    } catch (error) {
      return {
        success: false,
        importers: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==================== File-Level Queries ====================

  /**
   * Get all symbols in a file
   */
  async getSymbolsInFile(
    repoPath: string,
    commit: string,
    filePath: string
  ): Promise<FindDefinitionOutput> {
    try {
      const { commitId, error } = await this.resolveCommit(repoPath, commit);
      if (error || !commitId) {
        return { success: false, definitions: [], error };
      }

      const symbols = this.sqi.getSymbolsInFile(commitId, filePath);
      const definitions = symbols.map((s) => this.symbolRecordToInfo(s));

      return { success: true, definitions };
    } catch (error) {
      return {
        success: false,
        definitions: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==================== Statistics ====================

  /**
   * Get SQI statistics for a commit
   */
  async getStats(
    repoPath: string,
    commit: string
  ): Promise<{
    success: boolean;
    symbols?: number;
    usages?: number;
    imports?: number;
    files?: number;
    error?: string;
  }> {
    try {
      const { commitId, error } = await this.resolveCommit(repoPath, commit);
      if (error || !commitId) {
        return { success: false, error: error ?? 'Unknown error resolving commit' };
      }

      const stats = this.sqi.getCommitStats(commitId);

      return {
        success: true,
        ...stats,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==================== Codebase Summary ====================

  async codebaseSummary(input: CodebaseSummaryInput): Promise<CodebaseSummaryOutput> {
    try {
      const { commitId, error } = await this.resolveCommit(input.repo_path, input.commit);
      if (error || !commitId) {
        return { success: false, error: error ?? 'Failed to resolve commit' };
      }

      const stats = this.sqi.getCommitStats(commitId);
      const fileCounts = this.sqi.getFileCountsByExtension(commitId);
      const symbolCounts = this.sqi.getSymbolCountsByExtension(commitId);
      const totalFiles = fileCounts.reduce((sum, l) => sum + l.count, 0);

      const languageMap = new Map<string, LanguageStats>();
      for (const fc of fileCounts) {
        languageMap.set(fc.extension, { language: fc.extension, file_count: fc.count, symbol_count: 0, percentage: totalFiles > 0 ? Math.round((fc.count / totalFiles) * 100) : 0 });
      }
      for (const sc of symbolCounts) {
        const existing = languageMap.get(sc.extension);
        if (existing) existing.symbol_count = sc.count;
      }
      const languages = Array.from(languageMap.values()).sort((a, b) => b.file_count - a.file_count);

      const moduleRaw = this.sqi.getModuleStats(commitId, input.max_modules ?? 10);
      const modules: ModuleStats[] = moduleRaw.map(m => ({ path: m.path, file_count: m.file_count, symbol_count: m.symbol_count, main_symbols: this.sqi.getModuleMainSymbols(commitId, m.path) }));

      const entryRaw = this.sqi.getEntryPointFiles(commitId);
      const entry_points: EntryPointInfo[] = entryRaw.map(e => ({ file_path: e.file_path, type: e.type as EntryPointInfo['type'], exports: this.sqi.getExportedSymbols(commitId, e.file_path) }));

      let hotspots: HotspotInfo[] = [];
      if (input.include_hotspots !== false) {
        const hotspotRaw = this.sqi.getHotspots(commitId, input.max_hotspots ?? 10);
        hotspots = hotspotRaw.map(h => ({ name: h.name, qualified_name: h.qualified_name, kind: h.symbol_kind as SymbolKind, file_path: h.file_path, usage_count: h.usage_count }));
      }

      let dependencies: DependencyInfo[] = [];
      if (input.include_dependencies !== false) {
        const depRaw = this.sqi.getExternalDependencies(commitId);
        dependencies = depRaw.map(d => ({ name: d.name, import_count: d.import_count, importers: this.sqi.getDependencyImporters(commitId, d.name) }));
      }

      const kindCounts = this.sqi.getSymbolCountsByKind(commitId);
      const symbol_breakdown = kindCounts.map(k => ({ kind: k.kind as SymbolKind, count: k.count }));

      return { success: true, summary: { total_files: stats.files, total_symbols: stats.symbols, total_usages: stats.usages, total_imports: stats.imports, languages, modules, entry_points, hotspots, dependencies, symbol_breakdown } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }


  /**
   * Find dead code (symbols with no usages).
   * This is a key differentiator from LSP - analyzing cross-file dead code.
   */
  async findDeadCode(input: FindDeadCodeInput): Promise<FindDeadCodeOutput> {
    try {
      const { commitId, error } = await this.resolveCommit(input.repo_path, input.commit);
      if (error || !commitId) {
        return {
          success: false,
          dead_symbols: [],
          exported_count: 0,
          unexported_count: 0,
          error: error ?? 'Failed to resolve commit',
        };
      }

      const deadSymbolOptions: { exportedOnly?: boolean; limit?: number } = {
        limit: input.limit ?? 50,
      };
      if (input.exported_only !== undefined) {
        deadSymbolOptions.exportedOnly = input.exported_only;
      }

      const raw = this.sqi.getDeadSymbols(commitId, deadSymbolOptions);

      const dead_symbols: DeadSymbolInfo[] = raw.map((s) => ({
        name: s.name,
        qualified_name: s.qualified_name,
        kind: s.symbol_kind as SymbolKind,
        file_path: s.file_path,
        start_line: s.start_line,
        end_line: s.end_line,
        is_exported: s.is_exported ? true : false,
      }));

      return {
        success: true,
        dead_symbols,
        exported_count: dead_symbols.filter((s) => s.is_exported).length,
        unexported_count: dead_symbols.filter((s) => !s.is_exported).length,
      };
    } catch (error) {
      return {
        success: false,
        dead_symbols: [],
        exported_count: 0,
        unexported_count: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Analyze the impact of changing a symbol.
   * Shows direct usages and transitive impact through the call graph.
   */
  async analyzeChangeImpact(input: ChangeImpactInput): Promise<ChangeImpactOutput> {
    try {
      const { commitId, error, git } = await this.resolveCommit(input.repo_path, input.commit);
      if (error || !commitId || !git) {
        return {
          success: false,
          direct_usages: [],
          transitive_impact: [],
          total_affected: 0,
          error: error ?? 'Failed to resolve commit',
        };
      }

      // Find the symbol first
      const symbols = this.sqi.findSymbolsByName(commitId, input.symbol_name);
      if (symbols.length === 0) {
        return {
          success: false,
          direct_usages: [],
          transitive_impact: [],
          total_affected: 0,
          error: `Symbol not found: ${input.symbol_name}`,
        };
      }

      // Use the first matching symbol (could enhance to be more specific)
      const targetSymbol = symbols[0]!;
      const symbolInfo = this.symbolRecordToInfo(targetSymbol);

      // Get direct usages
      const usageRecords = this.sqi.findUsagesByDefinition(targetSymbol.id);
      const direct_usages: UsageInfo[] = [];

      for (const record of usageRecords) {
        let contextSnippet = '';
        try {
          const { content } = await git.readFileAtCommit(input.commit, record.file_path);
          contextSnippet = this.sqi.getContextSnippet(content, record.line, 1);
        } catch {
          // File might not exist, skip context
        }

        let enclosingSymbol: string | undefined;
        if (record.enclosing_symbol_id) {
          const enclosing = this.sqi.getSymbolById(record.enclosing_symbol_id);
          if (enclosing) {
            enclosingSymbol = enclosing.qualified_name;
          }
        }

        direct_usages.push({
          file_path: record.file_path,
          line: record.line,
          column: record.column,
          usage_type: record.usage_type,
          context_snippet: contextSnippet,
          enclosing_symbol: enclosingSymbol,
        });
      }

      // Get transitive impact
      const maxDepth = input.max_depth ?? 3;
      const transitiveRaw = this.sqi.getTransitiveImpact(commitId, targetSymbol.id, maxDepth);

      const transitive_impact: ImpactInfo[] = transitiveRaw.map((t) => ({
        name: t.name,
        qualified_name: t.qualified_name,
        file_path: t.file_path,
        start_line: t.start_line,
        depth: t.depth,
        usage_type: t.usage_type as UsageType,
      }));

      // Count unique symbols affected (direct + transitive, avoiding duplicates)
      const affectedSymbolIds = new Set<number>();
      for (const usage of usageRecords) {
        if (usage.enclosing_symbol_id) {
          affectedSymbolIds.add(usage.enclosing_symbol_id);
        }
      }
      for (const impact of transitiveRaw) {
        affectedSymbolIds.add(impact.symbol_id);
      }

      return {
        success: true,
        symbol: symbolInfo,
        direct_usages,
        transitive_impact,
        total_affected: affectedSymbolIds.size,
      };
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

  // ==================== Symbol Context ====================

  async getSymbolContext(input: GetSymbolContextInput): Promise<GetSymbolContextOutput> {
    try {
      const { commitId, error, git } = await this.resolveCommit(input.repo_path, input.commit);
      if (error || !commitId || !git) {
        return { success: false, error: error ?? 'Failed to resolve commit' };
      }

      const symbols = this.sqi.findSymbolsByName(commitId, input.symbol_name);
      if (symbols.length === 0) {
        return { success: false, error: `Symbol not found: ${input.symbol_name}` };
      }

      const symbol = symbols[0]!;
      const symbolInfo = this.symbolRecordToInfo(symbol);

      let source_code: string | undefined;
      if (input.include_source !== false) {
        try {
          const { content } = await git.readFileAtCommit(input.commit, symbol.file_path);
          const lines = content.split('\n');
          source_code = lines.slice(symbol.start_line - 1, symbol.end_line).join('\n');
        } catch { /* Source not available */ }
      }

      const usages: UsageInfo[] = [];
      if (input.include_usages !== false) {
        const usageRecords = this.sqi.findUsagesByName(commitId, input.symbol_name);
        for (const record of usageRecords.slice(0, input.max_usages ?? 20)) {
          let contextSnippet = '';
          try {
            const { content } = await git.readFileAtCommit(input.commit, record.file_path);
            contextSnippet = this.sqi.getContextSnippet(content, record.line, 1);
          } catch { /* Context not available */ }
          usages.push({ file_path: record.file_path, line: record.line, column: record.column, usage_type: record.usage_type, context_snippet: contextSnippet });
        }
      }

      const fileImports = this.sqi.getImportsForFile(commitId, symbol.file_path);
      const imports_used = fileImports.map(i => i.module_specifier);
      const importers = this.sqi.findImportersByPattern(commitId, `%${symbol.file_path.replace(/\.[^.]+$/, '')}%`);
      const imported_by = [...new Set(importers.map(i => i.file_path))].slice(0, 10);
      const sameFile = this.sqi.getSymbolsInFile(commitId, symbol.file_path);
      const related_symbols = sameFile.filter(s => s.id !== symbol.id).slice(0, 10).map(s => this.symbolRecordToInfo(s));

      const context: GetSymbolContextOutput['context'] = { symbol: symbolInfo, usages, imports_used, imported_by, related_symbols };
      if (source_code !== undefined) context.source_code = source_code;
      return { success: true, context };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ==================== Dependency Graph ====================

  async getDependencyGraph(input: DependencyGraphInput): Promise<DependencyGraphOutput> {
    try {
      const { commitId, error } = await this.resolveCommit(input.repo_path, input.commit);
      if (error || !commitId) {
        return { success: false, error: error ?? 'Failed to resolve commit' };
      }

      const importFiles = this.sqi.getImportFiles(commitId);
      const edgeCounts = new Map<string, DependencyEdge>();
      const nodes = new Set<string>();

      for (const filePath of importFiles) {
        const fromModule = this.getModuleNameForFile(filePath);
        nodes.add(fromModule);

        const imports = this.sqi.getImportsForFile(commitId, filePath);
        for (const imp of imports) {
          const target = this.normalizeDependencyTarget(filePath, imp.module_specifier);
          if (!target) {
            continue;
          }

          nodes.add(target.name);
          const edgeKey = `${fromModule}::${target.name}::${target.kind}`;
          const existing = edgeCounts.get(edgeKey);
          if (existing) {
            existing.import_count += 1;
          } else {
            edgeCounts.set(edgeKey, {
              from: fromModule,
              to: target.name,
              kind: target.kind,
              import_count: 1,
            });
          }
        }
      }

      const edges = Array.from(edgeCounts.values())
        .sort((a, b) => b.import_count - a.import_count)
        .slice(0, input.max_edges ?? 50);

      return {
        success: true,
        graph: {
          nodes: Array.from(nodes).sort(),
          edges,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ==================== Helper Methods ====================

  /**
   * Resolve commit reference to commit ID
   */
  private async resolveCommit(
    repoPath: string,
    commitRef: string
  ): Promise<{
    commitId?: number;
    commitSha?: string;
    git?: GitAdapter;
    error?: string;
  }> {
    // Get repository
    const repo = this.metadata.getRepositoryByPath(repoPath);
    if (!repo) {
      return { error: 'Repository not registered. Please index the codebase first.' };
    }

    // Create Git adapter
    let git: GitAdapter;
    try {
      git = await GitAdapter.create(repoPath);
    } catch (error) {
      return { error: `Failed to access repository: ${error instanceof Error ? error.message : String(error)}` };
    }

    // Resolve commit
    let commitSha: string;
    try {
      commitSha = await git.resolveRef(commitRef);
    } catch (error) {
      return { error: `Cannot resolve commit: ${commitRef}` };
    }

    // Get commit record
    const commitRecord = this.metadata.getIndexedCommit(repo.id, commitSha);
    if (!commitRecord) {
      return { error: `Commit not indexed: ${commitSha.slice(0, 8)}. Run 'sourcerack index' to index this commit.` };
    }

    if (commitRecord.status !== 'complete') {
      return { error: `Indexing incomplete for commit: ${commitSha.slice(0, 8)} (status: ${commitRecord.status}). Run 'sourcerack index --force' to re-index.` };
    }

    return { commitId: commitRecord.id, commitSha, git };
  }

  private getModuleNameForFile(filePath: string): string {
    const parts = filePath.split('/').filter(Boolean);
    return parts.length > 1 ? parts[0]! : filePath;
  }

  private normalizeDependencyTarget(
    importerPath: string,
    moduleSpecifier: string
  ): { name: string; kind: 'internal' | 'external' } | null {
    if (!moduleSpecifier) {
      return null;
    }

    if (moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/')) {
      const normalized = moduleSpecifier.startsWith('/')
        ? path.normalize(moduleSpecifier)
        : path.normalize(path.join(path.dirname(importerPath), moduleSpecifier));
      const trimmed = normalized.replace(/^\/+/, '');
      const moduleName = this.getModuleNameForFile(trimmed);
      return { name: moduleName, kind: 'internal' };
    }

    const packageParts = moduleSpecifier.split('/').filter(Boolean);
    if (packageParts.length === 0) {
      return null;
    }
    const name = moduleSpecifier.startsWith('@') && packageParts.length >= 2
      ? `${packageParts[0]}/${packageParts[1]}`
      : packageParts[0]!;

    return { name, kind: 'external' };
  }

  /**
   * Convert SymbolRecord to SymbolInfo
   */
  private symbolRecordToInfo(record: SymbolRecord): SymbolInfo {
    // Get parameters if function/method
    let parameters: ParameterInfo[] | undefined;
    if (
      record.symbol_kind === SymbolKind.FUNCTION ||
      record.symbol_kind === SymbolKind.METHOD ||
      record.symbol_kind === SymbolKind.CONSTRUCTOR
    ) {
      const paramRecords = this.sqi.getSymbolParameters(record.id);
      if (paramRecords.length > 0) {
        parameters = paramRecords.map((p) => ({
          name: p.name,
          type: p.type_annotation ?? undefined,
          optional: p.is_optional === 1,
        }));
      }
    }

    // Get docstring
    let docstring: string | undefined;
    const docRecord = this.sqi.getSymbolDocstring(record.id);
    if (docRecord) {
      docstring = docRecord.description ?? docRecord.raw_text;
    }

    return {
      name: record.name,
      qualified_name: record.qualified_name,
      kind: record.symbol_kind,
      file_path: record.file_path,
      start_line: record.start_line,
      end_line: record.end_line,
      visibility: record.visibility ?? undefined,
      is_async: record.is_async,
      is_static: record.is_static,
      is_exported: record.is_exported,
      return_type: record.return_type ?? undefined,
      docstring,
      parameters,
    };
  }
}

/**
 * Create a structured query engine
 */
export function createStructuredQueryEngine(
  metadata: MetadataStorage
): StructuredQueryEngine {
  return new StructuredQueryEngine(metadata);
}
