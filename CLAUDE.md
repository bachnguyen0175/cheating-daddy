# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes, plus the tooling rules for exploring this codebase. Merge with other project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

**Precedence:** Sections 1–4 (Behavior) govern. Section 5 (Tooling) describes *how* to gather information, never *whether* to change more code than asked. If a tool result tempts you toward scope creep, Sections 2 and 3 win.

---

# Part I — Behavior

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

**Resolve before you ask:** if the uncertainty is structural — where a function lives, who calls it, whether tests exist — answer it yourself with the graph tools (Section 5) first. Only escalate to the user for questions about *intent*, which the graph can't answer.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

**Before you edit a shared symbol,** check the blast radius with `get_impact_radius_tool`. Knowing what breaks is scope *awareness*, not permission to widen scope — report what you found, fix only what the request covers.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Find the existing coverage before you write new tests: `query_graph_tool` with `pattern="tests_for"`. Extend what's there rather than duplicating it.

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

# Part II — Tooling

## 5. Codebase Exploration: Graph First

This project has a knowledge graph. **ALWAYS use the code-review-graph MCP tools BEFORE Grep/Glob/Read.** The graph is faster, cheaper (fewer tokens), and gives structural context — callers, dependents, test coverage — that file scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with `callers_of` / `callees_of` / `imports_of` / `tests_for`
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes_tool` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context_tool` | Need source snippets for review — token-efficient |
| `get_impact_radius_tool` | Understanding blast radius of a change |
| `get_affected_flows_tool` | Finding which execution paths are impacted |
| `query_graph_tool` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool` | Finding functions/classes by name or keyword |
| `get_architecture_overview_tool` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` `pattern="tests_for"` to check coverage.

### Where the two parts meet

- **Graph-first applies to *reading*, not *writing*.** Query freely; edit narrowly.
- **`refactor_tool` finds dead code. Section 3 decides its fate** — report pre-existing dead code, don't delete it unasked.
- **The trivial-task exemption still holds.** Single known file, one-line fix, no shared symbols? Just do it. Don't run a full graph sweep to change a string literal.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, clarifying questions come before implementation rather than after mistakes, and exploration burns graph queries instead of full-file reads.