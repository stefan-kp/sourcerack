/**
 * Git adapter for SourceRack
 *
 * Provides Git operations for commit resolution, file access,
 * and repository management. All operations work on commit snapshots only,
 * never on the working tree (Commit-Snapshot Principle).
 */

import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { createHash } from 'node:crypto';
import { resolve, basename, dirname } from 'node:path';
import { existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import {
  RepositoryInfo,
  CommitInfo,
  FileInfo,
  GitError,
  GitErrorCode,
} from './types.js';

/**
 * Generate a stable UUID v5-like identifier from a path
 * Same path always produces the same ID
 */
function generateRepoId(canonicalPath: string): string {
  // Use SHA256 hash of the canonical path, formatted as UUID
  const hash = createHash('sha256').update(canonicalPath).digest('hex');
  // Format as UUID (8-4-4-4-12)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Resolve the actual Git directory for a repository or worktree
 *
 * For a regular repository: /path/to/repo/.git (directory)
 * For a worktree: /path/to/worktree/.git (file containing "gitdir: /path/to/main/.git/worktrees/name")
 *
 * @param gitPath - Path to .git (file or directory)
 * @returns Path to the actual main .git directory
 */
function resolveGitDir(gitPath: string): string {
  const stats = statSync(gitPath);

  if (stats.isDirectory()) {
    // Regular repository - .git is a directory
    // Check if this is inside a worktrees directory
    // e.g., /main/.git/worktrees/feature -> /main/.git
    if (gitPath.includes('/worktrees/') || gitPath.includes('\\worktrees\\')) {
      // This is a worktree's git dir, resolve to main
      const worktreesIndex = gitPath.lastIndexOf('/worktrees/');
      const worktreesIndexWin = gitPath.lastIndexOf('\\worktrees\\');
      const idx = Math.max(worktreesIndex, worktreesIndexWin);
      if (idx !== -1) {
        return gitPath.slice(0, idx);
      }
    }
    return gitPath;
  }

  if (stats.isFile()) {
    // Worktree - .git is a file containing "gitdir: <path>"
    const content = readFileSync(gitPath, 'utf-8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);

    const linkedPath = match?.[1];
    if (linkedPath !== undefined && linkedPath !== '') {
      let linkedGitDir = linkedPath;

      // Handle relative paths
      const windowsDrivePattern = /^[A-Za-z]:/;
      if (!resolve(linkedGitDir).startsWith('/') && !windowsDrivePattern.exec(linkedGitDir)) {
        linkedGitDir = resolve(dirname(gitPath), linkedGitDir);
      }

      // The linked dir is inside worktrees, resolve to main .git
      // e.g., /main/.git/worktrees/feature -> /main/.git
      return resolveGitDir(linkedGitDir);
    }
  }

  // Fallback - return as-is
  return gitPath;
}

/**
 * Get the canonical repository path from a .git directory
 *
 * For regular repos: /path/to/repo/.git -> /path/to/repo
 * For worktrees: resolves to main repository path
 *
 * Uses realpath to resolve symlinks (e.g., /tmp -> /private/tmp on macOS)
 * to ensure consistent paths across worktrees.
 *
 * @param gitDir - Path to .git (file or directory)
 * @returns Canonical path to the main repository root
 */
function getCanonicalRepoPath(gitDir: string): string {
  const mainGitDir = resolveGitDir(gitDir);
  // .git directory is inside the repo, so parent is the repo root
  const repoPath = dirname(mainGitDir);

  // Use realpath to resolve symlinks for consistent paths
  // This ensures /tmp/... and /private/tmp/... resolve to the same path
  try {
    return realpathSync(repoPath);
  } catch {
    return repoPath;
  }
}

/**
 * Git adapter class for repository operations
 */
export class GitAdapter {
  private git: SimpleGit;
  private repoPath: string;
  /** Path to the working directory (may be a worktree) */
  private workingPath: string;
  /** Path to the main repository (resolved from worktree if applicable) */
  private canonicalRepoPath: string;
  private repoInfo: RepositoryInfo | null = null;

  private constructor(
    workingPath: string,
    canonicalRepoPath: string,
    git: SimpleGit
  ) {
    this.workingPath = workingPath;
    this.canonicalRepoPath = canonicalRepoPath;
    // repoPath kept for backwards compatibility - points to canonical repo
    this.repoPath = canonicalRepoPath;
    this.git = git;
  }

  /**
   * Create a GitAdapter for a repository path
   *
   * Supports both regular repositories and Git worktrees.
   * For worktrees, the repo_id will be based on the main repository,
   * ensuring all worktrees of the same repo share the same index.
   *
   * @param repoPath - Path to the Git repository or worktree
   * @returns Initialized GitAdapter
   * @throws GitError if path is not a valid Git repository
   */
  static async create(repoPath: string): Promise<GitAdapter> {
    let absolutePath = resolve(repoPath);

    // Check if path exists
    if (!existsSync(absolutePath)) {
      throw new GitError(
        `Path does not exist: ${absolutePath}`,
        GitErrorCode.NOT_A_REPOSITORY
      );
    }

    // Resolve symlinks for consistent paths (e.g., /tmp -> /private/tmp on macOS)
    try {
      absolutePath = realpathSync(absolutePath);
    } catch {
      // Keep original path if realpath fails
    }

    // Check for .git (can be directory for regular repo, or file for worktree)
    const gitPath = resolve(absolutePath, '.git');
    if (!existsSync(gitPath)) {
      throw new GitError(
        `Not a Git repository: ${absolutePath}`,
        GitErrorCode.NOT_A_REPOSITORY
      );
    }

    // Resolve canonical repository path (handles worktrees)
    let canonicalRepoPath: string;
    try {
      canonicalRepoPath = getCanonicalRepoPath(gitPath);
    } catch {
      // If we can't resolve, use the working path
      canonicalRepoPath = absolutePath;
    }

    const options: Partial<SimpleGitOptions> = {
      baseDir: absolutePath,
      binary: 'git',
      maxConcurrentProcesses: 6,
    };

    const git = simpleGit(options);

    // Verify it's a valid git repository by checking status
    try {
      await git.status();
    } catch (error) {
      throw new GitError(
        `Failed to initialize Git repository at ${absolutePath}`,
        GitErrorCode.NOT_A_REPOSITORY,
        error instanceof Error ? error : undefined
      );
    }

    return new GitAdapter(absolutePath, canonicalRepoPath, git);
  }

  /**
   * Get repository information
   *
   * For worktrees, returns the canonical (main) repository info,
   * ensuring consistent repo_id across all worktrees.
   */
  getRepositoryInfo(): RepositoryInfo {
    if (this.repoInfo !== null) {
      return this.repoInfo;
    }

    // Use canonical repo path for ID generation (handles worktrees)
    this.repoInfo = {
      id: generateRepoId(this.canonicalRepoPath),
      path: this.canonicalRepoPath,
      name: basename(this.canonicalRepoPath),
    };

    return this.repoInfo;
  }

  /**
   * Get the working directory path
   *
   * For regular repos, this is the same as the repo path.
   * For worktrees, this is the worktree directory.
   */
  getWorkingPath(): string {
    return this.workingPath;
  }

  /**
   * Check if this adapter is for a worktree
   */
  isWorktree(): boolean {
    return this.workingPath !== this.canonicalRepoPath;
  }

  /**
   * Validate that a commit exists
   *
   * @param commitRef - Commit SHA or ref name
   * @returns true if commit exists
   */
  async commitExists(commitRef: string): Promise<boolean> {
    try {
      await this.git.catFile(['-t', commitRef]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a ref (branch, tag, or commit) to a full commit SHA
   *
   * @param ref - Branch name, tag name, or commit SHA
   * @returns Full 40-character commit SHA
   * @throws GitError if ref cannot be resolved
   */
  async resolveRef(ref: string): Promise<string> {
    try {
      // Use rev-parse to resolve to full SHA
      const result = await this.git.revparse([ref]);
      const sha = result.trim();

      // Verify it's a valid commit (not a tree or blob)
      const type = await this.git.catFile(['-t', sha]);
      if (type.trim() !== 'commit') {
        throw new GitError(
          `Ref '${ref}' does not point to a commit`,
          GitErrorCode.REF_NOT_FOUND
        );
      }

      return sha;
    } catch (error) {
      if (error instanceof GitError) {
        throw error;
      }
      throw new GitError(
        `Cannot resolve ref '${ref}'`,
        GitErrorCode.REF_NOT_FOUND,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get commit information
   *
   * @param commitSha - Full or partial commit SHA
   * @returns Commit information
   */
  async getCommitInfo(commitSha: string): Promise<CommitInfo> {
    try {
      const sha = await this.resolveRef(commitSha);

      // Use git log with the specific commit
      const log = await this.git.log({
        maxCount: 1,
        [sha]: null, // Tells simple-git to get this specific commit
      });

      const commit = log.latest;
      if (commit === null) {
        throw new GitError(
          `Commit not found: ${commitSha}`,
          GitErrorCode.COMMIT_NOT_FOUND
        );
      }

      return {
        sha,
        message: commit.message,
        author: commit.author_name,
        email: commit.author_email,
        date: new Date(commit.date),
      };
    } catch (error) {
      if (error instanceof GitError) {
        throw error;
      }
      throw new GitError(
        `Failed to get commit info for '${commitSha}'`,
        GitErrorCode.COMMIT_NOT_FOUND,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if a commit is reachable from any branch or tag
   *
   * @param commitSha - Commit SHA to check
   * @returns true if commit is reachable from any ref
   */
  async isCommitReachable(commitSha: string): Promise<boolean> {
    try {
      const sha = await this.resolveRef(commitSha);

      // Get all refs that contain this commit
      const result = await this.git.raw([
        'branch',
        '--all',
        '--contains',
        sha,
      ]);

      // If any branch contains this commit, it's reachable
      if (result.trim().length > 0) {
        return true;
      }

      // Also check tags
      const tagResult = await this.git.raw(['tag', '--contains', sha]);
      return tagResult.trim().length > 0;
    } catch {
      // If the commit doesn't exist or is not reachable, return false
      return false;
    }
  }

  /**
   * List all files at a specific commit
   *
   * @param commitSha - Commit SHA
   * @returns List of file information
   */
  async listFilesAtCommit(commitSha: string): Promise<FileInfo[]> {
    const sha = await this.resolveRef(commitSha);

    try {
      // Use ls-tree to list all files recursively
      const result = await this.git.raw(['ls-tree', '-r', '--full-tree', sha]);

      const files: FileInfo[] = [];
      const lines = result.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        // Format: <mode> <type> <sha>\t<path>
        const match = /^(\d+)\s+(\w+)\s+([a-f0-9]+)\t(.+)$/.exec(line);
        if (match !== null) {
          const [, mode, type, objSha, path] = match;
          if (type === 'blob' && mode !== undefined && objSha !== undefined && path !== undefined) {
            files.push({
              path,
              mode,
              sha: objSha,
              isBinary: false, // Will be determined when reading content
            });
          }
        }
      }

      return files;
    } catch (error) {
      throw new GitError(
        `Failed to list files at commit '${commitSha}'`,
        GitErrorCode.OPERATION_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Read file content at a specific commit
   *
   * @param commitSha - Commit SHA
   * @param filePath - Relative file path
   * @returns File content as string, or null if binary
   */
  async readFileAtCommit(
    commitSha: string,
    filePath: string
  ): Promise<{ content: string; isBinary: boolean }> {
    const sha = await this.resolveRef(commitSha);

    try {
      // Check if file is binary using diff attributes
      const isBinary = await this.isFileBinary(sha, filePath);

      if (isBinary) {
        return { content: '', isBinary: true };
      }

      // Read file content using git show
      const content = await this.git.show([`${sha}:${filePath}`]);
      return { content, isBinary: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('does not exist') || message.includes('not found')) {
        throw new GitError(
          `File '${filePath}' not found at commit '${commitSha}'`,
          GitErrorCode.FILE_NOT_FOUND,
          error instanceof Error ? error : undefined
        );
      }
      throw new GitError(
        `Failed to read file '${filePath}' at commit '${commitSha}'`,
        GitErrorCode.OPERATION_FAILED,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if a file is binary
   */
  private async isFileBinary(commitSha: string, filePath: string): Promise<boolean> {
    try {
      // Use git diff to check if file is binary
      // This checks the file content for null bytes
      const result = await this.git.raw([
        'diff',
        '--numstat',
        '4b825dc642cb6eb9a060e54bf8d69288fbee4904', // empty tree SHA
        commitSha,
        '--',
        filePath,
      ]);

      // Binary files show as "-\t-\t<path>"
      return result.startsWith('-\t-\t');
    } catch {
      // If we can't determine, assume not binary
      return false;
    }
  }

  /**
   * Get the repository path
   */
  getPath(): string {
    return this.repoPath;
  }
}

/**
 * Create a GitAdapter for a repository path
 * Convenience function for GitAdapter.create()
 */
export async function createGitAdapter(repoPath: string): Promise<GitAdapter> {
  return GitAdapter.create(repoPath);
}
