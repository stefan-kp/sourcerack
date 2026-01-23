import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listGroups,
  getGroup,
  addGroup,
  removeGroup,
  setDefaultGroup,
  getDefaultGroup,
  groupExists,
  addReposToGroup,
  removeReposFromGroup,
} from '../../../src/config/groups.js';
import * as configModule from '../../../src/config/config.js';

describe('Repository Groups', () => {
  let tempDir: string;
  let tempConfigPath: string;

  beforeEach(() => {
    // Create a temp directory for tests
    tempDir = join(tmpdir(), `sourcerack-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    tempConfigPath = join(tempDir, 'config.json');

    // Mock getGlobalConfigPath to return our temp path
    vi.spyOn(configModule, 'getGlobalConfigPath').mockReturnValue(tempConfigPath);
  });

  afterEach(() => {
    // Clean up
    vi.restoreAllMocks();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('listGroups', () => {
    it('should return empty array when no config exists', () => {
      const groups = listGroups();
      expect(groups).toEqual([]);
    });

    it('should return empty array when config has no groups', () => {
      writeFileSync(tempConfigPath, JSON.stringify({}), 'utf-8');
      const groups = listGroups();
      expect(groups).toEqual([]);
    });

    it('should return all groups', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            work: { repos: ['repo1', 'repo2'], description: 'Work projects' },
            personal: { repos: ['myapp'] },
          },
        }),
        'utf-8'
      );

      const groups = listGroups();
      expect(groups).toHaveLength(2);
      expect(groups).toContainEqual({
        name: 'work',
        repos: ['repo1', 'repo2'],
        description: 'Work projects',
      });
      expect(groups).toContainEqual({
        name: 'personal',
        repos: ['myapp'],
        description: undefined,
      });
    });
  });

  describe('getGroup', () => {
    it('should return null for non-existent group', () => {
      const group = getGroup('nonexistent');
      expect(group).toBeNull();
    });

    it('should return group by name', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo1'], description: 'My group' },
          },
        }),
        'utf-8'
      );

      const group = getGroup('mygroup');
      expect(group).toEqual({
        name: 'mygroup',
        repos: ['repo1'],
        description: 'My group',
      });
    });
  });

  describe('addGroup', () => {
    it('should create a new group', () => {
      addGroup('newgroup', ['repo1', 'repo2'], 'A new group');

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.groups.newgroup).toEqual({
        repos: ['repo1', 'repo2'],
        description: 'A new group',
      });
    });

    it('should replace an existing group', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            existing: { repos: ['old1'], description: 'Old desc' },
          },
        }),
        'utf-8'
      );

      addGroup('existing', ['new1', 'new2'], 'New desc');

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.groups.existing).toEqual({
        repos: ['new1', 'new2'],
        description: 'New desc',
      });
    });

    it('should create groups object if not present', () => {
      writeFileSync(tempConfigPath, JSON.stringify({}), 'utf-8');

      addGroup('first', ['repo1']);

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.groups.first).toEqual({
        repos: ['repo1'],
      });
    });
  });

  describe('removeGroup', () => {
    it('should return false for non-existent group', () => {
      const result = removeGroup('nonexistent');
      expect(result).toBe(false);
    });

    it('should remove an existing group', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            toremove: { repos: ['repo1'] },
            keep: { repos: ['repo2'] },
          },
        }),
        'utf-8'
      );

      const result = removeGroup('toremove');
      expect(result).toBe(true);

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.groups.toremove).toBeUndefined();
      expect(config.groups.keep).toBeDefined();
    });

    it('should clear defaultGroup if removing the default', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            default: { repos: ['repo1'] },
          },
          defaultGroup: 'default',
        }),
        'utf-8'
      );

      removeGroup('default');

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.defaultGroup).toBeUndefined();
    });
  });

  describe('setDefaultGroup / getDefaultGroup', () => {
    it('should return null when no default is set', () => {
      const defaultGroup = getDefaultGroup();
      expect(defaultGroup).toBeNull();
    });

    it('should set and get the default group', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mydefault: { repos: ['repo1'] },
          },
        }),
        'utf-8'
      );

      const result = setDefaultGroup('mydefault');
      expect(result).toBe(true);

      const defaultGroup = getDefaultGroup();
      expect(defaultGroup).toBe('mydefault');
    });

    it('should return false for non-existent group', () => {
      const result = setDefaultGroup('nonexistent');
      expect(result).toBe(false);
    });

    it('should clear default group when passed null', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo1'] },
          },
          defaultGroup: 'mygroup',
        }),
        'utf-8'
      );

      const result = setDefaultGroup(null);
      expect(result).toBe(true);

      const defaultGroup = getDefaultGroup();
      expect(defaultGroup).toBeNull();
    });
  });

  describe('groupExists', () => {
    it('should return false for non-existent group', () => {
      expect(groupExists('nonexistent')).toBe(false);
    });

    it('should return true for existing group', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            exists: { repos: ['repo1'] },
          },
        }),
        'utf-8'
      );

      expect(groupExists('exists')).toBe(true);
    });
  });

  describe('addReposToGroup', () => {
    it('should return false for non-existent group', () => {
      const result = addReposToGroup('nonexistent', ['repo1']);
      expect(result).toBe(false);
    });

    it('should add repos to existing group', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo1'] },
          },
        }),
        'utf-8'
      );

      const result = addReposToGroup('mygroup', ['repo2', 'repo3']);
      expect(result).toBe(true);

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.groups.mygroup.repos).toContain('repo1');
      expect(config.groups.mygroup.repos).toContain('repo2');
      expect(config.groups.mygroup.repos).toContain('repo3');
    });

    it('should not add duplicate repos', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo1', 'repo2'] },
          },
        }),
        'utf-8'
      );

      addReposToGroup('mygroup', ['repo2', 'repo3']);

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.groups.mygroup.repos).toHaveLength(3);
    });
  });

  describe('removeReposFromGroup', () => {
    it('should return false for non-existent group', () => {
      const result = removeReposFromGroup('nonexistent', ['repo1']);
      expect(result).toBe(false);
    });

    it('should remove repos from existing group', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo1', 'repo2', 'repo3'] },
          },
        }),
        'utf-8'
      );

      const result = removeReposFromGroup('mygroup', ['repo2']);
      expect(result).toBe(true);

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.groups.mygroup.repos).toEqual(['repo1', 'repo3']);
    });

    it('should delete group if all repos removed', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo1'] },
          },
        }),
        'utf-8'
      );

      removeReposFromGroup('mygroup', ['repo1']);

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.groups.mygroup).toBeUndefined();
    });

    it('should clear defaultGroup if emptying the default group', () => {
      writeFileSync(
        tempConfigPath,
        JSON.stringify({
          groups: {
            mygroup: { repos: ['repo1'] },
          },
          defaultGroup: 'mygroup',
        }),
        'utf-8'
      );

      removeReposFromGroup('mygroup', ['repo1']);

      const config = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));
      expect(config.defaultGroup).toBeUndefined();
    });
  });
});
