/**
 * Types for dirty file detection and handling
 */

import { ExtractedSymbol, ExtractedUsage } from '../sqi/types.js';

/**
 * Status of a file in the working tree
 */
export type DirtyFileStatus = 'modified' | 'staged' | 'untracked' | 'deleted';

/**
 * A dirty file with its status and path
 */
export interface DirtyFile {
  /** Relative path from repo root */
  path: string;
  /** Status of the file */
  status: DirtyFileStatus;
  /** Absolute path to the file */
  absolutePath: string;
}

/**
 * Options for dirty file detection
 */
export interface DirtyDetectionOptions {
  /** Include modified (unstaged) files (default: true) */
  includeModified?: boolean;
  /** Include staged files (default: true) */
  includeStaged?: boolean;
  /** Include untracked files in known source paths (default: true) */
  includeUntracked?: boolean;
  /** Repository root path */
  repoPath: string;
}

/**
 * Result of dirty file detection
 */
export interface DirtyDetectionResult {
  /** All dirty files found */
  files: DirtyFile[];
  /** Files that were modified or staged */
  modifiedOrStaged: DirtyFile[];
  /** Untracked files in known source paths */
  untrackedInSourcePaths: DirtyFile[];
  /** Deleted files (need to be excluded from results) */
  deleted: DirtyFile[];
}

/**
 * Symbols extracted from dirty files
 */
export interface DirtySymbols {
  /** Symbols from dirty files, keyed by file path */
  symbolsByFile: Map<string, ExtractedSymbol[]>;
  /** Usages from dirty files, keyed by file path */
  usagesByFile: Map<string, ExtractedUsage[]>;
  /** Files that were successfully parsed */
  parsedFiles: string[];
  /** Files that failed to parse */
  failedFiles: string[];
}

/**
 * Options for merging dirty symbols with database symbols
 */
export interface MergeOptions {
  /** File paths that have dirty versions (their DB symbols should be replaced) */
  dirtyFilePaths: Set<string>;
  /** File paths that were deleted (their DB symbols should be excluded) */
  deletedFilePaths: Set<string>;
}
