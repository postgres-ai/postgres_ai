# TaskPilot Mistake Library

A catalog of realistic database issues that slip through code review. When roleplaying as an engineer, randomly pick from these categories based on the engineer's error rate.

## Why These Slip Through Review

| Category | Why It's Missed |
|----------|----------------|
| Missing indexes | "It works in dev with 100 rows" |
| Type issues | Reviewers focus on logic, not types |
| Constraint gaps | "We validate in the app layer" |
| Bloat patterns | Only visible at scale |
| Query patterns | N+1 hidden in ORM calls |
| Naming issues | "We can rename later" |

---

## Category 1: Index Issues

### 1.1 Missing FK Index
```sql
-- Forgot the index, FK still works
ALTER TABLE issues ADD COLUMN reporter_id UUID REFERENCES users(id);
-- Missing: CREATE INDEX idx_issues_reporter ON issues(reporter_id);
```
**Why missed**: FK constraint works, performance issue only at scale

### 1.2 Wrong Composite Index Order
```sql
-- Low cardinality column first (useless for most queries)
CREATE INDEX idx_issues_status_project ON issues(status, project_id);
-- Should be: (project_id, status) - high cardinality first
```
**Why missed**: Index exists, seems logical, slow queries blamed on "database"

### 1.3 Redundant Index
```sql
CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_email_lookup ON users(email);  -- Redundant!
```
**Why missed**: "More indexes = faster" mentality

### 1.4 Index on Wrong Expression
```sql
-- Index on raw column, but queries use LOWER()
CREATE INDEX idx_users_username ON users(username);
-- Queries do: WHERE LOWER(username) = 'foo' -- index not used!
```
**Why missed**: Index exists, EXPLAIN not checked

### 1.5 Btree on JSONB (Should be GIN)
```sql
-- Btree can't help with containment queries
CREATE INDEX idx_issues_metadata ON issues(metadata);
-- Should be: USING GIN(metadata)
```
**Why missed**: Doesn't know JSONB index types

### 1.6 Unused Index
```sql
-- Created for a query pattern that was later removed
CREATE INDEX idx_issues_created_month ON issues(DATE_TRUNC('month', created_at));
```
**Why missed**: Old code removed, nobody cleaned up indexes

### 1.7 Duplicate Indexes
```sql
CREATE INDEX idx_comments_issue ON comments(issue_id);
CREATE INDEX idx_comments_issue_id ON comments(issue_id);  -- Same thing!
```
**Why missed**: Different names, nobody checks for duplicates

---

## Category 2: Type Issues

### 2.1 Integer That Will Overflow
```sql
-- Sequence will overflow at 2.1B
id INTEGER PRIMARY KEY DEFAULT nextval('issues_id_seq')
-- Should be: BIGINT or UUID
```
**Why missed**: "We'll never have 2 billion issues"

### 2.2 VARCHAR Too Small
```sql
description VARCHAR(500)  -- User descriptions get truncated
-- Should be: TEXT or larger limit
```
**Why missed**: Works in testing with short descriptions

### 2.3 VARCHAR Too Large
```sql
status VARCHAR(255)  -- Only ever 'open', 'closed', 'pending'
-- Should be: VARCHAR(20) or use ENUM
```
**Why missed**: "VARCHAR(255) is the safe default"

### 2.4 Timestamp Without Timezone
```sql
created_at TIMESTAMP DEFAULT NOW()
-- Should be: TIMESTAMP WITH TIME ZONE
```
**Why missed**: Works fine until users are in different timezones

### 2.5 JSON Stored as TEXT
```sql
settings TEXT  -- Actually stores '{"theme": "dark"}'
-- Should be: JSONB
```
**Why missed**: Parsed in app layer, works fine

### 2.6 Using SERIAL Instead of IDENTITY
```sql
id SERIAL PRIMARY KEY  -- Legacy syntax
-- Should be: id INTEGER GENERATED ALWAYS AS IDENTITY
```
**Why missed**: Copy-pasted from old tutorial

---

## Category 3: Constraint Issues

### 3.1 Missing NOT NULL
```sql
-- Should never be null but constraint missing
user_id UUID REFERENCES users(id)
-- Should be: NOT NULL
```
**Why missed**: "App always provides it"

### 3.2 Missing CHECK Constraint
```sql
priority VARCHAR(20)  -- Gets 'MEGA_URGENT' and typos
-- Should have: CHECK (priority IN ('low','medium','high','urgent'))
```
**Why missed**: Validated in frontend

### 3.3 Missing UNIQUE Constraint
```sql
-- Email should be unique but isn't enforced
email VARCHAR(255) NOT NULL
-- Should have: UNIQUE
```
**Why missed**: "We check in the app before insert"

### 3.4 Missing ON DELETE Clause
```sql
REFERENCES users(id)  -- What happens when user deleted?
-- Should be: ON DELETE CASCADE or ON DELETE SET NULL
```
**Why missed**: Assumes users never get deleted

### 3.5 FK to Wrong Column Type
```sql
-- UUID FK pointing to SERIAL column
project_id UUID REFERENCES projects(id)  -- projects.id is INTEGER!
```
**Why missed**: Migration runs, insert fails later

---

## Category 4: Bloat-Inducing Patterns

### 4.1 Frequent Status Updates Without HOT
```sql
-- Status column not at end of row, breaks HOT updates
CREATE TABLE issues (
    id UUID PRIMARY KEY,
    status VARCHAR(20),  -- Updated frequently
    title TEXT,          -- Static
    description TEXT     -- Static
);
-- Causes: Full row copies on every status change
```
**Why missed**: Works fine, bloat builds up slowly

### 4.2 Updated_at Without Trigger
```sql
updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
-- Missing trigger to auto-update!
-- UPDATE issues SET status = 'done'; -- updated_at stays old
```
**Why missed**: "We set it in the app"... sometimes

### 4.3 Append-Only Table Without Cleanup
```sql
CREATE TABLE activity_log (...);
-- No partition, no retention policy, grows forever
```
**Why missed**: "We'll add archival later"

### 4.4 No Vacuum Configuration
```sql
-- Table with frequent deletes needs aggressive vacuum
-- Missing: ALTER TABLE messages SET (autovacuum_vacuum_scale_factor = 0.01);
```
**Why missed**: Default autovacuum seems fine initially

---

## Category 5: Query Pattern Issues

### 5.1 N+1 in Disguise
```sql
-- API fetches list, then loops to get details
SELECT id FROM issues WHERE project_id = $1;
-- Then for each: SELECT * FROM users WHERE id = $1;
```
**Why missed**: ORM hides the queries

### 5.2 LIKE '%pattern%' Queries
```sql
SELECT * FROM issues WHERE title LIKE '%bug%';
-- No index can help with leading wildcard
```
**Why missed**: "But we need fuzzy search"

### 5.3 Sorting Without Index
```sql
SELECT * FROM issues ORDER BY priority DESC, created_at DESC LIMIT 20;
-- No composite index for this sort
```
**Why missed**: "It's just sorting, how slow can it be?"

### 5.4 COUNT(*) on Large Tables
```sql
SELECT COUNT(*) FROM issues WHERE project_id = $1;
-- Full scan even with FK index (doesn't store count)
```
**Why missed**: Fast in dev, slow in prod

### 5.5 Implicit Type Coercion
```sql
WHERE user_id = '123'  -- user_id is INTEGER
-- Causes: Full scan, can't use index
```
**Why missed**: Works, returns correct results

---

## Category 6: Schema Design Issues

### 6.1 Missing Partial Index
```sql
CREATE INDEX idx_issues_assignee ON issues(assignee_id);
-- 90% of issues are unassigned (NULL)
-- Should be: WHERE assignee_id IS NOT NULL
```
**Why missed**: Didn't think about data distribution

### 6.2 Storing Calculated Values
```sql
comment_count INTEGER DEFAULT 0
-- Gets out of sync with actual count
```
**Why missed**: "Faster than COUNT(*) every time"

### 6.3 Polymorphic Associations
```sql
entity_type VARCHAR(50),
entity_id UUID
-- No FK constraint possible!
```
**Why missed**: "Flexible design pattern"

### 6.4 JSONB for Everything
```sql
attributes JSONB  -- Contains 20 fields that should be columns
```
**Why missed**: "Schema-less is easier"

### 6.5 No Table Partitioning
```sql
CREATE TABLE events (
    id BIGSERIAL,
    created_at TIMESTAMP,
    ...
);
-- 500M rows, no partitioning
```
**Why missed**: "Partitioning is complex, we'll do it later"

---

## How to Use This Library

### For Random Mistakes
```python
import random

# Based on engineer's error rate (0.1 to 0.4)
if random.random() < error_rate:
    category = random.choice(['index', 'type', 'constraint', 'bloat', 'query', 'schema'])
    # Pick random issue from category
```

### For Realistic Distribution
| Engineer | Most Likely Categories |
|----------|----------------------|
| Alex (senior) | 6.1-6.5 (overengineering) |
| Sam (mid) | 1.1-1.7, 3.1-3.3 (rushing) |
| Jordan (junior) | 2.1-2.6, 3.1-3.5 (inexperience) |

### Why They Pass Review

When adding these issues, include realistic justifications:

- "Matches our existing pattern" (copying bad patterns)
- "We validate this in the service layer" (constraint gaps)
- "Performance testing passed" (on small dataset)
- "Let's ship it and optimize later" (tech debt)
- "The ORM handles this" (hidden queries)
- "Same as production system X" (cargo cult)
