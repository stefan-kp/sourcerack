/**
 * Git-related types for SourceRack
 */

/**
 * Repository information
 */
export interface RepositoryInfo {
  /** Unique repository identifier (UUID based on canonical path) */
  id: string;
  /** Absolute filesystem path to repository root */
  path: string;
  /** Human-readable repository name */
  name: string;
}

/**
 * Commit information
 */
export interface CommitInfo {
  /** Full 40-character SHA */
  sha: string;
  /** Commit message */
  message?: string;
  /** Author name */
  author?: string;
  /** Author email */
  email?: string;
  /** Commit timestamp */
  date?: Date;
}

/**
 * File change type in a diff
 */
export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

/**
 * File change information from a diff
 */
export interface FileChange {
  /** Relative file path */
  path: string;
  /** Type of change */
  changeType: ChangeType;
  /** Original path (for renamed/copied files) */
  oldPath?: string;
}

/**
 * Diff result between two commits
 */
export interface CommitDiff {
  /** Source commit SHA */
  fromCommit: string;
  /** Target commit SHA */
  toCommit: string;
  /** List of changed files */
  changes: FileChange[];
}

/**
 * File information at a specific commit
 */
export interface FileInfo {
  /** Relative file path */
  path: string;
  /** File mode (permissions) */
  mode: string;
  /** Object SHA */
  sha: string;
  /** Whether file is binary */
  isBinary: boolean;
}

/**
 * Error thrown for Git-related operations
 */
export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: GitErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Git error codes
 */
export enum GitErrorCode {
  /** Path is not a Git repository */
  NOT_A_REPOSITORY = 'NOT_A_REPOSITORY',
  /** Commit does not exist */
  COMMIT_NOT_FOUND = 'COMMIT_NOT_FOUND',
  /** Branch or ref does not exist */
  REF_NOT_FOUND = 'REF_NOT_FOUND',
  /** File does not exist at commit */
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  /** General Git operation error */
  OPERATION_FAILED = 'OPERATION_FAILED',
}
