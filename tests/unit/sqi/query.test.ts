import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMetadataStorage, type MetadataStorage } from '../../../src/storage/metadata.js';
import { createStructuredQueryEngine } from '../../../src/sqi/query.js';
import { SymbolKind } from '../../../src/sqi/types.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

describe('StructuredQueryEngine', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let metadata: MetadataStorage;
  let commitSha: string;
  let commitId: number;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sourcerack-sqi-query-'));
    repoPath = join(tempDir, 'repo');
    dbPath = join(tempDir, 'metadata.db');

    mkdirSync(repoPath, { recursive: true });
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });

    mkdirSync(join(repoPath, 'src'), { recursive: true });

    const indexContents = [
      "import { map } from 'lodash';",
      "import { helper } from './utils';",
      'export function greet(name: string) {',
      '  return helper(name);',
      '}',
      '',
    ].join('\n');
    const utilsContents = [
      'export function helper(name: string) {',
      '  return `Hello ${name}`;',
      '}',
      '',
    ].join('\n');

    writeFileSync(join(repoPath, 'src', 'index.ts'), indexContents);
    writeFileSync(join(repoPath, 'src', 'utils.ts'), utilsContents);

    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: 'pipe' });

    commitSha = execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe' })
      .toString()
      .trim();

    metadata = createMetadataStorage(dbPath);
    const repo = metadata.registerRepository('repo-id', repoPath, 'test-repo');
    const commitRecord = metadata.startIndexing(repo.id, commitSha);
    commitId = commitRecord.id;

    const sqi = metadata.getSQIStorage();

    const helperId = sqi.insertSymbol(repo.id, commitId, {
      name: 'helper',
      qualified_name: 'helper',
      symbol_kind: SymbolKind.FUNCTION,
      file_path: 'src/utils.ts',
      start_line: 1,
      end_line: 3,
      is_exported: true,
      content_hash: 'helper-hash',
    });

    const greetId = sqi.insertSymbol(repo.id, commitId, {
      name: 'greet',
      qualified_name: 'greet',
      symbol_kind: SymbolKind.FUNCTION,
      file_path: 'src/index.ts',
      start_line: 3,
      end_line: 5,
      is_exported: true,
      content_hash: 'greet-hash',
    });

    const [usageId] = sqi.insertUsages(commitId, [
      {
        symbol_name: 'helper',
        file_path: 'src/index.ts',
        line: 4,
        column: 10,
        usage_type: 'call',
      },
    ]);
    if (usageId) {
      sqi.linkUsageToDefinition(usageId, helperId);
      sqi.linkUsageToEnclosing(usageId, greetId);
    }

    sqi.insertImports(commitId, [
      {
        file_path: 'src/index.ts',
        line: 1,
        import_type: 'es_import',
        module_specifier: 'lodash',
        bindings: [{ imported_name: 'map', local_name: 'map' }],
      },
      {
        file_path: 'src/index.ts',
        line: 2,
        import_type: 'es_import',
        module_specifier: './utils',
        bindings: [{ imported_name: 'helper', local_name: 'helper' }],
      },
    ]);

    // Mark indexing as complete
    metadata.completeIndexing(commitId, 2);
  });

  afterAll(() => {
    metadata.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a codebase summary with expected sections', async () => {
    const queryEngine = createStructuredQueryEngine(metadata);

    const result = await queryEngine.codebaseSummary({
      repo_path: repoPath,
      commit: commitSha,
      include_hotspots: true,
      include_dependencies: true,
      max_modules: 5,
      max_hotspots: 5,
    });

    expect(result.success).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary?.total_files).toBe(2);
    expect(result.summary?.total_symbols).toBe(2);
    expect(result.summary?.total_usages).toBe(1);
    expect(result.summary?.total_imports).toBe(2);

    expect(result.summary?.entry_points.some((entry) => entry.file_path === 'src/index.ts')).toBe(true);
    expect(result.summary?.dependencies.some((dep) => dep.name === 'lodash')).toBe(true);
    expect(result.summary?.hotspots.some((spot) => spot.name === 'helper')).toBe(true);
  });

  it('returns symbol context with source and usages', async () => {
    const queryEngine = createStructuredQueryEngine(metadata);

    const result = await queryEngine.getSymbolContext({
      repo_path: repoPath,
      commit: commitSha,
      symbol_name: 'helper',
      include_source: true,
      include_usages: true,
      max_usages: 5,
    });

    expect(result.success).toBe(true);
    expect(result.context?.symbol.name).toBe('helper');
    expect(result.context?.source_code).toContain('export function helper');
    expect(result.context?.usages.length).toBe(1);
    expect(result.context?.usages[0]?.file_path).toBe('src/index.ts');
  });

  it('builds a dependency graph from imports', async () => {
    const queryEngine = createStructuredQueryEngine(metadata);

    const result = await queryEngine.getDependencyGraph({
      repo_path: repoPath,
      commit: commitSha,
      max_edges: 10,
    });

    expect(result.success).toBe(true);
    expect(result.graph).toBeDefined();
    expect(result.graph?.nodes).toContain('src');
    expect(result.graph?.nodes).toContain('lodash');
    expect(result.graph?.edges.some((edge) => edge.to === 'lodash')).toBe(true);
  });

  it('analyzes change impact for a symbol', async () => {
    const queryEngine = createStructuredQueryEngine(metadata);

    const result = await queryEngine.analyzeChangeImpact({
      repo_path: repoPath,
      commit: commitSha,
      symbol_name: 'helper',
      max_depth: 1,
    });

    expect(result.success).toBe(true);
    expect(result.symbol?.name).toBe('helper');
    expect(result.direct_usages.length).toBe(1);
    expect(result.total_affected).toBeGreaterThan(0);
  });
});
