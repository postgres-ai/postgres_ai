# tools

## Sync GitHub PRs into GitLab merge requests

The script `tools/sync_github_prs_to_gitlab_mrs.py` can:

- list PRs from GitHub (mirror)
- fetch each PR ref locally via `git fetch ... refs/pull/<N>/head`
- push it to GitLab as a branch (default: `gh-pr-<N>`)
- create a GitLab merge request targeting the same base branch

### Requirements

- You run it from a local clone of this repo
- Your local git clone has **two remotes**:
  - a GitHub remote (default name: `github`) pointing to the GitHub mirror
  - a GitLab remote (default name: `origin`) pointing to the GitLab repo
- You have credentials configured so `git fetch` from GitHub and `git push` to GitLab work

### Environment variables

- `GITHUB_OWNER`, `GITHUB_REPO`
- `GITHUB_TOKEN` (or `GH_TOKEN`)
- `GITLAB_PROJECT` (project id like `123456` or path like `postgres-ai/postgres_ai`)
- `GITLAB_TOKEN`

Optional:

- `GITHUB_REMOTE` (default `github`)
- `GITLAB_REMOTE` (default `origin`)
- `BRANCH_PREFIX` (default `gh-pr-`)
- `GITLAB_LABELS` (default `sync:github-pr`)

### Usage

Dry run:

```bash
python3 tools/sync_github_prs_to_gitlab_mrs.py --dry-run
```

Sync open PRs:

```bash
python3 tools/sync_github_prs_to_gitlab_mrs.py
```

Include drafts and force-update branches:

```bash
python3 tools/sync_github_prs_to_gitlab_mrs.py --include-drafts --force-push
```















