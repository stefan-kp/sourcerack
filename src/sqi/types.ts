/**
 * Structured Query Index (SQI) types for SourceRack
 *
 * Types and interfaces for the deterministic structure index that stores
 * rich AST information from Tree-sitter and enables exact code queries.
 */

/**
 * Symbol kinds that can be extracted from code
 *
 * More granular than parser SymbolType for detailed structural queries.
 */
export enum SymbolKind {
  // Basis
  FUNCTION = 'function',
  CLASS = 'class',
  METHOD = 'method',

  // Erweitert
  INTERFACE = 'interface',
  TRAIT = 'trait',
  ENUM = 'enum',
  TYPE_ALIAS = 'type_alias',

  // Granular
  PROPERTY = 'property',
  FIELD = 'field',
  CONSTANT = 'constant',
  VARIABLE = 'variable',

  // Structural
  NAMESPACE = 'namespace',
  MODULE = 'module',

  // Special
  CONSTRUCTOR = 'constructor',
  GETTER = 'getter',
  SETTER = 'setter',
}

/**
 * Visibility modifiers
 */
export type Visibility = 'public' | 'private' | 'protected' | 'internal' | 'package';

/**
 * Usage types for symbol references
 */
export type UsageType =
  | 'call'        // Function/method call
  | 'read'        // Variable read
  | 'write'       // Variable write/assignment
  | 'extend'      // Class extends
  | 'implement'   // Interface implementation
  | 'type_ref'    // Type reference
  | 'import'      // Import usage
  | 'decorator'   // Decorator usage
  | 'instantiate' // new Class()
  | 'other';

/**
 * Import types for different module systems
 */
export type ImportType =
  | 'es_import'   // ES modules (import/export)
  | 'es_export'   // ES export statement
  | 'commonjs'    // CommonJS (require/module.exports)
  | 'python'      // Python import/from
  | 'require'     // Ruby require
  | 'require_relative' // Ruby require_relative
  | 'go'          // Go import
  | 'rust'        // Rust use
  | 'java';       // Java import

/**
 * Docstring format types
 */
export type DocType =
  | 'jsdoc'       // JavaScript JSDoc
  | 'pydoc'       // Python docstrings
  | 'rdoc'        // Ruby documentation (RDoc/YARD)
  | 'rustdoc'     // Rust documentation
  | 'godoc'       // Go documentation
  | 'javadoc'     // Java documentation
  | 'other';

// ==================== Database Records ====================

/**
 * Symbol definition record (from symbols table)
 */
export interface SymbolRecord {
  id: number;
  repo_id: string;
  commit_id: number;

  // Identification
  name: string;
  qualified_name: string;
  symbol_kind: SymbolKind;

  // Location
  file_path: string;
  start_line: number;
  end_line: number;

  // Metadata
  visibility: Visibility | null;
  is_async: boolean;
  is_static: boolean;
  is_exported: boolean;
  return_type: string | null;

  // Hierarchy
  parent_symbol_id: number | null;

  // Dedup
  content_hash: string;
}

/**
 * Symbol parameter record (for functions/methods)
 */
export interface SymbolParameterRecord {
  id: number;
  symbol_id: number;
  position: number;
  name: string;
  type_annotation: string | null;
  is_optional: number; // SQLite stores as INTEGER (0 or 1)
}

/**
 * Symbol docstring record
 */
export interface SymbolDocstringRecord {
  id: number;
  symbol_id: number;
  doc_type: DocType;
  raw_text: string;
  description: string | null;
}

/**
 * Usage/reference record
 */
export interface UsageRecord {
  id: number;
  commit_id: number;
  symbol_name: string;
  file_path: string;
  line: number;
  column: number;
  usage_type: UsageType;
  enclosing_symbol_id: number | null;
  definition_symbol_id: number | null;
}

/**
 * Import statement record
 */
export interface ImportRecord {
  id: number;
  commit_id: number;
  file_path: string;
  line: number;
  import_type: ImportType;
  module_specifier: string;
  resolved_path: string | null;
}

/**
 * Import binding record (individual imported names)
 */
export interface ImportBindingRecord {
  id: number;
  import_id: number;
  imported_name: string;
  local_name: string;
  is_type_only: number; // SQLite stores as INTEGER (0 or 1)
}

// ==================== Extraction Types ====================

/**
 * Extracted symbol (before storage)
 */
export interface ExtractedSymbol {
  name: string;
  qualified_name: string;
  symbol_kind: SymbolKind;
  file_path: string;
  start_line: number;
  end_line: number;
  visibility?: Visibility | undefined;
  is_async?: boolean | undefined;
  is_static?: boolean | undefined;
  is_exported?: boolean | undefined;
  return_type?: string | undefined;
  content_hash: string;

  // Nested data
  parameters?: ExtractedParameter[] | undefined;
  docstring?: ExtractedDocstring | undefined;

  // Children (methods, properties, etc.)
  children?: ExtractedSymbol[] | undefined;
}

/**
 * Extracted parameter
 */
export interface ExtractedParameter {
  position: number;
  name: string;
  type_annotation?: string | undefined;
  is_optional?: boolean | undefined;
}

/**
 * Extracted docstring
 */
export interface ExtractedDocstring {
  doc_type: DocType;
  raw_text: string;
  description?: string | undefined;
}

/**
 * Extracted usage/reference
 */
export interface ExtractedUsage {
  symbol_name: string;
  file_path: string;
  line: number;
  column: number;
  usage_type: UsageType;
  enclosing_symbol_qualified_name?: string | undefined;
}

/**
 * Extracted import statement
 */
export interface ExtractedImport {
  file_path: string;
  line: number;
  import_type: ImportType;
  module_specifier: string;
  resolved_path?: string;
  bindings: ExtractedImportBinding[];
}

/**
 * Extracted import binding
 */
export interface ExtractedImportBinding {
  imported_name: string;
  local_name: string;
  is_type_only?: boolean;
}

/**
 * File extraction result
 */
export interface FileExtractionResult {
  file_path: string;
  language: string;
  symbols: ExtractedSymbol[];
  usages: ExtractedUsage[];
  imports: ExtractedImport[];
  success: boolean;
  error?: string;
}

// ==================== Query Types ====================

/**
 * Symbol info returned from queries
 */
export interface SymbolInfo {
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  file_path: string;
  start_line: number;
  end_line: number;
  visibility?: Visibility | undefined;
  is_async?: boolean | undefined;
  is_static?: boolean | undefined;
  is_exported?: boolean | undefined;
  return_type?: string | undefined;
  docstring?: string | undefined;
  parameters?: ParameterInfo[] | undefined;
}

/**
 * Parameter info returned from queries
 */
export interface ParameterInfo {
  name: string;
  type?: string | undefined;
  optional?: boolean | undefined;
}

/**
 * Usage info returned from queries
 */
export interface UsageInfo {
  file_path: string;
  line: number;
  column: number;
  usage_type: UsageType;
  context_snippet: string;
  enclosing_symbol?: string | undefined;
}

/**
 * Import info returned from queries
 */
export interface ImportInfo {
  file_path: string;
  line: number;
  import_type: ImportType;
  module_specifier: string;
  resolved_path?: string | undefined;
  bindings: ImportBindingInfo[];
}

/**
 * Import binding info
 */
export interface ImportBindingInfo {
  imported_name: string;
  local_name: string;
  is_type_only: boolean;
}

// ==================== Query Input/Output Types ====================

/**
 * Input for find_definition query
 */
export interface FindDefinitionInput {
  repo_path: string;
  commit: string;
  symbol_name: string;
  symbol_kind?: SymbolKind | undefined;
}

/**
 * Output for find_definition query
 */
export interface FindDefinitionOutput {
  success: boolean;
  definitions: SymbolInfo[];
  error?: string | undefined;
}

/**
 * Input for find_usages query
 */
export interface FindUsagesInput {
  repo_path: string;
  commit: string;
  symbol_name: string;
  file_path?: string | undefined;
}

/**
 * Output for find_usages query
 */
export interface FindUsagesOutput {
  success: boolean;
  usages: UsageInfo[];
  total_count: number;
  error?: string | undefined;
}

/**
 * Input for find_hierarchy query
 */
export interface FindHierarchyInput {
  repo_path: string;
  commit: string;
  symbol_name: string;
  direction: 'children' | 'parents' | 'both';
}

/**
 * Output for find_hierarchy query
 */
export interface FindHierarchyOutput {
  success: boolean;
  symbol?: SymbolInfo | undefined;
  children?: SymbolInfo[] | undefined;
  parents?: string[] | undefined;
  error?: string | undefined;
}

/**
 * Input for find_imports query
 */
export interface FindImportsInput {
  repo_path: string;
  commit: string;
  file_path: string;
}

/**
 * Output for find_imports query
 */
export interface FindImportsOutput {
  success: boolean;
  imports: ImportInfo[];
  error?: string;
}

/**
 * Input for find_importers query
 */
export interface FindImportersInput {
  repo_path: string;
  commit: string;
  module: string;
}

/**
 * Output for find_importers query
 */
export interface FindImportersOutput {
  success: boolean;
  importers: {
    file_path: string;
    line: number;
    bindings: ImportBindingInfo[];
  }[];
  error?: string;
}

// ==================== SQI Errors ====================

/**
 * SQI error codes
 */
export enum SQIErrorCode {
  /** Database operation failed */
  DATABASE_ERROR = 'DATABASE_ERROR',
  /** Symbol not found */
  SYMBOL_NOT_FOUND = 'SYMBOL_NOT_FOUND',
  /** File not found */
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  /** Commit not indexed */
  COMMIT_NOT_INDEXED = 'COMMIT_NOT_INDEXED',
  /** Language not supported */
  UNSUPPORTED_LANGUAGE = 'UNSUPPORTED_LANGUAGE',
  /** Extraction failed */
  EXTRACTION_FAILED = 'EXTRACTION_FAILED',
}

/**
 * SQI Error class
 */
export class SQIError extends Error {
  constructor(
    message: string,
    public readonly code: SQIErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'SQIError';
  }
}

// ==================== Codebase Summary Types ====================

/**
 * Language statistics for codebase summary
 */
export interface LanguageStats {
  language: string;
  file_count: number;
  symbol_count: number;
  percentage: number;
}

/**
 * Module/directory statistics
 */
export interface ModuleStats {
  path: string;
  file_count: number;
  symbol_count: number;
  main_symbols: string[];
}

/**
 * Hotspot - symbol with most usages
 */
export interface HotspotInfo {
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  file_path: string;
  usage_count: number;
}

/**
 * Entry point detection
 */
export interface EntryPointInfo {
  file_path: string;
  type: 'main' | 'index' | 'entry' | 'cli' | 'server' | 'app';
  exports: string[];
}

/**
 * External dependency info
 */
export interface DependencyInfo {
  name: string;
  import_count: number;
  importers: string[];
}

/**
 * Input for codebase_summary query
 */
export interface CodebaseSummaryInput {
  repo_path: string;
  commit: string;
  include_hotspots?: boolean;
  include_dependencies?: boolean;
  max_modules?: number;
  max_hotspots?: number;
}

/**
 * Output for codebase_summary query
 */
export interface CodebaseSummaryOutput {
  success: boolean;
  summary?: {
    total_files: number;
    total_symbols: number;
    total_usages: number;
    total_imports: number;
    languages: LanguageStats[];
    modules: ModuleStats[];
    entry_points: EntryPointInfo[];
    hotspots: HotspotInfo[];
    dependencies: DependencyInfo[];
    symbol_breakdown: { kind: SymbolKind; count: number }[];
  };
  error?: string;
}

/**
 * Input for get_symbol_context query
 */
export interface GetSymbolContextInput {
  repo_path: string;
  commit: string;
  symbol_name: string;
  include_usages?: boolean;
  include_source?: boolean;
  max_usages?: number;
}

/**
 * Output for get_symbol_context query
 */
export interface GetSymbolContextOutput {
  success: boolean;
  context?: {
    symbol: SymbolInfo;
    source_code?: string;
    usages: UsageInfo[];
    imports_used: string[];
    imported_by: string[];
    related_symbols: SymbolInfo[];
  };
  error?: string;
}
