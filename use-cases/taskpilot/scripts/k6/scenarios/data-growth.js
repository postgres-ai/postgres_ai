/**
 * TaskPilot k6 Load Test - Data Growth Scenario
 *
 * This scenario focuses on generating data to reach the 10 GiB/week growth target.
 * Run continuously to simulate production data growth.
 *
 * Run with: k6 run scripts/k6/scenarios/data-growth.js --duration 24h
 *
 * Target growth rates (per day):
 *   - Issues: ~10,000
 *   - Comments: ~50,000
 *   - Activity logs: ~200,000 (automatic from other operations)
 *   - Notifications: ~100,000 (automatic from other operations)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { randomItem, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// Custom metrics
const issuesCreated = new Counter('data_issues_created');
const commentsCreated = new Counter('data_comments_created');
const attachmentsCreated = new Counter('data_attachments_created');
const errorRate = new Rate('errors');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const API_URL = `${BASE_URL}/api/v1`;

export const options = {
  scenarios: {
    // Issue creators - 10,000 issues/day = ~7 issues/minute
    issue_creators: {
      executor: 'constant-arrival-rate',
      rate: 7,
      timeUnit: '1m',
      duration: __ENV.DURATION || '24h',
      preAllocatedVUs: 50,
      exec: 'createIssue',
    },
    // Comment creators - 50,000 comments/day = ~35 comments/minute
    comment_creators: {
      executor: 'constant-arrival-rate',
      rate: 35,
      timeUnit: '1m',
      duration: __ENV.DURATION || '24h',
      preAllocatedVUs: 100,
      exec: 'createComment',
    },
    // Issue updaters - 100,000 updates/day = ~70 updates/minute
    issue_updaters: {
      executor: 'constant-arrival-rate',
      rate: 70,
      timeUnit: '1m',
      duration: __ENV.DURATION || '24h',
      preAllocatedVUs: 100,
      exec: 'updateIssue',
    },
    // Attachment uploaders - 5,000/day = ~3.5/minute
    attachment_uploaders: {
      executor: 'constant-arrival-rate',
      rate: 4,
      timeUnit: '1m',
      duration: __ENV.DURATION || '24h',
      preAllocatedVUs: 20,
      exec: 'uploadAttachment',
    },
  },
  thresholds: {
    errors: ['rate<0.05'],
    http_req_duration: ['p(95)<2000'],
  },
};

// Data generation helpers
const issueTypes = [
  { prefix: 'Bug', templates: ['in login flow', 'with API response', 'on mobile view', 'with file upload', 'in search results'] },
  { prefix: 'Feature', templates: ['add dark mode', 'implement export', 'create dashboard', 'add notifications', 'improve search'] },
  { prefix: 'Improvement', templates: ['optimize query', 'refactor service', 'update UI', 'enhance performance', 'clean up code'] },
  { prefix: 'Task', templates: ['update documentation', 'write tests', 'review PR', 'deploy to staging', 'configure CI'] },
];

const commentTemplates = [
  "Looking into this now.",
  "I've identified the root cause. Working on a fix.",
  "This is related to the changes in PR #{{pr_number}}.",
  "Added unit tests covering this scenario.",
  "Fixed in commit {{commit_hash}}.",
  "Moving to code review.",
  "LGTM! Approved.",
  "Found another edge case we need to handle.",
  "Could you clarify the expected behavior?",
  "This is blocked by {{blocker}}.",
  "Unblocked, continuing work.",
  "Ready for QA testing.",
  "QA passed, ready for release.",
  "Deployed to production.",
  "Closing as duplicate of {{issue}}.",
  "Reopening - the fix didn't address all cases.",
  "Added to the next sprint.",
  "Updated the priority based on customer feedback.",
  "This affects the {{feature}} feature.",
  "Escalating to the infrastructure team.",
];

const descriptionTemplates = [
  "## Description\n\n{{summary}}\n\n## Steps to Reproduce\n\n1. Open the application\n2. Navigate to {{location}}\n3. Perform {{action}}\n4. Observe the issue\n\n## Expected Behavior\n\n{{expected}}\n\n## Actual Behavior\n\n{{actual}}",
  "## Summary\n\n{{summary}}\n\n## Acceptance Criteria\n\n- [ ] {{criteria1}}\n- [ ] {{criteria2}}\n- [ ] {{criteria3}}\n\n## Technical Notes\n\n{{notes}}",
  "## Context\n\n{{context}}\n\n## Proposed Solution\n\n{{solution}}\n\n## Alternatives Considered\n\n{{alternatives}}",
  "Quick fix needed for {{problem}}. Low risk change.",
  "Tech debt cleanup: {{description}}\n\nThis has been on the backlog for a while.",
];

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateIssueData() {
  const type = randomItem(issueTypes);
  const template = randomItem(type.templates);
  const priorities = ['none', 'low', 'medium', 'high', 'urgent'];
  const weights = [0.1, 0.3, 0.35, 0.2, 0.05]; // Realistic distribution

  // Weighted random priority
  const rand = Math.random();
  let cumulative = 0;
  let priority = 'medium';
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (rand <= cumulative) {
      priority = priorities[i];
      break;
    }
  }

  return {
    title: `[${type.prefix}] ${template} - ${Date.now()}`,
    description: randomItem(descriptionTemplates)
      .replace('{{summary}}', `This is about ${template}`)
      .replace(/\{\{[^}]+\}\}/g, generateRandomString(20)),
    priority: priority,
    status: 'backlog',
    metadata: {
      source: 'k6-growth',
      generated_at: new Date().toISOString(),
      batch_id: generateRandomString(8),
    },
  };
}

function generateCommentData() {
  let comment = randomItem(commentTemplates);
  comment = comment
    .replace('{{pr_number}}', randomIntBetween(100, 9999))
    .replace('{{commit_hash}}', generateRandomString(7))
    .replace('{{blocker}}', `TASK-${randomIntBetween(1, 10000)}`)
    .replace('{{issue}}', `TASK-${randomIntBetween(1, 10000)}`)
    .replace('{{feature}}', randomItem(['search', 'notifications', 'dashboard', 'export', 'API']));

  return {
    body: comment,
    metadata: {
      source: 'k6-growth',
    },
  };
}

// Cached auth token
let authToken = null;
let tokenExpiry = 0;

function getAuthToken() {
  if (authToken && Date.now() < tokenExpiry) {
    return authToken;
  }

  const userNum = randomIntBetween(1, 100);
  const payload = JSON.stringify({
    email: `user${userNum}@taskpilot.test`,
    password: 'password123',
  });

  const response = http.post(`${API_URL}/auth/login`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'login' },
  });

  if (response.status === 200) {
    const data = JSON.parse(response.body);
    authToken = data.access_token;
    tokenExpiry = Date.now() + (55 * 60 * 1000); // Refresh 5 min before expiry
    return authToken;
  }
  return null;
}

function getHeaders() {
  const token = getAuthToken();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

// Cached project IDs
let projectIds = [];
let projectIdsExpiry = 0;

function getRandomProjectId() {
  if (projectIds.length > 0 && Date.now() < projectIdsExpiry) {
    return randomItem(projectIds);
  }

  const response = http.get(`${API_URL}/projects?limit=100`, {
    headers: getHeaders(),
    tags: { name: 'list_projects' },
  });

  if (response.status === 200) {
    const data = JSON.parse(response.body);
    projectIds = data.data.map(p => p.id);
    projectIdsExpiry = Date.now() + (5 * 60 * 1000); // Cache for 5 minutes
    return randomItem(projectIds);
  }
  return null;
}

// Cached issue IDs per project
const issueCache = new Map();

function getRandomIssueId(projectId) {
  const cacheKey = projectId;
  const cached = issueCache.get(cacheKey);

  if (cached && cached.issues.length > 0 && Date.now() < cached.expiry) {
    return randomItem(cached.issues);
  }

  const response = http.get(`${API_URL}/projects/${projectId}/issues?limit=100`, {
    headers: getHeaders(),
    tags: { name: 'list_issues' },
  });

  if (response.status === 200) {
    const data = JSON.parse(response.body);
    const issues = data.data.map(i => i.id);
    issueCache.set(cacheKey, {
      issues: issues,
      expiry: Date.now() + (2 * 60 * 1000), // Cache for 2 minutes
    });
    return randomItem(issues);
  }
  return null;
}

// ==========================================
// Scenario: Create Issue
// ==========================================
export function createIssue() {
  const projectId = getRandomProjectId();
  if (!projectId) {
    errorRate.add(1);
    return;
  }

  const issueData = generateIssueData();
  issueData.project_id = projectId;

  const response = http.post(`${API_URL}/issues`, JSON.stringify(issueData), {
    headers: getHeaders(),
    tags: { name: 'create_issue' },
  });

  if (check(response, { 'issue created': (r) => r.status === 201 })) {
    issuesCreated.add(1);

    // Also add issue to cache
    const cached = issueCache.get(projectId);
    if (cached) {
      const newIssue = JSON.parse(response.body);
      cached.issues.push(newIssue.id);
    }
  } else {
    errorRate.add(1);
  }
}

// ==========================================
// Scenario: Create Comment
// ==========================================
export function createComment() {
  const projectId = getRandomProjectId();
  if (!projectId) {
    errorRate.add(1);
    return;
  }

  const issueId = getRandomIssueId(projectId);
  if (!issueId) {
    errorRate.add(1);
    return;
  }

  const commentData = generateCommentData();

  const response = http.post(`${API_URL}/issues/${issueId}/comments`, JSON.stringify(commentData), {
    headers: getHeaders(),
    tags: { name: 'create_comment' },
  });

  if (check(response, { 'comment created': (r) => r.status === 201 })) {
    commentsCreated.add(1);
  } else {
    errorRate.add(1);
  }
}

// ==========================================
// Scenario: Update Issue
// ==========================================
export function updateIssue() {
  const projectId = getRandomProjectId();
  if (!projectId) {
    errorRate.add(1);
    return;
  }

  const issueId = getRandomIssueId(projectId);
  if (!issueId) {
    errorRate.add(1);
    return;
  }

  // Random update type
  const updateTypes = [
    { status: randomItem(['todo', 'in_progress', 'in_review', 'done']) },
    { priority: randomItem(['low', 'medium', 'high']) },
    { assignee_id: null }, // Unassign
    { estimate: randomIntBetween(1, 13) },
    { due_date: new Date(Date.now() + randomIntBetween(1, 30) * 24 * 60 * 60 * 1000).toISOString().split('T')[0] },
  ];

  const update = randomItem(updateTypes);

  const response = http.patch(`${API_URL}/issues/${issueId}`, JSON.stringify(update), {
    headers: getHeaders(),
    tags: { name: 'update_issue' },
  });

  check(response, { 'issue updated': (r) => r.status === 200 });
}

// ==========================================
// Scenario: Upload Attachment
// ==========================================
export function uploadAttachment() {
  const projectId = getRandomProjectId();
  if (!projectId) {
    errorRate.add(1);
    return;
  }

  const issueId = getRandomIssueId(projectId);
  if (!issueId) {
    errorRate.add(1);
    return;
  }

  // Generate fake file content (random size 10KB - 500KB)
  const fileSize = randomIntBetween(10 * 1024, 500 * 1024);
  const fileContent = generateRandomString(fileSize);
  const filename = `document-${Date.now()}.txt`;

  const formData = {
    file: http.file(fileContent, filename, 'text/plain'),
  };

  const response = http.post(`${API_URL}/issues/${issueId}/attachments`, formData, {
    headers: {
      'Authorization': `Bearer ${getAuthToken()}`,
    },
    tags: { name: 'upload_attachment' },
  });

  if (check(response, { 'attachment uploaded': (r) => r.status === 201 })) {
    attachmentsCreated.add(1);
  } else {
    errorRate.add(1);
  }
}

// Default function
export default function() {
  createIssue();
  sleep(1);
}
