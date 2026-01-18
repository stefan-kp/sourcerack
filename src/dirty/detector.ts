/**
 * Dirty file detection using Git
 *
 * Detects modified, staged, and untracked files in the working tree.
 */

import { simpleGit, SimpleGit, StatusResult } from 'simple-git';
import { join, extname } from 'node:path';
import { getLanguageRegistry } from '../parser/language-registry.js';
import {
  DirtyFile,
  DirtyDetectionOptions,
  DirtyDetectionResult,
} from './types.js';

/**
 * Detect dirty files in a Git repository
 */
export async function detectDirtyFiles(
  options: DirtyDetectionOptions
): Promise<DirtyDetectionResult> {
  const {
    repoPath,
    includeModified = true,
    includeStaged = true,
    includeUntracked = true,
  } = options;

  const git: SimpleGit = simpleGit(repoPath);
  const status: StatusResult = await git.status();

  const files: DirtyFile[] = [];
  const modifiedOrStaged: DirtyFile[] = [];
  const untrackedInSourcePaths: DirtyFile[] = [];
  const deleted: DirtyFile[] = [];

  // Process modified files (unstaged changes)
  if (includeModified) {
    for (const filePath of status.modified) {
      const file: DirtyFile = {
        path: filePath,
        status: 'modified',
        absolutePath: join(repoPath, filePath),
      };
      files.push(file);
      modifiedOrStaged.push(file);
    }
  }

  // Process staged files
  if (includeStaged) {
    for (const filePath of status.staged) {
      // Avoid duplicates (file can be both modified and staged)
      if (!files.some((f) => f.path === filePath)) {
        const file: DirtyFile = {
          path: filePath,
          status: 'staged',
          absolutePath: join(repoPath, filePath),
        };
        files.push(file);
        modifiedOrStaged.push(file);
      }
    }
  }

  // Process deleted files
  for (const filePath of status.deleted) {
    const file: DirtyFile = {
      path: filePath,
      status: 'deleted',
      absolutePath: join(repoPath, filePath),
    };
    files.push(file);
    deleted.push(file);
  }

  // Process untracked files (only in known source paths)
  if (includeUntracked) {
    for (const filePath of status.not_added) {
      if (shouldIncludeUntracked(filePath)) {
        const file: DirtyFile = {
          path: filePath,
          status: 'untracked',
          absolutePath: join(repoPath, filePath),
        };
        files.push(file);
        untrackedInSourcePaths.push(file);
      }
    }
  }

  return {
    files,
    modifiedOrStaged,
    untrackedInSourcePaths,
    deleted,
  };
}

/**
 * Check if an untracked file should be included based on its path and extension
 */
function shouldIncludeUntracked(filePath: string): boolean {
  const registry = getLanguageRegistry();

  // Get file extension
  const ext = extname(filePath);
  if (!ext) return false;

  // Check if extension is known
  const language = registry.getLanguageByExtension(ext);
  if (!language) return false;

  // Get source paths for this language
  const sourcePaths = registry.getSourcePaths(language);
  if (!sourcePaths || sourcePaths.length === 0) {
    // If no source paths defined, don't include untracked files for this language
    return false;
  }

  // Check if file is in a known source path
  return sourcePaths.some((sourcePath) => filePath.startsWith(sourcePath));
}

/**
 * Filter dirty files to only include those with SQI extractor support
 */
export function filterFilesWithExtractorSupport(
  files: DirtyFile[]
): DirtyFile[] {
  const registry = getLanguageRegistry();

  return files.filter((file) => {
    const ext = extname(file.path);
    if (!ext) return false;

    const language = registry.getLanguageByExtension(ext);
    if (!language) return false;

    // Check if we have an SQI extractor for this language
    // For now, we support: typescript, javascript, python, ruby
    const supportedLanguages = new Set([
      'typescript',
      'tsx',
      'javascript',
      'python',
      'ruby',
    ]);
    return supportedLanguages.has(language);
  });
}

/**
 * Get the set of file paths that are dirty (for filtering DB results)
 */
export function getDirtyFilePaths(result: DirtyDetectionResult): Set<string> {
  const paths = new Set<string>();

  for (const file of result.files) {
    if (file.status !== 'deleted') {
      paths.add(file.path);
    }
  }

  return paths;
}

/**
 * Get the set of deleted file paths (for excluding from DB results)
 */
export function getDeletedFilePaths(result: DirtyDetectionResult): Set<string> {
  return new Set(result.deleted.map((f) => f.path));
}
