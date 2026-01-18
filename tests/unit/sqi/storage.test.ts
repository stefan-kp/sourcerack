import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStorage, createMetadataStorage } from '../../../src/storage/metadata.js';
import { SQIStorage } from '../../../src/sqi/storage.js';
import { SymbolKind } from '../../../src/sqi/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SQIStorage', () => {
  let metadata: MetadataStorage;
  let sqi: SQIStorage;
  let tempDir: string;
  let dbPath: string;
  let commitId: number;
  const repoId = 'test-repo-id';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sourcerack-sqi-test-'));
    dbPath = join(tempDir, 'test.db');
    metadata = createMetadataStorage(dbPath);
    sqi = metadata.getSQIStorage();

    // Set up test repository and commit
    metadata.registerRepository(repoId, '/test/path', 'test-repo');
    const commit = metadata.startIndexing(repoId, 'abc123');
    commitId = commit.id;
  });

  afterEach(() => {
    metadata.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Symbol Operations', () => {
    it('should insert a symbol', () => {
      const id = sqi.insertSymbol(repoId, commitId, {
        name: 'myFunction',
        qualified_name: 'myFunction',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/test.ts',
        start_line: 10,
        end_line: 20,
        is_exported: true,
        content_hash: 'abc123',
      });

      expect(id).toBeGreaterThan(0);
    });

    it('should insert symbol with parameters', () => {
      const id = sqi.insertSymbol(repoId, commitId, {
        name: 'calculate',
        qualified_name: 'calculate',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/math.ts',
        start_line: 1,
        end_line: 5,
        content_hash: 'def456',
        parameters: [
          { position: 0, name: 'a', type_annotation: 'number' },
          { position: 1, name: 'b', type_annotation: 'number', is_optional: true },
        ],
      });

      const params = sqi.getSymbolParameters(id);
      expect(params).toHaveLength(2);
      expect(params[0]?.name).toBe('a');
      expect(params[1]?.is_optional).toBe(1); // SQLite stores as INTEGER
    });

    it('should insert symbol with docstring', () => {
      const id = sqi.insertSymbol(repoId, commitId, {
        name: 'MyClass',
        qualified_name: 'MyClass',
        symbol_kind: SymbolKind.CLASS,
        file_path: 'src/class.ts',
        start_line: 1,
        end_line: 50,
        content_hash: 'ghi789',
        docstring: {
          doc_type: 'jsdoc',
          raw_text: '/** This is a test class */',
          description: 'This is a test class',
        },
      });

      const docstring = sqi.getSymbolDocstring(id);
      expect(docstring).not.toBeNull();
      expect(docstring?.description).toBe('This is a test class');
    });

    it('should find symbols by name', () => {
      sqi.insertSymbol(repoId, commitId, {
        name: 'handleRequest',
        qualified_name: 'handleRequest',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/api.ts',
        start_line: 10,
        end_line: 30,
        content_hash: 'hash1',
      });

      sqi.insertSymbol(repoId, commitId, {
        name: 'handleRequest',
        qualified_name: 'Server.handleRequest',
        symbol_kind: SymbolKind.METHOD,
        file_path: 'src/server.ts',
        start_line: 50,
        end_line: 70,
        content_hash: 'hash2',
      });

      const symbols = sqi.findSymbolsByName(commitId, 'handleRequest');
      expect(symbols).toHaveLength(2);
    });

    it('should find symbols by qualified name', () => {
      sqi.insertSymbol(repoId, commitId, {
        name: 'handleRequest',
        qualified_name: 'Server.handleRequest',
        symbol_kind: SymbolKind.METHOD,
        file_path: 'src/server.ts',
        start_line: 50,
        end_line: 70,
        content_hash: 'hash1',
      });

      const symbols = sqi.findSymbolsByQualifiedName(commitId, 'Server.handleRequest');
      expect(symbols).toHaveLength(1);
      expect(symbols[0]?.symbol_kind).toBe(SymbolKind.METHOD);
    });

    it('should filter symbols by kind', () => {
      sqi.insertSymbol(repoId, commitId, {
        name: 'getData',
        qualified_name: 'getData',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/utils.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'hash1',
      });

      sqi.insertSymbol(repoId, commitId, {
        name: 'getData',
        qualified_name: 'DataService.getData',
        symbol_kind: SymbolKind.METHOD,
        file_path: 'src/service.ts',
        start_line: 20,
        end_line: 40,
        content_hash: 'hash2',
      });

      const functions = sqi.findSymbolsByName(commitId, 'getData', SymbolKind.FUNCTION);
      expect(functions).toHaveLength(1);
      expect(functions[0]?.symbol_kind).toBe(SymbolKind.FUNCTION);
    });

    it('should get symbols in file', () => {
      sqi.insertSymbol(repoId, commitId, {
        name: 'funcA',
        qualified_name: 'funcA',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/file.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'hash1',
      });

      sqi.insertSymbol(repoId, commitId, {
        name: 'funcB',
        qualified_name: 'funcB',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/file.ts',
        start_line: 15,
        end_line: 25,
        content_hash: 'hash2',
      });

      sqi.insertSymbol(repoId, commitId, {
        name: 'funcC',
        qualified_name: 'funcC',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/other.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'hash3',
      });

      const symbols = sqi.getSymbolsInFile(commitId, 'src/file.ts');
      expect(symbols).toHaveLength(2);
    });

    it('should handle child symbols', () => {
      const classId = sqi.insertSymbol(repoId, commitId, {
        name: 'MyClass',
        qualified_name: 'MyClass',
        symbol_kind: SymbolKind.CLASS,
        file_path: 'src/class.ts',
        start_line: 1,
        end_line: 50,
        content_hash: 'classHash',
        children: [
          {
            name: 'constructor',
            qualified_name: 'MyClass.constructor',
            symbol_kind: SymbolKind.CONSTRUCTOR,
            file_path: 'src/class.ts',
            start_line: 5,
            end_line: 10,
            content_hash: 'ctorHash',
          },
          {
            name: 'doSomething',
            qualified_name: 'MyClass.doSomething',
            symbol_kind: SymbolKind.METHOD,
            file_path: 'src/class.ts',
            start_line: 12,
            end_line: 20,
            content_hash: 'methodHash',
          },
        ],
      });

      const children = sqi.getChildSymbols(classId);
      expect(children).toHaveLength(2);
      expect(children[0]?.name).toBe('constructor');
      expect(children[1]?.name).toBe('doSomething');
    });
  });

  describe('Usage Operations', () => {
    it('should insert usages', () => {
      const ids = sqi.insertUsages(commitId, [
        {
          symbol_name: 'getData',
          file_path: 'src/app.ts',
          line: 15,
          column: 5,
          usage_type: 'call',
        },
        {
          symbol_name: 'getData',
          file_path: 'src/test.ts',
          line: 20,
          column: 10,
          usage_type: 'call',
        },
      ]);

      expect(ids).toHaveLength(2);
    });

    it('should find usages by name', () => {
      sqi.insertUsages(commitId, [
        { symbol_name: 'myFunc', file_path: 'src/a.ts', line: 10, column: 5, usage_type: 'call' },
        { symbol_name: 'myFunc', file_path: 'src/b.ts', line: 20, column: 3, usage_type: 'read' },
        { symbol_name: 'other', file_path: 'src/c.ts', line: 30, column: 1, usage_type: 'call' },
      ]);

      const usages = sqi.findUsagesByName(commitId, 'myFunc');
      expect(usages).toHaveLength(2);
    });

    it('should filter usages by file', () => {
      sqi.insertUsages(commitId, [
        { symbol_name: 'target', file_path: 'src/a.ts', line: 10, column: 5, usage_type: 'call' },
        { symbol_name: 'target', file_path: 'src/b.ts', line: 20, column: 3, usage_type: 'call' },
      ]);

      const usages = sqi.findUsagesByName(commitId, 'target', 'src/a.ts');
      expect(usages).toHaveLength(1);
      expect(usages[0]?.file_path).toBe('src/a.ts');
    });

    it('should link usage to definition', () => {
      const symbolId = sqi.insertSymbol(repoId, commitId, {
        name: 'myFunc',
        qualified_name: 'myFunc',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/func.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'funcHash',
      });

      const [usageId] = sqi.insertUsages(commitId, [
        { symbol_name: 'myFunc', file_path: 'src/app.ts', line: 50, column: 5, usage_type: 'call' },
      ]);

      sqi.linkUsageToDefinition(usageId!, symbolId);

      const linkedUsages = sqi.findUsagesByDefinition(symbolId);
      expect(linkedUsages).toHaveLength(1);
    });
  });

  describe('Import Operations', () => {
    it('should insert imports', () => {
      const ids = sqi.insertImports(commitId, [
        {
          file_path: 'src/app.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'lodash',
          bindings: [
            { imported_name: 'map', local_name: 'map' },
            { imported_name: 'filter', local_name: 'filter' },
          ],
        },
      ]);

      expect(ids).toHaveLength(1);
    });

    it('should get imports for file', () => {
      sqi.insertImports(commitId, [
        {
          file_path: 'src/app.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'lodash',
          bindings: [],
        },
        {
          file_path: 'src/app.ts',
          line: 2,
          import_type: 'es_import',
          module_specifier: 'react',
          bindings: [],
        },
        {
          file_path: 'src/other.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'vue',
          bindings: [],
        },
      ]);

      const imports = sqi.getImportsForFile(commitId, 'src/app.ts');
      expect(imports).toHaveLength(2);
    });

    it('should find importers of a module', () => {
      sqi.insertImports(commitId, [
        {
          file_path: 'src/a.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: '@/utils/helpers',
          bindings: [],
        },
        {
          file_path: 'src/b.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: '@/utils/helpers',
          bindings: [],
        },
        {
          file_path: 'src/c.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'lodash',
          bindings: [],
        },
      ]);

      const importers = sqi.findImporters(commitId, '@/utils/helpers');
      expect(importers).toHaveLength(2);
    });

    it('should get import bindings', () => {
      const [importId] = sqi.insertImports(commitId, [
        {
          file_path: 'src/app.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'react',
          bindings: [
            { imported_name: 'default', local_name: 'React' },
            { imported_name: 'useState', local_name: 'useState' },
            { imported_name: 'FC', local_name: 'FC', is_type_only: true },
          ],
        },
      ]);

      const bindings = sqi.getImportBindings(importId!);
      expect(bindings).toHaveLength(3);
      expect(bindings[2]?.is_type_only).toBe(1);
    });
  });

  describe('Bulk Operations', () => {
    it('should delete all data for a commit', () => {
      // Insert some data
      sqi.insertSymbol(repoId, commitId, {
        name: 'func',
        qualified_name: 'func',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/test.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'hash1',
      });

      sqi.insertUsages(commitId, [
        { symbol_name: 'func', file_path: 'src/app.ts', line: 20, column: 5, usage_type: 'call' },
      ]);

      sqi.insertImports(commitId, [
        {
          file_path: 'src/app.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'lodash',
          bindings: [],
        },
      ]);

      // Delete all data
      sqi.deleteCommitData(commitId);

      // Verify deletion
      const symbols = sqi.findSymbolsByPattern(commitId, '%');
      expect(symbols).toHaveLength(0);

      const usages = sqi.findUsagesByName(commitId, 'func');
      expect(usages).toHaveLength(0);

      const imports = sqi.getImportsForFile(commitId, 'src/app.ts');
      expect(imports).toHaveLength(0);
    });

    it('should get commit stats', () => {
      sqi.insertSymbol(repoId, commitId, {
        name: 'funcA',
        qualified_name: 'funcA',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/a.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'hash1',
      });

      sqi.insertSymbol(repoId, commitId, {
        name: 'funcB',
        qualified_name: 'funcB',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/b.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'hash2',
      });

      sqi.insertUsages(commitId, [
        { symbol_name: 'funcA', file_path: 'src/app.ts', line: 20, column: 5, usage_type: 'call' },
        { symbol_name: 'funcB', file_path: 'src/app.ts', line: 25, column: 5, usage_type: 'call' },
        { symbol_name: 'funcA', file_path: 'src/test.ts', line: 10, column: 3, usage_type: 'call' },
      ]);

      sqi.insertImports(commitId, [
        {
          file_path: 'src/app.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'lodash',
          bindings: [],
        },
      ]);

      const stats = sqi.getCommitStats(commitId);
      expect(stats.symbols).toBe(2);
      expect(stats.usages).toBe(3);
      expect(stats.imports).toBe(1);
      expect(stats.files).toBe(2); // src/a.ts and src/b.ts
    });
  });

  describe('copyUnchangedData (Phase 3: SQI Deduplication)', () => {
    let targetCommitId: number;

    beforeEach(() => {
      // Create a target commit
      const targetCommit = metadata.startIndexing(repoId, 'def456');
      targetCommitId = targetCommit.id;
    });

    it('should copy symbols with proper ID mapping', () => {
      // Insert source symbols
      sqi.insertSymbol(repoId, commitId, {
        name: 'funcA',
        qualified_name: 'funcA',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/unchanged.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'hash1',
      });

      sqi.insertSymbol(repoId, commitId, {
        name: 'funcB',
        qualified_name: 'funcB',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/changed.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'hash2',
      });

      // Copy unchanged data (exclude src/changed.ts)
      sqi.copyUnchangedData(commitId, targetCommitId, ['src/changed.ts']);

      // Verify only unchanged file was copied
      const targetSymbols = sqi.findSymbolsByPattern(targetCommitId, '%');
      expect(targetSymbols).toHaveLength(1);
      expect(targetSymbols[0]?.name).toBe('funcA');
      expect(targetSymbols[0]?.file_path).toBe('src/unchanged.ts');
    });

    it('should copy nested symbols with parent references', () => {
      // Insert class with method (parent-child relationship)
      const classId = sqi.insertSymbol(repoId, commitId, {
        name: 'MyClass',
        qualified_name: 'MyClass',
        symbol_kind: SymbolKind.CLASS,
        file_path: 'src/class.ts',
        start_line: 1,
        end_line: 50,
        content_hash: 'class-hash',
        children: [
          {
            name: 'myMethod',
            qualified_name: 'MyClass.myMethod',
            symbol_kind: SymbolKind.METHOD,
            file_path: 'src/class.ts',
            start_line: 5,
            end_line: 15,
            content_hash: 'method-hash',
          },
        ],
      });

      // Copy all data (no exclusions)
      sqi.copyUnchangedData(commitId, targetCommitId, []);

      // Verify both symbols were copied
      const targetSymbols = sqi.findSymbolsByPattern(targetCommitId, '%');
      expect(targetSymbols).toHaveLength(2);

      // Verify parent-child relationship is preserved
      const targetClass = targetSymbols.find((s) => s.name === 'MyClass');
      const targetMethod = targetSymbols.find((s) => s.name === 'myMethod');
      expect(targetClass).toBeDefined();
      expect(targetMethod).toBeDefined();

      // Check that method's parent_symbol_id points to the new class ID
      const children = sqi.getChildSymbols(targetClass!.id);
      expect(children).toHaveLength(1);
      expect(children[0]?.name).toBe('myMethod');
    });

    it('should copy symbol parameters', () => {
      sqi.insertSymbol(repoId, commitId, {
        name: 'calculate',
        qualified_name: 'calculate',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/math.ts',
        start_line: 1,
        end_line: 5,
        content_hash: 'calc-hash',
        parameters: [
          { position: 0, name: 'x', type_annotation: 'number' },
          { position: 1, name: 'y', type_annotation: 'number', is_optional: true },
        ],
      });

      sqi.copyUnchangedData(commitId, targetCommitId, []);

      const targetSymbols = sqi.findSymbolsByPattern(targetCommitId, 'calculate');
      expect(targetSymbols).toHaveLength(1);

      const params = sqi.getSymbolParameters(targetSymbols[0]!.id);
      expect(params).toHaveLength(2);
      expect(params[0]?.name).toBe('x');
      expect(params[1]?.name).toBe('y');
      expect(params[1]?.is_optional).toBe(1);
    });

    it('should copy symbol docstrings', () => {
      sqi.insertSymbol(repoId, commitId, {
        name: 'documented',
        qualified_name: 'documented',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/docs.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'doc-hash',
        docstring: {
          doc_type: 'jsdoc',
          raw_text: '/** This is a documented function */',
          description: 'This is a documented function',
        },
      });

      sqi.copyUnchangedData(commitId, targetCommitId, []);

      const targetSymbols = sqi.findSymbolsByPattern(targetCommitId, 'documented');
      expect(targetSymbols).toHaveLength(1);

      const docstring = sqi.getSymbolDocstring(targetSymbols[0]!.id);
      expect(docstring).not.toBeNull();
      expect(docstring?.doc_type).toBe('jsdoc');
      expect(docstring?.description).toBe('This is a documented function');
    });

    it('should copy usages with mapped symbol references', () => {
      // Insert a symbol
      const symbolId = sqi.insertSymbol(repoId, commitId, {
        name: 'myFunc',
        qualified_name: 'myFunc',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/lib.ts',
        start_line: 1,
        end_line: 10,
        content_hash: 'func-hash',
      });

      // Insert usage that references the symbol
      sqi.insertUsages(commitId, [
        {
          symbol_name: 'myFunc',
          file_path: 'src/lib.ts',
          line: 20,
          column: 5,
          usage_type: 'call',
        },
      ]);

      // Link usage to definition
      const usages = sqi.findUsagesByName(commitId, 'myFunc');
      expect(usages).toHaveLength(1);
      sqi.linkUsageToDefinition(usages[0]!.id, symbolId);

      // Copy data
      sqi.copyUnchangedData(commitId, targetCommitId, []);

      // Verify usages were copied
      const targetUsages = sqi.findUsagesByName(targetCommitId, 'myFunc');
      expect(targetUsages).toHaveLength(1);
      expect(targetUsages[0]?.file_path).toBe('src/lib.ts');
    });

    it('should copy imports and import bindings', () => {
      sqi.insertImports(commitId, [
        {
          file_path: 'src/app.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'react',
          bindings: [
            { imported_name: 'default', local_name: 'React' },
            { imported_name: 'useState', local_name: 'useState' },
          ],
        },
      ]);

      sqi.copyUnchangedData(commitId, targetCommitId, []);

      // Verify imports were copied
      const targetImports = sqi.getImportsForFile(targetCommitId, 'src/app.ts');
      expect(targetImports).toHaveLength(1);
      expect(targetImports[0]?.module_specifier).toBe('react');

      // Verify bindings were copied
      const bindings = sqi.getImportBindings(targetImports[0]!.id);
      expect(bindings).toHaveLength(2);
      expect(bindings[0]?.local_name).toBe('React');
      expect(bindings[1]?.local_name).toBe('useState');
    });

    it('should exclude files correctly', () => {
      // Insert data for multiple files
      sqi.insertSymbol(repoId, commitId, {
        name: 'keep1',
        qualified_name: 'keep1',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/keep.ts',
        start_line: 1,
        end_line: 5,
        content_hash: 'keep-hash',
      });

      sqi.insertSymbol(repoId, commitId, {
        name: 'exclude1',
        qualified_name: 'exclude1',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/changed1.ts',
        start_line: 1,
        end_line: 5,
        content_hash: 'exc1-hash',
      });

      sqi.insertSymbol(repoId, commitId, {
        name: 'exclude2',
        qualified_name: 'exclude2',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/changed2.ts',
        start_line: 1,
        end_line: 5,
        content_hash: 'exc2-hash',
      });

      sqi.insertImports(commitId, [
        {
          file_path: 'src/keep.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'lodash',
          bindings: [],
        },
        {
          file_path: 'src/changed1.ts',
          line: 1,
          import_type: 'es_import',
          module_specifier: 'react',
          bindings: [],
        },
      ]);

      sqi.insertUsages(commitId, [
        { symbol_name: 'keep1', file_path: 'src/keep.ts', line: 10, column: 1, usage_type: 'call' },
        { symbol_name: 'exclude1', file_path: 'src/changed1.ts', line: 10, column: 1, usage_type: 'call' },
      ]);

      // Copy with exclusions
      sqi.copyUnchangedData(commitId, targetCommitId, ['src/changed1.ts', 'src/changed2.ts']);

      // Verify only unchanged data was copied
      const targetSymbols = sqi.findSymbolsByPattern(targetCommitId, '%');
      expect(targetSymbols).toHaveLength(1);
      expect(targetSymbols[0]?.name).toBe('keep1');

      const targetImports = sqi.getImportsForFile(targetCommitId, 'src/keep.ts');
      expect(targetImports).toHaveLength(1);

      const excludedImports = sqi.getImportsForFile(targetCommitId, 'src/changed1.ts');
      expect(excludedImports).toHaveLength(0);

      const targetUsages = sqi.findUsagesByName(targetCommitId, 'keep1');
      expect(targetUsages).toHaveLength(1);

      const excludedUsages = sqi.findUsagesByName(targetCommitId, 'exclude1');
      expect(excludedUsages).toHaveLength(0);
    });

    it('should handle empty exclusion list (copy all)', () => {
      sqi.insertSymbol(repoId, commitId, {
        name: 'allFiles',
        qualified_name: 'allFiles',
        symbol_kind: SymbolKind.FUNCTION,
        file_path: 'src/all.ts',
        start_line: 1,
        end_line: 5,
        content_hash: 'all-hash',
      });

      sqi.copyUnchangedData(commitId, targetCommitId, []);

      const targetSymbols = sqi.findSymbolsByPattern(targetCommitId, '%');
      expect(targetSymbols).toHaveLength(1);
    });

    it('should handle copying from empty source commit', () => {
      // Don't insert any data in source commit
      sqi.copyUnchangedData(commitId, targetCommitId, []);

      const targetSymbols = sqi.findSymbolsByPattern(targetCommitId, '%');
      expect(targetSymbols).toHaveLength(0);
    });
  });
});
