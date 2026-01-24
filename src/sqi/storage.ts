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
import {
  ExtractedEndpoint,
  EndpointRecord,
  EndpointParamRecord,
  HttpMethod,
  Framework,
} from './extractors/api/types.js';

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

-- Trigrams for fuzzy symbol search
CREATE TABLE IF NOT EXISTS symbol_trigrams (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  trigram TEXT NOT NULL,
  PRIMARY KEY (symbol_id, trigram)
);

CREATE INDEX IF NOT EXISTS idx_trigrams_trigram ON symbol_trigrams(trigram);

-- API Endpoints for framework-agnostic route discovery
CREATE TABLE IF NOT EXISTS api_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id INTEGER NOT NULL,

  -- HTTP routing
  http_method TEXT NOT NULL,
  path TEXT NOT NULL,

  -- Location
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,

  -- Framework
  framework TEXT NOT NULL,

  -- Handler (link to symbols)
  handler_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  handler_type TEXT NOT NULL,

  -- Documentation
  summary TEXT,
  description TEXT,
  tags TEXT,                     -- JSON array

  -- Middleware/Dependencies
  middleware TEXT,               -- JSON array
  dependencies TEXT,             -- JSON array (FastAPI Depends)

  -- Response
  response_model TEXT,           -- Model/DTO Name
  response_status INTEGER,
  response_content_type TEXT,

  -- Request Body
  body_schema TEXT,              -- Model Name or JSON Schema
  body_content_type TEXT,

  -- MCP specific
  mcp_tool_name TEXT,
  mcp_input_schema TEXT,

  FOREIGN KEY (commit_id) REFERENCES indexed_commits(id) ON DELETE CASCADE
);

-- Endpoint parameters (path, query, header params)
CREATE TABLE IF NOT EXISTS endpoint_params (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL,

  name TEXT NOT NULL,
  location TEXT NOT NULL,        -- 'path', 'query', 'header', 'cookie', 'body'
  param_type TEXT,               -- 'int', 'str', 'UUID', etc.
  required INTEGER NOT NULL,     -- 0 or 1
  default_value TEXT,
  description TEXT,

  FOREIGN KEY (endpoint_id) REFERENCES api_endpoints(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_endpoints_method ON api_endpoints(http_method);
CREATE INDEX IF NOT EXISTS idx_endpoints_path ON api_endpoints(path);
CREATE INDEX IF NOT EXISTS idx_endpoints_framework ON api_endpoints(framework);
CREATE INDEX IF NOT EXISTS idx_endpoints_commit ON api_endpoints(commit_id);
CREATE INDEX IF NOT EXISTS idx_endpoints_file ON api_endpoints(commit_id, file_path);
CREATE INDEX IF NOT EXISTS idx_params_endpoint ON endpoint_params(endpoint_id);
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

    // Insert trigrams for fuzzy search
    this.insertTrigrams(symbolId, symbol.name);

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
   * Find usages pointing to a definition (who calls this symbol?)
   */
  findUsagesByDefinition(definitionSymbolId: number): UsageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM usages WHERE definition_symbol_id = ? ORDER BY file_path, line')
      .all(definitionSymbolId) as RawUsageRow[];

    return rows.map((row) => this.mapUsageRow(row));
  }

  /**
   * Find usages originating from a symbol (what does this symbol call?)
   * This is the inverse of findUsagesByDefinition - it finds callees instead of callers.
   */
  findUsagesByEnclosing(enclosingSymbolId: number, usageType?: UsageType): UsageRecord[] {
    let query = 'SELECT * FROM usages WHERE enclosing_symbol_id = ?';
    const params: (number | string)[] = [enclosingSymbolId];

    if (usageType) {
      query += ' AND usage_type = ?';
      params.push(usageType);
    }

    query += ' ORDER BY file_path, line';

    const rows = this.db.prepare(query).all(...params) as RawUsageRow[];
    return rows.map((row) => this.mapUsageRow(row));
  }

  /**
   * Get callees with full symbol details.
   * Returns the symbols that the given symbol calls.
   */
  getCalleesWithDetails(
    enclosingSymbolId: number,
    commitId: number
  ): {
    symbol_id: number;
    name: string;
    qualified_name: string;
    symbol_kind: string;
    file_path: string;
    start_line: number;
  }[] {
    // Find all usages where this symbol is the caller (enclosing),
    // and join with symbols to get the callee details
    return this.db
      .prepare(`
        SELECT DISTINCT s.id as symbol_id, s.name, s.qualified_name, s.symbol_kind, s.file_path, s.start_line
        FROM usages u
        JOIN symbols s ON u.definition_symbol_id = s.id
        WHERE u.enclosing_symbol_id = ?
          AND u.usage_type = 'call'
          AND s.commit_id = ?
        ORDER BY s.file_path, s.start_line
      `)
      .all(enclosingSymbolId, commitId) as {
      symbol_id: number;
      name: string;
      qualified_name: string;
      symbol_kind: string;
      file_path: string;
      start_line: number;
    }[];
  }

  /**
   * Get callers with full symbol details.
   * Returns the symbols that call the given symbol.
   */
  getCallersWithDetails(
    definitionSymbolId: number,
    commitId: number
  ): {
    symbol_id: number;
    name: string;
    qualified_name: string;
    symbol_kind: string;
    file_path: string;
    start_line: number;
  }[] {
    // Find all usages where this symbol is called (definition),
    // and join with symbols to get the caller details
    return this.db
      .prepare(`
        SELECT DISTINCT s.id as symbol_id, s.name, s.qualified_name, s.symbol_kind, s.file_path, s.start_line
        FROM usages u
        JOIN symbols s ON u.enclosing_symbol_id = s.id
        WHERE u.definition_symbol_id = ?
          AND u.usage_type = 'call'
          AND s.commit_id = ?
        ORDER BY s.file_path, s.start_line
      `)
      .all(definitionSymbolId, commitId) as {
      symbol_id: number;
      name: string;
      qualified_name: string;
      symbol_kind: string;
      file_path: string;
      start_line: number;
    }[];
  }

  /**
   * Find usages with fuzzy symbol name matching
   * Returns exact matches and similar symbol names with their usages
   */
  findUsagesWithFuzzy(
    commitId: number,
    symbolName: string,
    options: {
      filePath?: string;
      minSimilarity?: number;
      fuzzyLimit?: number;
    } = {}
  ): {
    exact: UsageRecord[];
    fuzzy: { symbolName: string; similarity: number; usages: UsageRecord[] }[];
  } {
    const { filePath, minSimilarity = 0.3, fuzzyLimit = 5 } = options;

    // First, find exact matches
    const exact = this.findUsagesByName(commitId, symbolName, filePath);

    // Get trigrams for the search term
    const searchTrigrams = SQIStorage.generateTrigrams(symbolName);
    if (searchTrigrams.length === 0) {
      return { exact, fuzzy: [] };
    }

    // Find similar symbol names from usages table using trigrams
    // We need to find distinct symbol_names that have similar trigrams
    const trigramPlaceholders = searchTrigrams.map(() => '?').join(',');

    // This query finds symbol names used in usages that share trigrams with our search
    // We join through symbols that have those trigrams
    const query = `
      WITH matched_symbols AS (
        SELECT DISTINCT s.name, s.id
        FROM symbols s
        INNER JOIN symbol_trigrams st ON st.symbol_id = s.id
        WHERE s.commit_id = ? AND st.trigram IN (${trigramPlaceholders})
        AND s.name != ?
      ),
      symbol_trigram_counts AS (
        SELECT ms.name, ms.id, COUNT(DISTINCT st.trigram) as shared_count
        FROM matched_symbols ms
        INNER JOIN symbol_trigrams st ON st.symbol_id = ms.id
        WHERE st.trigram IN (${trigramPlaceholders})
        GROUP BY ms.name, ms.id
      ),
      total_trigrams AS (
        SELECT stc.name, stc.id, stc.shared_count,
               (SELECT COUNT(DISTINCT trigram) FROM symbol_trigrams WHERE symbol_id = stc.id) as total_count
        FROM symbol_trigram_counts stc
      )
      SELECT name,
             CAST(shared_count AS REAL) / (total_count + ? - shared_count) as similarity
      FROM total_trigrams
      WHERE CAST(shared_count AS REAL) / (total_count + ? - shared_count) >= ?
      ORDER BY similarity DESC
      LIMIT ?
    `;

    const params = [
      commitId,
      ...searchTrigrams,
      symbolName,
      ...searchTrigrams,
      searchTrigrams.length,
      searchTrigrams.length,
      minSimilarity,
      fuzzyLimit * 2, // Get more to account for filtering
    ];

    const similarNames = this.db.prepare(query).all(...params) as {
      name: string;
      similarity: number;
    }[];

    // For each similar symbol name, find its usages
    const fuzzy: { symbolName: string; similarity: number; usages: UsageRecord[] }[] = [];

    for (const match of similarNames) {
      const usages = this.findUsagesByName(commitId, match.name, filePath);
      if (usages.length > 0) {
        fuzzy.push({
          symbolName: match.name,
          similarity: match.similarity,
          usages,
        });
      }
      if (fuzzy.length >= fuzzyLimit) break;
    }

    return { exact, fuzzy };
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

      // Step 2.5: Copy symbol_trigrams with mapped symbol_id
      const trigramsToCopy = this.db.prepare(`
        SELECT st.symbol_id, st.trigram
        FROM symbol_trigrams st
        JOIN symbols s ON st.symbol_id = s.id
        WHERE s.commit_id = ? ${excludeClause.replace(/file_path/g, 's.file_path')}
      `).all(sourceCommitId, ...excludedFiles) as {
        symbol_id: number;
        trigram: string;
      }[];

      const insertTrigram = this.db.prepare(`
        INSERT OR IGNORE INTO symbol_trigrams (symbol_id, trigram) VALUES (?, ?)
      `);

      for (const tg of trigramsToCopy) {
        const newSymbolId = symbolIdMap.get(tg.symbol_id);
        if (newSymbolId !== undefined) {
          insertTrigram.run(newSymbolId, tg.trigram);
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

  /**
   * Get symbols with zero usages (dead code candidates).
   * Focuses on top-level symbols that could be unused exports or internal code.
   */
  getDeadSymbols(
    commitId: number,
    options: { exportedOnly?: boolean; limit?: number } = {}
  ): {
    symbol_id: number;
    name: string;
    qualified_name: string;
    symbol_kind: string;
    file_path: string;
    start_line: number;
    end_line: number;
    is_exported: boolean;
  }[] {
    const { exportedOnly = false, limit = 50 } = options;

    let whereClause = `s.commit_id = ?
      AND s.symbol_kind IN ('function', 'method', 'class', 'interface', 'type_alias')
      AND s.parent_symbol_id IS NULL`;

    if (exportedOnly) {
      whereClause += ' AND s.is_exported = 1';
    }

    return this.db
      .prepare(
        `SELECT s.id as symbol_id, s.name, s.qualified_name, s.symbol_kind,
                s.file_path, s.start_line, s.end_line, s.is_exported
         FROM symbols s
         LEFT JOIN usages u ON u.definition_symbol_id = s.id
         WHERE ${whereClause}
         GROUP BY s.id
         HAVING COUNT(u.id) = 0
         ORDER BY s.is_exported DESC, s.file_path, s.start_line
         LIMIT ?`
      )
      .all(commitId, limit) as {
      symbol_id: number;
      name: string;
      qualified_name: string;
      symbol_kind: string;
      file_path: string;
      start_line: number;
      end_line: number;
      is_exported: boolean;
    }[];
  }

  /**
   * Get transitive impact of changing a symbol.
   * Uses recursive CTE to find all symbols that directly or transitively use this symbol.
   */
  getTransitiveImpact(
    commitId: number,
    symbolId: number,
    maxDepth: number = 3
  ): {
    symbol_id: number;
    name: string;
    qualified_name: string;
    file_path: string;
    start_line: number;
    depth: number;
    usage_type: string;
  }[] {
    return this.db
      .prepare(
        `WITH RECURSIVE impact_chain AS (
          -- Base case: direct usages
          SELECT u.enclosing_symbol_id as symbol_id, 1 as depth, u.usage_type
          FROM usages u
          WHERE u.definition_symbol_id = ? AND u.enclosing_symbol_id IS NOT NULL

          UNION

          -- Recursive case: usages of the enclosing symbols
          SELECT u2.enclosing_symbol_id, ic.depth + 1, u2.usage_type
          FROM impact_chain ic
          JOIN usages u2 ON u2.definition_symbol_id = ic.symbol_id
          WHERE ic.depth < ? AND u2.enclosing_symbol_id IS NOT NULL
        )
        SELECT DISTINCT s.id as symbol_id, s.name, s.qualified_name,
               s.file_path, s.start_line, MIN(ic.depth) as depth, ic.usage_type
        FROM impact_chain ic
        JOIN symbols s ON s.id = ic.symbol_id
        WHERE s.commit_id = ?
        GROUP BY s.id
        ORDER BY depth, s.file_path`
      )
      .all(symbolId, maxDepth, commitId) as {
      symbol_id: number;
      name: string;
      qualified_name: string;
      file_path: string;
      start_line: number;
      depth: number;
      usage_type: string;
    }[];
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

  getImportFiles(commitId: number): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT file_path FROM imports WHERE commit_id = ? ORDER BY file_path`)
      .all(commitId) as { file_path: string }[];
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

  // ==================== Trigram / Fuzzy Search ====================

  /**
   * Generate trigrams from a string
   * Pads the string with spaces for edge trigrams
   */
  static generateTrigrams(text: string): string[] {
    // Normalize: lowercase, replace non-alphanumeric with spaces
    const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, ' ');
    // Pad with spaces for edge matching
    const padded = `  ${normalized}  `;
    
    const trigrams = new Set<string>();
    for (let i = 0; i <= padded.length - 3; i++) {
      const trigram = padded.slice(i, i + 3);
      // Skip pure whitespace trigrams
      if (trigram.trim().length > 0) {
        trigrams.add(trigram);
      }
    }
    return Array.from(trigrams);
  }

  /**
   * Insert trigrams for a symbol
   */
  insertTrigrams(symbolId: number, symbolName: string): void {
    const trigrams = SQIStorage.generateTrigrams(symbolName);
    
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO symbol_trigrams (symbol_id, trigram) VALUES (?, ?)'
    );
    
    for (const trigram of trigrams) {
      stmt.run(symbolId, trigram);
    }
  }

  /**
   * Find symbols by fuzzy matching using trigram similarity
   * Returns symbols sorted by similarity score (Jaccard index)
   */
  findSymbolsFuzzy(
    commitId: number,
    searchTerm: string,
    options: {
      minSimilarity?: number;
      limit?: number;
      kind?: SymbolKind;
    } = {}
  ): { symbol: SymbolRecord; similarity: number; isExact: boolean }[] {
    const { minSimilarity = 0.3, limit = 20, kind } = options;
    
    // Generate trigrams for search term
    const searchTrigrams = SQIStorage.generateTrigrams(searchTerm);
    if (searchTrigrams.length === 0) {
      return [];
    }

    // Build query to find matching symbols with trigram count
    const placeholders = searchTrigrams.map(() => '?').join(',');
    
    let query = `
      SELECT 
        s.*,
        COUNT(DISTINCT st.trigram) as matching_count,
        (SELECT COUNT(DISTINCT trigram) FROM symbol_trigrams WHERE symbol_id = s.id) as total_count
      FROM symbols s
      JOIN symbol_trigrams st ON s.id = st.symbol_id
      WHERE s.commit_id = ?
        AND st.trigram IN (${placeholders})
    `;
    
    const params: (number | string)[] = [commitId, ...searchTrigrams];
    
    if (kind) {
      query += ' AND s.symbol_kind = ?';
      params.push(kind);
    }
    
    query += `
      GROUP BY s.id
      HAVING matching_count > 0
      ORDER BY 
        (s.name = ?) DESC,
        (LOWER(s.name) = LOWER(?)) DESC,
        (matching_count * 1.0 / (total_count + ? - matching_count)) DESC
      LIMIT ?
    `;
    
    // Jaccard similarity: intersection / union
    // union = total_count + searchTrigrams.length - matching_count
    params.push(searchTerm, searchTerm, searchTrigrams.length, limit);
    
    const rows = this.db.prepare(query).all(...params) as (RawSymbolRow & {
      matching_count: number;
      total_count: number;
    })[];
    
    const searchTrigramCount = searchTrigrams.length;
    
    return rows
      .map((row) => {
        // Jaccard similarity: |A ∩ B| / |A ∪ B|
        const intersection = row.matching_count;
        const union = row.total_count + searchTrigramCount - intersection;
        const similarity = union > 0 ? intersection / union : 0;
        
        const isExact = row.name === searchTerm || row.name.toLowerCase() === searchTerm.toLowerCase();
        
        return {
          symbol: this.mapSymbolRow(row),
          similarity,
          isExact,
        };
      })
      .filter((result) => result.similarity >= minSimilarity || result.isExact);
  }

  /**
   * Find symbols with both exact and fuzzy matching
   * Returns exact matches first, then fuzzy matches
   */
  findSymbolsWithFuzzy(
    commitId: number,
    name: string,
    options: {
      kind?: SymbolKind;
      minSimilarity?: number;
      fuzzyLimit?: number;
    } = {}
  ): {
    exact: SymbolRecord[];
    fuzzy: { symbol: SymbolRecord; similarity: number }[];
  } {
    const { kind, minSimilarity = 0.3, fuzzyLimit = 10 } = options;
    
    // First, find exact matches
    const exact = this.findSymbolsByName(commitId, name, kind);
    const exactIds = new Set(exact.map((s) => s.id));
    
    // Then find fuzzy matches (excluding exact)
    const fuzzyOptions: { minSimilarity: number; limit: number; kind?: SymbolKind } = {
      minSimilarity,
      limit: fuzzyLimit + exact.length, // Get extra to account for exact matches
    };
    if (kind) {
      fuzzyOptions.kind = kind;
    }
    const fuzzyResults = this.findSymbolsFuzzy(commitId, name, fuzzyOptions);
    
    const fuzzy = fuzzyResults
      .filter((r) => !exactIds.has(r.symbol.id) && !r.isExact)
      .slice(0, fuzzyLimit)
      .map((r) => ({ symbol: r.symbol, similarity: r.similarity }));
    
    return { exact, fuzzy };
  }

  // ==================== API Endpoint Operations ====================

  /**
   * Insert an API endpoint
   */
  insertEndpoint(commitId: number, endpoint: ExtractedEndpoint): number {
    const stmt = this.db.prepare(`
      INSERT INTO api_endpoints (
        commit_id, http_method, path, file_path, start_line, end_line,
        framework, handler_symbol_id, handler_type,
        summary, description, tags, middleware, dependencies,
        response_model, response_status, response_content_type,
        body_schema, body_content_type,
        mcp_tool_name, mcp_input_schema
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      commitId,
      endpoint.http_method,
      endpoint.path,
      endpoint.file_path,
      endpoint.start_line,
      endpoint.end_line,
      endpoint.framework,
      null, // handler_symbol_id linked later
      endpoint.handler_type,
      endpoint.summary ?? null,
      endpoint.description ?? null,
      endpoint.tags.length > 0 ? JSON.stringify(endpoint.tags) : null,
      endpoint.middleware.length > 0 ? JSON.stringify(endpoint.middleware) : null,
      endpoint.dependencies.length > 0 ? JSON.stringify(endpoint.dependencies) : null,
      endpoint.response_model ?? null,
      endpoint.response_status ?? null,
      null, // response_content_type
      endpoint.body_schema ?? null,
      endpoint.body_content_type ?? null,
      endpoint.mcp_tool_name ?? null,
      endpoint.mcp_input_schema ?? null
    );

    const endpointId = result.lastInsertRowid as number;

    // Insert path params
    for (const paramName of endpoint.path_params) {
      this.insertEndpointParam(endpointId, {
        name: paramName,
        location: 'path',
        required: true,
      });
    }

    // Insert query params
    for (const param of endpoint.query_params) {
      const paramData: { name: string; location: string; type?: string; required?: boolean; default_value?: string; description?: string } = {
        name: param.name,
        location: param.location,
        required: param.required,
      };
      if (param.type) paramData.type = param.type;
      if (param.default_value) paramData.default_value = param.default_value;
      if (param.description) paramData.description = param.description;
      this.insertEndpointParam(endpointId, paramData);
    }

    return endpointId;
  }

  /**
   * Insert endpoint parameter
   */
  private insertEndpointParam(
    endpointId: number,
    param: { name: string; location: string; type?: string; required?: boolean; default_value?: string; description?: string }
  ): void {
    this.db.prepare(`
      INSERT INTO endpoint_params (endpoint_id, name, location, param_type, required, default_value, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      endpointId,
      param.name,
      param.location,
      param.type ?? null,
      param.required ? 1 : 0,
      param.default_value ?? null,
      param.description ?? null
    );
  }

  /**
   * Bulk insert endpoints
   */
  insertEndpoints(commitId: number, endpoints: ExtractedEndpoint[]): number[] {
    const insertAll = this.db.transaction(() => {
      const ids: number[] = [];
      for (const endpoint of endpoints) {
        const id = this.insertEndpoint(commitId, endpoint);
        ids.push(id);
      }
      return ids;
    });

    return insertAll();
  }

  /**
   * Get endpoint by ID
   */
  getEndpointById(id: number): EndpointRecord | null {
    const row = this.db
      .prepare('SELECT * FROM api_endpoints WHERE id = ?')
      .get(id) as RawEndpointRow | undefined;

    return row ? this.mapEndpointRow(row) : null;
  }

  /**
   * Find endpoints by HTTP method
   */
  findEndpointsByMethod(commitId: number, method: HttpMethod): EndpointRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM api_endpoints WHERE commit_id = ? AND http_method = ? ORDER BY path')
      .all(commitId, method) as RawEndpointRow[];

    return rows.map((row) => this.mapEndpointRow(row));
  }

  /**
   * Find endpoints by path pattern (LIKE query)
   */
  findEndpointsByPathPattern(commitId: number, pattern: string): EndpointRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM api_endpoints WHERE commit_id = ? AND path LIKE ? ORDER BY path')
      .all(commitId, pattern) as RawEndpointRow[];

    return rows.map((row) => this.mapEndpointRow(row));
  }

  /**
   * Find endpoints by framework
   */
  findEndpointsByFramework(commitId: number, framework: Framework): EndpointRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM api_endpoints WHERE commit_id = ? AND framework = ? ORDER BY path')
      .all(commitId, framework) as RawEndpointRow[];

    return rows.map((row) => this.mapEndpointRow(row));
  }

  /**
   * Get all endpoints for a commit
   */
  getAllEndpoints(commitId: number): EndpointRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM api_endpoints WHERE commit_id = ? ORDER BY path, http_method')
      .all(commitId) as RawEndpointRow[];

    return rows.map((row) => this.mapEndpointRow(row));
  }

  /**
   * Get endpoints in a file
   */
  getEndpointsInFile(commitId: number, filePath: string): EndpointRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM api_endpoints WHERE commit_id = ? AND file_path = ? ORDER BY start_line')
      .all(commitId, filePath) as RawEndpointRow[];

    return rows.map((row) => this.mapEndpointRow(row));
  }

  /**
   * Get endpoint parameters
   */
  getEndpointParams(endpointId: number): EndpointParamRecord[] {
    return this.db
      .prepare('SELECT * FROM endpoint_params WHERE endpoint_id = ? ORDER BY location, name')
      .all(endpointId) as EndpointParamRecord[];
  }

  /**
   * Find endpoints with flexible filtering
   */
  findEndpoints(
    commitId: number,
    options: {
      method?: HttpMethod;
      pathPattern?: string;
      framework?: Framework;
      limit?: number;
    } = {}
  ): EndpointRecord[] {
    const { method, pathPattern, framework, limit = 100 } = options;

    let query = 'SELECT * FROM api_endpoints WHERE commit_id = ?';
    const params: (number | string)[] = [commitId];

    if (method) {
      query += ' AND http_method = ?';
      params.push(method);
    }

    if (pathPattern) {
      query += ' AND path LIKE ?';
      params.push(pathPattern);
    }

    if (framework) {
      query += ' AND framework = ?';
      params.push(framework);
    }

    query += ' ORDER BY path, http_method LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as RawEndpointRow[];
    return rows.map((row) => this.mapEndpointRow(row));
  }

  /**
   * Get endpoint statistics for a commit
   */
  getEndpointStats(commitId: number): {
    total: number;
    by_method: { method: string; count: number }[];
    by_framework: { framework: string; count: number }[];
  } {
    const total = this.db
      .prepare('SELECT COUNT(*) as count FROM api_endpoints WHERE commit_id = ?')
      .get(commitId) as { count: number };

    const byMethod = this.db
      .prepare('SELECT http_method as method, COUNT(*) as count FROM api_endpoints WHERE commit_id = ? GROUP BY http_method ORDER BY count DESC')
      .all(commitId) as { method: string; count: number }[];

    const byFramework = this.db
      .prepare('SELECT framework, COUNT(*) as count FROM api_endpoints WHERE commit_id = ? GROUP BY framework ORDER BY count DESC')
      .all(commitId) as { framework: string; count: number }[];

    return {
      total: total.count,
      by_method: byMethod,
      by_framework: byFramework,
    };
  }

  /**
   * Link endpoint to its handler symbol
   */
  linkEndpointToHandler(endpointId: number, handlerSymbolId: number): void {
    this.db
      .prepare('UPDATE api_endpoints SET handler_symbol_id = ? WHERE id = ?')
      .run(handlerSymbolId, endpointId);
  }

  /**
   * Delete endpoints for a file
   */
  deleteEndpointsInFile(commitId: number, filePath: string): void {
    // First get endpoint IDs to delete their params
    const endpoints = this.db
      .prepare('SELECT id FROM api_endpoints WHERE commit_id = ? AND file_path = ?')
      .all(commitId, filePath) as { id: number }[];

    const deleteAll = this.db.transaction(() => {
      for (const { id } of endpoints) {
        this.db.prepare('DELETE FROM endpoint_params WHERE endpoint_id = ?').run(id);
      }
      this.db.prepare('DELETE FROM api_endpoints WHERE commit_id = ? AND file_path = ?').run(commitId, filePath);
    });

    deleteAll();
  }

  /**
   * Map raw endpoint row to EndpointRecord
   */
  private mapEndpointRow(row: RawEndpointRow): EndpointRecord {
    return {
      id: row.id,
      commit_id: row.commit_id,
      http_method: row.http_method as HttpMethod,
      path: row.path,
      file_path: row.file_path,
      start_line: row.start_line,
      end_line: row.end_line,
      framework: row.framework as Framework,
      handler_symbol_id: row.handler_symbol_id,
      handler_type: row.handler_type as EndpointRecord['handler_type'],
      summary: row.summary,
      description: row.description,
      tags: row.tags,
      middleware: row.middleware,
      dependencies: row.dependencies,
      response_model: row.response_model,
      response_status: row.response_status,
      response_content_type: row.response_content_type,
      body_schema: row.body_schema,
      body_content_type: row.body_content_type,
      mcp_tool_name: row.mcp_tool_name,
      mcp_input_schema: row.mcp_input_schema,
    };
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

/**
 * Raw endpoint row from database
 */
interface RawEndpointRow {
  id: number;
  commit_id: number;
  http_method: string;
  path: string;
  file_path: string;
  start_line: number;
  end_line: number;
  framework: string;
  handler_symbol_id: number | null;
  handler_type: string;
  summary: string | null;
  description: string | null;
  tags: string | null;
  middleware: string | null;
  dependencies: string | null;
  response_model: string | null;
  response_status: number | null;
  response_content_type: string | null;
  body_schema: string | null;
  body_content_type: string | null;
  mcp_tool_name: string | null;
  mcp_input_schema: string | null;
}
