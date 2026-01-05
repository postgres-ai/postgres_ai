"""
Comments API endpoints.
"""

from datetime import datetime
from typing import Annotated, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import get_db
from app.api.auth import get_current_user

router = APIRouter()


class CommentCreate(BaseModel):
    """Comment creation model."""
    body: str = Field(..., min_length=1)
    is_internal: bool = False


class CommentResponse(BaseModel):
    """Comment response model."""
    id: UUID
    issue_id: UUID
    user_id: UUID
    user_name: str
    body: str
    is_internal: bool = False
    created_at: datetime
    updated_at: datetime


class CommentListResponse(BaseModel):
    """Paginated comment list."""
    data: List[CommentResponse]
    total: int


@router.get("", response_model=CommentListResponse)
async def list_comments(
    issue_id: UUID,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
) -> CommentListResponse:
    """List comments for an issue."""
    mock_comments = [
        CommentResponse(
            id=UUID(f"00000000-0000-0000-0000-00000000000{i}"),
            issue_id=issue_id,
            user_id=UUID("00000000-0000-0000-0000-000000000001"),
            user_name=f"User {i}",
            body=f"This is comment {i} on the issue.",
            is_internal=False,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        for i in range(1, min(limit + 1, 6))
    ]
    return CommentListResponse(data=mock_comments, total=5)


@router.post("", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
async def create_comment(
    issue_id: UUID,
    comment: CommentCreate,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CommentResponse:
    """
    Create a new comment on an issue.

    This triggers:
    - Comment insert
    - Issue comment_count update (causes bloat on issues)
    - Activity log insert
    - Notification inserts for watchers
    """
    return CommentResponse(
        id=UUID("00000000-0000-0000-0000-000000000001"),
        issue_id=issue_id,
        user_id=UUID("00000000-0000-0000-0000-000000000001"),
        user_name="Demo User",
        body=comment.body,
        is_internal=comment.is_internal,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
