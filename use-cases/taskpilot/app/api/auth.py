"""
Authentication API endpoints.

Provides JWT-based authentication for TaskPilot API.
Supports both form-based login (OAuth2) and JSON login for programmatic access.
"""

import os
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.database import get_db

router = APIRouter()

# Password hashing with bcrypt (secure)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# OAuth2 scheme
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

# Demo mode flag - only enable in development with explicit flag
DEMO_MODE = os.getenv("TASKPILOT_DEMO_MODE", "false").lower() == "true"
DEMO_PASSWORD = os.getenv("TASKPILOT_DEMO_PASSWORD", "")


class Token(BaseModel):
    """JWT token response."""
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class TokenData(BaseModel):
    """Token payload data."""
    user_id: str | None = None
    email: str | None = None


class LoginRequest(BaseModel):
    """Login request body."""
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    """User response model."""
    id: str
    email: str
    name: str
    organization_id: str


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash."""
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """Hash a password."""
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=15))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


async def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Get the current authenticated user from JWT token."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
        )
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    # Return user data from token (in production, fetch from DB)
    return {
        "id": user_id,
        "email": payload.get("email"),
        "organization_id": payload.get("org_id"),
    }


@router.post("/login", response_model=Token)
async def login(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Token:
    """
    Login with email and password.

    In demo mode (TASKPILOT_DEMO_MODE=true), accepts configured demo password.
    In production, validates against database with bcrypt.
    """
    authenticated = False
    user_id = "demo-user-id"
    org_id = "demo-org-id"

    if DEMO_MODE and DEMO_PASSWORD:
        # Demo mode - validate against environment variable password
        authenticated = form_data.password == DEMO_PASSWORD
    else:
        # Production mode - validate against database
        # TODO: Implement database user lookup
        # user = await get_user_by_email(db, form_data.username)
        # if user and verify_password(form_data.password, user.password_hash):
        #     authenticated = True
        #     user_id = str(user.id)
        #     org_id = str(user.organization_id)
        pass

    if not authenticated:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Create access token
    access_token_expires = timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={
            "sub": user_id,
            "email": form_data.username,
            "org_id": org_id,
        },
        expires_delta=access_token_expires,
    )

    return Token(
        access_token=access_token,
        expires_in=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/login/json", response_model=Token)
async def login_json(
    request: LoginRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Token:
    """
    Login with JSON body (for k6 testing and programmatic access).

    In demo mode (TASKPILOT_DEMO_MODE=true), accepts configured demo password.
    """
    authenticated = False
    user_id = "demo-user-id"
    org_id = "demo-org-id"

    if DEMO_MODE and DEMO_PASSWORD:
        authenticated = request.password == DEMO_PASSWORD
    else:
        # Production mode - validate against database
        pass

    if not authenticated:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )

    access_token_expires = timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={
            "sub": user_id,
            "email": request.email,
            "org_id": org_id,
        },
        expires_delta=access_token_expires,
    )

    return Token(
        access_token=access_token,
        expires_in=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    current_user: Annotated[dict, Depends(get_current_user)],
) -> UserResponse:
    """Get current user information."""
    return UserResponse(
        id=current_user["id"],
        email=current_user["email"],
        name="Demo User",
        organization_id=current_user["organization_id"],
    )
