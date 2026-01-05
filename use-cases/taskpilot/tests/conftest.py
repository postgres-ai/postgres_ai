"""
TaskPilot Test Configuration

Provides fixtures for testing the TaskPilot API.
"""

import os
import pytest
from typing import AsyncGenerator
from httpx import AsyncClient, ASGITransport

# Set test environment before importing app
os.environ["APP_ENV"] = "test"
os.environ["DEBUG"] = "true"
os.environ["SECRET_KEY"] = "test-secret-key-for-testing-only"
os.environ["TASKPILOT_DEMO_MODE"] = "true"
os.environ["TASKPILOT_DEMO_PASSWORD"] = "test-password"
os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@localhost:5433/taskpilot_test"

from app.main import app


@pytest.fixture
def anyio_backend():
    """Use asyncio for async tests."""
    return "asyncio"


@pytest.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    """Create async test client."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
async def authenticated_client(client: AsyncClient) -> AsyncClient:
    """Create authenticated test client with JWT token."""
    # Login to get token
    response = await client.post(
        "/api/v1/auth/login",
        data={"username": "test@example.com", "password": "test-password"},
    )
    if response.status_code == 200:
        token = response.json()["access_token"]
        client.headers["Authorization"] = f"Bearer {token}"
    return client


@pytest.fixture
def sample_issue_data():
    """Sample issue creation data."""
    return {
        "project_id": "00000000-0000-0000-0000-000000000001",
        "title": "Test Issue",
        "description": "This is a test issue",
        "priority": "medium",
        "status": "backlog",
    }


@pytest.fixture
def sample_project_data():
    """Sample project data."""
    return {
        "name": "Test Project",
        "key": "TEST",
        "description": "A test project",
    }
