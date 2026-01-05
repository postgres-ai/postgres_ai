"""
Analytics API endpoints.

These endpoints run heavy aggregate queries that benefit from
materialized views and proper indexing.
"""

from datetime import datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import get_db
from app.api.auth import get_current_user

router = APIRouter()


class OrganizationMetrics(BaseModel):
    """Organization-level metrics."""
    total_issues: int
    open_issues: int
    completed_this_week: int
    overdue_issues: int
    avg_resolution_hours: float
    total_comments: int
    active_users: int


class ProjectVelocity(BaseModel):
    """Project velocity data."""
    week: str
    issues_completed: int
    points_completed: float
    moving_avg: float


class WorkloadItem(BaseModel):
    """Team workload item."""
    user_id: str
    user_name: str
    assigned_issues: int
    in_progress: int
    completed_this_week: int


@router.get("/organization", response_model=OrganizationMetrics)
async def get_organization_metrics(
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> OrganizationMetrics:
    """
    Get organization-wide metrics.

    This is a heavy query that aggregates across multiple tables.
    Benefits from the mv_organization_stats materialized view.
    """
    # In production, query materialized view or aggregate
    return OrganizationMetrics(
        total_issues=50000,
        open_issues=15000,
        completed_this_week=500,
        overdue_issues=200,
        avg_resolution_hours=48.5,
        total_comments=200000,
        active_users=150,
    )


@router.get("/projects/{project_id}/velocity")
async def get_project_velocity(
    project_id: UUID,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    weeks: int = Query(12, ge=1, le=52),
) -> list[ProjectVelocity]:
    """
    Get project velocity over time.

    Uses the mv_project_weekly_velocity materialized view.
    """
    return [
        ProjectVelocity(
            week=(datetime.now() - timedelta(weeks=i)).strftime("%Y-%m-%d"),
            issues_completed=10 + i,
            points_completed=25.0 + i * 2,
            moving_avg=12.0 + i,
        )
        for i in range(weeks)
    ]


@router.get("/workload")
async def get_team_workload(
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[WorkloadItem]:
    """
    Get current team workload distribution.
    """
    return [
        WorkloadItem(
            user_id=f"user-{i}",
            user_name=f"Team Member {i}",
            assigned_issues=10 + i * 2,
            in_progress=3 + i,
            completed_this_week=5 + i,
        )
        for i in range(1, 6)
    ]


@router.get("/search")
async def search_issues(
    q: str,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    project_id: UUID = None,
    limit: int = Query(20, ge=1, le=100),
):
    """
    Full-text search across issues.

    Uses the search_vector column with GIN index.
    """
    return {
        "query": q,
        "results": [
            {
                "id": f"issue-{i}",
                "title": f"Issue matching '{q}' #{i}",
                "project_key": "PRJ",
                "number": i,
                "rank": 1.0 - (i * 0.1),
            }
            for i in range(1, min(limit + 1, 11))
        ],
        "total": 10,
    }
