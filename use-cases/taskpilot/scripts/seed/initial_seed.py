#!/usr/bin/env python3
"""
TaskPilot Initial Data Seeder

Generates approximately 10 GiB of realistic data for the TaskPilot database.
This creates the initial state for testing postgres_ai monitoring.

Target data volumes:
- Organizations: 100
- Users: 5,000
- Teams: 500
- Projects: 1,000
- Issues: 500,000
- Comments: 2,000,000
- Activity Log: 3,000,000
- Labels: 5,000
- Notifications: 500,000

Usage:
    python scripts/seed/initial_seed.py

Environment:
    DATABASE_URL: PostgreSQL connection string
    SEED_BATCH_SIZE: Batch size for inserts (default: 1000)
    SEED_WORKERS: Parallel workers (default: 4)
"""

import os
import sys
import uuid
import random
import hashlib
import json
import asyncio
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
import argparse

# Try to import required packages
try:
    import psycopg
    from psycopg import sql
    from psycopg.rows import dict_row
except ImportError:
    print("Installing required packages...")
    os.system("pip install psycopg[binary]")
    import psycopg
    from psycopg import sql
    from psycopg.rows import dict_row

try:
    from faker import Faker
except ImportError:
    print("Installing faker...")
    os.system("pip install faker")
    from faker import Faker

try:
    from tqdm import tqdm
except ImportError:
    print("Installing tqdm...")
    os.system("pip install tqdm")
    from tqdm import tqdm


# Configuration
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://taskpilot:taskpilot@localhost:5433/taskpilot"
)
BATCH_SIZE = int(os.getenv("SEED_BATCH_SIZE", "1000"))
WORKERS = int(os.getenv("SEED_WORKERS", "4"))

# Initialize Faker
fake = Faker()
Faker.seed(42)  # Reproducible data
random.seed(42)


# Data Templates
ISSUE_TITLES = [
    "[Bug] {component} crashes when {action}",
    "[Feature] Add {feature} to {component}",
    "[Improvement] Optimize {component} performance",
    "[Task] Update {component} documentation",
    "[Bug] {component} shows incorrect {data}",
    "[Feature] Implement {feature} for {component}",
    "[Improvement] Refactor {component} code",
    "[Task] Write tests for {component}",
    "[Bug] {action} fails silently in {component}",
    "[Feature] {component} should support {feature}",
]

COMPONENTS = [
    "login page", "dashboard", "user profile", "settings", "API",
    "search", "notifications", "file upload", "export", "import",
    "billing", "admin panel", "reports", "analytics", "integrations",
    "webhooks", "authentication", "authorization", "database", "cache",
]

ACTIONS = [
    "clicking submit", "loading data", "saving changes", "deleting items",
    "filtering results", "sorting columns", "exporting data", "uploading files",
    "refreshing page", "navigating back", "opening modal", "closing dialog",
]

FEATURES = [
    "dark mode", "keyboard shortcuts", "bulk actions", "drag and drop",
    "auto-save", "real-time updates", "offline mode", "mobile support",
    "accessibility", "localization", "custom themes", "API rate limiting",
]

DATA_TYPES = [
    "data", "count", "status", "timestamp", "user info", "error message",
    "progress", "statistics", "metrics", "configuration",
]

COMMENT_TEMPLATES = [
    "Looking into this now.",
    "I've identified the root cause.",
    "This is related to {issue_ref}.",
    "Fixed in the latest commit.",
    "Moving to code review.",
    "LGTM! Approved.",
    "Could you provide more details?",
    "This needs more investigation.",
    "Added unit tests for this.",
    "Ready for QA testing.",
    "Deployed to staging.",
    "Closing as duplicate.",
    "@{username} can you take a look?",
    "Updated the priority based on feedback.",
    "This is blocked by {issue_ref}.",
    "Unblocked, continuing work.",
]

ACTIVITY_ACTIONS = [
    "created", "updated", "deleted", "commented", "status_changed",
    "assigned", "labeled", "unlabeled", "linked", "moved",
]


@dataclass
class SeedStats:
    """Track seeding progress and statistics."""
    organizations: int = 0
    users: int = 0
    teams: int = 0
    team_members: int = 0
    projects: int = 0
    cycles: int = 0
    labels: int = 0
    issues: int = 0
    issue_labels: int = 0
    comments: int = 0
    activity_logs: int = 0
    notifications: int = 0
    attachments: int = 0
    start_time: datetime = field(default_factory=datetime.now)

    def elapsed(self) -> str:
        delta = datetime.now() - self.start_time
        return str(delta).split('.')[0]

    def summary(self) -> str:
        return f"""
Seeding Complete!
=================
Time elapsed: {self.elapsed()}

Organizations: {self.organizations:,}
Users: {self.users:,}
Teams: {self.teams:,}
Team Members: {self.team_members:,}
Projects: {self.projects:,}
Cycles: {self.cycles:,}
Labels: {self.labels:,}
Issues: {self.issues:,}
Issue Labels: {self.issue_labels:,}
Comments: {self.comments:,}
Activity Logs: {self.activity_logs:,}
Notifications: {self.notifications:,}
Attachments: {self.attachments:,}
"""


def generate_uuid() -> str:
    return str(uuid.uuid4())


def generate_slug(name: str) -> str:
    return name.lower().replace(" ", "-").replace("'", "")[:50]


def generate_password_hash(password: str = "password123") -> str:
    # Simple hash for demo purposes (use bcrypt in production)
    return hashlib.sha256(password.encode()).hexdigest()


def generate_issue_title() -> str:
    template = random.choice(ISSUE_TITLES)
    return template.format(
        component=random.choice(COMPONENTS),
        action=random.choice(ACTIONS),
        feature=random.choice(FEATURES),
        data=random.choice(DATA_TYPES),
    )


def generate_issue_description() -> str:
    paragraphs = random.randint(1, 4)
    return "\n\n".join([fake.paragraph(nb_sentences=random.randint(3, 8)) for _ in range(paragraphs)])


def generate_comment_body(usernames: List[str], issue_numbers: List[int]) -> str:
    template = random.choice(COMMENT_TEMPLATES)
    return template.format(
        username=random.choice(usernames) if usernames else "user",
        issue_ref=f"PROJ-{random.choice(issue_numbers)}" if issue_numbers else "PROJ-1",
    )


def random_datetime(start: datetime, end: datetime) -> datetime:
    delta = end - start
    random_seconds = random.randint(0, int(delta.total_seconds()))
    return start + timedelta(seconds=random_seconds)


class TaskPilotSeeder:
    """Main seeder class for TaskPilot database."""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self.stats = SeedStats()

        # Caches for relationships
        self.organization_ids: List[str] = []
        self.user_ids: List[str] = []
        self.user_by_org: Dict[str, List[str]] = {}
        self.usernames: List[str] = []
        self.team_ids: List[str] = []
        self.project_ids: List[str] = []
        self.project_by_org: Dict[str, List[str]] = {}
        self.label_ids: List[str] = []
        self.label_by_project: Dict[str, List[str]] = {}
        self.issue_ids: List[str] = []
        self.issue_by_project: Dict[str, List[str]] = {}
        self.issue_numbers: List[int] = []

    def connect(self):
        """Create database connection."""
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def execute_batch(self, conn, query: str, data: List[tuple], desc: str = "Inserting"):
        """Execute batch insert with progress bar."""
        with conn.cursor() as cur:
            with tqdm(total=len(data), desc=desc, unit="rows") as pbar:
                for i in range(0, len(data), BATCH_SIZE):
                    batch = data[i:i + BATCH_SIZE]
                    cur.executemany(query, batch)
                    pbar.update(len(batch))
            conn.commit()

    def seed_organizations(self, conn, count: int = 100):
        """Seed organization data."""
        print(f"\n📦 Seeding {count} organizations...")

        data = []
        for i in range(count):
            org_id = generate_uuid()
            name = f"{fake.company()} {random.choice(['Inc', 'LLC', 'Corp', 'Co'])}"
            slug = generate_slug(name) + f"-{i}"

            plan_types = ["free", "starter", "pro", "enterprise"]
            plan_weights = [0.4, 0.3, 0.2, 0.1]
            plan = random.choices(plan_types, weights=plan_weights)[0]

            settings = json.dumps({
                "timezone": random.choice(["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"]),
                "date_format": "YYYY-MM-DD",
                "default_issue_status": "backlog",
                "require_estimate": random.choice([True, False]),
            })

            created_at = random_datetime(
                datetime.now() - timedelta(days=365 * 2),
                datetime.now() - timedelta(days=30)
            )

            data.append((org_id, name, slug, plan, settings, created_at, created_at))
            self.organization_ids.append(org_id)
            self.user_by_org[org_id] = []
            self.project_by_org[org_id] = []

        query = """
            INSERT INTO organizations (id, name, slug, plan_type, settings, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """
        self.execute_batch(conn, query, data, "Organizations")
        self.stats.organizations = count

    def seed_users(self, conn, count: int = 5000):
        """Seed user data."""
        print(f"\n👤 Seeding {count} users...")

        data = []
        for i in range(count):
            user_id = generate_uuid()
            org_id = random.choice(self.organization_ids)

            first_name = fake.first_name()
            last_name = fake.last_name()
            name = f"{first_name} {last_name}"
            username = f"{first_name.lower()}.{last_name.lower()}{random.randint(1, 99)}"
            email = f"{username}@{fake.domain_name()}"

            preferences = json.dumps({
                "theme": random.choice(["light", "dark", "system"]),
                "notifications_email": random.choice([True, False]),
                "notifications_web": True,
                "compact_view": random.choice([True, False]),
            })

            is_admin = i < 10 or random.random() < 0.05  # First 10 + 5% are admins
            created_at = random_datetime(
                datetime.now() - timedelta(days=365),
                datetime.now() - timedelta(days=7)
            )

            data.append((
                user_id, org_id, email, name, username,
                generate_password_hash(), True, is_admin,
                preferences, created_at, created_at
            ))

            self.user_ids.append(user_id)
            self.user_by_org[org_id].append(user_id)
            self.usernames.append(username)

        query = """
            INSERT INTO users (id, organization_id, email, name, username,
                             password_hash, is_active, is_admin, preferences,
                             created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        self.execute_batch(conn, query, data, "Users")
        self.stats.users = count

    def seed_teams(self, conn, count: int = 500):
        """Seed team data."""
        print(f"\n👥 Seeding {count} teams...")

        team_names = [
            "Engineering", "Product", "Design", "QA", "DevOps",
            "Frontend", "Backend", "Mobile", "Data", "Security",
            "Platform", "Infrastructure", "API", "Core", "Growth",
        ]

        data = []
        for i in range(count):
            team_id = generate_uuid()
            org_id = random.choice(self.organization_ids)

            name = f"{random.choice(team_names)} {fake.word().title()}"
            slug = generate_slug(name) + f"-{i}"

            created_at = random_datetime(
                datetime.now() - timedelta(days=300),
                datetime.now() - timedelta(days=30)
            )

            data.append((
                team_id, org_id, name, slug, fake.sentence(),
                f"#{fake.hex_color()[1:]}", created_at, created_at
            ))
            self.team_ids.append(team_id)

        query = """
            INSERT INTO teams (id, organization_id, name, slug, description,
                             color, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """
        self.execute_batch(conn, query, data, "Teams")
        self.stats.teams = count

    def seed_team_members(self, conn):
        """Seed team membership data."""
        print("\n👥 Seeding team members...")

        data = []
        roles = ["member", "lead", "admin"]
        role_weights = [0.7, 0.2, 0.1]

        for team_id in self.team_ids:
            # Each team has 5-20 members
            num_members = random.randint(5, 20)
            members = random.sample(self.user_ids, min(num_members, len(self.user_ids)))

            for user_id in members:
                role = random.choices(roles, weights=role_weights)[0]
                joined_at = random_datetime(
                    datetime.now() - timedelta(days=200),
                    datetime.now() - timedelta(days=7)
                )
                data.append((generate_uuid(), team_id, user_id, role, joined_at))

        query = """
            INSERT INTO team_members (id, team_id, user_id, role, joined_at)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (team_id, user_id) DO NOTHING
        """
        self.execute_batch(conn, query, data, "Team Members")
        self.stats.team_members = len(data)

    def seed_projects(self, conn, count: int = 1000):
        """Seed project data."""
        print(f"\n📁 Seeding {count} projects...")

        project_prefixes = [
            "WEB", "API", "MOB", "SRV", "CLI", "LIB", "SDK",
            "APP", "SYS", "NET", "SEC", "OPS", "DOC", "TEST",
        ]

        data = []
        used_keys = set()

        for i in range(count):
            project_id = generate_uuid()
            org_id = random.choice(self.organization_ids)
            team_id = random.choice(self.team_ids) if random.random() > 0.2 else None
            lead_id = random.choice(self.user_by_org[org_id]) if self.user_by_org[org_id] else None

            name = f"{fake.word().title()} {random.choice(['Service', 'App', 'Platform', 'System', 'Tool'])}"

            # Generate unique key
            while True:
                key = f"{random.choice(project_prefixes)}{random.randint(1, 99):02d}"
                if key not in used_keys:
                    used_keys.add(key)
                    break

            status = random.choices(
                ["active", "paused", "archived"],
                weights=[0.8, 0.1, 0.1]
            )[0]

            settings = json.dumps({
                "default_status": "backlog",
                "enable_cycles": random.choice([True, False]),
                "cycle_duration_weeks": random.choice([1, 2, 3, 4]),
                "enable_estimates": random.choice([True, False]),
            })

            created_at = random_datetime(
                datetime.now() - timedelta(days=300),
                datetime.now() - timedelta(days=30)
            )

            data.append((
                project_id, org_id, team_id, lead_id, name, key,
                fake.paragraph(), status, settings, 0, created_at, created_at
            ))

            self.project_ids.append(project_id)
            self.project_by_org[org_id].append(project_id)
            self.issue_by_project[project_id] = []
            self.label_by_project[project_id] = []

        query = """
            INSERT INTO projects (id, organization_id, team_id, lead_id, name, key,
                                description, status, settings, issue_count,
                                created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        self.execute_batch(conn, query, data, "Projects")
        self.stats.projects = count

    def seed_labels(self, conn, per_project: int = 5):
        """Seed label data."""
        total = len(self.project_ids) * per_project
        print(f"\n🏷️ Seeding {total} labels...")

        label_names = [
            "bug", "feature", "improvement", "documentation", "question",
            "help wanted", "good first issue", "wontfix", "duplicate",
            "enhancement", "priority: high", "priority: low", "priority: medium",
            "frontend", "backend", "mobile", "infrastructure", "security",
            "performance", "accessibility", "design", "testing", "refactor",
        ]

        colors = [
            "#e11d48", "#f97316", "#eab308", "#22c55e", "#06b6d4",
            "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280", "#0ea5e9",
        ]

        data = []
        for project_id in self.project_ids:
            selected_labels = random.sample(label_names, min(per_project, len(label_names)))
            for name in selected_labels:
                label_id = generate_uuid()
                data.append((
                    label_id, project_id, name, fake.sentence()[:100],
                    random.choice(colors), datetime.now()
                ))
                self.label_ids.append(label_id)
                self.label_by_project[project_id].append(label_id)

        query = """
            INSERT INTO labels (id, project_id, name, description, color, created_at)
            VALUES (%s, %s, %s, %s, %s, %s)
        """
        self.execute_batch(conn, query, data, "Labels")
        self.stats.labels = len(data)

    def seed_issues(self, conn, count: int = 500000):
        """Seed issue data - the main data volume."""
        print(f"\n📋 Seeding {count} issues...")

        statuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"]
        status_weights = [0.15, 0.2, 0.15, 0.1, 0.35, 0.05]

        priorities = ["none", "low", "medium", "high", "urgent"]
        priority_weights = [0.1, 0.25, 0.4, 0.2, 0.05]

        data = []
        issue_number_by_project = {}

        for i in range(count):
            issue_id = generate_uuid()
            project_id = random.choice(self.project_ids)

            # Get org for this project
            org_id = None
            for oid, pids in self.project_by_org.items():
                if project_id in pids:
                    org_id = oid
                    break

            # Get users for this org
            org_users = self.user_by_org.get(org_id, self.user_ids[:10])
            creator_id = random.choice(org_users) if org_users else random.choice(self.user_ids)
            assignee_id = random.choice(org_users) if org_users and random.random() > 0.3 else None

            # Auto-increment number per project
            if project_id not in issue_number_by_project:
                issue_number_by_project[project_id] = 0
            issue_number_by_project[project_id] += 1
            number = issue_number_by_project[project_id]

            title = generate_issue_title()
            description = generate_issue_description()
            status = random.choices(statuses, weights=status_weights)[0]
            priority = random.choices(priorities, weights=priority_weights)[0]

            estimate = random.choice([None, 1, 2, 3, 5, 8, 13]) if random.random() > 0.4 else None
            due_date = (datetime.now() + timedelta(days=random.randint(-30, 60))).date() if random.random() > 0.6 else None

            created_at = random_datetime(
                datetime.now() - timedelta(days=365),
                datetime.now() - timedelta(hours=1)
            )
            updated_at = random_datetime(created_at, datetime.now())

            # Completed issues have completion time
            completed_at = None
            if status in ["done", "cancelled"]:
                completed_at = random_datetime(created_at, updated_at)

            metadata = json.dumps({
                "source": "seed",
                "version": 1,
            })

            data.append((
                issue_id, project_id, None, creator_id, assignee_id,
                number, title, description, status, priority,
                estimate, due_date, None, completed_at,
                metadata, 0, 0, 0, 0,
                created_at, updated_at
            ))

            self.issue_ids.append(issue_id)
            self.issue_by_project[project_id].append(issue_id)
            self.issue_numbers.append(number)

            # Commit periodically to avoid memory issues
            if len(data) >= BATCH_SIZE * 10:
                query = """
                    INSERT INTO issues (id, project_id, cycle_id, creator_id, assignee_id,
                                       number, title, description, status, priority,
                                       estimate, due_date, started_at, completed_at,
                                       metadata, comment_count, attachment_count,
                                       sub_issue_count, sort_order, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """
                self.execute_batch(conn, query, data, f"Issues ({self.stats.issues + len(data):,}/{count:,})")
                self.stats.issues += len(data)
                data = []

        # Insert remaining
        if data:
            query = """
                INSERT INTO issues (id, project_id, cycle_id, creator_id, assignee_id,
                                   number, title, description, status, priority,
                                   estimate, due_date, started_at, completed_at,
                                   metadata, comment_count, attachment_count,
                                   sub_issue_count, sort_order, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """
            self.execute_batch(conn, query, data, f"Issues (final)")
            self.stats.issues += len(data)

    def seed_issue_labels(self, conn, avg_labels_per_issue: float = 2.0):
        """Seed issue-label relationships."""
        total = int(len(self.issue_ids) * avg_labels_per_issue)
        print(f"\n🏷️ Seeding ~{total:,} issue labels...")

        data = []
        for issue_id in self.issue_ids:
            # Find project for this issue
            project_id = None
            for pid, iids in self.issue_by_project.items():
                if issue_id in iids:
                    project_id = pid
                    break

            if not project_id or project_id not in self.label_by_project:
                continue

            project_labels = self.label_by_project[project_id]
            if not project_labels:
                continue

            # Random number of labels (0-4)
            num_labels = random.choices([0, 1, 2, 3, 4], weights=[0.2, 0.3, 0.3, 0.15, 0.05])[0]
            if num_labels == 0:
                continue

            selected_labels = random.sample(project_labels, min(num_labels, len(project_labels)))
            for label_id in selected_labels:
                data.append((issue_id, label_id, datetime.now()))

        query = """
            INSERT INTO issue_labels (issue_id, label_id, created_at)
            VALUES (%s, %s, %s)
            ON CONFLICT DO NOTHING
        """
        self.execute_batch(conn, query, data, "Issue Labels")
        self.stats.issue_labels = len(data)

    def seed_comments(self, conn, count: int = 2000000):
        """Seed comment data."""
        print(f"\n💬 Seeding {count:,} comments...")

        data = []
        for i in range(count):
            comment_id = generate_uuid()
            issue_id = random.choice(self.issue_ids)
            user_id = random.choice(self.user_ids)

            body = generate_comment_body(self.usernames, self.issue_numbers)

            created_at = random_datetime(
                datetime.now() - timedelta(days=300),
                datetime.now() - timedelta(minutes=5)
            )

            data.append((
                comment_id, issue_id, user_id, None,
                body, False, False, "{}", created_at, created_at
            ))

            # Commit periodically
            if len(data) >= BATCH_SIZE * 10:
                query = """
                    INSERT INTO comments (id, issue_id, user_id, parent_id,
                                        body, is_internal, is_edited, reactions,
                                        created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """
                self.execute_batch(conn, query, data, f"Comments ({self.stats.comments + len(data):,}/{count:,})")
                self.stats.comments += len(data)
                data = []

        # Insert remaining
        if data:
            query = """
                INSERT INTO comments (id, issue_id, user_id, parent_id,
                                    body, is_internal, is_edited, reactions,
                                    created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """
            self.execute_batch(conn, query, data, "Comments (final)")
            self.stats.comments += len(data)

    def seed_activity_log(self, conn, count: int = 3000000):
        """Seed activity log data."""
        print(f"\n📜 Seeding {count:,} activity log entries...")

        actions = ["created", "updated", "status_changed", "assigned", "commented"]
        action_weights = [0.1, 0.3, 0.25, 0.15, 0.2]

        data = []
        for i in range(count):
            log_id = generate_uuid()

            # Get random issue and its project/org
            issue_id = random.choice(self.issue_ids)
            project_id = None
            org_id = None

            for pid, iids in self.issue_by_project.items():
                if issue_id in iids:
                    project_id = pid
                    break

            for oid, pids in self.project_by_org.items():
                if project_id in pids:
                    org_id = oid
                    break

            user_id = random.choice(self.user_ids)
            action = random.choices(actions, weights=action_weights)[0]

            changes = None
            if action == "status_changed":
                old_status = random.choice(["backlog", "todo", "in_progress"])
                new_status = random.choice(["in_progress", "in_review", "done"])
                changes = json.dumps({"field": "status", "old": old_status, "new": new_status})
            elif action == "assigned":
                changes = json.dumps({"field": "assignee_id", "old": None, "new": random.choice(self.user_ids)})

            created_at = random_datetime(
                datetime.now() - timedelta(days=365),
                datetime.now() - timedelta(minutes=1)
            )

            data.append((
                log_id, org_id, project_id, issue_id, user_id,
                action, "issue", issue_id, changes, created_at
            ))

            # Commit periodically
            if len(data) >= BATCH_SIZE * 10:
                query = """
                    INSERT INTO activity_log (id, organization_id, project_id, issue_id,
                                            user_id, action, entity_type, entity_id,
                                            changes, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """
                self.execute_batch(conn, query, data, f"Activity Log ({self.stats.activity_logs + len(data):,}/{count:,})")
                self.stats.activity_logs += len(data)
                data = []

        # Insert remaining
        if data:
            query = """
                INSERT INTO activity_log (id, organization_id, project_id, issue_id,
                                        user_id, action, entity_type, entity_id,
                                        changes, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """
            self.execute_batch(conn, query, data, "Activity Log (final)")
            self.stats.activity_logs += len(data)

    def seed_notifications(self, conn, count: int = 500000):
        """Seed notification data."""
        print(f"\n🔔 Seeding {count:,} notifications...")

        notification_types = [
            "issue_assigned", "issue_mentioned", "comment_added",
            "issue_updated", "due_date_reminder"
        ]

        data = []
        for i in range(count):
            notif_id = generate_uuid()
            user_id = random.choice(self.user_ids)
            issue_id = random.choice(self.issue_ids) if random.random() > 0.1 else None
            actor_id = random.choice(self.user_ids)

            notif_type = random.choice(notification_types)
            title = f"Notification: {notif_type.replace('_', ' ').title()}"

            created_at = random_datetime(
                datetime.now() - timedelta(days=60),
                datetime.now() - timedelta(minutes=5)
            )

            # 60% are read
            read_at = random_datetime(created_at, datetime.now()) if random.random() > 0.4 else None

            data.append((
                notif_id, user_id, notif_type, title, None,
                issue_id, None, actor_id, None, read_at, created_at
            ))

            # Commit periodically
            if len(data) >= BATCH_SIZE * 10:
                query = """
                    INSERT INTO notifications (id, user_id, type, title, body,
                                             issue_id, comment_id, actor_id, url,
                                             read_at, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """
                self.execute_batch(conn, query, data, f"Notifications ({self.stats.notifications + len(data):,}/{count:,})")
                self.stats.notifications += len(data)
                data = []

        # Insert remaining
        if data:
            query = """
                INSERT INTO notifications (id, user_id, type, title, body,
                                         issue_id, comment_id, actor_id, url,
                                         read_at, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """
            self.execute_batch(conn, query, data, "Notifications (final)")
            self.stats.notifications += len(data)

    def update_issue_counts(self, conn):
        """Update denormalized counts on issues table."""
        print("\n🔢 Updating issue comment counts...")

        with conn.cursor() as cur:
            cur.execute("""
                UPDATE issues i
                SET comment_count = (
                    SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id
                )
            """)
            conn.commit()
            print(f"   Updated {cur.rowcount:,} issue comment counts")

    def run(self,
            organizations: int = 100,
            users: int = 5000,
            teams: int = 500,
            projects: int = 1000,
            issues: int = 500000,
            comments: int = 2000000,
            activity_logs: int = 3000000,
            notifications: int = 500000):
        """Run the complete seeding process."""

        print("=" * 60)
        print("TaskPilot Database Seeder")
        print("=" * 60)
        print(f"Database: {self.database_url.split('@')[1] if '@' in self.database_url else 'local'}")
        print(f"Batch size: {BATCH_SIZE:,}")
        print()

        with self.connect() as conn:
            # Core entities
            self.seed_organizations(conn, organizations)
            self.seed_users(conn, users)
            self.seed_teams(conn, teams)
            self.seed_team_members(conn)
            self.seed_projects(conn, projects)
            self.seed_labels(conn)

            # Main data volume
            self.seed_issues(conn, issues)
            self.seed_issue_labels(conn)
            self.seed_comments(conn, comments)
            self.seed_activity_log(conn, activity_logs)
            self.seed_notifications(conn, notifications)

            # Update counts
            self.update_issue_counts(conn)

        print(self.stats.summary())

        # Show database size
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT pg_size_pretty(pg_database_size(current_database())) as size
                """)
                result = cur.fetchone()
                print(f"\n📊 Database size: {result['size']}")


def main():
    parser = argparse.ArgumentParser(description="Seed TaskPilot database with test data")
    parser.add_argument("--organizations", type=int, default=100)
    parser.add_argument("--users", type=int, default=5000)
    parser.add_argument("--teams", type=int, default=500)
    parser.add_argument("--projects", type=int, default=1000)
    parser.add_argument("--issues", type=int, default=500000)
    parser.add_argument("--comments", type=int, default=2000000)
    parser.add_argument("--activity-logs", type=int, default=3000000)
    parser.add_argument("--notifications", type=int, default=500000)
    parser.add_argument("--small", action="store_true", help="Use small dataset for testing")

    args = parser.parse_args()

    # Small dataset for testing
    if args.small:
        args.organizations = 10
        args.users = 100
        args.teams = 20
        args.projects = 50
        args.issues = 1000
        args.comments = 5000
        args.activity_logs = 10000
        args.notifications = 2000

    seeder = TaskPilotSeeder(DATABASE_URL)
    seeder.run(
        organizations=args.organizations,
        users=args.users,
        teams=args.teams,
        projects=args.projects,
        issues=args.issues,
        comments=args.comments,
        activity_logs=args.activity_logs,
        notifications=args.notifications,
    )


if __name__ == "__main__":
    main()
