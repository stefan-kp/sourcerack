# SourceRack

**Code search that actually understands your code.**

> *While grep is still counting matches, SourceRack already found the definition.*

SourceRack combines AST-based symbol extraction with semantic embeddings to give you precise code navigation. Find definitions, track usages, and search by meaning - not just text patterns.

## Why SourceRack?

| What you want | grep/ripgrep | SourceRack |
|---------------|--------------|------------|
| Find where `UserService` is defined | 47 matches (good luck) | `src/services/user.ts:15` |
| Find all usages of `authenticate` | Includes comments & strings | Only actual code references |
| "Show me the error handling" | `???` | Returns relevant code blocks |
| Track class hierarchy | Manual detective work | `--hierarchy` flag |

**Performance**: Index a 100-file TypeScript project in ~10 seconds. Queries return in milliseconds.

## Features

- **Precise Symbol Search** - AST-level accuracy for definitions and usages
- **Semantic Search** - Natural language queries ("find authentication middleware")
- **Multi-Language** - TypeScript, JavaScript, Python, Ruby (full support), 20+ languages for embeddings
- **Git-Aware** - Index specific commits, automatic deduplication across branches
- **Incremental** - Only re-process changed files
- **Local-First** - Your code stays on your machine
- **AI-Ready** - MCP server + Claude Code skill included

## Quick Start

### 1. Install

```bash
git clone https://github.com/yourusername/sourcerack.git
cd sourcerack
npm install && npm run build
npm link  # optional: make 'sourcerack' available globally
```

### 2. Start Services

SourceRack uses Docker Compose to run Qdrant (vector database) and the embedding service:

```bash
docker compose up -d
```

This starts:
- **Qdrant** on `localhost:6333` - Vector storage for semantic search
- **Embedding Service** on `localhost:8080` - Generates embeddings via fastembed

### 3. Index Your Code

```bash
sourcerack index /path/to/your/repo
```

### 4. Search

```bash
# Find where a symbol is defined
sourcerack find-def UserService
# → src/services/user.ts:15  [class] exported UserService

# Find all usages
sourcerack find-usages authenticate
# → Shows every call site with context

# Semantic search - find by meaning
sourcerack query "error handling in API routes"
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `sourcerack index [path]` | Index a repository |
| `sourcerack find-def <symbol>` | Find symbol definition |
| `sourcerack find-usages <symbol>` | Find all usages of a symbol |
| `sourcerack hierarchy <symbol>` | Show class inheritance tree |
| `sourcerack query <search>` | Semantic search |
| `sourcerack status` | Show index status |
| `sourcerack repos` | List indexed repositories |

### Examples

```bash
# Find a class definition
sourcerack find-def ExtractorRegistry

# Find method usages, filter by type
sourcerack find-usages handleRequest --type method

# Semantic search with limit
sourcerack query "database connection handling" --limit 20

# Show class hierarchy
sourcerack hierarchy BaseExtractor

# JSON output for scripting
sourcerack find-def MyClass --json
```

## Configuration

Configuration lives in `~/.sourcerack/config.json`:

```json
{
  "embedding": {
    "enabled": true,
    "provider": "remote",
    "remoteUrl": "http://127.0.0.1:8080/embed"
  },
  "qdrant": {
    "url": "http://localhost:6333"
  }
}
```

### SQI-Only Mode (No Docker)

For structural queries only (find-def, find-usages), you don't need Docker:

```json
{
  "embedding": {
    "enabled": false
  }
}
```

This disables semantic search but keeps all symbol-based features working.

### Custom Embedding Provider

You can point to any embedding service that follows this API:

```bash
POST /embed
Body: { "texts": ["text1", "text2"] }
Response: { "embeddings": [[...], [...]], "dimensions": 384 }
```

Just set `remoteUrl` in your config to your endpoint.

## Claude Code Integration

SourceRack includes a skill for Claude Code:

```bash
# The skill auto-installs to ~/.claude/skills/sourcerack/
# Just ask Claude: "find where UserService is defined"
```

## MCP Server

Use SourceRack with any MCP-compatible client:

```bash
sourcerack mcp
```

Add to Claude Desktop (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sourcerack": {
      "command": "node",
      "args": ["/path/to/sourcerack/dist/mcp/index.js"]
    }
  }
}
```

## Supported Languages

**Full Symbol Extraction** (find-def, find-usages, hierarchy):
- TypeScript / JavaScript
- Python
- Ruby

**Embeddings Only** (semantic search):
- Go, Rust, Java, C, C++, C#, PHP, Kotlin, Swift, Scala
- HTML, CSS, YAML, JSON, TOML, Markdown, SQL, Bash

Want to add a language? See [CONTRIBUTING.md](./CONTRIBUTING.md) - it's ~200-400 lines of code.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Source     │────▶│ Tree-sitter │────▶│  Extractor  │
│  Files      │     │   Parser    │     │  (per lang) │
└─────────────┘     └─────────────┘     └─────────────┘
                                               │
                    ┌──────────────────────────┴──────────────────────────┐
                    ▼                                                      ▼
             ┌─────────────┐                                       ┌─────────────┐
             │   SQLite    │                                       │   Qdrant    │
             │    (SQI)    │                                       │  (Docker)   │
             └─────────────┘                                       └─────────────┘
                    │                                                      │
                    ▼                                                      ▼
             find-def                                               semantic query
             find-usages                                            "find auth code"
             hierarchy
```

## Requirements

- Node.js 20 LTS or later
- Docker & Docker Compose (for semantic search)

## Development

```bash
npm test        # Run tests
npm run lint    # Linting
npm run build   # Build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT
