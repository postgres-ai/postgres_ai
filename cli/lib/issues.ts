import { maskSecret, normalizeBaseUrl } from "./util";

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
    let errMsg = `Failed to fetch issues: HTTP ${response.status}`;
    if (data) {
      try {
        const errObj = JSON.parse(data);
        errMsg += `\n${JSON.stringify(errObj, null, 2)}`;
      } catch {
        errMsg += `\n${data}`;
      }
    }
    throw new Error(errMsg);
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
    let errMsg = `Failed to fetch issue comments: HTTP ${response.status}`;
    if (data) {
      try {
        const errObj = JSON.parse(data);
        errMsg += `\n${JSON.stringify(errObj, null, 2)}`;
      } catch {
        errMsg += `\n${data}`;
      }
    }
    throw new Error(errMsg);
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
    let errMsg = `Failed to fetch issue: HTTP ${response.status}`;
    if (data) {
      try {
        const errObj = JSON.parse(data);
        errMsg += `\n${JSON.stringify(errObj, null, 2)}`;
      } catch {
        errMsg += `\n${data}`;
      }
    }
    throw new Error(errMsg);
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
    let errMsg = `Failed to create issue comment: HTTP ${response.status}`;
    if (data) {
      try {
        const errObj = JSON.parse(data);
        errMsg += `\n${JSON.stringify(errObj, null, 2)}`;
      } catch {
        errMsg += `\n${data}`;
      }
    }
    throw new Error(errMsg);
  }
}
