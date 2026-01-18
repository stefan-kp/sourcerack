/**
 * Parser types for SourceRack
 */

/**
 * Symbol types that can be extracted from code
 */
export type SymbolType = 'function' | 'class' | 'method' | 'module' | 'other';

/**
 * A code chunk extracted from source code
 */
export interface CodeChunk {
  /** Relative file path */
  path: string;
  /** Symbol name (function name, class name, etc.) */
  symbol: string;
  /** Type of symbol */
  symbolType: SymbolType;
  /** Programming language */
  language: string;
  /** Starting line number (1-based) */
  startLine: number;
  /** Ending line number (1-based, inclusive) */
  endLine: number;
  /** Source code content */
  content: string;
}

/**
 * Result of parsing a file
 */
export interface ParseResult {
  /** File path */
  path: string;
  /** Language detected */
  language: string;
  /** Extracted chunks */
  chunks: CodeChunk[];
  /** Whether parsing was successful */
  success: boolean;
  /** Error message if parsing failed */
  error?: string;
}

/**
 * Core supported languages (shipped by default)
 * Note: Additional languages can be installed on-demand via the language registry
 */
export const CORE_LANGUAGES = [
  'javascript',
  'typescript',
  'tsx',
  'python',
] as const;

export type CoreLanguage = (typeof CORE_LANGUAGES)[number];

/**
 * All known languages (for typing purposes)
 * The actual list is managed by the language registry (languages.yml)
 */
export const KNOWN_LANGUAGES = [
  'javascript',
  'typescript',
  'tsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'c_sharp',
  'ruby',
  'php',
  'kotlin',
  'swift',
  'scala',
  'json',
  'yaml',
  'toml',
  'html',
  'css',
  'scss',
  'bash',
  'lua',
  'hcl',
  'dockerfile',
  'sql',
  'markdown',
] as const;

export type KnownLanguage = (typeof KNOWN_LANGUAGES)[number];

/**
 * @deprecated Use KnownLanguage instead. Languages are now managed dynamically.
 */
export type SupportedLanguage = string;

/**
 * @deprecated Use language registry instead. Extensions are now in languages.yml.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
};

/**
 * Parser error
 */
export class ParserError extends Error {
  constructor(
    message: string,
    public readonly code: ParserErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ParserError';
  }
}

/**
 * Parser error codes
 */
export enum ParserErrorCode {
  /** Language not supported */
  UNSUPPORTED_LANGUAGE = 'UNSUPPORTED_LANGUAGE',
  /** Failed to parse file */
  PARSE_FAILED = 'PARSE_FAILED',
  /** Grammar not loaded */
  GRAMMAR_NOT_LOADED = 'GRAMMAR_NOT_LOADED',
}
