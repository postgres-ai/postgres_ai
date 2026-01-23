#!/usr/bin/env bun
/**
 * Release Notes Generator
 *
 * Generates release notes from git commit history using conventional commits.
 * Analyzes commits between two references (tags, commits, or branches).
 * Fetches MR numbers from GitLab API and includes links.
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
 *   --gitlab-project  GitLab project path (default: postgres-ai/postgresai)
 */

import { execFileSync } from "child_process";
import * as fs from "fs";

// GitLab project configuration
const GITLAB_PROJECT = "postgres-ai/postgresai";
const GITLAB_MR_URL = `https://gitlab.com/${GITLAB_PROJECT}/-/merge_requests`;

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

interface GitLabMR {
  iid: number;
  title: string;
  source_branch: string;
  merged_at: string | null;
  labels?: string[];
}

interface ChangelogEntry {
  mrNumber: number;
  title: string;
  type: string;
  scope: string | null;
  breaking: boolean;
  authors: Set<string>;
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
  mrNumber?: number;
}

interface ReleaseNotes {
  version: string;
  date: string;
  sinceRef: string;
  untilRef: string;
  commits: ParsedCommit[];
  entries: ChangelogEntry[];
  categories: Record<string, ChangelogEntry[]>;
  breaking: ChangelogEntry[];
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

// Cache for GitLab MRs
let mrCache: GitLabMR[] | null = null;

async function fetchMergedMRs(sinceDate: string): Promise<GitLabMR[]> {
  if (mrCache) return mrCache;

  const mrs: GitLabMR[] = [];
  const projectEncoded = encodeURIComponent(GITLAB_PROJECT);

  try {
    // Fetch merged MRs, paginate through all results
    let page = 1;
    const perPage = 100;

    while (true) {
      const url = `https://gitlab.com/api/v4/projects/${projectEncoded}/merge_requests?state=merged&per_page=${perPage}&page=${page}&updated_after=${sinceDate}`;
      const response = await fetch(url);

      if (!response.ok) break;

      const pageMrs: GitLabMR[] = await response.json();
      if (pageMrs.length === 0) break;

      mrs.push(...pageMrs);

      if (pageMrs.length < perPage) break;
      page++;
    }
  } catch (err) {
    // Silently fail - MR links are optional
  }

  mrCache = mrs;
  return mrs;
}

function buildBranchToMRMap(mrs: GitLabMR[]): Map<string, GitLabMR> {
  const map = new Map<string, GitLabMR>();
  for (const mr of mrs) {
    map.set(mr.source_branch, mr);
  }
  return map;
}

function getMRNumberFromBranch(branch: string, mrMap: Map<string, GitLabMR>): number | undefined {
  const mr = mrMap.get(branch);
  return mr?.iid;
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

function parseMRTitle(title: string): { type: string; scope: string | null; subject: string; breaking: boolean } {
  // Parse conventional commit format from MR title: type(scope): subject
  const match = title.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);

  if (match) {
    let type = match[1]?.toLowerCase() || "other";
    if (type === "feature") type = "feat";
    if (type === "bugfix") type = "fix";

    return {
      type,
      scope: match[2] || null,
      subject: match[4] || title,
      breaking: !!match[3],
    };
  }

  // If not conventional commit format, try to infer type from title
  const lowerTitle = title.toLowerCase();
  let inferredType = "other";
  if (lowerTitle.startsWith("fix") || lowerTitle.includes("fix:") || lowerTitle.includes("bugfix")) {
    inferredType = "fix";
  } else if (lowerTitle.startsWith("feat") || lowerTitle.startsWith("add ") || lowerTitle.startsWith("implement")) {
    inferredType = "feat";
  } else if (lowerTitle.startsWith("docs") || lowerTitle.startsWith("doc:")) {
    inferredType = "docs";
  } else if (lowerTitle.startsWith("refactor")) {
    inferredType = "refactor";
  } else if (lowerTitle.startsWith("perf") || lowerTitle.includes("performance")) {
    inferredType = "perf";
  } else if (lowerTitle.startsWith("chore") || lowerTitle.startsWith("ci") || lowerTitle.startsWith("build")) {
    inferredType = "chore";
  } else if (lowerTitle.startsWith("test")) {
    inferredType = "test";
  }

  return {
    type: inferredType,
    scope: null,
    subject: title,
    breaking: false,
  };
}

interface GroupResult {
  entries: Map<number, ChangelogEntry>;
  orphanedCommits: ParsedCommit[];
}

function groupCommitsByMR(commits: ParsedCommit[], mrMap: Map<string, GitLabMR>): GroupResult {
  const entries = new Map<number, ChangelogEntry>();
  const orphanedCommits: ParsedCommit[] = [];

  for (const commit of commits) {
    if (!commit.mrNumber) {
      orphanedCommits.push(commit);
      continue;
    }

    if (entries.has(commit.mrNumber)) {
      // Add author to existing entry
      const entry = entries.get(commit.mrNumber)!;
      if (commit.author && !isExcludedAuthor(commit.author)) {
        entry.authors.add(normalizeAuthor(commit.author));
      }
    } else {
      // Find MR data to get the title
      let mrTitle = commit.subject;
      for (const [, mr] of mrMap) {
        if (mr.iid === commit.mrNumber) {
          mrTitle = mr.title;
          break;
        }
      }

      const parsed = parseMRTitle(mrTitle);
      entries.set(commit.mrNumber, {
        mrNumber: commit.mrNumber,
        title: parsed.subject,
        type: parsed.type,
        scope: parsed.scope,
        breaking: parsed.breaking,
        authors: new Set(commit.author && !isExcludedAuthor(commit.author) ? [normalizeAuthor(commit.author)] : []),
      });
    }
  }

  return { entries, orphanedCommits };
}

function categorizeEntries(entries: Map<number, ChangelogEntry>): Record<string, ChangelogEntry[]> {
  const categories: Record<string, ChangelogEntry[]> = {};

  for (const [, entry] of entries) {
    const type = COMMIT_TYPES[entry.type] ? entry.type : "other";
    if (!categories[type]) {
      categories[type] = [];
    }
    categories[type].push(entry);
  }

  return categories;
}

function formatMRLink(mrNumber: number | undefined): string {
  if (!mrNumber) return "";
  // Use HTML link so copy-pasting to GitHub shows "!XXX" not the full URL
  return ` (<a href="${GITLAB_MR_URL}/${mrNumber}">!${mrNumber}</a>)`;
}

function formatTitle(title: string): string {
  // Wrap CLI flags (--something) in backticks
  let formatted = title.replace(/\s(--[\w-]+)/g, " `$1`");
  // Wrap CLI commands like "postgresai init", "postgresai checkup" in backticks
  // Only match known subcommands, not arbitrary words
  formatted = formatted.replace(/\b(postgresai\s+(?:init|checkup|mon|auth|prepare-db|unprepare-db))\b/g, "`$1`");
  // Wrap PostgreSQL technical terms
  formatted = formatted.replace(/\b(pg_stat_statements|pg_statistic|pg_catalog)\b/g, "`$1`");
  return formatted;
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
    lines.push("## ⚠️ Breaking Changes");
    lines.push("");
    for (const entry of notes.breaking) {
      const scopeStr = entry.scope ? `**${entry.scope}:** ` : "";
      const mrLink = formatMRLink(entry.mrNumber);
      lines.push(`- ${scopeStr}${entry.title}${mrLink}`);
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
    const entries = notes.categories[type];
    if (!entries || entries.length === 0) continue;

    const typeInfo = COMMIT_TYPES[type] || { title: "Other Changes", emoji: "📝", priority: 99 };
    lines.push(`## ${typeInfo.emoji} ${typeInfo.title}`);
    lines.push("");

    // Flat list with scope prefix (no sub-headers)
    for (const entry of entries) {
      const mrLink = formatMRLink(entry.mrNumber);
      // Format scope: uppercase CLI, MCP; title case others
      let scopeStr = "";
      if (entry.scope) {
        const upperScopes = ["cli", "mcp", "api", "sql", "ci"];
        const formattedScope = upperScopes.includes(entry.scope.toLowerCase())
          ? entry.scope.toUpperCase()
          : entry.scope;
        scopeStr = `**${formattedScope}:** `;
      }
      lines.push(`- ${scopeStr}${formatTitle(entry.title)}${mrLink}`);
    }
    lines.push("");
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

  // Get the date of the since ref for MR filtering
  const sinceDate = gitExec(["log", "-1", "--format=%aI", since]) || "2024-01-01T00:00:00Z";

  // Fetch MRs from GitLab API
  log("Fetching MR data from GitLab...");
  const mrs = await fetchMergedMRs(sinceDate);
  const mrBranchMap = buildBranchToMRMap(mrs);
  log(`Found ${mrs.length} merged MRs`);

  // Get and parse commits
  const hashes = getCommitsBetween(since, until);
  log(`Found ${hashes.length} commits to analyze`);

  // Build a map of commit hash to branch name from merge commits
  const commitToBranch = new Map<string, string>();
  const mergeLog = gitExec(["log", `${since}..${until}`, "--merges", "--format=%H|%P|%s"]);
  for (const line of mergeLog.split("\n").filter(Boolean)) {
    const [mergeHash, parents, subject] = line.split("|");
    const branchMatch = subject?.match(/Merge branch '([^']+)'/);
    if (branchMatch && parents) {
      const branch = branchMatch[1];
      // The second parent is the merged branch
      const mergedParent = parents.split(" ")[1];
      if (mergedParent && branch) {
        // Get all commits that are ancestors of mergedParent but not of first parent
        const firstParent = parents.split(" ")[0];
        if (firstParent) {
          const branchCommits = gitExec(["log", "--format=%H", `${firstParent}..${mergedParent}`]);
          for (const hash of branchCommits.split("\n").filter(Boolean)) {
            commitToBranch.set(hash, branch);
          }
        }
      }
    }
  }

  const commits: ParsedCommit[] = [];
  for (const hash of hashes) {
    const parsed = parseCommit(hash);
    if (parsed) {
      // Try to find MR number from branch name
      const branch = commitToBranch.get(hash);
      if (branch) {
        parsed.mrNumber = getMRNumberFromBranch(branch, mrBranchMap);
      }
      commits.push(parsed);
    }
  }

  // Group commits by MR and build changelog entries
  const { entries: entriesMap, orphanedCommits } = groupCommitsByMR(commits, mrBranchMap);
  const entries = Array.from(entriesMap.values());
  log(`Grouped into ${entries.length} changelog entries`);

  // Warn about orphaned commits (no MR association found)
  if (orphanedCommits.length > 0) {
    log(`Warning: ${orphanedCommits.length} commits have no MR association:`);
    for (const commit of orphanedCommits.slice(0, 10)) {
      log(`  - ${commit.shortHash}: ${commit.subject}`);
    }
    if (orphanedCommits.length > 10) {
      log(`  ... and ${orphanedCommits.length - 10} more`);
    }
  }

  // Categorize entries by type
  const categories = categorizeEntries(entriesMap as Map<number, ChangelogEntry>);
  const breaking = entries.filter((e) => e.breaking);

  // Collect all contributors from entries
  const contributorSet = new Set<string>();
  for (const entry of entries) {
    for (const author of entry.authors) {
      contributorSet.add(author);
    }
  }
  const contributors = Array.from(contributorSet);

  const notes: ReleaseNotes = {
    version: args.version || "",
    date: new Date().toISOString().split("T")[0] || "",
    sinceRef: since,
    untilRef: until,
    commits,
    entries,
    categories,
    breaking,
    stats: {
      total: entries.length,
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
