"""
Issues API endpoints.
"""

from datetime import datetime, timezone
from typing import Annotated, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.database import get_db
from app.api.auth import get_current_user

router = APIRouter()


# Pydantic models
class IssueBase(BaseModel):
    """Base issue model."""
    title: str = Field(..., min_length=1, max_length=500)
    description: Optional[str] = None
    status: str = "backlog"
    priority: str = "none"
    estimate: Optional[float] = None
    due_date: Optional[str] = None


class IssueCreate(IssueBase):
    """Issue creation model."""
    project_id: UUID


class IssueUpdate(BaseModel):
    """Issue update model."""
    title: Optional[str] = Field(None, min_length=1, max_length=500)
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    estimate: Optional[float] = None
    due_date: Optional[str] = None
    assignee_id: Optional[UUID] = None


class IssueResponse(IssueBase):
    """Issue response model."""
    id: UUID
    project_id: UUID
    number: int
    creator_id: UUID
    assignee_id: Optional[UUID] = None
    comment_count: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class IssueListResponse(BaseModel):
    """Paginated issue list response."""
    data: List[IssueResponse]
    total: int
    page: int
    page_size: int
    has_more: bool


@router.get("", response_model=IssueListResponse)
async def list_issues(
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    project_id: Optional[UUID] = None,
    status: Optional[str] = None,
    priority: Optional[str] = None,
    assignee_id: Optional[UUID] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
) -> IssueListResponse:
    """
    List issues with filtering and pagination.

    This is a high-frequency query that benefits from proper indexing.
    """
    # Build query filters
    # In production, this would query the issues table
    # For demo, return mock data

    mock_issues = [
        IssueResponse(
            id=UUID("00000000-0000-0000-0000-000000000001"),
            project_id=project_id or UUID("00000000-0000-0000-0000-000000000001"),
            number=i,
            title=f"Sample Issue {i}",
            description="This is a sample issue for demo purposes.",
            status=status or "backlog",
            priority=priority or "medium",
            creator_id=UUID("00000000-0000-0000-0000-000000000001"),
            assignee_id=assignee_id,
            comment_count=i % 10,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        for i in range(1, min(limit + 1, 21))
    ]

    return IssueListResponse(
        data=mock_issues,
        total=100,
        page=page,
        page_size=limit,
        has_more=page * limit < 100,
    )


@router.post("", response_model=IssueResponse, status_code=status.HTTP_201_CREATED)
async def create_issue(
    issue: IssueCreate,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> IssueResponse:
    """
    Create a new issue.

    This triggers:
    - Issue insert
    - Activity log insert
    - Notification inserts for project watchers
    """
    # In production, insert into database
    # For demo, return mock data

    return IssueResponse(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        project_id=issue.project_id,
        number=1,
        title=issue.title,
        description=issue.description,
        status=issue.status,
        priority=issue.priority,
        estimate=issue.estimate,
        due_date=issue.due_date,
        creator_id=UUID("00000000-0000-0000-0000-000000000001"),
        comment_count=0,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


@router.get("/{issue_id}", response_model=IssueResponse)
async def get_issue(
    issue_id: UUID,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> IssueResponse:
    """
    Get a single issue by ID.
    """
    return IssueResponse(
        id=issue_id,
        project_id=UUID("00000000-0000-0000-0000-000000000001"),
        number=1,
        title="Sample Issue",
        description="This is a sample issue.",
        status="in_progress",
        priority="high",
        creator_id=UUID("00000000-0000-0000-0000-000000000001"),
        comment_count=5,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


@router.patch("/{issue_id}", response_model=IssueResponse)
async def update_issue(
    issue_id: UUID,
    issue_update: IssueUpdate,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> IssueResponse:
    """
    Update an issue.

    This is a high-frequency operation that causes bloat due to frequent
    status changes. The issues table needs regular vacuuming.
    """
    return IssueResponse(
        id=issue_id,
        project_id=UUID("00000000-0000-0000-0000-000000000001"),
        number=1,
        title=issue_update.title or "Updated Issue",
        description=issue_update.description,
        status=issue_update.status or "in_progress",
        priority=issue_update.priority or "high",
        estimate=issue_update.estimate,
        due_date=issue_update.due_date,
        creator_id=UUID("00000000-0000-0000-0000-000000000001"),
        assignee_id=issue_update.assignee_id,
        comment_count=5,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


@router.delete("/{issue_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_issue(
    issue_id: UUID,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    """
    Delete an issue (soft delete).
    """
    # In production, set archived_at = NOW()
    pass


@router.get("/{issue_id}/activity")
async def get_issue_activity(
    issue_id: UUID,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
):
    """
    Get activity log for an issue.

    This queries the high-volume activity_log table.
    """
    return {
        "data": [
            {
                "id": "00000000-0000-0000-0000-000000000001",
                "action": "status_changed",
                "changes": {"field": "status", "old": "todo", "new": "in_progress"},
                "user_name": "Demo User",
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        ],
        "total": 1,
        "page": page,
        "page_size": limit,
    }
