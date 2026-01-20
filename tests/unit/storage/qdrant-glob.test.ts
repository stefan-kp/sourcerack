/**
 * Tests for glob pattern filtering in Qdrant search
 */

import { describe, it, expect } from 'vitest';
import { minimatch } from 'minimatch';

/**
 * These tests verify the glob pattern matching behavior that is used
 * in QdrantStorage.search() for path filtering.
 * 
 * The actual implementation uses minimatch with matchBase: true option.
 */

describe('Glob Pattern Filtering', () => {
  describe('minimatch behavior verification', () => {
    it('should match exact file extensions', () => {
      expect(minimatch('src/app.ts', '*.ts', { matchBase: true })).toBe(true);
      expect(minimatch('src/utils/helper.ts', '*.ts', { matchBase: true })).toBe(true);
      expect(minimatch('src/app.js', '*.ts', { matchBase: true })).toBe(false);
    });

    it('should match double-star patterns for nested directories', () => {
      expect(minimatch('src/components/Button.tsx', 'src/**/*.tsx', { matchBase: true })).toBe(true);
      expect(minimatch('src/pages/Home.tsx', 'src/**/*.tsx', { matchBase: true })).toBe(true);
      expect(minimatch('lib/Button.tsx', 'src/**/*.tsx', { matchBase: true })).toBe(false);
    });

    it('should match test file patterns', () => {
      expect(minimatch('src/utils/helper.test.ts', '**/*.test.ts', { matchBase: true })).toBe(true);
      expect(minimatch('tests/unit/app.test.ts', '**/*.test.ts', { matchBase: true })).toBe(true);
      expect(minimatch('src/app.ts', '**/*.test.ts', { matchBase: true })).toBe(false);
    });

    it('should handle complex patterns with directory wildcards', () => {
      // Match any TypeScript file in test directories
      expect(minimatch('tests/unit/foo.test.ts', '**/test*/**/*.ts', { matchBase: true })).toBe(true);
      expect(minimatch('tests/integration/bar.ts', '**/test*/**/*.ts', { matchBase: true })).toBe(true);
      expect(minimatch('src/utils/foo.ts', '**/test*/**/*.ts', { matchBase: true })).toBe(false);
    });

    it('should match single directory wildcard patterns', () => {
      expect(minimatch('src/services/user.ts', 'src/*/user.ts', { matchBase: true })).toBe(true);
      expect(minimatch('src/services/api/user.ts', 'src/*/user.ts', { matchBase: true })).toBe(false);
    });

    it('should handle patterns without wildcards (exact prefix)', () => {
      expect(minimatch('src/index.ts', 'src/*', { matchBase: true })).toBe(true);
      expect(minimatch('src/utils/index.ts', 'src/*', { matchBase: true })).toBe(false);
    });

    it('should match extension patterns correctly', () => {
      expect(minimatch('package.json', '*.json', { matchBase: true })).toBe(true);
      expect(minimatch('src/config.json', '*.json', { matchBase: true })).toBe(true);
      expect(minimatch('src/app.ts', '*.json', { matchBase: true })).toBe(false);
    });
  });

  describe('search filter scenarios', () => {
    const testPaths = [
      'src/index.ts',
      'src/utils/helper.ts',
      'src/utils/helper.test.ts',
      'src/components/Button.tsx',
      'tests/unit/app.test.ts',
      'tests/integration/api.test.ts',
      'lib/external.ts',
      'package.json',
      'tsconfig.json',
    ];

    function filterPaths(pattern: string): string[] {
      return testPaths.filter(p => minimatch(p, pattern, { matchBase: true }));
    }

    it('should filter to only test files', () => {
      const result = filterPaths('**/*.test.ts');
      expect(result).toEqual([
        'src/utils/helper.test.ts',
        'tests/unit/app.test.ts',
        'tests/integration/api.test.ts',
      ]);
    });

    it('should filter to only src directory TypeScript files', () => {
      const result = filterPaths('src/**/*.ts');
      expect(result).toEqual([
        'src/index.ts',
        'src/utils/helper.ts',
        'src/utils/helper.test.ts',
      ]);
    });

    it('should filter to only JSON files', () => {
      const result = filterPaths('*.json');
      expect(result).toEqual([
        'package.json',
        'tsconfig.json',
      ]);
    });

    it('should filter to only TSX files', () => {
      const result = filterPaths('**/*.tsx');
      expect(result).toEqual([
        'src/components/Button.tsx',
      ]);
    });

    it('should filter to tests directory only', () => {
      const result = filterPaths('tests/**/*');
      expect(result).toEqual([
        'tests/unit/app.test.ts',
        'tests/integration/api.test.ts',
      ]);
    });
  });
});
