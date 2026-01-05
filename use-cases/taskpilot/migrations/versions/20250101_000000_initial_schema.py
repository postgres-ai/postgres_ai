"""Initial schema for TaskPilot

Revision ID: 001_initial
Revises:
Create Date: 2025-01-01 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '001_initial'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ==========================================================================
    # Organizations
    # ==========================================================================
    op.create_table(
        'organizations',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('slug', sa.String(50), nullable=False),
        sa.Column('plan_type', postgresql.ENUM('free', 'starter', 'pro', 'enterprise', name='plan_type', create_type=False), nullable=False, server_default='free'),
        sa.Column('settings', postgresql.JSONB(), nullable=False, server_default='{}'),
        sa.Column('trial_ends_at', sa.DateTime(timezone=True)),
        sa.Column('subscription_id', sa.String(100)),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('slug'),
        sa.CheckConstraint("slug ~ '^[a-z0-9-]+$'", name='organizations_slug_format'),
    )
    op.create_index('idx_organizations_slug', 'organizations', ['slug'])
    op.create_index('idx_organizations_plan_type', 'organizations', ['plan_type'])
    op.create_index('idx_organizations_created_at', 'organizations', ['created_at'])

    # ==========================================================================
    # Users
    # ==========================================================================
    op.create_table(
        'users',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('organization_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('email', sa.String(255), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('username', sa.String(50)),
        sa.Column('avatar_url', sa.Text()),
        sa.Column('password_hash', sa.String(255)),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('is_admin', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('timezone', sa.String(50), server_default='UTC'),
        sa.Column('preferences', postgresql.JSONB(), nullable=False, server_default='{}'),
        sa.Column('last_login_at', sa.DateTime(timezone=True)),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('organization_id', 'email', name='users_email_org_unique'),
        sa.UniqueConstraint('organization_id', 'username', name='users_username_org_unique'),
    )
    op.create_index('idx_users_organization_id', 'users', ['organization_id'])
    op.create_index('idx_users_email', 'users', ['email'])

    # ==========================================================================
    # Teams
    # ==========================================================================
    op.create_table(
        'teams',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('organization_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('slug', sa.String(50), nullable=False),
        sa.Column('description', sa.Text()),
        sa.Column('icon', sa.String(50)),
        sa.Column('color', sa.String(7)),
        sa.Column('settings', postgresql.JSONB(), nullable=False, server_default='{}'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('organization_id', 'slug', name='teams_slug_org_unique'),
    )
    op.create_index('idx_teams_organization_id', 'teams', ['organization_id'])

    # ==========================================================================
    # Team Members
    # ==========================================================================
    op.create_table(
        'team_members',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('team_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('role', postgresql.ENUM('member', 'lead', 'admin', name='team_role', create_type=False), nullable=False, server_default='member'),
        sa.Column('joined_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('team_id', 'user_id', name='team_members_unique'),
    )
    op.create_index('idx_team_members_team_id', 'team_members', ['team_id'])
    op.create_index('idx_team_members_user_id', 'team_members', ['user_id'])

    # ==========================================================================
    # Projects
    # ==========================================================================
    op.create_table(
        'projects',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('organization_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('team_id', postgresql.UUID(as_uuid=True)),
        sa.Column('lead_id', postgresql.UUID(as_uuid=True)),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('key', sa.String(10), nullable=False),
        sa.Column('description', sa.Text()),
        sa.Column('icon', sa.String(50)),
        sa.Column('color', sa.String(7)),
        sa.Column('status', postgresql.ENUM('active', 'paused', 'archived', name='project_status', create_type=False), nullable=False, server_default='active'),
        sa.Column('settings', postgresql.JSONB(), nullable=False, server_default='{}'),
        sa.Column('issue_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('archived_at', sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['lead_id'], ['users.id'], ondelete='SET NULL'),
        sa.UniqueConstraint('organization_id', 'key', name='projects_key_org_unique'),
        sa.CheckConstraint("key ~ '^[A-Z]{2,10}$'", name='projects_key_format'),
    )
    op.create_index('idx_projects_organization_id', 'projects', ['organization_id'])
    op.create_index('idx_projects_team_id', 'projects', ['team_id'])
    op.create_index('idx_projects_status', 'projects', ['organization_id', 'status'])

    # ==========================================================================
    # Cycles
    # ==========================================================================
    op.create_table(
        'cycles',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('project_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('number', sa.Integer(), nullable=False),
        sa.Column('description', sa.Text()),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=False),
        sa.Column('status', postgresql.ENUM('upcoming', 'active', 'completed', name='cycle_status', create_type=False), nullable=False, server_default='upcoming'),
        sa.Column('completed_issue_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_issue_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('completed_estimate', sa.Numeric(10, 2), server_default='0'),
        sa.Column('total_estimate', sa.Numeric(10, 2), server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('project_id', 'number', name='cycles_number_project_unique'),
        sa.CheckConstraint('end_date > start_date', name='cycles_dates_valid'),
    )
    op.create_index('idx_cycles_project_id', 'cycles', ['project_id'])
    op.create_index('idx_cycles_status', 'cycles', ['project_id', 'status'])

    # ==========================================================================
    # Labels
    # ==========================================================================
    op.create_table(
        'labels',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('project_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(50), nullable=False),
        sa.Column('description', sa.Text()),
        sa.Column('color', sa.String(7), nullable=False),
        sa.Column('parent_id', postgresql.UUID(as_uuid=True)),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['parent_id'], ['labels.id'], ondelete='SET NULL'),
        sa.UniqueConstraint('project_id', 'name', name='labels_name_project_unique'),
    )
    op.create_index('idx_labels_project_id', 'labels', ['project_id'])

    # ==========================================================================
    # Issues (main table - high volume)
    # ==========================================================================
    op.create_table(
        'issues',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('project_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('cycle_id', postgresql.UUID(as_uuid=True)),
        sa.Column('parent_id', postgresql.UUID(as_uuid=True)),
        sa.Column('creator_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('assignee_id', postgresql.UUID(as_uuid=True)),
        sa.Column('number', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(500), nullable=False),
        sa.Column('description', sa.Text()),
        sa.Column('status', postgresql.ENUM('backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled', name='issue_status', create_type=False), nullable=False, server_default='backlog'),
        sa.Column('priority', postgresql.ENUM('none', 'low', 'medium', 'high', 'urgent', name='issue_priority', create_type=False), nullable=False, server_default='none'),
        sa.Column('estimate', sa.Numeric(5, 2)),
        sa.Column('due_date', sa.Date()),
        sa.Column('started_at', sa.DateTime(timezone=True)),
        sa.Column('completed_at', sa.DateTime(timezone=True)),
        sa.Column('metadata', postgresql.JSONB(), nullable=False, server_default='{}'),
        sa.Column('comment_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('attachment_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sub_issue_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sort_order', sa.Numeric(20, 10), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('archived_at', sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['cycle_id'], ['cycles.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['parent_id'], ['issues.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['creator_id'], ['users.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['assignee_id'], ['users.id'], ondelete='SET NULL'),
        sa.UniqueConstraint('project_id', 'number', name='issues_number_project_unique'),
    )
    # Primary indexes
    op.create_index('idx_issues_project_id', 'issues', ['project_id'])
    op.create_index('idx_issues_status', 'issues', ['project_id', 'status'])
    op.create_index('idx_issues_priority', 'issues', ['project_id', 'priority'])
    op.create_index('idx_issues_assignee_id', 'issues', ['assignee_id'], postgresql_where=sa.text('assignee_id IS NOT NULL'))
    op.create_index('idx_issues_creator_id', 'issues', ['creator_id'])
    op.create_index('idx_issues_cycle_id', 'issues', ['cycle_id'], postgresql_where=sa.text('cycle_id IS NOT NULL'))
    op.create_index('idx_issues_created_at', 'issues', ['project_id', sa.text('created_at DESC')])
    op.create_index('idx_issues_updated_at', 'issues', [sa.text('updated_at DESC')])
    op.create_index('idx_issues_due_date', 'issues', ['due_date'], postgresql_where=sa.text('due_date IS NOT NULL'))
    op.create_index('idx_issues_sort_order', 'issues', ['project_id', 'sort_order'])
    op.create_index('idx_issues_metadata', 'issues', ['metadata'], postgresql_using='gin')

    # ==========================================================================
    # Issue Labels (many-to-many)
    # ==========================================================================
    op.create_table(
        'issue_labels',
        sa.Column('issue_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('label_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('issue_id', 'label_id'),
        sa.ForeignKeyConstraint(['issue_id'], ['issues.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['label_id'], ['labels.id'], ondelete='CASCADE'),
    )
    op.create_index('idx_issue_labels_issue_id', 'issue_labels', ['issue_id'])
    op.create_index('idx_issue_labels_label_id', 'issue_labels', ['label_id'])

    # ==========================================================================
    # Issue Links
    # ==========================================================================
    op.create_table(
        'issue_links',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('source_issue_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('target_issue_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('link_type', postgresql.ENUM('blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicate_of', name='link_type', create_type=False), nullable=False),
        sa.Column('created_by_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['source_issue_id'], ['issues.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['target_issue_id'], ['issues.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ondelete='RESTRICT'),
        sa.CheckConstraint('source_issue_id != target_issue_id', name='issue_links_no_self_link'),
        sa.UniqueConstraint('source_issue_id', 'target_issue_id', 'link_type', name='issue_links_unique'),
    )
    op.create_index('idx_issue_links_source', 'issue_links', ['source_issue_id'])
    op.create_index('idx_issue_links_target', 'issue_links', ['target_issue_id'])

    # ==========================================================================
    # Comments (high volume)
    # ==========================================================================
    op.create_table(
        'comments',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('issue_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('parent_id', postgresql.UUID(as_uuid=True)),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('body_html', sa.Text()),
        sa.Column('is_internal', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('is_edited', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('reactions', postgresql.JSONB(), nullable=False, server_default='{}'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['issue_id'], ['issues.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['parent_id'], ['comments.id'], ondelete='CASCADE'),
    )
    op.create_index('idx_comments_issue_id', 'comments', ['issue_id'])
    op.create_index('idx_comments_user_id', 'comments', ['user_id'])
    op.create_index('idx_comments_created_at', 'comments', ['issue_id', sa.text('created_at DESC')])

    # ==========================================================================
    # Attachments
    # ==========================================================================
    op.create_table(
        'attachments',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('issue_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('comment_id', postgresql.UUID(as_uuid=True)),
        sa.Column('filename', sa.String(255), nullable=False),
        sa.Column('original_filename', sa.String(255), nullable=False),
        sa.Column('content_type', sa.String(100), nullable=False),
        sa.Column('file_size', sa.BigInteger(), nullable=False),
        sa.Column('storage_key', sa.String(500), nullable=False),
        sa.Column('storage_provider', sa.String(20), nullable=False, server_default='local'),
        sa.Column('width', sa.Integer()),
        sa.Column('height', sa.Integer()),
        sa.Column('thumbnail_key', sa.String(500)),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['issue_id'], ['issues.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['comment_id'], ['comments.id'], ondelete='CASCADE'),
    )
    op.create_index('idx_attachments_issue_id', 'attachments', ['issue_id'])

    # ==========================================================================
    # Activity Log (very high volume)
    # ==========================================================================
    op.create_table(
        'activity_log',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('organization_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('project_id', postgresql.UUID(as_uuid=True)),
        sa.Column('issue_id', postgresql.UUID(as_uuid=True)),
        sa.Column('user_id', postgresql.UUID(as_uuid=True)),
        sa.Column('action', postgresql.ENUM('created', 'updated', 'deleted', 'commented', 'status_changed', 'assigned', 'labeled', 'unlabeled', 'linked', 'unlinked', 'moved', 'archived', name='activity_action', create_type=False), nullable=False),
        sa.Column('entity_type', sa.String(50), nullable=False),
        sa.Column('entity_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('changes', postgresql.JSONB()),
        sa.Column('ip_address', postgresql.INET()),
        sa.Column('user_agent', sa.Text()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['issue_id'], ['issues.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    )
    op.create_index('idx_activity_log_organization_id', 'activity_log', ['organization_id'])
    op.create_index('idx_activity_log_project_id', 'activity_log', ['project_id'], postgresql_where=sa.text('project_id IS NOT NULL'))
    op.create_index('idx_activity_log_issue_id', 'activity_log', ['issue_id'], postgresql_where=sa.text('issue_id IS NOT NULL'))
    op.create_index('idx_activity_log_created_at', 'activity_log', ['organization_id', sa.text('created_at DESC')])

    # ==========================================================================
    # Notifications (high volume, high update)
    # ==========================================================================
    op.create_table(
        'notifications',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('type', postgresql.ENUM('issue_assigned', 'issue_mentioned', 'comment_added', 'issue_updated', 'due_date_reminder', 'cycle_started', 'cycle_ending', name='notification_type', create_type=False), nullable=False),
        sa.Column('title', sa.String(255), nullable=False),
        sa.Column('body', sa.Text()),
        sa.Column('issue_id', postgresql.UUID(as_uuid=True)),
        sa.Column('comment_id', postgresql.UUID(as_uuid=True)),
        sa.Column('actor_id', postgresql.UUID(as_uuid=True)),
        sa.Column('url', sa.Text()),
        sa.Column('read_at', sa.DateTime(timezone=True)),
        sa.Column('archived_at', sa.DateTime(timezone=True)),
        sa.Column('email_sent_at', sa.DateTime(timezone=True)),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['issue_id'], ['issues.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['comment_id'], ['comments.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['actor_id'], ['users.id'], ondelete='SET NULL'),
    )
    op.create_index('idx_notifications_user_id', 'notifications', ['user_id'])
    op.create_index('idx_notifications_unread', 'notifications', ['user_id', sa.text('created_at DESC')], postgresql_where=sa.text('read_at IS NULL'))
    op.create_index('idx_notifications_created_at', 'notifications', ['user_id', sa.text('created_at DESC')])

    # ==========================================================================
    # Webhooks
    # ==========================================================================
    op.create_table(
        'webhooks',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('organization_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('url', sa.Text(), nullable=False),
        sa.Column('secret', sa.String(255), nullable=False),
        sa.Column('events', postgresql.ARRAY(sa.Text()), nullable=False, server_default='{}'),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('last_triggered_at', sa.DateTime(timezone=True)),
        sa.Column('success_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('failure_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
    )
    op.create_index('idx_webhooks_organization_id', 'webhooks', ['organization_id'])

    # ==========================================================================
    # API Tokens
    # ==========================================================================
    op.create_table(
        'api_tokens',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text('uuid_generate_v4()')),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('token_hash', sa.String(255), nullable=False),
        sa.Column('token_prefix', sa.String(10), nullable=False),
        sa.Column('scopes', postgresql.ARRAY(sa.Text()), nullable=False, server_default="'{read}'"),
        sa.Column('last_used_at', sa.DateTime(timezone=True)),
        sa.Column('last_used_ip', postgresql.INET()),
        sa.Column('expires_at', sa.DateTime(timezone=True)),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
        sa.Column('revoked_at', sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index('idx_api_tokens_user_id', 'api_tokens', ['user_id'])
    op.create_index('idx_api_tokens_token_hash', 'api_tokens', ['token_hash'])

    # ==========================================================================
    # Triggers
    # ==========================================================================

    # Updated_at triggers
    op.execute("""
        CREATE TRIGGER update_organizations_updated_at
            BEFORE UPDATE ON organizations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)
    op.execute("""
        CREATE TRIGGER update_users_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)
    op.execute("""
        CREATE TRIGGER update_teams_updated_at
            BEFORE UPDATE ON teams
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)
    op.execute("""
        CREATE TRIGGER update_projects_updated_at
            BEFORE UPDATE ON projects
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)
    op.execute("""
        CREATE TRIGGER update_cycles_updated_at
            BEFORE UPDATE ON cycles
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)
    op.execute("""
        CREATE TRIGGER update_issues_updated_at
            BEFORE UPDATE ON issues
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)
    op.execute("""
        CREATE TRIGGER update_comments_updated_at
            BEFORE UPDATE ON comments
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)
    op.execute("""
        CREATE TRIGGER update_webhooks_updated_at
            BEFORE UPDATE ON webhooks
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    """)


def downgrade() -> None:
    # Drop triggers
    op.execute("DROP TRIGGER IF EXISTS update_webhooks_updated_at ON webhooks;")
    op.execute("DROP TRIGGER IF EXISTS update_comments_updated_at ON comments;")
    op.execute("DROP TRIGGER IF EXISTS update_issues_updated_at ON issues;")
    op.execute("DROP TRIGGER IF EXISTS update_cycles_updated_at ON cycles;")
    op.execute("DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;")
    op.execute("DROP TRIGGER IF EXISTS update_teams_updated_at ON teams;")
    op.execute("DROP TRIGGER IF EXISTS update_users_updated_at ON users;")
    op.execute("DROP TRIGGER IF EXISTS update_organizations_updated_at ON organizations;")

    # Drop tables in reverse order
    op.drop_table('api_tokens')
    op.drop_table('webhooks')
    op.drop_table('notifications')
    op.drop_table('activity_log')
    op.drop_table('attachments')
    op.drop_table('comments')
    op.drop_table('issue_links')
    op.drop_table('issue_labels')
    op.drop_table('issues')
    op.drop_table('labels')
    op.drop_table('cycles')
    op.drop_table('projects')
    op.drop_table('team_members')
    op.drop_table('teams')
    op.drop_table('users')
    op.drop_table('organizations')

    # Drop enums
    op.execute("DROP TYPE IF EXISTS notification_type;")
    op.execute("DROP TYPE IF EXISTS activity_action;")
    op.execute("DROP TYPE IF EXISTS link_type;")
    op.execute("DROP TYPE IF EXISTS cycle_status;")
    op.execute("DROP TYPE IF EXISTS team_role;")
    op.execute("DROP TYPE IF EXISTS project_status;")
    op.execute("DROP TYPE IF EXISTS issue_priority;")
    op.execute("DROP TYPE IF EXISTS issue_status;")
    op.execute("DROP TYPE IF EXISTS plan_type;")
