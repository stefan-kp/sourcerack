/**
 * Symbol Extractor Registry for SQI
 *
 * Central registry for language-specific symbol extractors.
 * Allows registration and lookup of extractors by language.
 */

import Parser from 'tree-sitter';
import { SymbolExtractor } from './base.js';
import { TypeScriptExtractor } from './typescript.js';
import { PythonExtractor } from './python.js';
import { RubyExtractor } from './ruby.js';
import { FileExtractionResult } from '../types.js';
import { parseCode, initializeTreeSitter, ensureLanguageGrammar } from '../../parser/tree-sitter.js';

/**
 * Extractor registry for managing language-specific extractors
 */
export class ExtractorRegistry {
  private extractors = new Map<string, SymbolExtractor>();
  private initialized = false;

  constructor() {
    // Register built-in extractors
    this.register(new TypeScriptExtractor());
    this.register(new PythonExtractor());
    this.register(new RubyExtractor());
  }

  /**
   * Register an extractor
   */
  register(extractor: SymbolExtractor): void {
    this.extractors.set(extractor.language, extractor);

    // Also register aliases
    for (const alias of extractor.aliases) {
      this.extractors.set(alias, extractor);
    }
  }

  /**
   * Get extractor for a language
   */
  getExtractor(language: string): SymbolExtractor | null {
    return this.extractors.get(language) ?? null;
  }

  /**
   * Check if a language is supported
   */
  isSupported(language: string): boolean {
    return this.extractors.has(language);
  }

  /**
   * Get all supported languages
   */
  getSupportedLanguages(): string[] {
    return Array.from(this.extractors.keys());
  }

  /**
   * Extract symbols from a file
   *
   * @param filePath - Relative file path
   * @param content - File content
   * @param language - Programming language
   * @returns Extraction result
   */
  async extract(
    filePath: string,
    content: string,
    language: string
  ): Promise<FileExtractionResult> {
    // Ensure tree-sitter is initialized
    if (!this.initialized) {
      await initializeTreeSitter();
      this.initialized = true;
    }

    // Get extractor for language
    const extractor = this.getExtractor(language);
    if (!extractor) {
      return {
        file_path: filePath,
        language,
        symbols: [],
        usages: [],
        imports: [],
        success: false,
        error: `No extractor available for language: ${language}`,
      };
    }

    // Ensure grammar is loaded (handles optional languages)
    const grammarReady = await ensureLanguageGrammar(language);
    if (!grammarReady) {
      return {
        file_path: filePath,
        language,
        symbols: [],
        usages: [],
        imports: [],
        success: false,
        error: `Grammar not available for language: ${language}`,
      };
    }

    // Parse the code
    let tree: Parser.Tree;
    try {
      tree = parseCode(content, language);
    } catch (error) {
      return {
        file_path: filePath,
        language,
        symbols: [],
        usages: [],
        imports: [],
        success: false,
        error: `Failed to parse: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Extract symbols, usages, and imports
    return extractor.extract(tree, filePath, content);
  }

  /**
   * Batch extract from multiple files
   */
  async extractBatch(
    files: { path: string; content: string; language: string }[]
  ): Promise<FileExtractionResult[]> {
    // Ensure tree-sitter is initialized
    if (!this.initialized) {
      await initializeTreeSitter();
      this.initialized = true;
    }

    const results: FileExtractionResult[] = [];

    for (const file of files) {
      const result = await this.extract(file.path, file.content, file.language);
      results.push(result);
    }

    return results;
  }
}

/**
 * Default registry instance
 */
let defaultRegistry: ExtractorRegistry | null = null;

/**
 * Get the default extractor registry
 */
export function getExtractorRegistry(): ExtractorRegistry {
  defaultRegistry ??= new ExtractorRegistry();
  return defaultRegistry;
}

/**
 * Create a new extractor registry
 */
export function createExtractorRegistry(): ExtractorRegistry {
  return new ExtractorRegistry();
}
