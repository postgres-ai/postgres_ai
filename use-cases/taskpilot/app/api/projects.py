"""
Projects API endpoints.
"""

from datetime import datetime, timezone
from typing import Annotated, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import get_db
from app.api.auth import get_current_user

router = APIRouter()


class ProjectResponse(BaseModel):
    """Project response model."""
    id: UUID
    name: str
    key: str
    description: Optional[str] = None
    status: str = "active"
    issue_count: int = 0
    created_at: datetime


class ProjectListResponse(BaseModel):
    """Paginated project list."""
    data: List[ProjectResponse]
    total: int


@router.get("", response_model=ProjectListResponse)
async def list_projects(
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    status: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
) -> ProjectListResponse:
    """List all projects for the current organization."""
    mock_projects = [
        ProjectResponse(
            id=UUID(f"00000000-0000-0000-0000-00000000000{i}"),
            name=f"Project {i}",
            key=f"PRJ{i}",
            description=f"Description for project {i}",
            status="active",
            issue_count=i * 10,
            created_at=datetime.now(timezone.utc),
        )
        for i in range(1, 6)
    ]
    return ProjectListResponse(data=mock_projects, total=5)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: UUID,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ProjectResponse:
    """Get a single project."""
    return ProjectResponse(
        id=project_id,
        name="Sample Project",
        key="SAMP",
        description="A sample project",
        status="active",
        issue_count=100,
        created_at=datetime.now(timezone.utc),
    )


@router.get("/{project_id}/issues")
async def list_project_issues(
    project_id: UUID,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    status: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
):
    """List issues for a project."""
    from app.api.issues import list_issues
    return await list_issues(
        current_user=current_user,
        db=db,
        project_id=project_id,
        status=status,
        limit=limit,
    )
