/**
 * On-the-fly parsing of dirty files
 *
 * Parses modified/staged/untracked files using tree-sitter and extracts symbols.
 */

import { readFileSync } from 'node:fs';
import { getTreeSitterParser } from '../parser/tree-sitter.js';
import { getExtractorRegistry } from '../sqi/extractors/registry.js';
import { ExtractedSymbol, ExtractedUsage } from '../sqi/types.js';
import { DirtyFile, DirtySymbols } from './types.js';

/**
 * Parse dirty files and extract symbols
 */
export async function parseDirtyFiles(files: DirtyFile[]): Promise<DirtySymbols> {
  const symbolsByFile = new Map<string, ExtractedSymbol[]>();
  const usagesByFile = new Map<string, ExtractedUsage[]>();
  const parsedFiles: string[] = [];
  const failedFiles: string[] = [];

  const parser = getTreeSitterParser();
  const extractorRegistry = getExtractorRegistry();

  // Filter to files we can parse (have extractors for)
  const supportedLanguages = new Set(['typescript', 'tsx', 'javascript', 'python', 'ruby']);

  for (const file of files) {
    // Skip deleted files
    if (file.status === 'deleted') {
      continue;
    }

    try {
      // Determine language from file path
      const language = parser.getLanguageForFile(file.path);

      if (!language || !supportedLanguages.has(language)) {
        // No extractor for this language, skip
        continue;
      }

      // Ensure grammar is loaded
      const grammarLoaded = await parser.ensureLanguage(language);
      if (!grammarLoaded) {
        failedFiles.push(file.path);
        continue;
      }

      // Read file content
      const sourceCode = readFileSync(file.absolutePath, 'utf-8');

      // Parse with tree-sitter
      const tree = parser.parse(sourceCode, language);
      if (!tree) {
        failedFiles.push(file.path);
        continue;
      }

      // Get extractor for this language
      const extractor = extractorRegistry.getExtractor(language);
      if (!extractor) {
        continue;
      }

      // Extract symbols and usages
      const result = extractor.extract(tree, file.path, sourceCode);

      if (result.success) {
        symbolsByFile.set(file.path, result.symbols);
        usagesByFile.set(file.path, result.usages);
        parsedFiles.push(file.path);
      } else {
        failedFiles.push(file.path);
      }
    } catch (error) {
      failedFiles.push(file.path);
    }
  }

  return {
    symbolsByFile,
    usagesByFile,
    parsedFiles,
    failedFiles,
  };
}

/**
 * Flatten symbols from dirty files into a single array
 */
export function flattenDirtySymbols(dirtySymbols: DirtySymbols): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  for (const fileSymbols of dirtySymbols.symbolsByFile.values()) {
    symbols.push(...fileSymbols);
  }

  return symbols;
}

/**
 * Flatten usages from dirty files into a single array
 */
export function flattenDirtyUsages(dirtySymbols: DirtySymbols): ExtractedUsage[] {
  const usages: ExtractedUsage[] = [];

  for (const fileUsages of dirtySymbols.usagesByFile.values()) {
    usages.push(...fileUsages);
  }

  return usages;
}
