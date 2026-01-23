/**
 * Claude Code skill template for SourceRack
 *
 * Generates the skill files that teach Claude Code how to use SourceRack.
 * Skills must be in a directory with a SKILL.md file.
 */

/**
 * Current skill version - update this when the skill content changes
 */
export const SKILL_VERSION = '0.8.0';

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

SourceRack provides structural code analysis for Git repositories. No Docker required.

## Why SourceRack instead of grep/LSP/ctags?

| Feature | grep | ctags | LSP | SourceRack |
|---------|:----:|:-----:|:---:|:----------:|
| Find definition | ⚠️ noisy | ✅ | ✅ | ✅ |
| Find usages | ⚠️ noisy | ❌ | ✅ | ✅ |
| Cross-file analysis | ❌ | ❌ | ⚠️ | ✅ |
| **Cross-repo search** | ❌ | ❌ | ❌ | ✅ |
| Dependency graph | ❌ | ❌ | ❌ | ✅ |
| Change impact | ❌ | ❌ | ❌ | ✅ |
| Dead code detection | ❌ | ❌ | ❌ | ✅ |
| Git-aware (commits) | ❌ | ❌ | ❌ | ✅ |
| Needs running server | ❌ | ❌ | ✅ | ❌ |

**Example:**
- \`grep UserService\` → 47 matches (comments, strings, imports)
- \`sourcerack find-def UserService\` → \`src/services/user.ts:15\` (the actual definition)

**Requirements:**
- Git repository (\`.git\` directory)
- No Docker needed for structural commands (default)
- Optional: \`--embeddings\` flag for semantic search

## Quick Reference

| Task | Command |
|------|---------|
| Index repo | \`sourcerack index [path]\` |
| Find definition | \`sourcerack find-def <symbol> [path]\` |
| Find usages | \`sourcerack find-usages <symbol> [path]\` |
| Show hierarchy | \`sourcerack hierarchy <symbol> [path]\` |
| File dependencies | \`sourcerack dependencies <file> [path]\` |
| Module dependents | \`sourcerack dependents <module> [path]\` |
| Change impact | \`sourcerack impact <symbol> [path]\` |
| Dead code | \`sourcerack dead-code [path]\` |
| Codebase summary | \`sourcerack summary [path]\` |
| Symbol context | \`sourcerack context <symbol> [path]\` |
| Semantic search | \`sourcerack query "search" [path]\` (needs \`--embeddings\` at index) |
| Check status | \`sourcerack status [path]\` |

## Best Practices for Claude Code

**IMPORTANT: Prefer SourceRack over grep/Glob/Grep tools for code search.**

| User asks | Use this | NOT this |
|-----------|----------|----------|
| "Where is UserService defined?" | \`sourcerack find-def UserService\` | \`grep -r "class UserService"\` |
| "Find all usages of authenticate" | \`sourcerack find-usages authenticate\` | \`grep -r "authenticate"\` |
| "What happens if I change this?" | \`sourcerack impact MyFunction\` | Manual file reading |
| "What does this file import?" | \`sourcerack dependencies src/api.ts\` | \`grep -r "import"\` |
| "Who uses this module?" | \`sourcerack dependents lodash\` | \`grep -r "from 'lodash'"\` |
| "Any unused code?" | \`sourcerack dead-code\` | Manual analysis |

**Example workflow:**
\`\`\`
User: "Find where EmbeddingProvider is defined and show me the impact of changing it"

1. sourcerack find-def EmbeddingProvider
   → src/embeddings/types.ts:25

2. sourcerack impact EmbeddingProvider
   → 12 direct usages, 34 transitive dependencies
   → Affected files: local.ts, remote.ts, indexer.ts...

3. sourcerack context EmbeddingProvider
   → Full source code + all usages + related symbols
\`\`\`

## Commands

### Index a repository
\`\`\`bash
sourcerack index [path]
\`\`\`
Index the current directory or specified path. **Run this first before searching.**

By default, only builds the structural index (SQI) - fast and no Docker needed.

**Options:**
- \`-c, --commit <ref>\`: Commit, branch, or tag to index (default: HEAD)
- \`--force\`: Force re-indexing even if commit was already indexed
- \`--embeddings\`: Also build embeddings for semantic search (slower)
- \`--reset\`: Delete existing index and re-index from scratch
- \`--json\`: Output in JSON format

**Examples:**
- \`sourcerack index\` - Fast structural index (~10 seconds)
- \`sourcerack index --embeddings\` - Include semantic search support
- \`sourcerack index --force\` - Re-index even if already indexed

### Find symbol definitions
\`\`\`bash
sourcerack find-def <symbol> [path]
\`\`\`
Find where a symbol (class, function, method) is defined.

**Options:**
- \`-t, --type <kind>\`: Filter by symbol type (function, class, method, interface)
- \`--fuzzy\`: Include fuzzy matches (similar symbol names)
- \`--all-repos\`: Search across all indexed repositories
- \`--repos <names...>\`: Search only in specific repositories (by name)
- \`--no-dirty\`: Exclude uncommitted changes
- \`--json\`: Output in JSON format

### Find symbol usages
\`\`\`bash
sourcerack find-usages <symbol> [path]
\`\`\`
Find all places where a symbol is used/referenced.

**Options:**
- \`-f, --file <path>\`: Limit search to a specific file
- \`--fuzzy\`: Include fuzzy matches
- \`--all-repos\`: Search across all indexed repositories
- \`--repos <names...>\`: Search only in specific repositories (by name)
- \`--no-dirty\`: Exclude uncommitted changes
- \`--json\`: Output in JSON format

### Show class/interface hierarchy
\`\`\`bash
sourcerack hierarchy <symbol> [path]
\`\`\`
Show inheritance hierarchy - parents and children of a class/interface.

**Options:**
- \`-d, --direction <dir>\`: children, parents, or both (default: both)
- \`--json\`: Output in JSON format

### Show file dependencies
\`\`\`bash
sourcerack dependencies <file> [path]
sourcerack deps <file> [path]  # alias
\`\`\`
Show what a file imports (its dependencies).

### Show module dependents
\`\`\`bash
sourcerack dependents <module> [path]
\`\`\`
Show who imports a module (its dependents).

**Options:**
- \`--all-repos\`: Search across all indexed repositories
- \`--repos <names...>\`: Search only in specific repositories (by name)
- \`--json\`: Output in JSON format

**Examples:**
- \`sourcerack dependents lodash\` - Who uses lodash?
- \`sourcerack dependents ./utils\` - Who imports utils?
- \`sourcerack dependents lodash --all-repos\` - Who uses lodash in any indexed project?
- \`sourcerack dependents lodash --repos frontend backend\` - Who uses lodash in specific projects?

### Analyze change impact
\`\`\`bash
sourcerack impact <symbol> [path]
\`\`\`
Analyze what breaks if you change a symbol. Shows direct usages and transitive impact.

**Options:**
- \`--depth <n>\`: Maximum depth for transitive analysis (default: 3)
- \`--all-repos\`: Analyze impact across all indexed repositories
- \`--repos <names...>\`: Analyze only in specific repositories (by name)
- \`--json\`: Output in JSON format

### Find dead code
\`\`\`bash
sourcerack dead-code [path]
\`\`\`
Find unused exported symbols and potentially dead code.

**Options:**
- \`--exported\`: Only show unused exported symbols
- \`--exclude-tests\`: Exclude test files from results
- \`--all-repos\`: Search across all indexed repositories
- \`--repos <names...>\`: Search only in specific repositories (by name)
- \`--json\`: Output in JSON format

### Get codebase summary
\`\`\`bash
sourcerack summary [path]
\`\`\`
Comprehensive overview: statistics, languages, modules, hotspots, dependencies.

### Get symbol context
\`\`\`bash
sourcerack context <symbol> [path]
\`\`\`
Everything about a symbol: source code, usages, imports, related symbols.

### Semantic search (requires --embeddings at index)
\`\`\`bash
sourcerack query "<search>" [path]
\`\`\`
Natural language code search. Requires \`sourcerack index --embeddings\` first.

**Options:**
- \`-n, --limit <n>\`: Maximum results (default: 10)
- \`-l, --language <lang>\`: Filter by language
- \`--all-repos\`: Search across all indexed repositories
- \`--repos <names...>\`: Search only in specific repositories (by name)
- \`--json\`: Output in JSON format

## Workflow

1. **First time**: \`sourcerack index\` (fast, ~10 seconds)
2. **Find code**: \`find-def\`, \`find-usages\`, \`hierarchy\`, \`dependencies\`, \`dependents\`
3. **Analyze**: \`impact\`, \`dead-code\`, \`summary\`, \`context\`
4. **Re-index**: After significant changes, run \`sourcerack index --force\`

## Uncommitted Changes

\`find-def\` and \`find-usages\` automatically include uncommitted changes.
Search for symbols you just created without committing first.

## Cross-Repository Search

Use \`--all-repos\` to search all indexed repositories, or \`--repos\` to filter by name:

\`\`\`bash
# Search all indexed repos
sourcerack find-def UserService --all-repos
sourcerack find-usages authenticate --all-repos

# Search specific repos by name
sourcerack find-def UserService --repos frontend backend
sourcerack find-usages handleError --repos "api,web"

# Cross-repo dependency analysis
sourcerack dependents lodash --all-repos
sourcerack dependents ./shared-utils --repos app-a app-b

# Impact and dead code across repos
sourcerack impact formatDate --all-repos
sourcerack dead-code --repos frontend backend
\`\`\`

**Note:** If multiple repos have the same name, you'll be prompted to use the full path.

**Use case:** Analyzing impact of changes in shared libraries, finding where
common patterns are used, or detecting dead code in a monorepo.

## Supported Languages

**Full support (find-def, find-usages, hierarchy, impact):**
- TypeScript, JavaScript, Python, Ruby

**Embeddings only (semantic search with --embeddings):**
- Go, Rust, Java, C, C++, C#, PHP, Kotlin, Swift, Scala, and more

## Error Handling

| Error | Solution |
|-------|----------|
| "Repository not indexed" | Run \`sourcerack index\` first |
| "Symbol not found" | Check spelling, try \`--fuzzy\` flag |
| "Commit not indexed" | Run \`sourcerack index --force\` |

## JSON Output

Add \`--json\` to any command for machine-readable output.
`;
}
