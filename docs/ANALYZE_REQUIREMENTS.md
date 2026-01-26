# Requirements: `analyze` Command (LLM-Based Code Analysis)

## Goal

Define a new `sourcerack analyze` command that runs offline, LLM-driven code analysis using existing SourceRack metadata (e.g., dependency graph, call graph, symbol context). The command should guide the user through selecting analysis scenarios (via prompts), then iterate through the codebase with the selected prompts while preserving conversation context.

## Problem Statement

SourceRack already builds rich structural metadata (symbols, imports, call graph, change impact). We want to enable a second-stage, LLM-powered audit pass that leverages those artifacts to identify potential security issues, bugs, inconsistencies, and architectural smells. The analysis should run locally (e.g., via Ollama) to reduce token costs and preserve privacy.

## Scope

### In Scope

- A new CLI command: `sourcerack analyze`.
- Validation that **indexing is complete** for the target commit before analysis starts.
  - Embeddings are **not required**.
- A prompt library (English prompts) for targeted analysis scenarios (e.g., Security, Bug Detection, Architecture Drift).
- An interactive selection flow (checkbox-style) to pick which prompts to run.
- An iterative LLM loop that:
  - Feeds structured context into the LLM.
  - Preserves and extends conversation context between iterations.
- Configuration-driven LLM provider selection (prefers Ollama endpoint, but configurable).

### Out of Scope (for this phase)

- Embedding generation or semantic search.
- Full UI (web) or visualization of findings.
- Cross-repo or multi-repo analysis.
- Real-time, editor-integrated workflows.

## Functional Requirements

### 1) CLI Command

- **Command**: `sourcerack analyze`
- **Options** (initial proposal):
  - `--commit <ref>`: commit SHA/branch to analyze (default: `HEAD`).
  - `--config <path>`: optional config file path override (reuse existing config loader behavior).
  - `--output <path>`: optional path for findings export (JSON/Markdown; default to stdout).
  - `--format <json|md|text>`: output format (default `text`).
  - `--prompts <list>`: non-interactive selection by prompt IDs (comma-separated). Optional; otherwise interactive selection is required.

### 2) Preconditions: Indexing Status

- Before any analysis starts, the command must check:
  - The commit is fully indexed (SQI metadata present).
  - If indexing is incomplete, exit with a clear error and actionable next steps (e.g., run `sourcerack index`).
- Embeddings are explicitly **not required**.

### 3) Prompt Library

- Provide a prompt directory (example path: `prompts/analyze/`).
- Prompts are **English** and have explicit IDs (e.g., `security_audit`, `bug_hunt`, `consistency_check`).
- Prompts can be stored as `.md` or `.txt` with front-matter or a small JSON/YAML header for metadata, such as:
  - `id`, `name`, `description`, `tags`, `version`, `min_context`.

### 4) Prompt Selection UI (Interactive)

- If `--prompts` is not supplied, prompt the user with a checklist of available prompts.
- The user can select one or more prompts to run.
- The selected prompts are composed into a single “analysis plan” (ordered steps), each with its own LLM call strategy.

### 5) Iterative LLM Loop

- For each selected prompt:
  1. Assemble structured context from SourceRack metadata (symbols, call graph, dependency graph, imports, hotspot list, change impact, etc.).
  2. Send to the LLM using a structured message template.
  3. Receive structured findings (JSON or Markdown block with fields).
  4. Feed summary + findings back into the LLM to continue the analysis.
- Conversation context is preserved throughout the prompt’s iteration sequence.
- The loop should be robust to large repos by chunking context (e.g., module by module).

### 6) Findings Output

- Findings should be structured and traceable with:
  - `id`, `severity`, `confidence`, `category`, `summary`, `details`, `evidence`, `symbol_refs`, `file_refs`, and `suggested_fix`.
- Output can be streamed to stdout or written to file.

## Configuration Requirements

### Configuration Keys (Proposed)

Add a new `analysis` section under config:

```json
{
  "analysis": {
    "provider": "ollama",
    "model": "codellama:latest",
    "ollamaUrl": "http://localhost:11434",
    "temperature": 0.2,
    "maxTokens": 4096,
    "promptDir": "./prompts/analyze",
    "outputFormat": "text"
  }
}
```

- Allow the provider to be swapped (e.g., `ollama`, `openai`, `custom_http`).
- Default to `ollama` if available, but allow overrides.

### Environment Overrides (Optional)

Extend environment variable mappings for analysis settings (optional in later iteration).

## UX Requirements

- If indexing is incomplete, show a **single-line** remediation hint.
- Make the prompt selection and analysis progress user-friendly with clear progress indicators.
- Provide a dry-run option in future iteration (not in scope for MVP).

## Security & Privacy Requirements

- If provider is remote, warn about code context leaving the machine.
- If using Ollama/local, note that analysis is local.

## Non-Functional Requirements

- Should handle large repos without exhausting memory (use chunked context).
- Must be resilient to partial failures; if one prompt fails, remaining prompts can proceed with a warning.
- Logs should capture LLM input/output sizes and timing.

## Open Questions

1. What subset of existing metadata should be the default context payload?
2. How should we prioritize which files/modules get analyzed first?
3. What is the minimal viable prompt format (front-matter, JSON, or file naming convention)?
4. Should the initial output be strictly JSON to enable CI parsing, or allow text?
5. How do we ensure “findings” map to concrete symbols when LLM returns ambiguous references?

## Acceptance Criteria (MVP)

- `sourcerack analyze` exists and enforces indexing precondition.
- Prompts are discoverable and selectable interactively.
- Analysis runs using the configured LLM provider (Ollama by default).
- Outputs contain structured findings with file/symbol references.
- Works on a repository without embedding index.
