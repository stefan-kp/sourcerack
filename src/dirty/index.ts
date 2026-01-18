/**
 * Dirty File Module
 *
 * Provides functionality for detecting and parsing uncommitted changes
 * in the working tree, allowing queries to include modified, staged,
 * and untracked files.
 *
 * @module dirty
 */

// Types
export type {
  DirtyFile,
  DirtyFileStatus,
  DirtyDetectionOptions,
  DirtyDetectionResult,
  DirtySymbols,
  MergeOptions,
} from './types.js';

// Detection
export {
  detectDirtyFiles,
  filterFilesWithExtractorSupport,
  getDirtyFilePaths,
  getDeletedFilePaths,
} from './detector.js';

// Parsing
export {
  parseDirtyFiles,
  flattenDirtySymbols,
  flattenDirtyUsages,
} from './parser.js';

// Merging
export {
  mergeSymbols,
  mergeUsages,
  filterDeletedSymbols,
  filterDeletedUsages,
} from './merger.js';

/**
 * High-level function to get dirty symbols for a repository
 *
 * This is the main entry point for including dirty files in queries.
 *
 * @param repoPath - Path to the repository
 * @param options - Detection options
 * @returns Dirty symbols and metadata
 */
export async function getDirtySymbols(
  repoPath: string,
  options: {
    includeModified?: boolean;
    includeStaged?: boolean;
    includeUntracked?: boolean;
  } = {}
): Promise<{
  symbols: import('./types.js').DirtySymbols;
  dirtyFilePaths: Set<string>;
  deletedFilePaths: Set<string>;
}> {
  const { detectDirtyFiles, filterFilesWithExtractorSupport, getDirtyFilePaths, getDeletedFilePaths } = await import('./detector.js');
  const { parseDirtyFiles } = await import('./parser.js');

  // Detect dirty files
  const detection = await detectDirtyFiles({
    repoPath,
    includeModified: options.includeModified ?? true,
    includeStaged: options.includeStaged ?? true,
    includeUntracked: options.includeUntracked ?? true,
  });

  // Filter to files we can parse
  const parsableFiles = filterFilesWithExtractorSupport(detection.files);

  // Parse dirty files
  const symbols = await parseDirtyFiles(parsableFiles);

  return {
    symbols,
    dirtyFilePaths: getDirtyFilePaths(detection),
    deletedFilePaths: getDeletedFilePaths(detection),
  };
}
