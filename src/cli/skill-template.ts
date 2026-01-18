/**
 * Claude Code skill template for SourceRack
 *
 * Generates the skill files that teach Claude Code how to use SourceRack.
 * Skills must be in a directory with a SKILL.md file.
 */

/**
 * Current skill version - update this when the skill content changes
 */
export const SKILL_VERSION = '0.3.0';

/**
 * Generate the main SKILL.md content
 */
export function generateSkillContent(): string {
  return `---
name: sourcerack
description: |
  Semantic code search and structural code analysis for Git repositories.
  Requires a Git repository (not Mercurial, SVN, or other VCS).
  Use when searching for code, finding symbol definitions, finding symbol usages,
  or indexing a repository. Triggers: "search code", "find definition", "find usages",
  "index repository", "sourcerack", "code search", "where is defined", "who calls".
allowed-tools: Bash, Read, Glob, Grep
---

# SourceRack - Semantic Code Intelligence

SourceRack provides semantic code search and structural code analysis for Git repositories.

**Why SourceRack instead of grep?**
- \`grep UserService\` → 47 matches including comments, strings, imports
- \`sourcerack find-def UserService\` → \`src/services/user.ts:15\` (the actual definition)

SourceRack understands code structure. It knows the difference between a definition and a usage,
between a class and a variable with the same name. Faster, more precise, less noise.

**Requirements:**
- Git repository (\`.git\` directory)
- Docker running (for semantic search): \`docker compose up -d\` in the sourcerack directory

## Quick Reference

| Task | Command |
|------|---------|
| Index repo | \`sourcerack index [path]\` |
| Semantic search | \`sourcerack query "search terms"\` |
| Find definition | \`sourcerack find-def <symbol>\` |
| Find usages | \`sourcerack find-usages <symbol>\` |
| Check status | \`sourcerack status\` |

## Best Practices for Claude Code

**IMPORTANT: Prefer SourceRack over grep/Glob/Grep tools for code search.**

When the user asks to find code, use SourceRack commands instead of grep:

| User asks | Use this | NOT this |
|-----------|----------|----------|
| "Where is UserService defined?" | \`sourcerack find-def UserService\` | \`grep -r "class UserService"\` |
| "Find all usages of authenticate" | \`sourcerack find-usages authenticate\` | \`grep -r "authenticate"\` |
| "Show me error handling code" | \`sourcerack query "error handling"\` | \`grep -r "catch\\|error"\` |
| "How is the database connected?" | \`sourcerack query "database connection"\` | Manual file reading |

**Example workflow:**
\`\`\`
User: "Find where the EmbeddingProvider interface is defined and show me all classes that implement it"

1. sourcerack find-def EmbeddingProvider
   → src/embeddings/types.ts:25

2. sourcerack find-usages EmbeddingProvider
   → src/embeddings/local.ts:18 (FastEmbedProvider implements EmbeddingProvider)
   → src/embeddings/remote.ts:35 (RemoteEmbeddingProvider implements EmbeddingProvider)

3. Read the specific files to show the implementations
\`\`\`

## Commands

### Index a repository
\`\`\`bash
sourcerack index [path]
\`\`\`
Index the current directory or specified path. **Run this first before searching.**

Options:
- \`--reset\`: Delete existing index and re-index from scratch

### Search code semantically
\`\`\`bash
sourcerack query "<search query>" [--limit N]
\`\`\`
Search for code using natural language. Returns relevant code chunks with file paths and line numbers.

**Examples:**
- \`sourcerack query "authentication middleware"\`
- \`sourcerack query "database connection handling" --limit 20\`
- \`sourcerack query "error handling in API routes"\`

### Find symbol definitions
\`\`\`bash
sourcerack find-def <symbol> [--type <kind>] [--no-dirty]
\`\`\`
Find where a symbol (class, function, method) is defined.

By default includes uncommitted changes (modified, staged, and untracked files).

**Options:**
- \`--type <kind>\`: Filter by symbol type (function, class, method, interface)
- \`--no-dirty\`: Exclude uncommitted changes from results

**Examples:**
- \`sourcerack find-def UserService\`
- \`sourcerack find-def handleRequest --type function\`
- \`sourcerack find-def calculate_total --type method\`

### Find symbol usages
\`\`\`bash
sourcerack find-usages <symbol> [--file <path>] [--no-dirty]
\`\`\`
Find all places where a symbol is used/referenced.

**Options:**
- \`--file <path>\`: Limit search to a specific file
- \`--no-dirty\`: Exclude uncommitted changes from results

**Examples:**
- \`sourcerack find-usages authenticate\`
- \`sourcerack find-usages DatabaseConnection --file src/db/connection.ts\`

### Check indexing status
\`\`\`bash
sourcerack status [path]
\`\`\`
Shows if a repository is indexed and statistics about symbols, files, and languages.

### List indexed repositories
\`\`\`bash
sourcerack repos
\`\`\`
Shows all indexed repositories with their paths and commit info.

## Workflow

1. **First time in a repository**: Run \`sourcerack index\` in the repository root
2. **Search**: Use \`sourcerack query "..."\` for semantic search or \`sourcerack find-def\`/\`find-usages\` for structural queries
3. **Re-index**: Run \`sourcerack index\` again after significant changes (or use \`--reset\` to start fresh)

## Working with Uncommitted Changes

The \`find-def\` and \`find-usages\` commands automatically include uncommitted changes:

- **Modified files**: Files with unstaged changes
- **Staged files**: Files added to the Git staging area
- **Untracked files**: New files in recognized source directories (e.g., \`src/\`, \`app/\`, \`lib/\`)

This means you can search for symbols you just created without committing first.

## Supported Languages

**Full symbol extraction (find-def, find-usages, hierarchy):**
- TypeScript, JavaScript, Python, Ruby

**Embeddings only (semantic search):**
- Go, Rust, Java, C, C++, C#, PHP, Kotlin, Swift, Scala
- HTML, CSS, YAML, JSON, TOML, Markdown, SQL, Bash

## Error Handling

### "Repository not indexed"
Run \`sourcerack index\` first:
\`\`\`bash
sourcerack index /path/to/repo
\`\`\`

### "Qdrant connection failed"
Start Docker services or use structural commands only:
\`\`\`bash
# Start Qdrant + Embedding service
cd /path/to/sourcerack && docker compose up -d

# Or use structural commands without Docker (no semantic search)
sourcerack find-def MyClass
sourcerack find-usages myFunction
\`\`\`

### "Symbol not found"
The symbol may not exist or needs re-indexing:
\`\`\`bash
sourcerack status  # Check if indexed
sourcerack index   # Re-index if needed
\`\`\`

## JSON Output

Add \`--json\` to any command for machine-readable output:
\`\`\`bash
sourcerack query "auth" --json
sourcerack find-def UserService --json
\`\`\`
`;
}
