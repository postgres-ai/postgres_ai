import { formatHttpError, maskSecret, normalizeBaseUrl } from "./util";

/**
 * Issue status constants.
 * Used in updateIssue to change issue state.
 */
export const IssueStatus = {
  /** Issue is open and active */
  OPEN: 0,
  /** Issue is closed/resolved */
  CLOSED: 1,
} as const;

export interface IssueActionItem {
  id: string;
  issue_id: string;
  title: string;
  description: string | null;
  severity: number;
  is_done: boolean;
  done_by: number | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  status: number;
  url_main: string | null;
  urls_extra: string[] | null;
  data: unknown | null;
  author_id: number;
  org_id: number;
  project_id: number | null;
  is_ai_generated: boolean;
  assigned_to: number[] | null;
  labels: string[] | null;
  is_edited: boolean;
  author_display_name: string;
  comment_count: number;
  action_items: IssueActionItem[];
}

export interface IssueComment {
  id: string;
  issue_id: string;
  author_id: number;
  parent_comment_id: string | null;
  content: string;
  created_at: string;
  updated_at: string;
  data: unknown | null;
}

export type IssueListItem = Pick<Issue, "id" | "title" | "status" | "created_at">;

export type IssueDetail = Pick<Issue, "id" | "title" | "description" | "status" | "created_at" | "author_display_name">;
export interface FetchIssuesParams {
  apiKey: string;
  apiBaseUrl: string;
  debug?: boolean;
}

export async function fetchIssues(params: FetchIssuesParams): Promise<IssueListItem[]> {
  const { apiKey, apiBaseUrl, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }

  const base = normalizeBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/issues`);
  url.searchParams.set("select", "id,title,status,created_at");

  const headers: Record<string, string> = {
    "access-token": apiKey,
    "Prefer": "return=representation",
    "Content-Type": "application/json",
    "Connection": "close",
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    console.log(`Debug: Resolved API base URL: ${base}`);
    console.log(`Debug: GET URL: ${url.toString()}`);
    console.log(`Debug: Auth scheme: access-token`);
    console.log(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers,
  });

  if (debug) {
    console.log(`Debug: Response status: ${response.status}`);
    console.log(`Debug: Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  }

  const data = await response.text();

  if (response.ok) {
    try {
      return JSON.parse(data) as IssueListItem[];
    } catch {
      throw new Error(`Failed to parse issues response: ${data}`);
    }
  } else {
    throw new Error(formatHttpError("Failed to fetch issues", response.status, data));
  }
}


export interface FetchIssueCommentsParams {
  apiKey: string;
  apiBaseUrl: string;
  issueId: string;
  debug?: boolean;
}

export async function fetchIssueComments(params: FetchIssueCommentsParams): Promise<IssueComment[]> {
  const { apiKey, apiBaseUrl, issueId, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!issueId) {
    throw new Error("issueId is required");
  }

  const base = normalizeBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/issue_comments?issue_id=eq.${encodeURIComponent(issueId)}`);

  const headers: Record<string, string> = {
    "access-token": apiKey,
    "Prefer": "return=representation",
    "Content-Type": "application/json",
    "Connection": "close",
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    console.log(`Debug: Resolved API base URL: ${base}`);
    console.log(`Debug: GET URL: ${url.toString()}`);
    console.log(`Debug: Auth scheme: access-token`);
    console.log(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers,
  });

  if (debug) {
    console.log(`Debug: Response status: ${response.status}`);
    console.log(`Debug: Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  }

  const data = await response.text();

  if (response.ok) {
    try {
      return JSON.parse(data) as IssueComment[];
    } catch {
      throw new Error(`Failed to parse issue comments response: ${data}`);
    }
  } else {
    throw new Error(formatHttpError("Failed to fetch issue comments", response.status, data));
  }
}

export interface FetchIssueParams {
  apiKey: string;
  apiBaseUrl: string;
  issueId: string;
  debug?: boolean;
}

export async function fetchIssue(params: FetchIssueParams): Promise<IssueDetail | null> {
  const { apiKey, apiBaseUrl, issueId, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!issueId) {
    throw new Error("issueId is required");
  }

  const base = normalizeBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/issues`);
  url.searchParams.set("select", "id,title,description,status,created_at,author_display_name");
  url.searchParams.set("id", `eq.${issueId}`);
  url.searchParams.set("limit", "1");

  const headers: Record<string, string> = {
    "access-token": apiKey,
    "Prefer": "return=representation",
    "Content-Type": "application/json",
    "Connection": "close",
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    console.log(`Debug: Resolved API base URL: ${base}`);
    console.log(`Debug: GET URL: ${url.toString()}`);
    console.log(`Debug: Auth scheme: access-token`);
    console.log(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers,
  });

  if (debug) {
    console.log(`Debug: Response status: ${response.status}`);
    console.log(`Debug: Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  }

  const data = await response.text();

  if (response.ok) {
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return (parsed[0] as IssueDetail) ?? null;
      } else {
        return parsed as IssueDetail;
      }
    } catch {
      throw new Error(`Failed to parse issue response: ${data}`);
    }
  } else {
    throw new Error(formatHttpError("Failed to fetch issue", response.status, data));
  }
}

export interface CreateIssueParams {
  apiKey: string;
  apiBaseUrl: string;
  title: string;
  orgId: number;
  description?: string;
  projectId?: number;
  labels?: string[];
  debug?: boolean;
}

export interface CreatedIssue {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  status: number;
  project_id: number | null;
  labels: string[] | null;
}

/**
 * Create a new issue in the PostgresAI platform.
 *
 * @param params - The parameters for creating an issue
 * @param params.apiKey - API key for authentication
 * @param params.apiBaseUrl - Base URL for the API
 * @param params.title - Issue title (required)
 * @param params.orgId - Organization ID (required)
 * @param params.description - Optional issue description
 * @param params.projectId - Optional project ID to associate with
 * @param params.labels - Optional array of label strings
 * @param params.debug - Enable debug logging
 * @returns The created issue object
 * @throws Error if API key, title, or orgId is missing, or if the API call fails
 */
export async function createIssue(params: CreateIssueParams): Promise<CreatedIssue> {
  const { apiKey, apiBaseUrl, title, orgId, description, projectId, labels, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!title) {
    throw new Error("title is required");
  }
  if (typeof orgId !== "number") {
    throw new Error("orgId is required");
  }

  const base = normalizeBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/rpc/issue_create`);

  const bodyObj: Record<string, unknown> = {
    title: title,
    org_id: orgId,
  };
  if (description !== undefined) {
    bodyObj.description = description;
  }
  if (projectId !== undefined) {
    bodyObj.project_id = projectId;
  }
  if (labels && labels.length > 0) {
    bodyObj.labels = labels;
  }
  const body = JSON.stringify(bodyObj);

  const headers: Record<string, string> = {
    "access-token": apiKey,
    "Prefer": "return=representation",
    "Content-Type": "application/json",
    "Connection": "close",
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    console.log(`Debug: Resolved API base URL: ${base}`);
    console.log(`Debug: POST URL: ${url.toString()}`);
    console.log(`Debug: Auth scheme: access-token`);
    console.log(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
    console.log(`Debug: Request body: ${body}`);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body,
  });

  if (debug) {
    console.log(`Debug: Response status: ${response.status}`);
    console.log(`Debug: Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  }

  const data = await response.text();

  if (response.ok) {
    try {
      return JSON.parse(data) as CreatedIssue;
    } catch {
      throw new Error(`Failed to parse create issue response: ${data}`);
    }
  } else {
    throw new Error(formatHttpError("Failed to create issue", response.status, data));
  }
}

export interface CreateIssueCommentParams {
  apiKey: string;
  apiBaseUrl: string;
  issueId: string;
  content: string;
  parentCommentId?: string;
  debug?: boolean;
}

export async function createIssueComment(params: CreateIssueCommentParams): Promise<IssueComment> {
  const { apiKey, apiBaseUrl, issueId, content, parentCommentId, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!issueId) {
    throw new Error("issueId is required");
  }
  if (!content) {
    throw new Error("content is required");
  }

  const base = normalizeBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/rpc/issue_comment_create`);

  const bodyObj: Record<string, unknown> = {
    issue_id: issueId,
    content: content,
  };
  if (parentCommentId) {
    bodyObj.parent_comment_id = parentCommentId;
  }
  const body = JSON.stringify(bodyObj);

  const headers: Record<string, string> = {
    "access-token": apiKey,
    "Prefer": "return=representation",
    "Content-Type": "application/json",
    "Connection": "close",
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    console.log(`Debug: Resolved API base URL: ${base}`);
    console.log(`Debug: POST URL: ${url.toString()}`);
    console.log(`Debug: Auth scheme: access-token`);
    console.log(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
    console.log(`Debug: Request body: ${body}`);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body,
  });

  if (debug) {
    console.log(`Debug: Response status: ${response.status}`);
    console.log(`Debug: Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  }

  const data = await response.text();

  if (response.ok) {
    try {
      return JSON.parse(data) as IssueComment;
    } catch {
      throw new Error(`Failed to parse create comment response: ${data}`);
    }
  } else {
    throw new Error(formatHttpError("Failed to create issue comment", response.status, data));
  }
}

export interface UpdateIssueParams {
  apiKey: string;
  apiBaseUrl: string;
  issueId: string;
  title?: string;
  description?: string;
  status?: number;
  labels?: string[];
  debug?: boolean;
}

export interface UpdatedIssue {
  id: string;
  title: string;
  description: string | null;
  status: number;
  updated_at: string;
  labels: string[] | null;
}

/**
 * Update an existing issue in the PostgresAI platform.
 *
 * @param params - The parameters for updating an issue
 * @param params.apiKey - API key for authentication
 * @param params.apiBaseUrl - Base URL for the API
 * @param params.issueId - ID of the issue to update (required)
 * @param params.title - New title (optional)
 * @param params.description - New description (optional)
 * @param params.status - New status: 0 = open, 1 = closed (optional)
 * @param params.labels - New labels array (optional, replaces existing)
 * @param params.debug - Enable debug logging
 * @returns The updated issue object
 * @throws Error if API key or issueId is missing, if no fields to update are provided, or if the API call fails
 */
export async function updateIssue(params: UpdateIssueParams): Promise<UpdatedIssue> {
  const { apiKey, apiBaseUrl, issueId, title, description, status, labels, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!issueId) {
    throw new Error("issueId is required");
  }
  if (title === undefined && description === undefined && status === undefined && labels === undefined) {
    throw new Error("At least one field to update is required (title, description, status, or labels)");
  }

  const base = normalizeBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/rpc/issue_update`);

  // Prod RPC expects p_* argument names (see OpenAPI at /api/general/).
  const bodyObj: Record<string, unknown> = {
    p_id: issueId,
  };
  if (title !== undefined) {
    bodyObj.p_title = title;
  }
  if (description !== undefined) {
    bodyObj.p_description = description;
  }
  if (status !== undefined) {
    bodyObj.p_status = status;
  }
  if (labels !== undefined) {
    bodyObj.p_labels = labels;
  }
  const body = JSON.stringify(bodyObj);

  const headers: Record<string, string> = {
    "access-token": apiKey,
    "Prefer": "return=representation",
    "Content-Type": "application/json",
    "Connection": "close",
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    console.log(`Debug: Resolved API base URL: ${base}`);
    console.log(`Debug: POST URL: ${url.toString()}`);
    console.log(`Debug: Auth scheme: access-token`);
    console.log(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
    console.log(`Debug: Request body: ${body}`);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body,
  });

  if (debug) {
    console.log(`Debug: Response status: ${response.status}`);
    console.log(`Debug: Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  }

  const data = await response.text();

  if (response.ok) {
    try {
      return JSON.parse(data) as UpdatedIssue;
    } catch {
      throw new Error(`Failed to parse update issue response: ${data}`);
    }
  } else {
    throw new Error(formatHttpError("Failed to update issue", response.status, data));
  }
}

export interface UpdateIssueCommentParams {
  apiKey: string;
  apiBaseUrl: string;
  commentId: string;
  content: string;
  debug?: boolean;
}

export interface UpdatedIssueComment {
  id: string;
  issue_id: string;
  content: string;
  updated_at: string;
}

/**
 * Update an existing issue comment in the PostgresAI platform.
 *
 * @param params - The parameters for updating a comment
 * @param params.apiKey - API key for authentication
 * @param params.apiBaseUrl - Base URL for the API
 * @param params.commentId - ID of the comment to update (required)
 * @param params.content - New comment content (required)
 * @param params.debug - Enable debug logging
 * @returns The updated comment object
 * @throws Error if API key, commentId, or content is missing, or if the API call fails
 */
export async function updateIssueComment(params: UpdateIssueCommentParams): Promise<UpdatedIssueComment> {
  const { apiKey, apiBaseUrl, commentId, content, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!commentId) {
    throw new Error("commentId is required");
  }
  if (!content) {
    throw new Error("content is required");
  }

  const base = normalizeBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/rpc/issue_comment_update`);

  const bodyObj: Record<string, unknown> = {
    // Prod RPC expects p_* argument names (see OpenAPI at /api/general/).
    p_id: commentId,
    p_content: content,
  };
  const body = JSON.stringify(bodyObj);

  const headers: Record<string, string> = {
    "access-token": apiKey,
    "Prefer": "return=representation",
    "Content-Type": "application/json",
    "Connection": "close",
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    console.log(`Debug: Resolved API base URL: ${base}`);
    console.log(`Debug: POST URL: ${url.toString()}`);
    console.log(`Debug: Auth scheme: access-token`);
    console.log(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
    console.log(`Debug: Request body: ${body}`);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body,
  });

  if (debug) {
    console.log(`Debug: Response status: ${response.status}`);
    console.log(`Debug: Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  }

  const data = await response.text();

  if (response.ok) {
    try {
      return JSON.parse(data) as UpdatedIssueComment;
    } catch {
      throw new Error(`Failed to parse update comment response: ${data}`);
    }
  } else {
    throw new Error(formatHttpError("Failed to update issue comment", response.status, data));
  }
}
