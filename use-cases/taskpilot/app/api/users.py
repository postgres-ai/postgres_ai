"""
Users API endpoints.
"""

from datetime import datetime
from typing import Annotated, List
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import get_db
from app.api.auth import get_current_user

router = APIRouter()


class UserResponse(BaseModel):
    """User response model."""
    id: UUID
    email: str
    name: str
    username: str
    avatar_url: str | None = None
    is_active: bool = True
    created_at: datetime


@router.get("", response_model=List[UserResponse])
async def list_users(
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(20, ge=1, le=100),
) -> List[UserResponse]:
    """List users in the organization."""
    return [
        UserResponse(
            id=UUID(f"00000000-0000-0000-0000-00000000000{i}"),
            email=f"user{i}@example.com",
            name=f"User {i}",
            username=f"user{i}",
            is_active=True,
            created_at=datetime.now(),
        )
        for i in range(1, 6)
    ]


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: UUID,
    current_user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> UserResponse:
    """Get a user by ID."""
    return UserResponse(
        id=user_id,
        email="user@example.com",
        name="Sample User",
        username="sampleuser",
        is_active=True,
        created_at=datetime.now(),
    )
