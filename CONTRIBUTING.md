# Contributing to SourceRack

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/sourcerack.git
cd sourcerack

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Link for local development
npm link
```

## Code Style

We use ESLint and TypeScript strict mode. Before submitting:

```bash
# Check for lint errors
npm run lint

# Type check
npm run typecheck

# Run all checks
npm test && npm run lint
```

### Guidelines

- Use TypeScript strict mode (`strict: true`)
- Prefer `const` over `let`
- Use async/await over raw promises
- Add JSDoc comments for public APIs
- Keep functions focused and small

## Project Structure

```
src/
├── cli/              # CLI commands and output formatting
├── config/           # Configuration loading and schema
├── embeddings/       # Embedding providers (fastembed, remote)
├── git/              # Git operations (simple-git wrapper)
├── indexer/          # Main indexing logic
├── mcp/              # MCP server and tools
├── parser/           # Tree-sitter integration
├── sqi/              # Structured Query Index
│   ├── extractors/   # Language-specific symbol extractors
│   ├── linker/       # Usage-to-definition linking
│   └── storage.ts    # SQLite storage for symbols
└── storage/          # Qdrant and metadata storage

tests/
├── unit/             # Unit tests
└── integration/      # Integration tests (require Qdrant)
```

## Adding a New Language Extractor

This is the most common contribution. Here's how to add support for a new language:

### 1. Check Tree-sitter Grammar Availability

First, verify a tree-sitter grammar exists for your language:

```bash
npm search tree-sitter-<language>
```

### 2. Add Grammar to languages.yml

Edit `src/parser/languages.yml`:

```yaml
go:
  extensions: [".go"]
  package: "tree-sitter-go"
  version: "^0.21.0"
  tier: optional  # or 'core' for bundled languages
```

### 3. Create the Extractor

Create `src/sqi/extractors/<language>.ts`. Use existing extractors as reference:

```typescript
import Parser from 'tree-sitter';
import { SymbolExtractor } from './base.js';
import {
  ExtractedSymbol,
  ExtractedUsage,
  ExtractedImport,
  FileExtractionResult,
  SymbolKind
} from '../types.js';

export class GoExtractor extends SymbolExtractor {
  readonly language = 'go';
  readonly aliases: string[] = ['golang'];

  extract(
    tree: Parser.Tree,
    filePath: string,
    sourceCode: string
  ): FileExtractionResult {
    const symbols: ExtractedSymbol[] = [];
    const usages: ExtractedUsage[] = [];
    const imports: ExtractedImport[] = [];

    // Walk the AST and extract symbols
    this.traverse(tree.rootNode, (node) => {
      // Handle function declarations
      if (node.type === 'function_declaration') {
        const symbol = this.extractFunction(node, filePath, sourceCode);
        if (symbol) symbols.push(symbol);
      }
      // ... handle other node types
    });

    return {
      file_path: filePath,
      language: this.language,
      symbols,
      usages,
      imports,
      success: true,
    };
  }

  private extractFunction(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedSymbol | null {
    const nameNode = this.getChildByField(node, 'name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const location = this.getLocation(node);

    return {
      name,
      qualified_name: name,
      symbol_kind: SymbolKind.FUNCTION,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility: this.determineVisibility(name),
      content_hash: this.generateContentHash(node.text),
    };
  }

  private determineVisibility(name: string): 'public' | 'private' {
    // Go convention: uppercase = exported (public)
    return name[0] === name[0].toUpperCase() ? 'public' : 'private';
  }
}
```

### 4. Register the Extractor

Edit `src/sqi/extractors/registry.ts`:

```typescript
import { GoExtractor } from './go.js';

export class ExtractorRegistry {
  constructor() {
    this.register(new TypeScriptExtractor());
    this.register(new PythonExtractor());
    this.register(new RubyExtractor());
    this.register(new GoExtractor());  // Add this
  }
}
```

### 5. Add Tests

Create `tests/unit/sqi/<language>-extractor.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { GoExtractor } from '../../../src/sqi/extractors/go.js';
import { SymbolKind } from '../../../src/sqi/types.js';
import { initializeTreeSitter, parseCode, ensureLanguageGrammar } from '../../../src/parser/tree-sitter.js';

describe('GoExtractor', () => {
  const extractor = new GoExtractor();
  let grammarAvailable = false;

  beforeAll(async () => {
    await initializeTreeSitter();
    grammarAvailable = await ensureLanguageGrammar('go');
  });

  const itIfGo = (name: string, fn: () => void | Promise<void>) => {
    it(name, async () => {
      if (!grammarAvailable) {
        console.log(`Skipping: ${name} (Go grammar not available)`);
        return;
      }
      await fn();
    });
  };

  describe('Symbol Extraction', () => {
    itIfGo('should extract function definitions', () => {
      const code = `
package main

func HelloWorld() string {
    return "Hello, World!"
}
`;
      const tree = parseCode(code, 'go');
      const result = extractor.extract(tree, 'main.go', code);

      expect(result.success).toBe(true);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]?.name).toBe('HelloWorld');
      expect(result.symbols[0]?.symbol_kind).toBe(SymbolKind.FUNCTION);
      expect(result.symbols[0]?.visibility).toBe('public');
    });
  });
});
```

### 6. What to Extract

At minimum, extract:

- **Functions/Methods**: Name, parameters, return type, visibility
- **Classes/Structs/Types**: Name, members, inheritance
- **Constants/Variables**: Module-level declarations
- **Imports**: Module specifiers and bindings

For usages, track:
- Function/method calls
- Type references
- Class instantiation
- Inheritance relationships

### 7. Testing Your Extractor

```bash
# Run your specific tests
npm test -- --run tests/unit/sqi/go-extractor.test.ts

# Test with a real project
sourcerack index /path/to/go/project
sourcerack find-def main
sourcerack find-usages MyFunction
```

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/go-extractor`
3. Make your changes
4. Run tests: `npm test && npm run lint`
5. Commit with a descriptive message
6. Push and create a pull request

### Commit Message Format

```
feat(extractor): add Go language support

- Extract functions, methods, structs, interfaces
- Handle Go visibility conventions (exported vs unexported)
- Extract import statements
- Add comprehensive tests
```

## Architecture Decisions

### Vector Database: Qdrant

We currently use **Qdrant** as the vector database. This was chosen for:
- Easy Docker deployment
- Good performance for our scale
- Simple HTTP API

**Community Contribution Opportunity:** The codebase could be abstracted to support other vector databases (Pinecone, Weaviate, Milvus, ChromaDB, etc.). The current implementation is in `src/storage/qdrant.ts`. A pluggable interface similar to `EmbeddingProvider` would allow users to choose their preferred vector store.

### Embedding Provider

Embeddings are abstracted via the `EmbeddingProvider` interface (`src/embeddings/types.ts`):

```typescript
interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingVector>;
  embedBatch(texts: string[]): Promise<EmbeddingVector[]>;
  dimensions: number;
}
```

Two implementations exist:
- `LocalEmbeddingProvider` - Uses fastembed (ONNX-based, runs locally)
- `RemoteEmbeddingProvider` - HTTP-based, calls external API

Users can configure a remote embedding endpoint in their config to use any embedding service (OpenAI, Voyage, self-hosted, etc.) that follows the expected API format.

### Structured Query Index (SQI)

SQI uses **SQLite** for storing extracted symbols, usages, and imports. This is intentionally simple and fast, requiring no external services. The schema is in `src/sqi/storage.ts`.

## Questions?

Open an issue for:
- Bug reports
- Feature requests
- Questions about implementation

We're happy to help!
