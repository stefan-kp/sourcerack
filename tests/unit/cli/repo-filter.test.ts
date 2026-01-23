import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseReposOption,
  resolveRepoIdentifier,
  resolveRepoIdentifiers,
  resolveGroupRepos,
  resolveRepoFilters,
} from '../../../src/cli/repo-filter.js';
import * as configModule from '../../../src/config/config.js';
import type { MetadataStorage } from '../../../src/storage/metadata.js';

describe('Repository Filter Utilities', () => {
  let tempDir: string;
  let tempConfigPath: string;

  // Mock MetadataStorage
  const createMockMetadata = (repos: Array<{ id: string; name: string; path: string }>) => {
    return {
      listRepositories: () => repos,
      getRepositoryByPath: (path: string) => repos.find((r) => r.path === path) ?? null,
    } as unknown as MetadataStorage;
  };

  beforeEach(() => {
    // Create a temp directory for tests
    tempDir = join(tmpdir(), `sourcerack-repo-filter-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    tempConfigPath = join(tempDir, 'config.json');

    // Mock getGlobalConfigPath to return our temp path
    vi.spyOn(configModule, 'getGlobalConfigPath').mockReturnValue(tempConfigPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('parseReposOption', () => {
    it('should return empty array for undefined', () => {
      expect(parseReposOption(undefined)).toEqual([]);
    });

    it('should handle single string', () => {
      expect(parseReposOption('repo1')).toEqual(['repo1']);
    });

    it('should handle array of strings', () => {
      expect(parseReposOption(['repo1', 'repo2'])).toEqual(['repo1', 'repo2']);
    });

    it('should split comma-separated values', () => {
      expect(parseReposOption('repo1,repo2,repo3')).toEqual(['repo1', 'repo2', 'repo3']);
    });

    it('should handle mixed comma-separated and array', () => {
      expect(parseReposOption(['repo1,repo2', 'repo3'])).toEqual(['repo1', 'repo2', 'repo3']);
    });

    it('should trim whitespace', () => {
      expect(parseReposOption('repo1 , repo2 , repo3')).toEqual(['repo1', 'repo2', 'repo3']);
    });
  });

  describe('resolveRepoIdentifier', () => {
    it('should find repo by exact path', () => {
      const metadata = createMockMetadata([
        { id: '1', name: 'myrepo', path: '/path/to/myrepo' },
      ]);

      const result = resolveRepoIdentifier(metadata, '/path/to/myrepo');
      expect(result.id).toBe('1');
    });

    it('should find repo by name', () => {
      const metadata = createMockMetadata([
        { id: '1', name: 'myrepo', path: '/path/to/myrepo' },
      ]);

      const result = resolveRepoIdentifier(metadata, 'myrepo');
      expect(result.id).toBe('1');
    });

    it('should throw for ambiguous name', () => {
      const metadata = createMockMetadata([
        { id: '1', name: 'myrepo', path: '/path/one/myrepo' },
        { id: '2', name: 'myrepo', path: '/path/two/myrepo' },
      ]);

      expect(() => resolveRepoIdentifier(metadata, 'myrepo')).toThrow(/Ambiguous/);
    });

    it('should throw for not found', () => {
      const metadata = createMockMetadata([
        { id: '1', name: 'other', path: '/path/to/other' },
      ]);

      expect(() => resolveRepoIdentifier(metadata, 'notfound')).toThrow(/not found/);
    });
  });

  describe('resolveRepoIdentifiers', () => {
    it('should resolve multiple identifiers', () => {
      const metadata = createMockMetadata([
        { id: '1', name: 'repo1', path: '/path/to/repo1' },
        { id: '2', name: 'repo2', path: '/path/to/repo2' },
      ]);

      const result = resolveRepoIdentifiers(metadata, ['repo1', 'repo2']);
      expect(result.repoIds).toEqual(['1', '2']);
      expect(result.repos).toHaveLength(2);
    });

    it('should deduplicate repos', () => {
      const metadata = createMockMetadata([
        { id: '1', name: 'repo1', path: '/path/to/repo1' },
      ]);

      const result = resolveRepoIdentifiers(metadata, ['repo1', '/path/to/repo1', 'repo1']);
      expect(result.repoIds).toEqual(['1']);
    });
  });

  describe('resolveGroupRepos', () => {
    it('should resolve group to repo IDs', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo1', 'repo2'] },
          },
        }),
        'utf-8'
      );

      const metadata = createMockMetadata([
        { id: '1', name: 'repo1', path: '/path/to/repo1' },
        { id: '2', name: 'repo2', path: '/path/to/repo2' },
      ]);

      const result = resolveGroupRepos(metadata, 'mygroup');
      expect(result.repoIds).toEqual(['1', '2']);
    });

    it('should throw for non-existent group', () => {
      const metadata = createMockMetadata([]);

      expect(() => resolveGroupRepos(metadata, 'nonexistent')).toThrow(/not found/);
    });
  });

  describe('resolveRepoFilters', () => {
    it('should prioritize --repos over --group', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo2'] },
          },
        }),
        'utf-8'
      );

      const metadata = createMockMetadata([
        { id: '1', name: 'repo1', path: '/path/to/repo1' },
        { id: '2', name: 'repo2', path: '/path/to/repo2' },
      ]);

      const result = resolveRepoFilters(metadata, {
        repos: ['repo1'],
        group: 'mygroup',
      });

      expect(result.repoIds).toEqual(['1']);
    });

    it('should prioritize --group over --all-repos', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo1'] },
          },
        }),
        'utf-8'
      );

      const metadata = createMockMetadata([
        { id: '1', name: 'repo1', path: '/path/to/repo1' },
        { id: '2', name: 'repo2', path: '/path/to/repo2' },
      ]);

      const result = resolveRepoFilters(metadata, {
        group: 'mygroup',
        allRepos: true,
      });

      expect(result.repoIds).toEqual(['1']);
    });

    it('should use --all-repos when no other filter', () => {
      const metadata = createMockMetadata([
        { id: '1', name: 'repo1', path: '/path/to/repo1' },
        { id: '2', name: 'repo2', path: '/path/to/repo2' },
      ]);

      const result = resolveRepoFilters(metadata, {
        allRepos: true,
      });

      expect(result.repoIds).toHaveLength(2);
    });

    it('should fall back to default group', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            defaultgrp: { repos: ['repo1'] },
          },
          defaultGroup: 'defaultgrp',
        }),
        'utf-8'
      );

      const metadata = createMockMetadata([
        { id: '1', name: 'repo1', path: '/path/to/repo1' },
        { id: '2', name: 'repo2', path: '/path/to/repo2' },
      ]);

      const result = resolveRepoFilters(metadata, {});
      expect(result.repoIds).toEqual(['1']);
    });

    it('should return current repo if no filter and no default group', () => {
      const metadata = createMockMetadata([
        { id: '1', name: 'repo1', path: '/path/to/repo1' },
      ]);

      const result = resolveRepoFilters(metadata, {}, '1');
      expect(result.repoIds).toEqual(['1']);
    });
  });
});
