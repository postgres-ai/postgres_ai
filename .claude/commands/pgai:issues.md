# Issues

Work with PostgresAI Issues from console.postgres.ai.

Use the MCP server tools to:
- List open issues: `mcp__postgresai__list_issues`
- View issue details: `mcp__postgresai__view_issue`
- Post comments: `mcp__postgresai__post_issue_comment`
- Create action items: `mcp__postgresai__create_action_item`

$ARGUMENTS can be:
- Empty: list all open issues
- Issue ID: view that specific issue
- "comment <id> <text>": add a comment to an issue

When listing issues, show a table with columns: ID (full UUID), Title, Status, Created.
When viewing a specific issue, analyze the details and propose an action plan.
