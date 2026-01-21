/**
 * SQI Storage Layer for SourceRack
 *
 * SQLite-based storage for the Structured Query Index.
 * Provides CRUD operations for symbols, usages, imports, and related entities.
 */

import { Database as DatabaseType } from 'better-sqlite3';
import {
  SymbolKind,
  Visibility,
  UsageType,
  SymbolRecord,
  SymbolParameterRecord,
  SymbolDocstringRecord,
  UsageRecord,
  ImportRecord,
  ImportBindingRecord,
  ExtractedSymbol,
  ExtractedUsage,
  ExtractedImport,
} from './types.js';

/**
 * SQI schema version for migrations
 */
export const SQI_SCHEMA_VERSION = 1;

/**
 * SQL statements for SQI schema creation
 */
export const CREATE_SQI_TABLES = `
-- Symbol definitions
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  commit_id INTEGER NOT NULL,

  -- Identification
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,

  -- Location
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,

  -- Metadata
  visibility TEXT,
  is_async INTEGER DEFAULT 0,
  is_static INTEGER DEFAULT 0,
  is_exported INTEGER DEFAULT 0,
  return_type TEXT,

  -- Hierarchy
  parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,

  -- Dedup
  content_hash TEXT NOT NULL,

  FOREIGN KEY (commit_id) REFERENCES indexed_commits(id) ON DELETE CASCADE
);

-- Symbol parameters (functions/methods)
CREATE TABLE IF NOT EXISTS symbol_parameters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  type_annotation TEXT,
  is_optional INTEGER DEFAULT 0
);

-- Docstrings
CREATE TABLE IF NOT EXISTS symbol_docstrings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER NOT NULL UNIQUE REFERENCES symbols(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  description TEXT
);

-- Usages (references)
CREATE TABLE IF NOT EXISTS usages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id INTEGER NOT NULL,
  symbol_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  usage_type TEXT NOT NULL,
  enclosing_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  definition_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,

  FOREIGN KEY (commit_id) REFERENCES indexed_commits(id) ON DELETE CASCADE
);

-- Imports
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  import_type TEXT NOT NULL,
  module_specifier TEXT NOT NULL,
  resolved_path TEXT,

  FOREIGN KEY (commit_id) REFERENCES indexed_commits(id) ON DELETE CASCADE
);

-- Import bindings
CREATE TABLE IF NOT EXISTS import_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  imported_name TEXT NOT NULL,
  local_name TEXT NOT NULL,
  is_type_only INTEGER DEFAULT 0
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_commit_file ON symbols(commit_id, file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(symbol_kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_symbol_id);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_commit ON symbols(repo_id, commit_id);

CREATE INDEX IF NOT EXISTS idx_params_symbol ON symbol_parameters(symbol_id);

CREATE INDEX IF NOT EXISTS idx_usages_name ON usages(symbol_name);
CREATE INDEX IF NOT EXISTS idx_usages_commit ON usages(commit_id);
CREATE INDEX IF NOT EXISTS idx_usages_file ON usages(commit_id, file_path);
CREATE INDEX IF NOT EXISTS idx_usages_enclosing ON usages(enclosing_symbol_id);
CREATE INDEX IF NOT EXISTS idx_usages_definition ON usages(definition_symbol_id);

CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module_specifier);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(commit_id, file_path);
CREATE INDEX IF NOT EXISTS idx_imports_commit ON imports(commit_id);

CREATE INDEX IF NOT EXISTS idx_bindings_import ON import_bindings(import_id);
CREATE INDEX IF NOT EXISTS idx_bindings_name ON import_bindings(imported_name);
`;

/**
 * SQI Storage class
 *
 * Extends the existing MetadataStorage pattern to provide
 * CRUD operations for the Structured Query Index.
 */
export class SQIStorage {
  private db: DatabaseType;

  constructor(db: DatabaseType) {
    this.db = db;
  }

  /**
   * Initialize SQI tables in an existing database
   */
  static initializeTables(db: DatabaseType): void {
    db.exec(CREATE_SQI_TABLES);
  }

  // ==================== Symbol Operations ====================

  /**
   * Insert a symbol and its related data (parameters, docstring)
   * Returns the symbol ID
   */
  insertSymbol(
    repoId: string,
    commitId: number,
    symbol: ExtractedSymbol,
    parentSymbolId?: number
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO symbols (
        repo_id, commit_id, name, qualified_name, symbol_kind,
        file_path, start_line, end_line,
        visibility, is_async, is_static, is_exported, return_type,
        parent_symbol_id, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      repoId,
      commitId,
      symbol.name,
      symbol.qualified_name,
      symbol.symbol_kind,
      symbol.file_path,
      symbol.start_line,
      symbol.end_line,
      symbol.visibility ?? null,
      symbol.is_async ? 1 : 0,
      symbol.is_static ? 1 : 0,
      symbol.is_exported ? 1 : 0,
      symbol.return_type ?? null,
      parentSymbolId ?? null,
      symbol.content_hash
    );

    const symbolId = result.lastInsertRowid as number;

    // Insert parameters if present
    if (symbol.parameters && symbol.parameters.length > 0) {
      this.insertParameters(symbolId, symbol.parameters);
    }

    // Insert docstring if present
    if (symbol.docstring) {
      this.insertDocstring(symbolId, symbol.docstring);
    }

    // Recursively insert children
    if (symbol.children && symbol.children.length > 0) {
      for (const child of symbol.children) {
        this.insertSymbol(repoId, commitId, child, symbolId);
      }
    }

    return symbolId;
  }

  /**
   * Insert symbol parameters
   */
  private insertParameters(
    symbolId: number,
    parameters: ExtractedSymbol['parameters']
  ): void {
    if (!parameters) return;

    const stmt = this.db.prepare(`
      INSERT INTO symbol_parameters (symbol_id, position, name, type_annotation, is_optional)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const param of parameters) {
      stmt.run(
        symbolId,
        param.position,
        param.name,
        param.type_annotation ?? null,
        param.is_optional ? 1 : 0
      );
    }
  }

  /**
   * Insert symbol docstring
   */
  private insertDocstring(
    symbolId: number,
    docstring: ExtractedSymbol['docstring']
  ): void {
    if (!docstring) return;

    this.db.prepare(`
      INSERT INTO symbol_docstrings (symbol_id, doc_type, raw_text, description)
      VALUES (?, ?, ?, ?)
    `).run(
      symbolId,
      docstring.doc_type,
      docstring.raw_text,
      docstring.description ?? null
    );
  }

  /**
   * Bulk insert symbols for a file
   */
  insertSymbols(
    repoId: string,
    commitId: number,
    symbols: ExtractedSymbol[]
  ): number[] {
    const insertAll = this.db.transaction(() => {
      const ids: number[] = [];
      for (const symbol of symbols) {
        const id = this.insertSymbol(repoId, commitId, symbol);
        ids.push(id);
      }
      return ids;
    });

    return insertAll();
  }

  /**
   * Get symbol by ID
   */
  getSymbolById(id: number): SymbolRecord | null {
    const row = this.db
      .prepare('SELECT * FROM symbols WHERE id = ?')
      .get(id) as RawSymbolRow | undefined;

    return row ? this.mapSymbolRow(row) : null;
  }

  /**
   * Find symbols by name
   */
  findSymbolsByName(
    commitId: number,
    name: string,
    kind?: SymbolKind
  ): SymbolRecord[] {
    let query = 'SELECT * FROM symbols WHERE commit_id = ? AND name = ?';
    const params: (number | string)[] = [commitId, name];

    if (kind) {
      query += ' AND symbol_kind = ?';
      params.push(kind);
    }

    const rows = this.db.prepare(query).all(...params) as RawSymbolRow[];
    return rows.map((row) => this.mapSymbolRow(row));
  }

  /**
   * Find symbols by qualified name
   */
  findSymbolsByQualifiedName(
    commitId: number,
    qualifiedName: string
  ): SymbolRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM symbols WHERE commit_id = ? AND qualified_name = ?')
      .all(commitId, qualifiedName) as RawSymbolRow[];

    return rows.map((row) => this.mapSymbolRow(row));
  }

  /**
   * Find symbols by name pattern (LIKE query)
   */
  findSymbolsByPattern(
    commitId: number,
    pattern: string,
    kind?: SymbolKind
  ): SymbolRecord[] {
    let query = 'SELECT * FROM symbols WHERE commit_id = ? AND name LIKE ?';
    const params: (number | string)[] = [commitId, pattern];

    if (kind) {
      query += ' AND symbol_kind = ?';
      params.push(kind);
    }

    const rows = this.db.prepare(query).all(...params) as RawSymbolRow[];
    return rows.map((row) => this.mapSymbolRow(row));
  }

  /**
   * Get symbols in a file
   */
  getSymbolsInFile(commitId: number, filePath: string): SymbolRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM symbols WHERE commit_id = ? AND file_path = ? ORDER BY start_line')
      .all(commitId, filePath) as RawSymbolRow[];

    return rows.map((row) => this.mapSymbolRow(row));
  }

  /**
   * Get child symbols (methods of a class, etc.)
   */
  getChildSymbols(parentId: number): SymbolRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM symbols WHERE parent_symbol_id = ? ORDER BY start_line')
      .all(parentId) as RawSymbolRow[];

    return rows.map((row) => this.mapSymbolRow(row));
  }

  /**
   * Get symbol parameters
   */
  getSymbolParameters(symbolId: number): SymbolParameterRecord[] {
    return this.db
      .prepare('SELECT * FROM symbol_parameters WHERE symbol_id = ? ORDER BY position')
      .all(symbolId) as SymbolParameterRecord[];
  }

  /**
   * Get symbol docstring
   */
  getSymbolDocstring(symbolId: number): SymbolDocstringRecord | null {
    const row = this.db
      .prepare('SELECT * FROM symbol_docstrings WHERE symbol_id = ?')
      .get(symbolId) as SymbolDocstringRecord | undefined;

    return row ?? null;
  }

  // ==================== Usage Operations ====================

  /**
   * Insert a usage record
   */
  insertUsage(commitId: number, usage: ExtractedUsage): number {
    const stmt = this.db.prepare(`
      INSERT INTO usages (commit_id, symbol_name, file_path, line, col, usage_type, enclosing_symbol_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Note: enclosing_symbol_id and definition_symbol_id are linked later
    const result = stmt.run(
      commitId,
      usage.symbol_name,
      usage.file_path,
      usage.line,
      usage.column,
      usage.usage_type,
      null // enclosing_symbol_id linked later
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Bulk insert usages
   */
  insertUsages(commitId: number, usages: ExtractedUsage[]): number[] {
    const insertAll = this.db.transaction(() => {
      const ids: number[] = [];
      for (const usage of usages) {
        const id = this.insertUsage(commitId, usage);
        ids.push(id);
      }
      return ids;
    });

    return insertAll();
  }

  /**
   * Find usages by symbol name
   */
  findUsagesByName(
    commitId: number,
    symbolName: string,
    filePath?: string
  ): UsageRecord[] {
    let query = 'SELECT * FROM usages WHERE commit_id = ? AND symbol_name = ?';
    const params: (number | string)[] = [commitId, symbolName];

    if (filePath) {
      query += ' AND file_path = ?';
      params.push(filePath);
    }

    query += ' ORDER BY file_path, line';

    const rows = this.db.prepare(query).all(...params) as RawUsageRow[];
    return rows.map((row) => this.mapUsageRow(row));
  }

  /**
   * Find usages pointing to a definition
   */
  findUsagesByDefinition(definitionSymbolId: number): UsageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM usages WHERE definition_symbol_id = ? ORDER BY file_path, line')
      .all(definitionSymbolId) as RawUsageRow[];

    return rows.map((row) => this.mapUsageRow(row));
  }

  /**
   * Get usages in a file
   */
  getUsagesInFile(commitId: number, filePath: string): UsageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM usages WHERE commit_id = ? AND file_path = ? ORDER BY line')
      .all(commitId, filePath) as RawUsageRow[];

    return rows.map((row) => this.mapUsageRow(row));
  }

  /**
   * Link usage to its definition symbol
   */
  linkUsageToDefinition(usageId: number, definitionSymbolId: number): void {
    this.db
      .prepare('UPDATE usages SET definition_symbol_id = ? WHERE id = ?')
      .run(definitionSymbolId, usageId);
  }

  /**
   * Link usage to its enclosing symbol
   */
  linkUsageToEnclosing(usageId: number, enclosingSymbolId: number): void {
    this.db
      .prepare('UPDATE usages SET enclosing_symbol_id = ? WHERE id = ?')
      .run(enclosingSymbolId, usageId);
  }

  // ==================== Import Operations ====================

  /**
   * Insert an import record
   */
  insertImport(commitId: number, importData: ExtractedImport): number {
    const stmt = this.db.prepare(`
      INSERT INTO imports (commit_id, file_path, line, import_type, module_specifier, resolved_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      commitId,
      importData.file_path,
      importData.line,
      importData.import_type,
      importData.module_specifier,
      importData.resolved_path ?? null
    );

    const importId = result.lastInsertRowid as number;

    // Insert bindings
    if (importData.bindings.length > 0) {
      this.insertImportBindings(importId, importData.bindings);
    }

    return importId;
  }

  /**
   * Insert import bindings
   */
  private insertImportBindings(
    importId: number,
    bindings: ExtractedImport['bindings']
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO import_bindings (import_id, imported_name, local_name, is_type_only)
      VALUES (?, ?, ?, ?)
    `);

    for (const binding of bindings) {
      stmt.run(
        importId,
        binding.imported_name,
        binding.local_name,
        binding.is_type_only ? 1 : 0
      );
    }
  }

  /**
   * Bulk insert imports
   */
  insertImports(commitId: number, imports: ExtractedImport[]): number[] {
    const insertAll = this.db.transaction(() => {
      const ids: number[] = [];
      for (const imp of imports) {
        const id = this.insertImport(commitId, imp);
        ids.push(id);
      }
      return ids;
    });

    return insertAll();
  }

  /**
   * Get imports for a file
   */
  getImportsForFile(commitId: number, filePath: string): ImportRecord[] {
    return this.db
      .prepare('SELECT * FROM imports WHERE commit_id = ? AND file_path = ? ORDER BY line')
      .all(commitId, filePath) as ImportRecord[];
  }

  /**
   * Find files importing a module
   */
  findImporters(commitId: number, moduleSpecifier: string): ImportRecord[] {
    return this.db
      .prepare('SELECT * FROM imports WHERE commit_id = ? AND module_specifier = ?')
      .all(commitId, moduleSpecifier) as ImportRecord[];
  }

  /**
   * Find files importing a module (pattern match)
   */
  findImportersByPattern(commitId: number, pattern: string): ImportRecord[] {
    return this.db
      .prepare('SELECT * FROM imports WHERE commit_id = ? AND module_specifier LIKE ?')
      .all(commitId, pattern) as ImportRecord[];
  }

  /**
   * Get import bindings
   */
  getImportBindings(importId: number): ImportBindingRecord[] {
    return this.db
      .prepare('SELECT * FROM import_bindings WHERE import_id = ?')
      .all(importId) as ImportBindingRecord[];
  }

  // ==================== Bulk Operations ====================

  /**
   * Delete all SQI data for a commit
   */
  deleteCommitData(commitId: number): void {
    const deleteAll = this.db.transaction(() => {
      // Usages and imports have ON DELETE CASCADE from commit
      // Symbols have ON DELETE CASCADE from commit
      // But we need to handle parameters, docstrings that cascade from symbols

      // Delete in correct order to satisfy foreign keys
      this.db.prepare('DELETE FROM usages WHERE commit_id = ?').run(commitId);
      this.db.prepare('DELETE FROM imports WHERE commit_id = ?').run(commitId);
      this.db.prepare('DELETE FROM symbols WHERE commit_id = ?').run(commitId);
    });

    deleteAll();
  }

  /**
   * Delete SQI data for a file within a commit
   */
  deleteFileData(commitId: number, filePath: string): void {
    const deleteAll = this.db.transaction(() => {
      // Get symbol IDs for this file
      const symbolIds = this.db
        .prepare('SELECT id FROM symbols WHERE commit_id = ? AND file_path = ?')
        .all(commitId, filePath) as { id: number }[];

      // Delete parameters and docstrings for these symbols
      for (const { id } of symbolIds) {
        this.db.prepare('DELETE FROM symbol_parameters WHERE symbol_id = ?').run(id);
        this.db.prepare('DELETE FROM symbol_docstrings WHERE symbol_id = ?').run(id);
      }

      // Delete usages in this file
      this.db
        .prepare('DELETE FROM usages WHERE commit_id = ? AND file_path = ?')
        .run(commitId, filePath);

      // Delete imports in this file
      this.db
        .prepare('DELETE FROM imports WHERE commit_id = ? AND file_path = ?')
        .run(commitId, filePath);

      // Delete symbols in this file
      this.db
        .prepare('DELETE FROM symbols WHERE commit_id = ? AND file_path = ?')
        .run(commitId, filePath);
    });

    deleteAll();
  }

  /**
   * Copy SQI data from one commit to another (for unchanged files)
   */
  copyUnchangedData(
    sourceCommitId: number,
    targetCommitId: number,
    excludedFiles: string[]
  ): void {
    const copyAll = this.db.transaction(() => {
      // Build NOT IN clause for excluded files
      const placeholders = excludedFiles.map(() => '?').join(',');
      const excludeClause = excludedFiles.length > 0
        ? `AND file_path NOT IN (${placeholders})`
        : '';

      // Step 1: Copy symbols and build ID mapping (old_id -> new_id)
      // First, get all symbols to copy (without parent references)
      const symbolsToCopy = this.db.prepare(`
        SELECT id, repo_id, name, qualified_name, symbol_kind,
               file_path, start_line, end_line,
               visibility, is_async, is_static, is_exported, return_type,
               parent_symbol_id, content_hash
        FROM symbols
        WHERE commit_id = ? ${excludeClause}
        ORDER BY id
      `).all(sourceCommitId, ...excludedFiles) as {
        id: number;
        repo_id: string;
        name: string;
        qualified_name: string;
        symbol_kind: string;
        file_path: string;
        start_line: number;
        end_line: number;
        visibility: string | null;
        is_async: number;
        is_static: number;
        is_exported: number;
        return_type: string | null;
        parent_symbol_id: number | null;
        content_hash: string;
      }[];

      // Build old_id -> new_id mapping
      const symbolIdMap = new Map<number, number>();

      // Insert symbols without parent references first
      const insertSymbol = this.db.prepare(`
        INSERT INTO symbols (
          repo_id, commit_id, name, qualified_name, symbol_kind,
          file_path, start_line, end_line,
          visibility, is_async, is_static, is_exported, return_type,
          content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const symbol of symbolsToCopy) {
        const result = insertSymbol.run(
          symbol.repo_id,
          targetCommitId,
          symbol.name,
          symbol.qualified_name,
          symbol.symbol_kind,
          symbol.file_path,
          symbol.start_line,
          symbol.end_line,
          symbol.visibility,
          symbol.is_async,
          symbol.is_static,
          symbol.is_exported,
          symbol.return_type,
          symbol.content_hash
        );
        symbolIdMap.set(symbol.id, result.lastInsertRowid as number);
      }

      // Step 2: Update parent_symbol_id references
      const updateParent = this.db.prepare(`
        UPDATE symbols SET parent_symbol_id = ? WHERE id = ?
      `);

      for (const symbol of symbolsToCopy) {
        if (symbol.parent_symbol_id !== null) {
          const newId = symbolIdMap.get(symbol.id);
          const newParentId = symbolIdMap.get(symbol.parent_symbol_id);
          if (newId !== undefined && newParentId !== undefined) {
            updateParent.run(newParentId, newId);
          }
        }
      }

      // Step 3: Copy symbol_parameters with mapped symbol_id
      const paramsToCopy = this.db.prepare(`
        SELECT sp.symbol_id, sp.position, sp.name, sp.type_annotation, sp.is_optional
        FROM symbol_parameters sp
        JOIN symbols s ON sp.symbol_id = s.id
        WHERE s.commit_id = ? ${excludeClause.replace(/file_path/g, 's.file_path')}
      `).all(sourceCommitId, ...excludedFiles) as {
        symbol_id: number;
        position: number;
        name: string;
        type_annotation: string | null;
        is_optional: number;
      }[];

      const insertParam = this.db.prepare(`
        INSERT INTO symbol_parameters (symbol_id, position, name, type_annotation, is_optional)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const param of paramsToCopy) {
        const newSymbolId = symbolIdMap.get(param.symbol_id);
        if (newSymbolId !== undefined) {
          insertParam.run(newSymbolId, param.position, param.name, param.type_annotation, param.is_optional);
        }
      }

      // Step 4: Copy symbol_docstrings with mapped symbol_id
      const docsToCopy = this.db.prepare(`
        SELECT sd.symbol_id, sd.doc_type, sd.raw_text, sd.description
        FROM symbol_docstrings sd
        JOIN symbols s ON sd.symbol_id = s.id
        WHERE s.commit_id = ? ${excludeClause.replace(/file_path/g, 's.file_path')}
      `).all(sourceCommitId, ...excludedFiles) as {
        symbol_id: number;
        doc_type: string;
        raw_text: string;
        description: string | null;
      }[];

      const insertDoc = this.db.prepare(`
        INSERT INTO symbol_docstrings (symbol_id, doc_type, raw_text, description)
        VALUES (?, ?, ?, ?)
      `);

      for (const doc of docsToCopy) {
        const newSymbolId = symbolIdMap.get(doc.symbol_id);
        if (newSymbolId !== undefined) {
          insertDoc.run(newSymbolId, doc.doc_type, doc.raw_text, doc.description);
        }
      }

      // Step 5: Copy usages with mapped symbol references
      const usagesToCopy = this.db.prepare(`
        SELECT symbol_name, file_path, line, col, usage_type,
               enclosing_symbol_id, definition_symbol_id
        FROM usages
        WHERE commit_id = ? ${excludeClause}
      `).all(sourceCommitId, ...excludedFiles) as {
        symbol_name: string;
        file_path: string;
        line: number;
        col: number;
        usage_type: string;
        enclosing_symbol_id: number | null;
        definition_symbol_id: number | null;
      }[];

      const insertUsage = this.db.prepare(`
        INSERT INTO usages (commit_id, symbol_name, file_path, line, col, usage_type,
                           enclosing_symbol_id, definition_symbol_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const usage of usagesToCopy) {
        const newEnclosingId = usage.enclosing_symbol_id !== null
          ? symbolIdMap.get(usage.enclosing_symbol_id) ?? null
          : null;
        const newDefinitionId = usage.definition_symbol_id !== null
          ? symbolIdMap.get(usage.definition_symbol_id) ?? null
          : null;

        insertUsage.run(
          targetCommitId,
          usage.symbol_name,
          usage.file_path,
          usage.line,
          usage.col,
          usage.usage_type,
          newEnclosingId,
          newDefinitionId
        );
      }

      // Step 6: Copy imports and build import_id mapping
      const importsToCopy = this.db.prepare(`
        SELECT id, file_path, line, import_type, module_specifier, resolved_path
        FROM imports
        WHERE commit_id = ? ${excludeClause}
      `).all(sourceCommitId, ...excludedFiles) as {
        id: number;
        file_path: string;
        line: number;
        import_type: string;
        module_specifier: string;
        resolved_path: string | null;
      }[];

      const importIdMap = new Map<number, number>();

      const insertImport = this.db.prepare(`
        INSERT INTO imports (commit_id, file_path, line, import_type, module_specifier, resolved_path)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const imp of importsToCopy) {
        const result = insertImport.run(
          targetCommitId,
          imp.file_path,
          imp.line,
          imp.import_type,
          imp.module_specifier,
          imp.resolved_path
        );
        importIdMap.set(imp.id, result.lastInsertRowid as number);
      }

      // Step 7: Copy import_bindings with mapped import_id
      const bindingsToCopy = this.db.prepare(`
        SELECT ib.import_id, ib.imported_name, ib.local_name, ib.is_type_only
        FROM import_bindings ib
        JOIN imports i ON ib.import_id = i.id
        WHERE i.commit_id = ? ${excludeClause.replace(/file_path/g, 'i.file_path')}
      `).all(sourceCommitId, ...excludedFiles) as {
        import_id: number;
        imported_name: string;
        local_name: string;
        is_type_only: number;
      }[];

      const insertBinding = this.db.prepare(`
        INSERT INTO import_bindings (import_id, imported_name, local_name, is_type_only)
        VALUES (?, ?, ?, ?)
      `);

      for (const binding of bindingsToCopy) {
        const newImportId = importIdMap.get(binding.import_id);
        if (newImportId !== undefined) {
          insertBinding.run(newImportId, binding.imported_name, binding.local_name, binding.is_type_only);
        }
      }
    });

    copyAll();
  }

  // ==================== Statistics ====================

  /**
   * Get SQI statistics for a commit
   */
  getCommitStats(commitId: number): {
    symbols: number;
    usages: number;
    imports: number;
    files: number;
  } {
    const symbolCount = this.db
      .prepare('SELECT COUNT(*) as count FROM symbols WHERE commit_id = ?')
      .get(commitId) as { count: number };

    const usageCount = this.db
      .prepare('SELECT COUNT(*) as count FROM usages WHERE commit_id = ?')
      .get(commitId) as { count: number };

    const importCount = this.db
      .prepare('SELECT COUNT(*) as count FROM imports WHERE commit_id = ?')
      .get(commitId) as { count: number };

    const fileCount = this.db
      .prepare('SELECT COUNT(DISTINCT file_path) as count FROM symbols WHERE commit_id = ?')
      .get(commitId) as { count: number };

    return {
      symbols: symbolCount.count,
      usages: usageCount.count,
      imports: importCount.count,
      files: fileCount.count,
    };
  }

  // ==================== Codebase Summary Queries ====================

  getSymbolCountsByKind(commitId: number): { kind: string; count: number }[] {
    return this.db
      .prepare(`SELECT symbol_kind as kind, COUNT(*) as count FROM symbols WHERE commit_id = ? GROUP BY symbol_kind ORDER BY count DESC`)
      .all(commitId) as { kind: string; count: number }[];
  }

  getFileCountsByExtension(commitId: number): { extension: string; count: number }[] {
    return this.db
      .prepare(`
        SELECT
          CASE WHEN file_path LIKE '%.ts' OR file_path LIKE '%.tsx' THEN 'typescript'
               WHEN file_path LIKE '%.js' OR file_path LIKE '%.jsx' THEN 'javascript'
               WHEN file_path LIKE '%.py' THEN 'python'
               WHEN file_path LIKE '%.rb' THEN 'ruby'
               ELSE 'other' END as extension,
          COUNT(DISTINCT file_path) as count
        FROM symbols WHERE commit_id = ? GROUP BY extension ORDER BY count DESC
      `).all(commitId) as { extension: string; count: number }[];
  }

  getSymbolCountsByExtension(commitId: number): { extension: string; count: number }[] {
    return this.db
      .prepare(`
        SELECT
          CASE WHEN file_path LIKE '%.ts' OR file_path LIKE '%.tsx' THEN 'typescript'
               WHEN file_path LIKE '%.js' OR file_path LIKE '%.jsx' THEN 'javascript'
               WHEN file_path LIKE '%.py' THEN 'python'
               WHEN file_path LIKE '%.rb' THEN 'ruby'
               ELSE 'other' END as extension,
          COUNT(*) as count
        FROM symbols WHERE commit_id = ? GROUP BY extension ORDER BY count DESC
      `).all(commitId) as { extension: string; count: number }[];
  }

  getModuleStats(commitId: number, maxModules: number = 10): { path: string; file_count: number; symbol_count: number }[] {
    return this.db
      .prepare(`
        SELECT CASE WHEN INSTR(file_path, '/') > 0 THEN SUBSTR(file_path, 1, INSTR(file_path, '/') - 1) ELSE file_path END as path,
               COUNT(DISTINCT file_path) as file_count, COUNT(*) as symbol_count
        FROM symbols WHERE commit_id = ? GROUP BY path ORDER BY symbol_count DESC LIMIT ?
      `).all(commitId, maxModules) as { path: string; file_count: number; symbol_count: number }[];
  }

  getModuleMainSymbols(commitId: number, modulePath: string, limit: number = 5): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM symbols WHERE commit_id = ? AND file_path LIKE ? AND is_exported = 1 AND parent_symbol_id IS NULL AND symbol_kind IN ('function', 'class', 'interface') ORDER BY CASE symbol_kind WHEN 'class' THEN 1 WHEN 'interface' THEN 2 ELSE 3 END LIMIT ?`)
      .all(commitId, modulePath + '%', limit) as { name: string }[];
    return rows.map(r => r.name);
  }

  getHotspots(commitId: number, limit: number = 10): { symbol_id: number; name: string; qualified_name: string; symbol_kind: string; file_path: string; usage_count: number }[] {
    return this.db
      .prepare(`SELECT s.id as symbol_id, s.name, s.qualified_name, s.symbol_kind, s.file_path, COUNT(u.id) as usage_count FROM symbols s LEFT JOIN usages u ON u.definition_symbol_id = s.id WHERE s.commit_id = ? AND s.symbol_kind IN ('function', 'method', 'class', 'interface') GROUP BY s.id HAVING usage_count > 0 ORDER BY usage_count DESC LIMIT ?`)
      .all(commitId, limit) as { symbol_id: number; name: string; qualified_name: string; symbol_kind: string; file_path: string; usage_count: number }[];
  }

  getEntryPointFiles(commitId: number): { file_path: string; type: string }[] {
    return this.db
      .prepare(`SELECT DISTINCT file_path, CASE WHEN file_path LIKE '%/index.%' OR file_path LIKE 'index.%' THEN 'index' WHEN file_path LIKE '%/main.%' OR file_path LIKE 'main.%' THEN 'main' WHEN file_path LIKE '%/app.%' OR file_path LIKE 'app.%' THEN 'app' WHEN file_path LIKE '%/server.%' OR file_path LIKE 'server.%' THEN 'server' ELSE 'entry' END as type FROM symbols WHERE commit_id = ? AND (file_path LIKE '%/index.%' OR file_path LIKE 'index.%' OR file_path LIKE '%/main.%' OR file_path LIKE 'main.%' OR file_path LIKE '%/app.%' OR file_path LIKE 'app.%' OR file_path LIKE '%/server.%' OR file_path LIKE 'server.%')`)
      .all(commitId) as { file_path: string; type: string }[];
  }

  getExportedSymbols(commitId: number, filePath: string): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM symbols WHERE commit_id = ? AND file_path = ? AND is_exported = 1 AND parent_symbol_id IS NULL ORDER BY start_line`)
      .all(commitId, filePath) as { name: string }[];
    return rows.map(r => r.name);
  }

  getExternalDependencies(commitId: number, limit: number = 20): { name: string; import_count: number }[] {
    return this.db
      .prepare(`SELECT CASE WHEN module_specifier LIKE '@%/%' THEN SUBSTR(module_specifier, 1, INSTR(SUBSTR(module_specifier, 2), '/') + 1) WHEN INSTR(module_specifier, '/') > 0 THEN SUBSTR(module_specifier, 1, INSTR(module_specifier, '/') - 1) ELSE module_specifier END as name, COUNT(*) as import_count FROM imports WHERE commit_id = ? AND module_specifier NOT LIKE '.%' AND module_specifier NOT LIKE '/%' GROUP BY name ORDER BY import_count DESC LIMIT ?`)
      .all(commitId, limit) as { name: string; import_count: number }[];
  }

  getDependencyImporters(commitId: number, dependencyName: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT file_path FROM imports WHERE commit_id = ? AND (module_specifier = ? OR module_specifier LIKE ? || '/%') ORDER BY file_path LIMIT 10`)
      .all(commitId, dependencyName, dependencyName) as { file_path: string }[];
    return rows.map(r => r.file_path);
  }

  // ==================== Context Snippet ====================

  /**
   * Get context snippet around a usage (requires file content)
   */
  getContextSnippet(
    fileContent: string,
    line: number,
    contextLines: number = 1
  ): string {
    const lines = fileContent.split('\n');
    const startLine = Math.max(0, line - 1 - contextLines);
    const endLine = Math.min(lines.length, line + contextLines);

    return lines.slice(startLine, endLine).join('\n');
  }

  // ==================== Private Helpers ====================

  /**
   * Map raw database row to SymbolRecord
   */
  private mapSymbolRow(row: RawSymbolRow): SymbolRecord {
    return {
      id: row.id,
      repo_id: row.repo_id,
      commit_id: row.commit_id,
      name: row.name,
      qualified_name: row.qualified_name,
      symbol_kind: row.symbol_kind as SymbolKind,
      file_path: row.file_path,
      start_line: row.start_line,
      end_line: row.end_line,
      visibility: row.visibility as Visibility | null,
      is_async: row.is_async === 1,
      is_static: row.is_static === 1,
      is_exported: row.is_exported === 1,
      return_type: row.return_type,
      parent_symbol_id: row.parent_symbol_id,
      content_hash: row.content_hash,
    };
  }

  /**
   * Map raw database row to UsageRecord
   */
  private mapUsageRow(row: RawUsageRow): UsageRecord {
    return {
      id: row.id,
      commit_id: row.commit_id,
      symbol_name: row.symbol_name,
      file_path: row.file_path,
      line: row.line,
      column: row.col,
      usage_type: row.usage_type as UsageType,
      enclosing_symbol_id: row.enclosing_symbol_id,
      definition_symbol_id: row.definition_symbol_id,
    };
  }
}

/**
 * Raw symbol row from database (SQLite uses integers for booleans)
 */
interface RawSymbolRow {
  id: number;
  repo_id: string;
  commit_id: number;
  name: string;
  qualified_name: string;
  symbol_kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  visibility: string | null;
  is_async: number;
  is_static: number;
  is_exported: number;
  return_type: string | null;
  parent_symbol_id: number | null;
  content_hash: string;
}

/**
 * Raw usage row from database
 */
interface RawUsageRow {
  id: number;
  commit_id: number;
  symbol_name: string;
  file_path: string;
  line: number;
  col: number;
  usage_type: string;
  enclosing_symbol_id: number | null;
  definition_symbol_id: number | null;
}
