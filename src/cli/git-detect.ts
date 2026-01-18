/**
 * Git auto-detection for CLI
 *
 * Detects repository path, current commit, and branch information.
 */

import { resolve } from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';
import { GitAdapter } from '../git/adapter.js';
import { NotFoundError } from './errors.js';

/**
 * Detected repository context
 */
export interface RepoContext {
  /** Absolute path to the repository */
  repoPath: string;
  /** Full commit SHA */
  commitSha: string;
  /** Current branch name (if on a branch) */
  branch?: string;
}

/**
 * Detect repository context from path and optional commit
 *
 * @param explicitPath - Explicit repository path (defaults to cwd)
 * @param explicitCommit - Explicit commit/branch/tag reference (defaults to HEAD)
 * @returns Detected repository context
 */
export async function detectRepoContext(
  explicitPath?: string,
  explicitCommit?: string
): Promise<RepoContext> {
  // Resolve repository path
  const repoPath = resolve(explicitPath ?? process.cwd());

  // Create Git adapter (validates repository)
  let git: GitAdapter;
  try {
    git = await GitAdapter.create(repoPath);
  } catch (error) {
    throw new NotFoundError(
      `Not a Git repository: ${repoPath}`,
      error instanceof Error ? error : undefined
    );
  }

  // Resolve commit reference
  const commitRef = explicitCommit ?? 'HEAD';
  let commitSha: string;
  try {
    commitSha = await git.resolveRef(commitRef);
  } catch (error) {
    throw new NotFoundError(
      `Cannot resolve commit reference: ${commitRef}`,
      error instanceof Error ? error : undefined
    );
  }

  // Detect current branch
  const branch = await detectCurrentBranch(repoPath);

  const context: RepoContext = {
    repoPath,
    commitSha,
  };
  if (branch !== undefined) {
    context.branch = branch;
  }

  return context;
}

/**
 * Detect the current branch name
 *
 * @param repoPath - Path to the repository
 * @returns Branch name or undefined if detached HEAD
 */
async function detectCurrentBranch(repoPath: string): Promise<string | undefined> {
  const git: SimpleGit = simpleGit(repoPath);

  try {
    // Get symbolic ref for HEAD
    const result = await git.raw(['symbolic-ref', '--short', 'HEAD']);
    const branch = result.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    // Detached HEAD state
    return undefined;
  }
}

/**
 * Validate that a path is a Git repository
 *
 * @param path - Path to validate
 * @returns true if path is a Git repository
 */
export async function isGitRepository(path: string): Promise<boolean> {
  try {
    await GitAdapter.create(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the repository root from any subdirectory
 *
 * @param startPath - Starting path
 * @returns Repository root path or undefined
 */
export async function findRepositoryRoot(startPath: string): Promise<string | undefined> {
  const git: SimpleGit = simpleGit(resolve(startPath));

  try {
    const result = await git.revparse(['--show-toplevel']);
    return result.trim();
  } catch {
    return undefined;
  }
}
