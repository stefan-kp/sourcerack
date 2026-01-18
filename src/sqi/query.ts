/**
 * Structured Query Engine for SQI
 *
 * Provides high-level query operations on the Structured Query Index,
 * implementing find_definition, find_usages, find_hierarchy, and find_imports.
 */

import { GitAdapter } from '../git/adapter.js';
import { MetadataStorage } from '../storage/metadata.js';
import { SQIStorage } from './storage.js';
import {
  SymbolKind,
  SymbolInfo,
  UsageInfo,
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

      // Find symbols by name
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

      // Find usages by name
      const usageRecords = this.sqi.findUsagesByName(
        commitId,
        input.symbol_name,
        input.file_path
      );

      // Build usage info with context snippets
      const usages: UsageInfo[] = [];

      for (const record of usageRecords) {
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
      return { error: `Commit not indexed: ${commitSha}` };
    }

    if (commitRecord.status !== 'complete') {
      return { error: `Indexing not complete for commit: ${commitSha}` };
    }

    return { commitId: commitRecord.id, commitSha, git };
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
