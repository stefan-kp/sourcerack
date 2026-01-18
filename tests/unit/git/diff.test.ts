import { describe, it, expect } from 'vitest';
import { computeCommitDiff, getCommitChanges } from '../../../src/git/diff.js';
import { resolve } from 'node:path';

describe('Git Diff', () => {
  // Use the sourcerack repository itself for testing
  const repoPath = resolve(process.cwd());

  describe('computeCommitDiff', () => {
    it('should compute diff between same commit (empty result)', async () => {
      // Get current HEAD
      const { simpleGit } = await import('simple-git');
      const git = simpleGit(repoPath);
      const sha = (await git.revparse(['HEAD'])).trim();

      const diff = await computeCommitDiff(repoPath, sha, sha);

      expect(diff.fromCommit).toBe(sha);
      expect(diff.toCommit).toBe(sha);
      expect(diff.changes).toHaveLength(0);
    });

    it('should return structured diff result', async () => {
      const { simpleGit } = await import('simple-git');
      const git = simpleGit(repoPath);

      // Get two commits if available
      const log = await git.log({ maxCount: 2 });
      if (log.all.length < 2) {
        // Skip if only one commit
        return;
      }

      const fromCommit = log.all[1]?.hash;
      const toCommit = log.all[0]?.hash;

      if (fromCommit === undefined || toCommit === undefined) {
        return;
      }

      const diff = await computeCommitDiff(repoPath, fromCommit, toCommit);

      expect(diff.fromCommit).toBe(fromCommit);
      expect(diff.toCommit).toBe(toCommit);
      expect(Array.isArray(diff.changes)).toBe(true);

      // Each change should have required fields
      for (const change of diff.changes) {
        expect(change.path).toBeDefined();
        expect(['added', 'modified', 'deleted', 'renamed', 'copied']).toContain(
          change.changeType
        );
      }
    });
  });

  describe('getCommitChanges', () => {
    it('should get changes for a commit', async () => {
      const { simpleGit } = await import('simple-git');
      const git = simpleGit(repoPath);
      const sha = (await git.revparse(['HEAD'])).trim();

      const changes = await getCommitChanges(repoPath, sha);

      expect(Array.isArray(changes)).toBe(true);
      // Changes should be valid
      for (const change of changes) {
        expect(change.path).toBeDefined();
        expect(typeof change.path).toBe('string');
      }
    });
  });
});
