/**
 * SQI Indexer for SourceRack
 *
 * Orchestrates SQI extraction and storage during the indexing process.
 * Runs alongside the embedding indexer to populate the Structured Query Index.
 */

import { SQIStorage } from './storage.js';
import { ExtractorRegistry, getExtractorRegistry } from './extractors/registry.js';
import { createUsageLinker } from './linker/usage-linker.js';
import { FileExtractionResult, ExtractedSymbol, ExtractedUsage, ExtractedImport } from './types.js';
import { detectLanguage } from '../parser/tree-sitter.js';
import {
  EndpointExtractorRegistry,
  getEndpointExtractorRegistry,
  ExtractedEndpoint,
} from './extractors/api/index.js';

/**
 * Options for SQI indexing
 */
export interface SQIIndexingOptions {
  /** Repository ID */
  repoId: string;
  /** Commit ID in the database */
  commitId: number;
  /** Whether to link usages after extraction */
  linkUsages?: boolean;
  /** Whether to extract API endpoints */
  extractEndpoints?: boolean;
}

/**
 * Result of SQI indexing for a commit
 */
export interface SQIIndexingResult {
  /** Whether indexing was successful */
  success: boolean;
  /** Number of files processed */
  filesProcessed: number;
  /** Number of symbols extracted */
  symbolsExtracted: number;
  /** Number of usages extracted */
  usagesExtracted: number;
  /** Number of imports extracted */
  importsExtracted: number;
  /** Number of API endpoints extracted */
  endpointsExtracted: number;
  /** Number of files that failed extraction */
  filesFailed: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Progress callback for SQI indexing
 */
export type SQIProgressCallback = (event: {
  type: 'file_extracted' | 'linking' | 'completed';
  file?: string;
  filesProcessed?: number;
  totalFiles?: number;
}) => void;

/**
 * SQI Indexer
 *
 * Extracts and stores structural code information from parsed files.
 */
export class SQIIndexer {
  private sqi: SQIStorage;
  private registry: ExtractorRegistry;
  private endpointRegistry: EndpointExtractorRegistry;

  constructor(sqi: SQIStorage, registry?: ExtractorRegistry) {
    this.sqi = sqi;
    this.registry = registry ?? getExtractorRegistry();
    this.endpointRegistry = getEndpointExtractorRegistry();
  }

  /**
   * Index files for a commit
   *
   * @param files - Array of files with path, content, and language
   * @param options - Indexing options
   * @param onProgress - Progress callback
   */
  async indexFiles(
    files: { path: string; content: string }[],
    options: SQIIndexingOptions,
    onProgress?: SQIProgressCallback
  ): Promise<SQIIndexingResult> {
    const { repoId, commitId, linkUsages = true, extractEndpoints = true } = options;

    let filesProcessed = 0;
    let symbolsExtracted = 0;
    let usagesExtracted = 0;
    let importsExtracted = 0;
    let endpointsExtracted = 0;
    let filesFailed = 0;

    try {
      const totalFiles = files.length;

      for (const file of files) {
        // Detect language
        const language = detectLanguage(file.path);
        if (!language) {
          filesProcessed++;
          continue;
        }

        // Check if language is supported by SQI
        if (!this.registry.isSupported(language)) {
          filesProcessed++;
          continue;
        }

        try {
          // Extract symbols, usages, and imports
          const result = await this.registry.extract(
            file.path,
            file.content,
            language
          );

          if (result.success) {
            // Store symbols
            const symbolIds = this.storeSymbols(
              repoId,
              commitId,
              result.symbols
            );
            symbolsExtracted += symbolIds.length;

            // Store usages
            const usageIds = this.storeUsages(commitId, result.usages);
            usagesExtracted += usageIds.length;

            // Store imports
            const importIds = this.storeImports(commitId, result.imports);
            importsExtracted += importIds.length;

            // Extract and store API endpoints if enabled
            if (extractEndpoints) {
              const imports = result.imports.map(i => i.module_specifier);
              if (this.endpointRegistry.mightHaveEndpoints(file.path, language, imports)) {
                try {
                  const endpointResult = await this.endpointRegistry.extract(
                    file.path,
                    file.content,
                    language,
                    imports
                  );

                  if (endpointResult.success && endpointResult.endpoints.length > 0) {
                    const endpointIds = this.storeEndpoints(commitId, endpointResult.endpoints);
                    endpointsExtracted += endpointIds.length;
                  }
                } catch {
                  // Endpoint extraction is optional - don't fail the whole file
                }
              }
            }
          } else {
            filesFailed++;
            // Log parse failures for visibility
            if (result.error) {
              console.warn(`⚠️  SQI extraction failed for ${file.path}: ${result.error}`);
            }
          }

          filesProcessed++;

          if (onProgress) {
            onProgress({
              type: 'file_extracted',
              file: file.path,
              filesProcessed,
              totalFiles,
            });
          }
        } catch (error) {
          filesFailed++;
          filesProcessed++;
          // Log extraction errors
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`⚠️  SQI extraction error for ${file.path}: ${errorMsg}`);
          // Continue with other files
        }
      }

      // Link usages to definitions
      if (linkUsages) {
        if (onProgress) {
          onProgress({ type: 'linking' });
        }

        const linker = createUsageLinker(this.sqi);
        linker.linkCommit(commitId, {
          linkDefinitions: true,
          linkEnclosing: true,
        });
      }

      if (onProgress) {
        onProgress({ type: 'completed' });
      }

      // Log summary if there were failures
      if (filesFailed > 0) {
        console.warn(`⚠️  SQI: ${filesFailed} file(s) failed to extract (symbols from these files won't be searchable)`);
      }

      return {
        success: true,
        filesProcessed,
        symbolsExtracted,
        usagesExtracted,
        importsExtracted,
        endpointsExtracted,
        filesFailed,
      };
    } catch (error) {
      return {
        success: false,
        filesProcessed,
        symbolsExtracted,
        usagesExtracted,
        importsExtracted,
        endpointsExtracted,
        filesFailed,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Index a single file
   */
  async indexFile(
    file: { path: string; content: string },
    options: SQIIndexingOptions
  ): Promise<FileExtractionResult> {
    const { repoId, commitId } = options;

    // Detect language
    const language = detectLanguage(file.path);
    if (!language) {
      return {
        file_path: file.path,
        language: 'unknown',
        symbols: [],
        usages: [],
        imports: [],
        success: false,
        error: 'Unsupported file type',
      };
    }

    // Extract
    const result = await this.registry.extract(file.path, file.content, language);

    if (result.success) {
      // Store results
      this.storeSymbols(repoId, commitId, result.symbols);
      this.storeUsages(commitId, result.usages);
      this.storeImports(commitId, result.imports);
    }

    return result;
  }

  /**
   * Delete SQI data for a commit
   */
  deleteCommitData(commitId: number): void {
    this.sqi.deleteCommitData(commitId);
  }

  /**
   * Delete SQI data for a specific file
   */
  deleteFileData(commitId: number, filePath: string): void {
    this.sqi.deleteFileData(commitId, filePath);
  }

  // ==================== Private Methods ====================

  /**
   * Store extracted symbols
   */
  private storeSymbols(
    repoId: string,
    commitId: number,
    symbols: ExtractedSymbol[]
  ): number[] {
    if (symbols.length === 0) return [];
    return this.sqi.insertSymbols(repoId, commitId, symbols);
  }

  /**
   * Store extracted usages
   */
  private storeUsages(
    commitId: number,
    usages: ExtractedUsage[]
  ): number[] {
    if (usages.length === 0) return [];
    return this.sqi.insertUsages(commitId, usages);
  }

  /**
   * Store extracted imports
   */
  private storeImports(
    commitId: number,
    imports: ExtractedImport[]
  ): number[] {
    if (imports.length === 0) return [];
    return this.sqi.insertImports(commitId, imports);
  }

  /**
   * Store extracted API endpoints
   */
  private storeEndpoints(
    commitId: number,
    endpoints: ExtractedEndpoint[]
  ): number[] {
    if (endpoints.length === 0) return [];
    return this.sqi.insertEndpoints(commitId, endpoints);
  }
}

/**
 * Create an SQI indexer
 */
export function createSQIIndexer(
  sqi: SQIStorage,
  registry?: ExtractorRegistry
): SQIIndexer {
  return new SQIIndexer(sqi, registry);
}
