/**
 * Commit diff computation for SourceRack
 *
 * Computes differences between commits for incremental indexing.
 * Uses git diff --name-status for efficient change detection.
 */

import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { resolve } from 'node:path';
import { CommitDiff, FileChange, ChangeType, GitError, GitErrorCode } from './types.js';

/**
 * Parse git diff --name-status output
 */
function parseNameStatus(output: string): FileChange[] {
  const changes: FileChange[] = [];
  const lines = output.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const status = parts[0];
    if (status === undefined) continue;

    let changeType: ChangeType;
    let path: string;
    let oldPath: string | undefined;

    // Status codes: A (added), M (modified), D (deleted), R (renamed), C (copied)
    // Renamed and copied include a percentage: R100, R095, C100, etc.
    const statusChar = status.charAt(0);

    switch (statusChar) {
      case 'A':
        changeType = 'added';
        path = parts[1] ?? '';
        break;
      case 'M':
        changeType = 'modified';
        path = parts[1] ?? '';
        break;
      case 'D':
        changeType = 'deleted';
        path = parts[1] ?? '';
        break;
      case 'R':
        changeType = 'renamed';
        oldPath = parts[1];
        path = parts[2] ?? '';
        break;
      case 'C':
        changeType = 'copied';
        oldPath = parts[1];
        path = parts[2] ?? '';
        break;
      default:
        // Unknown status, treat as modified
        changeType = 'modified';
        path = parts[1] ?? '';
    }

    if (path !== '') {
      changes.push({
        path,
        changeType,
        ...(oldPath !== undefined && { oldPath }),
      });
    }
  }

  return changes;
}

/**
 * Compute the diff between two commits
 *
 * @param repoPath - Path to the Git repository
 * @param fromCommit - Source commit SHA (older)
 * @param toCommit - Target commit SHA (newer)
 * @returns Diff result with list of changed files
 */
export async function computeCommitDiff(
  repoPath: string,
  fromCommit: string,
  toCommit: string
): Promise<CommitDiff> {
  const absolutePath = resolve(repoPath);

  const options: Partial<SimpleGitOptions> = {
    baseDir: absolutePath,
    binary: 'git',
    maxConcurrentProcesses: 6,
  };

  const git: SimpleGit = simpleGit(options);

  try {
    // Get diff between commits using --name-status
    const result = await git.raw([
      'diff',
      '--name-status',
      '-M', // Detect renames
      '-C', // Detect copies
      fromCommit,
      toCommit,
    ]);

    const changes = parseNameStatus(result);

    return {
      fromCommit,
      toCommit,
      changes,
    };
  } catch (error) {
    throw new GitError(
      `Failed to compute diff between ${fromCommit} and ${toCommit}`,
      GitErrorCode.OPERATION_FAILED,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get all files that have changed in a commit compared to its parent
 *
 * @param repoPath - Path to the Git repository
 * @param commitSha - Commit SHA
 * @returns List of changed files
 */
export async function getCommitChanges(
  repoPath: string,
  commitSha: string
): Promise<FileChange[]> {
  const absolutePath = resolve(repoPath);

  const options: Partial<SimpleGitOptions> = {
    baseDir: absolutePath,
    binary: 'git',
    maxConcurrentProcesses: 6,
  };

  const git: SimpleGit = simpleGit(options);

  try {
    // Get diff from parent commit
    const result = await git.raw([
      'diff',
      '--name-status',
      '-M',
      '-C',
      `${commitSha}^`,
      commitSha,
    ]);

    return parseNameStatus(result);
  } catch (error) {
    // If there's no parent (initial commit), list all files as added
    if (error instanceof Error && error.message.includes('unknown revision')) {
      const result = await git.raw([
        'diff',
        '--name-status',
        '-M',
        '-C',
        '4b825dc642cb6eb9a060e54bf8d69288fbee4904', // Empty tree SHA
        commitSha,
      ]);
      return parseNameStatus(result);
    }

    throw new GitError(
      `Failed to get changes for commit ${commitSha}`,
      GitErrorCode.OPERATION_FAILED,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get files that differ between two commits, grouped by type
 */
export interface GroupedChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
}

/**
 * Get grouped changes between two commits
 *
 * @param repoPath - Path to the Git repository
 * @param fromCommit - Source commit SHA
 * @param toCommit - Target commit SHA
 * @returns Changes grouped by type
 */
export async function getGroupedChanges(
  repoPath: string,
  fromCommit: string,
  toCommit: string
): Promise<GroupedChanges> {
  const diff = await computeCommitDiff(repoPath, fromCommit, toCommit);

  const grouped: GroupedChanges = {
    added: [],
    modified: [],
    deleted: [],
    renamed: [],
  };

  for (const change of diff.changes) {
    switch (change.changeType) {
      case 'added':
        grouped.added.push(change.path);
        break;
      case 'modified':
        grouped.modified.push(change.path);
        break;
      case 'deleted':
        grouped.deleted.push(change.path);
        break;
      case 'renamed':
      case 'copied':
        if (change.oldPath !== undefined) {
          grouped.renamed.push({ from: change.oldPath, to: change.path });
        }
        break;
    }
  }

  return grouped;
}
