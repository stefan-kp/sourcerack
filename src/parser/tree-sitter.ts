/**
 * tree-sitter integration for SourceRack
 *
 * Initializes and manages tree-sitter parsers for supported languages.
 * Uses the LanguageRegistry for dynamic grammar management.
 */

import Parser from 'tree-sitter';
import {
  getLanguageRegistry,
  type LanguageRegistry,
} from './language-registry.js';
import { ParserError, ParserErrorCode } from './types.js';

/**
 * Tree-sitter parser wrapper
 */
class TreeSitterParser {
  private parser: Parser;
  private registry: LanguageRegistry;
  private initialized = false;

  constructor(options: { autoInstall?: boolean } = {}) {
    this.parser = new Parser();
    this.registry = getLanguageRegistry(options);
  }

  /**
   * Initialize the parser with core language grammars
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize core languages
      await this.registry.initializeCore();
      this.initialized = true;
    } catch (error) {
      throw new ParserError(
        'Failed to initialize tree-sitter parsers',
        ParserErrorCode.GRAMMAR_NOT_LOADED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get language ID from file extension
   */
  getLanguageForFile(filePath: string): string | null {
    return this.registry.getLanguageForFile(filePath);
  }

  /**
   * Check if a language is supported (has a definition in registry)
   */
  isLanguageSupported(languageId: string): boolean {
    return this.registry.getLanguage(languageId) !== null;
  }

  /**
   * Check if a language grammar is loaded and ready
   */
  isLanguageLoaded(languageId: string): boolean {
    return this.registry.isLanguageLoaded(languageId);
  }

  /**
   * Ensure a language grammar is available (load/install if needed)
   */
  async ensureLanguage(languageId: string): Promise<boolean> {
    return this.registry.ensureGrammar(languageId);
  }

  /**
   * Parse source code
   */
  parse(code: string, languageId: string): Parser.Tree {
    const grammar = this.registry.getGrammar(languageId);
    if (grammar === null) {
      throw new ParserError(
        `Grammar not loaded for language: ${languageId}`,
        ParserErrorCode.GRAMMAR_NOT_LOADED
      );
    }

    this.parser.setLanguage(grammar as Parser.Language);
    return this.parser.parse(code);
  }

  /**
   * Parse code with automatic grammar loading
   * Will attempt to load/install grammar if not available
   */
  async parseWithAutoLoad(code: string, languageId: string): Promise<Parser.Tree> {
    const loaded = await this.ensureLanguage(languageId);
    if (!loaded) {
      throw new ParserError(
        `Could not load grammar for language: ${languageId}`,
        ParserErrorCode.GRAMMAR_NOT_LOADED
      );
    }

    return this.parse(code, languageId);
  }

  /**
   * Get list of loaded languages
   */
  getLoadedLanguages(): string[] {
    return this.registry
      .getAllLanguages()
      .filter((lang) => this.registry.isLanguageLoaded(lang.id))
      .map((lang) => lang.id);
  }

  /**
   * Get list of all supported languages (from registry)
   */
  getSupportedLanguages(): string[] {
    return this.registry.getAllLanguages().map((lang) => lang.id);
  }

  /**
   * Get missing grammars for a list of files
   */
  async getMissingGrammarsForFiles(filePaths: string[]): Promise<string[]> {
    const missing = await this.registry.getMissingGrammars(filePaths);
    return missing.map((lang) => lang.id);
  }

  /**
   * Pre-install grammars for a list of files
   */
  async preInstallGrammarsForFiles(
    filePaths: string[]
  ): Promise<{ installed: string[]; failed: string[] }> {
    const results = await this.registry.preInstallGrammars(filePaths);

    const installed = results
      .filter((r) => r.success)
      .map((r) => r.language);
    const failed = results
      .filter((r) => !r.success)
      .map((r) => r.language);

    return { installed, failed };
  }

  /**
   * Get the underlying registry
   */
  getRegistry(): LanguageRegistry {
    return this.registry;
  }
}

// Singleton instance
let parserInstance: TreeSitterParser | null = null;

/**
 * Get the tree-sitter parser singleton
 */
export function getTreeSitterParser(
  options?: { autoInstall?: boolean }
): TreeSitterParser {
  parserInstance ??= new TreeSitterParser(options);
  return parserInstance;
}

/**
 * Initialize the tree-sitter parser
 */
export async function initializeTreeSitter(
  options?: { autoInstall?: boolean }
): Promise<void> {
  const parser = getTreeSitterParser(options);
  await parser.initialize();
}

/**
 * Parse source code using tree-sitter
 */
export function parseCode(code: string, languageId: string): Parser.Tree {
  return getTreeSitterParser().parse(code, languageId);
}

/**
 * Parse code with automatic grammar loading
 */
export async function parseCodeWithAutoLoad(
  code: string,
  languageId: string
): Promise<Parser.Tree> {
  return getTreeSitterParser().parseWithAutoLoad(code, languageId);
}

/**
 * Detect language from file path
 */
export function detectLanguage(filePath: string): string | null {
  return getTreeSitterParser().getLanguageForFile(filePath);
}

/**
 * Check if a language is supported and loaded
 */
export function isLanguageReady(languageId: string): boolean {
  const parser = getTreeSitterParser();
  return parser.isLanguageSupported(languageId) && parser.isLanguageLoaded(languageId);
}

/**
 * Ensure language grammar is available
 */
export async function ensureLanguageGrammar(languageId: string): Promise<boolean> {
  return getTreeSitterParser().ensureLanguage(languageId);
}

/**
 * Get missing grammars for files
 */
export async function getMissingGrammars(filePaths: string[]): Promise<string[]> {
  return getTreeSitterParser().getMissingGrammarsForFiles(filePaths);
}

/**
 * Pre-install grammars for files
 */
export async function preInstallGrammars(
  filePaths: string[]
): Promise<{ installed: string[]; failed: string[] }> {
  return getTreeSitterParser().preInstallGrammarsForFiles(filePaths);
}

// ============================================================================
// LEGACY EXPORTS (for backward compatibility)
// ============================================================================

/**
 * @deprecated Use getTreeSitterParser() instead
 */
export function getTreeSitterRegistry(): TreeSitterParser {
  return getTreeSitterParser();
}
