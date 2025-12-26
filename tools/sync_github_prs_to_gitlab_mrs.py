#!/usr/bin/env python3
"""
Sync GitHub pull requests into GitLab merge requests.

How it works
- Lists PRs from GitHub via API
- For each PR, fetches the PR ref via git: refs/pull/<N>/head
- Pushes it to GitLab as a branch (default: gh-pr-<N>)
- Creates a GitLab merge request targeting the same base branch

This approach works even when PRs come from forks, because GitHub exposes
refs/pull/<N>/head on the base repository.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_GITHUB_API = "https://api.github.com"
DEFAULT_GITLAB_API = "https://gitlab.com/api/v4"


class SyncError(RuntimeError):
    pass


def _stderr(msg: str) -> None:
    sys.stderr.write(msg + "\n")


def _run(cmd: List[str], *, cwd: Optional[str] = None, quiet: bool = False) -> str:
    if not quiet:
        _stderr("+ " + " ".join(cmd))
    p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise SyncError(
            f"Command failed ({p.returncode}): {' '.join(cmd)}\n"
            f"stdout:\n{p.stdout}\n"
            f"stderr:\n{p.stderr}\n"
        )
    return p.stdout.strip()


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v


def _json_request(
    *,
    method: str,
    url: str,
    headers: Dict[str, str],
    params: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout_s: int = 30,
) -> Tuple[int, Dict[str, str], Any]:
    if params:
        u = urllib.parse.urlsplit(url)
        q = urllib.parse.parse_qsl(u.query, keep_blank_values=True)
        for k, v in params.items():
            q.append((k, str(v)))
        url = urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, urllib.parse.urlencode(q), u.fragment))

    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers = dict(headers)
        headers.setdefault("Content-Type", "application/json")

    req = urllib.request.Request(url=url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8")
            content_type = resp.headers.get("Content-Type", "")
            if "application/json" in content_type:
                payload = json.loads(raw) if raw else None
            else:
                payload = raw
            return resp.getcode(), dict(resp.headers), payload
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        msg = raw
        try:
            msg = json.dumps(json.loads(raw), indent=2)
        except Exception:
            pass
        raise SyncError(f"HTTP {e.code} for {method} {url}\n{msg}") from e


def _parse_link_header(link_header: str) -> Dict[str, str]:
    # GitHub: <url>; rel="next", <url>; rel="last"
    res: Dict[str, str] = {}
    for part in link_header.split(","):
        part = part.strip()
        m = re.match(r'^<([^>]+)>;\s*rel="([^"]+)"$', part)
        if not m:
            continue
        res[m.group(2)] = m.group(1)
    return res


@dataclass(frozen=True)
class GitHubPR:
    number: int
    title: str
    body: str
    html_url: str
    user_login: str
    draft: bool
    base_ref: str
    head_sha: str


def list_github_prs(
    *,
    github_api: str,
    owner: str,
    repo: str,
    token: str,
    state: str,
    include_drafts: bool,
    limit: int,
) -> List[GitHubPR]:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "postgres-ai-sync-script",
    }

    prs: List[GitHubPR] = []
    url = f"{github_api}/repos/{owner}/{repo}/pulls"
    params: Dict[str, Any] = {"state": state, "per_page": 100, "page": 1}

    while True:
        _, resp_headers, payload = _json_request(method="GET", url=url, headers=headers, params=params)
        if not isinstance(payload, list):
            raise SyncError("Unexpected GitHub response: expected list")

        for pr in payload:
            pr_obj = GitHubPR(
                number=int(pr["number"]),
                title=pr.get("title") or "",
                body=pr.get("body") or "",
                html_url=pr.get("html_url") or "",
                user_login=(pr.get("user") or {}).get("login") or "unknown",
                draft=bool(pr.get("draft", False)),
                base_ref=((pr.get("base") or {}).get("ref") or "main"),
                head_sha=((pr.get("head") or {}).get("sha") or ""),
            )
            if pr_obj.draft and not include_drafts:
                continue
            prs.append(pr_obj)
            if limit and len(prs) >= limit:
                return prs

        link = resp_headers.get("Link") or resp_headers.get("link") or ""
        links = _parse_link_header(link) if link else {}
        if "next" in links:
            url = links["next"]
            params = None  # already embedded in the next URL
            continue
        return prs


def git_assert_repo_root() -> str:
    top = _run(["git", "rev-parse", "--show-toplevel"], quiet=True)
    if not top:
        raise SyncError("Not in a git repository")
    return top


def git_fetch_pr_ref(*, github_remote: str, pr_number: int, local_branch: str, dry_run: bool) -> None:
    ref = f"refs/pull/{pr_number}/head"
    cmd = ["git", "fetch", "--prune", github_remote, f"{ref}:{local_branch}"]
    if dry_run:
        _stderr("[dry-run] " + " ".join(cmd))
        return
    _run(cmd)


def git_push_branch(
    *,
    gitlab_remote: str,
    local_branch: str,
    remote_branch: str,
    force: bool,
    dry_run: bool,
) -> None:
    spec = f"{local_branch}:{remote_branch}"
    if force:
        spec = f"+{spec}"
    cmd = ["git", "push", gitlab_remote, spec]
    if dry_run:
        _stderr("[dry-run] " + " ".join(cmd))
        return
    _run(cmd)


def gitlab_find_mr_by_source_branch(
    *,
    gitlab_api: str,
    project: str,
    token: str,
    source_branch: str,
) -> List[Dict[str, Any]]:
    headers = {"PRIVATE-TOKEN": token}
    url = f"{gitlab_api}/projects/{urllib.parse.quote_plus(project)}/merge_requests"
    params = {"source_branch": source_branch, "scope": "all", "per_page": 100}
    _, _, payload = _json_request(method="GET", url=url, headers=headers, params=params)
    if not isinstance(payload, list):
        raise SyncError("Unexpected GitLab response: expected list")
    return payload


def gitlab_create_mr(
    *,
    gitlab_api: str,
    project: str,
    token: str,
    title: str,
    description: str,
    source_branch: str,
    target_branch: str,
    labels: List[str],
    remove_source_branch: bool,
    draft: bool,
) -> Dict[str, Any]:
    headers = {"PRIVATE-TOKEN": token}
    url = f"{gitlab_api}/projects/{urllib.parse.quote_plus(project)}/merge_requests"

    mr_title = title
    if draft and not title.lower().startswith("draft:"):
        mr_title = f"Draft: {title}"

    body: Dict[str, Any] = {
        "title": mr_title,
        "description": description,
        "source_branch": source_branch,
        "target_branch": target_branch,
        "remove_source_branch": bool(remove_source_branch),
    }
    if labels:
        body["labels"] = ",".join(labels)

    _, _, payload = _json_request(method="POST", url=url, headers=headers, body=body)
    if not isinstance(payload, dict):
        raise SyncError("Unexpected GitLab response: expected dict")
    return payload


def build_description(pr: GitHubPR) -> str:
    parts: List[str] = []
    parts.append(f"Synced from GitHub PR #{pr.number}")
    parts.append(f"GitHub: {pr.html_url}")
    parts.append(f"Author: {pr.user_login}")
    parts.append(f"Base branch: {pr.base_ref}")
    if pr.head_sha:
        parts.append(f"Head SHA: {pr.head_sha}")
    parts.append("")
    parts.append("Original description:")
    parts.append(pr.body.strip() if pr.body.strip() else "(empty)")
    return "\n".join(parts).rstrip() + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description="Sync GitHub PRs into GitLab merge requests (branches pushed as gh-pr-<N>)."
    )
    p.add_argument("--github-owner", default=_env("GITHUB_OWNER"), help="GitHub repo owner (or env GITHUB_OWNER).")
    p.add_argument("--github-repo", default=_env("GITHUB_REPO"), help="GitHub repo name (or env GITHUB_REPO).")
    p.add_argument(
        "--github-token",
        default=_env("GITHUB_TOKEN") or _env("GH_TOKEN"),
        help="GitHub token (or env GITHUB_TOKEN/GH_TOKEN).",
    )
    p.add_argument("--github-api", default=_env("GITHUB_API", DEFAULT_GITHUB_API), help="GitHub API base URL.")
    p.add_argument(
        "--gitlab-project",
        default=_env("GITLAB_PROJECT"),
        help="GitLab project id or path (env GITLAB_PROJECT).",
    )
    p.add_argument(
        "--gitlab-token",
        default=_env("GITLAB_TOKEN"),
        help="GitLab token (or env GITLAB_TOKEN).",
    )
    p.add_argument("--gitlab-api", default=_env("GITLAB_API", DEFAULT_GITLAB_API), help="GitLab API base URL.")

    p.add_argument("--github-remote", default=_env("GITHUB_REMOTE", "github"), help="Git remote name for GitHub mirror.")
    p.add_argument("--gitlab-remote", default=_env("GITLAB_REMOTE", "origin"), help="Git remote name for GitLab repo.")
    p.add_argument("--branch-prefix", default=_env("BRANCH_PREFIX", "gh-pr-"), help="Branch prefix to create on GitLab.")
    p.add_argument("--state", default=_env("PR_STATE", "open"), choices=["open", "closed", "all"], help="GitHub PR state to sync.")
    p.add_argument("--include-drafts", action="store_true", default=bool(_env("INCLUDE_DRAFTS", "")), help="Include draft PRs.")
    p.add_argument("--limit", type=int, default=int(_env("LIMIT", "0")), help="Max PRs to process (0 = no limit).")
    p.add_argument("--labels", default=_env("GITLAB_LABELS", "sync:github-pr"), help="Comma-separated GitLab labels to set.")
    p.add_argument("--remove-source-branch", action="store_true", help="Set remove_source_branch=true in created MRs.")
    p.add_argument("--force-push", action="store_true", help="Force push updated branches to GitLab.")
    p.add_argument("--dry-run", action="store_true", help="Show actions without pushing/creating MRs.")
    p.add_argument("--no-push", action="store_true", help="Do not push branches to GitLab (API only).")
    p.add_argument("--no-create-mr", action="store_true", help="Do not create GitLab MRs (git only).")
    p.add_argument("--sleep-s", type=float, default=0.2, help="Sleep between PRs to reduce API pressure.")

    args = p.parse_args(argv)

    owner = args.github_owner or ""
    repo = args.github_repo or ""
    if not owner or not repo:
        raise SyncError("GitHub owner/repo must be provided via --github-owner/--github-repo or env vars.")

    github_token = args.github_token or ""
    if not github_token:
        raise SyncError("GitHub token must be provided via --github-token or env GITHUB_TOKEN/GH_TOKEN.")

    gitlab_project = args.gitlab_project or ""
    if not gitlab_project:
        raise SyncError("GitLab project must be provided via --gitlab-project or env GITLAB_PROJECT.")

    gitlab_token = args.gitlab_token or ""
    if not gitlab_token:
        raise SyncError("GitLab token must be provided via --gitlab-token or env GITLAB_TOKEN.")

    git_assert_repo_root()

    labels = [x.strip() for x in (args.labels or "").split(",") if x.strip()]

    prs = list_github_prs(
        github_api=args.github_api.rstrip("/"),
        owner=owner,
        repo=repo,
        token=github_token,
        state=args.state,
        include_drafts=args.include_drafts,
        limit=args.limit,
    )

    _stderr(f"Found {len(prs)} PR(s) to consider.")

    created = 0
    skipped = 0
    updated = 0

    for pr in prs:
        source_branch = f"{args.branch_prefix}{pr.number}"
        target_branch = pr.base_ref

        existing = gitlab_find_mr_by_source_branch(
            gitlab_api=args.gitlab_api.rstrip("/"),
            project=gitlab_project,
            token=gitlab_token,
            source_branch=source_branch,
        )
        if existing:
            _stderr(f"Skip PR #{pr.number}: GitLab MR already exists for source branch {source_branch}.")
            skipped += 1
            continue

        git_fetch_pr_ref(
            github_remote=args.github_remote,
            pr_number=pr.number,
            local_branch=source_branch,
            dry_run=args.dry_run,
        )

        if not args.no_push:
            git_push_branch(
                gitlab_remote=args.gitlab_remote,
                local_branch=source_branch,
                remote_branch=source_branch,
                force=args.force_push,
                dry_run=args.dry_run,
            )
            updated += 1

        if not args.no_create_mr:
            desc = build_description(pr)
            mr = gitlab_create_mr(
                gitlab_api=args.gitlab_api.rstrip("/"),
                project=gitlab_project,
                token=gitlab_token,
                title=pr.title,
                description=desc,
                source_branch=source_branch,
                target_branch=target_branch,
                labels=labels,
                remove_source_branch=args.remove_source_branch,
                draft=pr.draft,
            )
            created += 1
            web_url = mr.get("web_url") or mr.get("url") or "(unknown)"
            _stderr(f"Created MR for PR #{pr.number}: {web_url}")

        time.sleep(max(0.0, float(args.sleep_s)))

    _stderr(
        f"Done. created={created} updated_branches={updated} skipped_existing={skipped} total_considered={len(prs)}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SyncError as e:
        _stderr(f"error: {e}")
        raise SystemExit(2)















