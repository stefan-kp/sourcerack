import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GitAdapter, createGitAdapter } from '../../../src/git/adapter.js';
import { GitError, GitErrorCode } from '../../../src/git/types.js';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';

describe('GitAdapter', () => {
  // Use the sourcerack repository itself for testing
  const repoPath = resolve(process.cwd());
  let adapter: GitAdapter;

  beforeAll(async () => {
    adapter = await createGitAdapter(repoPath);
  });

  describe('create', () => {
    it('should create adapter for valid git repository', async () => {
      const gitAdapter = await GitAdapter.create(repoPath);
      expect(gitAdapter).toBeInstanceOf(GitAdapter);
    });

    it('should throw for non-existent path', async () => {
      await expect(GitAdapter.create('/nonexistent/path')).rejects.toThrow(
        GitError
      );
    });

    it('should throw for non-git directory', async () => {
      // Use /tmp which exists but is not a git repo
      await expect(GitAdapter.create('/tmp')).rejects.toThrow(GitError);
    });
  });

  describe('getRepositoryInfo', () => {
    it('should return repository info with stable ID', async () => {
      const info = adapter.getRepositoryInfo();

      expect(info.path).toBe(repoPath);
      expect(info.name).toBe('sourcerack');
      expect(info.id).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
      );
    });

    it('should return same ID for same path', async () => {
      const info1 = adapter.getRepositoryInfo();
      const info2 = adapter.getRepositoryInfo();

      expect(info1.id).toBe(info2.id);
    });
  });

  describe('commitExists', () => {
    it('should return true for existing commit', async () => {
      // HEAD always exists
      const exists = await adapter.commitExists('HEAD');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent commit', async () => {
      const exists = await adapter.commitExists('0000000000000000000000000000000000000000');
      expect(exists).toBe(false);
    });
  });

  describe('resolveRef', () => {
    it('should resolve HEAD to a full SHA', async () => {
      const sha = await adapter.resolveRef('HEAD');
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    });

    it('should resolve branch name to SHA', async () => {
      const sha = await adapter.resolveRef('main');
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    });

    it('should throw for unknown ref', async () => {
      await expect(adapter.resolveRef('nonexistent-branch-xyz')).rejects.toThrow(
        GitError
      );
    });
  });

  describe('getCommitInfo', () => {
    it('should return commit information', async () => {
      const info = await adapter.getCommitInfo('HEAD');

      expect(info.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(info.message).toBeDefined();
      expect(info.date).toBeInstanceOf(Date);
    });
  });

  describe('isCommitReachable', () => {
    it('should return true for HEAD', async () => {
      const sha = await adapter.resolveRef('HEAD');
      const reachable = await adapter.isCommitReachable(sha);
      expect(reachable).toBe(true);
    });
  });

  describe('listFilesAtCommit', () => {
    it('should list files at HEAD', async () => {
      const files = await adapter.listFilesAtCommit('HEAD');

      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);

      // All files should have required fields
      for (const file of files) {
        expect(file.path).toBeDefined();
        expect(typeof file.path).toBe('string');
        expect(file.sha).toMatch(/^[a-f0-9]{40}$/);
      }
    });
  });

  describe('readFileAtCommit', () => {
    it('should read file content at HEAD', async () => {
      // First list files to find one that exists
      const files = await adapter.listFilesAtCommit('HEAD');
      if (files.length === 0) {
        // Skip if no files at HEAD
        return;
      }

      // Find a file that's likely to be text
      const textFile = files.find(
        (f) => f.path.endsWith('.md') || f.path.endsWith('.json') || f.path.endsWith('.ts')
      );

      if (textFile === undefined) {
        // Skip if no suitable text file found
        return;
      }

      const result = await adapter.readFileAtCommit('HEAD', textFile.path);
      expect(result.isBinary).toBe(false);
      expect(typeof result.content).toBe('string');
    });

    it('should throw for non-existent file', async () => {
      await expect(
        adapter.readFileAtCommit('HEAD', 'nonexistent-file.xyz')
      ).rejects.toThrow(GitError);
    });
  });

  describe('worktree support', () => {
    it('should return false for isWorktree() on regular repo', () => {
      expect(adapter.isWorktree()).toBe(false);
    });

    it('should return working path same as repo path for regular repo', async () => {
      const info = adapter.getRepositoryInfo();
      expect(adapter.getWorkingPath()).toBe(info.path);
    });
  });
});

describe('GitAdapter worktree integration', () => {
  // Test worktree functionality with a temporary git repo
  // Use realpath to handle symlinks (e.g., /tmp -> /private/tmp on macOS)
  const tmpBase = realpathSync('/tmp/claude') + '/sourcerack-worktree-test';
  const mainRepoPath = join(tmpBase, 'main-repo');
  const worktreePath = join(tmpBase, 'feature-worktree');

  beforeAll(() => {
    // Cleanup any previous test artifacts
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }

    // Create test directory structure
    mkdirSync(mainRepoPath, { recursive: true });

    try {
      // Initialize main repo
      execSync('git init', { cwd: mainRepoPath, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: mainRepoPath, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: mainRepoPath, stdio: 'pipe' });

      // Create initial commit
      writeFileSync(join(mainRepoPath, 'README.md'), '# Test Repo');
      execSync('git add .', { cwd: mainRepoPath, stdio: 'pipe' });
      execSync('git commit -m "Initial commit"', { cwd: mainRepoPath, stdio: 'pipe' });

      // Create a feature branch and worktree
      execSync('git branch feature', { cwd: mainRepoPath, stdio: 'pipe' });
      execSync(`git worktree add "${worktreePath}" feature`, { cwd: mainRepoPath, stdio: 'pipe' });
    } catch (error) {
      console.error('Failed to set up worktree test:', error);
    }
  });

  afterAll(() => {
    // Cleanup
    try {
      if (existsSync(mainRepoPath)) {
        execSync(`git worktree remove "${worktreePath}" --force`, { cwd: mainRepoPath, stdio: 'pipe' });
      }
    } catch {
      // Ignore cleanup errors
    }
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('should detect worktree and resolve to main repo', async () => {
    // Skip if worktree wasn't created (e.g., git not available)
    if (!existsSync(worktreePath)) {
      return;
    }

    const worktreeAdapter = await GitAdapter.create(worktreePath);
    const mainAdapter = await GitAdapter.create(mainRepoPath);

    // Both should have the same repo ID
    const worktreeInfo = worktreeAdapter.getRepositoryInfo();
    const mainInfo = mainAdapter.getRepositoryInfo();

    expect(worktreeInfo.id).toBe(mainInfo.id);
    expect(worktreeInfo.path).toBe(mainInfo.path);
  });

  it('should identify as worktree', async () => {
    if (!existsSync(worktreePath)) {
      return;
    }

    const worktreeAdapter = await GitAdapter.create(worktreePath);

    expect(worktreeAdapter.isWorktree()).toBe(true);
    expect(worktreeAdapter.getWorkingPath()).toBe(worktreePath);
  });

  it('should identify main repo as not a worktree', async () => {
    if (!existsSync(mainRepoPath)) {
      return;
    }

    const mainAdapter = await GitAdapter.create(mainRepoPath);

    expect(mainAdapter.isWorktree()).toBe(false);
    expect(mainAdapter.getWorkingPath()).toBe(mainRepoPath);
  });
});
