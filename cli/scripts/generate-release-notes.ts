#!/usr/bin/env bun
/**
 * Release Notes Generator
 *
 * Generates release notes from git commit history using conventional commits.
 * Analyzes commits between two references (tags, commits, or branches).
 *
 * Usage:
 *   bun run scripts/generate-release-notes.ts [options]
 *
 * Options:
 *   --since <ref>     Start reference (tag, commit, branch). Default: auto-detect last tag
 *   --until <ref>     End reference. Default: HEAD
 *   --version <ver>   Version string for the release (e.g., "0.14.0")
 *   --format <fmt>    Output format: markdown (default), json
 *   --output <file>   Write to file instead of stdout
 */

import { execFileSync } from "child_process";
import * as fs from "fs";

// Valid git ref pattern: alphanumeric, dots, hyphens, underscores, slashes, tildes, carets
const GIT_REF_PATTERN = /^[a-zA-Z0-9._~^/+-]+$/;
// Valid git SHA pattern: 7-40 hex characters
const GIT_SHA_PATTERN = /^[a-f0-9]{7,40}$/i;

function isValidGitRef(ref: string): boolean {
  return GIT_REF_PATTERN.test(ref) && !ref.includes("..");
}

function isValidGitSha(sha: string): boolean {
  return GIT_SHA_PATTERN.test(sha);
}

// Conventional commit types and their display names
const COMMIT_TYPES: Record<string, { title: string; emoji: string; priority: number }> = {
  feat: { title: "New Features", emoji: "🚀", priority: 1 },
  fix: { title: "Bug Fixes", emoji: "🐛", priority: 2 },
  perf: { title: "Performance Improvements", emoji: "⚡", priority: 3 },
  refactor: { title: "Refactoring", emoji: "♻️", priority: 4 },
  docs: { title: "Documentation", emoji: "📚", priority: 5 },
  chore: { title: "Maintenance", emoji: "🔧", priority: 6 },
  test: { title: "Testing", emoji: "🧪", priority: 7 },
  ci: { title: "CI/CD", emoji: "🔄", priority: 8 },
  build: { title: "Build System", emoji: "📦", priority: 9 },
  style: { title: "Code Style", emoji: "💅", priority: 10 },
};

// Scopes to highlight (CLI, monitoring, etc.)
const KNOWN_SCOPES = ["cli", "monitoring", "reporter", "grafana", "mcp", "prepare-db", "checkup", "deps", "ci", "formula", "pgai", "dashboards"];

// Author name mappings for deduplication
const AUTHOR_ALIASES: Record<string, string> = {
  "Nik Samokhvalov": "Nikolay Samokhvalov",
};

// Authors to exclude from contributors list (bots, AI assistants)
const EXCLUDED_AUTHORS = ["Claude", "dependabot[bot]", "github-actions[bot]"];

function normalizeAuthor(author: string): string {
  return AUTHOR_ALIASES[author] || author;
}

function isExcludedAuthor(author: string): boolean {
  return EXCLUDED_AUTHORS.some((excluded) => author.toLowerCase().includes(excluded.toLowerCase()));
}

interface ParsedCommit {
  hash: string;
  shortHash: string;
  type: string;
  scope: string | null;
  subject: string;
  body: string;
  breaking: boolean;
  date: string;
  author: string;
}

interface ReleaseNotes {
  version: string;
  date: string;
  sinceRef: string;
  untilRef: string;
  commits: ParsedCommit[];
  categories: Record<string, ParsedCommit[]>;
  breaking: ParsedCommit[];
  stats: {
    total: number;
    features: number;
    fixes: number;
    contributors: string[];
  };
}

function gitExec(args: string[]): string {
  try {
    const result = execFileSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return result.trim();
  } catch (err) {
    return "";
  }
}

function parseArgs(): { since: string; until: string; version: string; format: string; output: string | null } {
  const args = process.argv.slice(2);
  const result = { since: "", until: "HEAD", version: "", format: "markdown", output: null as string | null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--since":
        result.since = next || "";
        i++;
        break;
      case "--until":
        result.until = next || "HEAD";
        i++;
        break;
      case "--version":
        result.version = next || "";
        i++;
        break;
      case "--format":
        result.format = next || "markdown";
        i++;
        break;
      case "--output":
        result.output = next || null;
        i++;
        break;
      case "--help":
        console.log(`
Release Notes Generator

Usage: bun run scripts/generate-release-notes.ts [options]

Options:
  --since <ref>     Start reference (tag, commit, or branch)
                    Default: auto-detect last release tag
  --until <ref>     End reference (tag, commit, or branch)
                    Default: HEAD
  --version <ver>   Version string for the release header
                    Default: derived from --until or current date
  --format <fmt>    Output format: markdown (default) or json
  --output <file>   Write to file instead of stdout

Examples:
  # Generate notes for upcoming 0.14.0 release
  bun run scripts/generate-release-notes.ts --version 0.14.0

  # Generate notes between two commits
  bun run scripts/generate-release-notes.ts --since abc123 --until def456

  # Output as JSON
  bun run scripts/generate-release-notes.ts --format json
`);
        process.exit(0);
    }
  }
  return result;
}

function detectLastTag(): string {
  // Try to find the last version tag
  const tags = gitExec(["tag", "--sort=-version:refname"]).split("\n").filter(Boolean);

  // Look for semantic version tags
  for (const tag of tags) {
    if (/^v?\d+\.\d+/.test(tag)) {
      return tag;
    }
  }

  // Fallback: find a meaningful starting point from commit messages
  const versionCommits = gitExec(["log", "--grep=prepare-for-0.14\\|0.13\\|release", "--format=%H"]).split("\n").filter(Boolean);
  if (versionCommits.length > 0 && versionCommits[0]) {
    return versionCommits[0];
  }

  // Last resort: 100 commits back
  return "HEAD~100";
}

function getCommitsBetween(since: string, until: string): string[] {
  // Validate refs to prevent command injection
  if (since && !isValidGitRef(since)) {
    throw new Error(`Invalid git ref: ${since}`);
  }
  if (!isValidGitRef(until)) {
    throw new Error(`Invalid git ref: ${until}`);
  }

  // Get commit hashes between the two refs
  const range = since ? `${since}..${until}` : until;
  const output = gitExec(["log", range, "--format=%H", "--no-merges"]);
  return output.split("\n").filter(Boolean);
}

function parseCommit(hash: string): ParsedCommit | null {
  // Validate hash to prevent command injection
  if (!isValidGitSha(hash)) {
    return null;
  }

  // Use null byte as delimiter (unlikely to appear in commit messages)
  const format = "%H%x00%h%x00%s%x00%b%x00%ad%x00%an";
  const output = gitExec(["log", "-1", `--format=${format}`, "--date=short", hash]);

  if (!output) return null;

  const parts = output.split("\x00");
  const [fullHash, shortHash, subject, body, date, author] = parts;

  if (!subject) return null;

  const trimmedBody = (body || "").trim();

  // Parse conventional commit format: type(scope): subject
  // Also handle: type: subject, type!: subject (breaking)
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);

  let type = "other";
  let scope: string | null = null;
  let breaking = false;
  let cleanSubject = subject;

  if (match) {
    type = match[1]?.toLowerCase() || "other";
    scope = match[2] || null;
    breaking = !!match[3] || trimmedBody.includes("BREAKING CHANGE");
    cleanSubject = match[4] || subject;
  }

  // Normalize type aliases
  if (type === "feature") type = "feat";
  if (type === "bugfix") type = "fix";

  return {
    hash: fullHash || hash,
    shortHash: shortHash || hash.slice(0, 7),
    type,
    scope,
    subject: cleanSubject,
    body: trimmedBody,
    breaking,
    date: date || new Date().toISOString().split("T")[0] || "",
    author: (author || "").trim(),
  };
}

function categorizeCommits(commits: ParsedCommit[]): Record<string, ParsedCommit[]> {
  const categories: Record<string, ParsedCommit[]> = {};

  for (const commit of commits) {
    const type = COMMIT_TYPES[commit.type] ? commit.type : "other";
    if (!categories[type]) {
      categories[type] = [];
    }
    categories[type].push(commit);
  }

  return categories;
}

function generateMarkdown(notes: ReleaseNotes): string {
  const lines: string[] = [];

  // Header
  const dateStr = new Date().toISOString().split("T")[0];
  lines.push(`# Release ${notes.version || "Notes"}`);
  lines.push("");
  lines.push(`**Release Date:** ${dateStr}`);
  lines.push("");

  // Stats summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`This release includes **${notes.stats.total}** changes:`);
  lines.push(`- ${notes.stats.features} new features`);
  lines.push(`- ${notes.stats.fixes} bug fixes`);
  lines.push("");

  // Breaking changes (if any)
  if (notes.breaking.length > 0) {
    lines.push("## Breaking Changes");
    lines.push("");
    for (const commit of notes.breaking) {
      const scopeStr = commit.scope ? `**${commit.scope}:** ` : "";
      lines.push(`- ${scopeStr}${commit.subject}`);
    }
    lines.push("");
  }

  // Categories sorted by priority
  const sortedTypes = Object.keys(notes.categories).sort((a, b) => {
    const pa = COMMIT_TYPES[a]?.priority ?? 99;
    const pb = COMMIT_TYPES[b]?.priority ?? 99;
    return pa - pb;
  });

  for (const type of sortedTypes) {
    const commits = notes.categories[type];
    if (!commits || commits.length === 0) continue;

    const typeInfo = COMMIT_TYPES[type] || { title: "Other Changes", emoji: "📝", priority: 99 };
    lines.push(`## ${typeInfo.emoji} ${typeInfo.title}`);
    lines.push("");

    // Group by scope within each type
    const byScope: Record<string, ParsedCommit[]> = {};
    for (const commit of commits) {
      const scope = commit.scope || "_general";
      if (!byScope[scope]) byScope[scope] = [];
      byScope[scope].push(commit);
    }

    // Sort scopes: known scopes first, then alphabetically
    const scopes = Object.keys(byScope).sort((a, b) => {
      if (a === "_general") return 1;
      if (b === "_general") return -1;
      const aKnown = KNOWN_SCOPES.includes(a);
      const bKnown = KNOWN_SCOPES.includes(b);
      if (aKnown && !bKnown) return -1;
      if (!aKnown && bKnown) return 1;
      return a.localeCompare(b);
    });

    for (const scope of scopes) {
      const scopeCommits = byScope[scope] || [];
      if (scope !== "_general" && scopeCommits.length > 0) {
        lines.push(`### ${scope}`);
        lines.push("");
      }
      for (const commit of scopeCommits) {
        lines.push(`- ${commit.subject} (\`${commit.shortHash}\`)`);
      }
      lines.push("");
    }
  }

  // Contributors
  if (notes.stats.contributors.length > 0) {
    lines.push("## Contributors");
    lines.push("");
    lines.push("Thank you to all contributors:");
    lines.push("");
    for (const contributor of notes.stats.contributors.sort()) {
      lines.push(`- ${contributor}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generateJson(notes: ReleaseNotes): string {
  return JSON.stringify(notes, null, 2);
}

async function main() {
  const args = parseArgs();

  // Determine the range
  const since = args.since || detectLastTag();
  const until = args.until;

  const log = (msg: string) => process.stderr.write(msg + "\n");
  log(`Analyzing commits from ${since} to ${until}...`);

  // Get and parse commits
  const hashes = getCommitsBetween(since, until);
  log(`Found ${hashes.length} commits to analyze`);

  const commits: ParsedCommit[] = [];
  for (const hash of hashes) {
    const parsed = parseCommit(hash);
    if (parsed) {
      commits.push(parsed);
    }
  }

  // Build release notes structure
  const categories = categorizeCommits(commits);
  const breaking = commits.filter((c) => c.breaking);

  // Normalize author names and exclude bots/AI
  const contributors = [
    ...new Set(
      commits
        .map((c) => normalizeAuthor(c.author))
        .filter((author) => author && !isExcludedAuthor(author))
    ),
  ];

  const notes: ReleaseNotes = {
    version: args.version || "",
    date: new Date().toISOString().split("T")[0] || "",
    sinceRef: since,
    untilRef: until,
    commits,
    categories,
    breaking,
    stats: {
      total: commits.length,
      features: categories["feat"]?.length || 0,
      fixes: categories["fix"]?.length || 0,
      contributors,
    },
  };

  // Generate output
  let output: string;
  if (args.format === "json") {
    output = generateJson(notes);
  } else {
    output = generateMarkdown(notes);
  }

  // Write output
  if (args.output) {
    fs.writeFileSync(args.output, output, "utf8");
    log(`Release notes written to: ${args.output}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error("Error generating release notes:", err);
  process.exit(1);
});
