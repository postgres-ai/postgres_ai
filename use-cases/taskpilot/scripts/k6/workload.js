/**
 * TaskPilot k6 Load Test - Main Workload
 *
 * Simulates realistic user behavior for the TaskPilot issue tracker.
 * Run with: k6 run scripts/k6/workload.js
 *
 * Environment variables:
 *   - BASE_URL: API base URL (default: http://localhost:8000)
 *   - VUS: Virtual users (default: 50)
 *   - DURATION: Test duration (default: 1h)
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import { randomItem, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// Custom metrics
const errorRate = new Rate('errors');
const issueCreated = new Counter('issues_created');
const commentsAdded = new Counter('comments_added');
const issuesUpdated = new Counter('issues_updated');
const searchQueries = new Counter('search_queries');
const dbQueryTime = new Trend('db_query_time');

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const API_URL = `${BASE_URL}/api/v1`;

// Test scenarios
export const options = {
  scenarios: {
    // Regular users browsing and creating issues
    regular_users: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '5m', target: parseInt(__ENV.VUS) || 50 },  // Ramp up
        { duration: '50m', target: parseInt(__ENV.VUS) || 50 }, // Steady state
        { duration: '5m', target: 0 },                           // Ramp down
      ],
      exec: 'regularUserWorkflow',
    },
    // Power users with heavy activity
    power_users: {
      executor: 'constant-vus',
      vus: 5,
      duration: __ENV.DURATION || '1h',
      exec: 'powerUserWorkflow',
    },
    // Background sync/automation checks
    background_jobs: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: __ENV.DURATION || '1h',
      preAllocatedVUs: 20,
      exec: 'backgroundJobWorkflow',
    },
    // Dashboard/reporting queries
    dashboards: {
      executor: 'constant-vus',
      vus: 3,
      duration: __ENV.DURATION || '1h',
      exec: 'dashboardWorkflow',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    errors: ['rate<0.01'], // Error rate < 1%
    'http_req_duration{name:list_issues}': ['p(95)<300'],
    'http_req_duration{name:create_issue}': ['p(95)<500'],
    'http_req_duration{name:search_issues}': ['p(95)<800'],
  },
};

// Sample data for generating realistic content
const issueStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];
const issuePriorities = ['none', 'low', 'medium', 'high', 'urgent'];
const actionVerbs = ['Fix', 'Implement', 'Add', 'Update', 'Refactor', 'Remove', 'Investigate', 'Review'];
const subjects = ['login page', 'user dashboard', 'API endpoint', 'database query', 'notification system',
  'search feature', 'export functionality', 'caching layer', 'error handling', 'performance issue'];

// Helper functions
function generateIssueTitle() {
  const verb = randomItem(actionVerbs);
  const subject = randomItem(subjects);
  return `${verb} ${subject} - ${Date.now()}`;
}

function generateDescription() {
  const descriptions = [
    'This needs to be addressed as soon as possible.',
    'Found this while testing the feature.',
    'User reported this issue via support ticket.',
    'This is blocking other work.',
    'Low priority cleanup task.',
    'Part of the Q1 roadmap.',
    'Tech debt that needs attention.',
    'Quick fix needed for release.',
  ];
  return randomItem(descriptions);
}

function generateComment() {
  const comments = [
    'Looking into this now.',
    'Can you provide more details?',
    'This is related to the other issue we discussed.',
    'Fixed in the latest commit.',
    'Moving to code review.',
    'Waiting for feedback.',
    'This needs more investigation.',
    'Added unit tests for this.',
    'Documentation updated.',
    'Ready for QA testing.',
  ];
  return randomItem(comments);
}

function getAuthHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

// Simulate user login and get token
function login() {
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
    return JSON.parse(response.body).access_token;
  }
  return null;
}

// Get random project ID
function getRandomProject(token) {
  const response = http.get(`${API_URL}/projects`, {
    headers: getAuthHeaders(token),
    tags: { name: 'list_projects' },
  });

  if (response.status === 200) {
    const projects = JSON.parse(response.body).data;
    return randomItem(projects)?.id;
  }
  return null;
}

// Get random issue from project
function getRandomIssue(token, projectId) {
  const response = http.get(`${API_URL}/projects/${projectId}/issues?limit=50`, {
    headers: getAuthHeaders(token),
    tags: { name: 'list_issues' },
  });

  if (response.status === 200) {
    const issues = JSON.parse(response.body).data;
    return randomItem(issues);
  }
  return null;
}

// ==========================================
// WORKFLOW: Regular User
// ==========================================
export function regularUserWorkflow() {
  const token = login();
  if (!token) {
    errorRate.add(1);
    sleep(5);
    return;
  }

  group('Regular User Session', function() {
    // 1. View project list (dashboard landing)
    group('View Dashboard', function() {
      const resp = http.get(`${API_URL}/projects`, {
        headers: getAuthHeaders(token),
        tags: { name: 'list_projects' },
      });
      check(resp, { 'projects loaded': (r) => r.status === 200 });
      sleep(randomIntBetween(1, 3));
    });

    // 2. Navigate to a project
    const projectId = getRandomProject(token);
    if (!projectId) {
      errorRate.add(1);
      return;
    }

    group('Browse Project Issues', function() {
      // List issues (common query pattern)
      let resp = http.get(`${API_URL}/projects/${projectId}/issues?status=in_progress&limit=20`, {
        headers: getAuthHeaders(token),
        tags: { name: 'list_issues' },
      });
      check(resp, { 'issues loaded': (r) => r.status === 200 });

      // Check different status filters (simulates board view)
      for (const status of ['backlog', 'todo', 'in_review']) {
        resp = http.get(`${API_URL}/projects/${projectId}/issues?status=${status}&limit=10`, {
          headers: getAuthHeaders(token),
          tags: { name: 'list_issues_filtered' },
        });
        sleep(0.5);
      }
    });

    sleep(randomIntBetween(2, 5));

    // 3. View a specific issue
    const issue = getRandomIssue(token, projectId);
    if (issue) {
      group('View Issue Detail', function() {
        // Get issue details
        let resp = http.get(`${API_URL}/issues/${issue.id}`, {
          headers: getAuthHeaders(token),
          tags: { name: 'get_issue' },
        });
        check(resp, { 'issue loaded': (r) => r.status === 200 });

        // Get comments
        resp = http.get(`${API_URL}/issues/${issue.id}/comments`, {
          headers: getAuthHeaders(token),
          tags: { name: 'list_comments' },
        });
        check(resp, { 'comments loaded': (r) => r.status === 200 });

        // Get activity log
        resp = http.get(`${API_URL}/issues/${issue.id}/activity`, {
          headers: getAuthHeaders(token),
          tags: { name: 'get_activity' },
        });

        sleep(randomIntBetween(5, 15)); // Reading time
      });
    }

    // 4. Maybe create a new issue (30% chance)
    if (Math.random() < 0.3) {
      group('Create Issue', function() {
        const payload = JSON.stringify({
          project_id: projectId,
          title: generateIssueTitle(),
          description: generateDescription(),
          priority: randomItem(issuePriorities),
          status: 'backlog',
        });

        const resp = http.post(`${API_URL}/issues`, payload, {
          headers: getAuthHeaders(token),
          tags: { name: 'create_issue' },
        });

        if (check(resp, { 'issue created': (r) => r.status === 201 })) {
          issueCreated.add(1);
        }
        sleep(1);
      });
    }

    // 5. Maybe add a comment (40% chance if viewing issue)
    if (issue && Math.random() < 0.4) {
      group('Add Comment', function() {
        const payload = JSON.stringify({
          body: generateComment(),
        });

        const resp = http.post(`${API_URL}/issues/${issue.id}/comments`, payload, {
          headers: getAuthHeaders(token),
          tags: { name: 'create_comment' },
        });

        if (check(resp, { 'comment added': (r) => r.status === 201 })) {
          commentsAdded.add(1);
        }
      });
    }

    // 6. Maybe update issue status (20% chance)
    if (issue && Math.random() < 0.2) {
      group('Update Issue Status', function() {
        const newStatus = randomItem(issueStatuses);
        const payload = JSON.stringify({
          status: newStatus,
        });

        const resp = http.patch(`${API_URL}/issues/${issue.id}`, payload, {
          headers: getAuthHeaders(token),
          tags: { name: 'update_issue' },
        });

        if (check(resp, { 'issue updated': (r) => r.status === 200 })) {
          issuesUpdated.add(1);
        }
      });
    }

    // Simulate think time
    sleep(randomIntBetween(10, 30));
  });
}

// ==========================================
// WORKFLOW: Power User
// ==========================================
export function powerUserWorkflow() {
  const token = login();
  if (!token) {
    errorRate.add(1);
    sleep(5);
    return;
  }

  group('Power User Session', function() {
    const projectId = getRandomProject(token);
    if (!projectId) {
      errorRate.add(1);
      return;
    }

    // Power users do bulk operations
    group('Bulk Issue Operations', function() {
      // Create multiple issues
      for (let i = 0; i < 5; i++) {
        const payload = JSON.stringify({
          project_id: projectId,
          title: generateIssueTitle(),
          description: generateDescription(),
          priority: randomItem(issuePriorities),
        });

        const resp = http.post(`${API_URL}/issues`, payload, {
          headers: getAuthHeaders(token),
          tags: { name: 'create_issue' },
        });

        if (resp.status === 201) {
          issueCreated.add(1);
        }
        sleep(0.5);
      }
    });

    group('Bulk Status Updates', function() {
      // Get many issues and update them
      const resp = http.get(`${API_URL}/projects/${projectId}/issues?limit=20&status=backlog`, {
        headers: getAuthHeaders(token),
        tags: { name: 'list_issues' },
      });

      if (resp.status === 200) {
        const issues = JSON.parse(resp.body).data;
        for (const issue of issues.slice(0, 10)) {
          const payload = JSON.stringify({
            status: 'todo',
            priority: randomItem(['medium', 'high']),
          });

          http.patch(`${API_URL}/issues/${issue.id}`, payload, {
            headers: getAuthHeaders(token),
            tags: { name: 'update_issue' },
          });
          issuesUpdated.add(1);
          sleep(0.2);
        }
      }
    });

    group('Heavy Search Usage', function() {
      const searchTerms = ['login', 'error', 'fix', 'performance', 'urgent'];
      for (const term of searchTerms) {
        const resp = http.get(`${API_URL}/search?q=${term}&project_id=${projectId}`, {
          headers: getAuthHeaders(token),
          tags: { name: 'search_issues' },
        });
        check(resp, { 'search completed': (r) => r.status === 200 });
        searchQueries.add(1);
        sleep(1);
      }
    });

    sleep(randomIntBetween(30, 60));
  });
}

// ==========================================
// WORKFLOW: Background Jobs
// ==========================================
export function backgroundJobWorkflow() {
  const token = login();
  if (!token) {
    errorRate.add(1);
    return;
  }

  // Simulates automated processes checking status
  group('Background Checks', function() {
    // Check for SLA breaches
    http.get(`${API_URL}/internal/sla/check`, {
      headers: getAuthHeaders(token),
      tags: { name: 'sla_check' },
    });

    // Webhook delivery retry
    http.get(`${API_URL}/internal/webhooks/pending`, {
      headers: getAuthHeaders(token),
      tags: { name: 'webhook_check' },
    });

    // Recurring issue check
    http.get(`${API_URL}/internal/recurring/due`, {
      headers: getAuthHeaders(token),
      tags: { name: 'recurring_check' },
    });

    // Activity log aggregation
    http.get(`${API_URL}/internal/metrics/aggregate`, {
      headers: getAuthHeaders(token),
      tags: { name: 'metrics_aggregate' },
    });
  });
}

// ==========================================
// WORKFLOW: Dashboard Queries
// ==========================================
export function dashboardWorkflow() {
  const token = login();
  if (!token) {
    errorRate.add(1);
    sleep(5);
    return;
  }

  group('Dashboard Queries', function() {
    // Organization-wide metrics (heavy query)
    group('Organization Metrics', function() {
      const resp = http.get(`${API_URL}/analytics/organization`, {
        headers: getAuthHeaders(token),
        tags: { name: 'org_metrics' },
      });
      check(resp, { 'org metrics loaded': (r) => r.status === 200 });
      sleep(5);
    });

    // Project velocity
    group('Project Velocity', function() {
      const projectId = getRandomProject(token);
      if (projectId) {
        const resp = http.get(`${API_URL}/analytics/projects/${projectId}/velocity`, {
          headers: getAuthHeaders(token),
          tags: { name: 'project_velocity' },
        });
        check(resp, { 'velocity loaded': (r) => r.status === 200 });
      }
      sleep(5);
    });

    // Team workload
    group('Team Workload', function() {
      const resp = http.get(`${API_URL}/analytics/workload`, {
        headers: getAuthHeaders(token),
        tags: { name: 'team_workload' },
      });
      check(resp, { 'workload loaded': (r) => r.status === 200 });
      sleep(10);
    });

    // Activity feed (pagination test)
    group('Activity Feed', function() {
      for (let page = 1; page <= 5; page++) {
        const resp = http.get(`${API_URL}/activity?page=${page}&limit=50`, {
          headers: getAuthHeaders(token),
          tags: { name: 'activity_feed' },
        });
        check(resp, { 'activity loaded': (r) => r.status === 200 });
        sleep(1);
      }
    });

    sleep(randomIntBetween(30, 60));
  });
}

// Default function (runs if no scenario specified)
export default function() {
  regularUserWorkflow();
}
