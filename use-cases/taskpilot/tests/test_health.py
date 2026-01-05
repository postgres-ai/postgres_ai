"""
Health Check Tests

Tests for the health check endpoint.
"""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    """Test that health check endpoint returns healthy status."""
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert "timestamp" in data
    assert "version" in data


@pytest.mark.asyncio
async def test_root_endpoint(client: AsyncClient):
    """Test that root endpoint returns API info."""
    response = await client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "TaskPilot API"
    assert "version" in data


@pytest.mark.asyncio
async def test_api_root(client: AsyncClient):
    """Test that API root returns endpoint list."""
    response = await client.get("/api/v1/")
    assert response.status_code == 200
    data = response.json()
    assert "endpoints" in data
    assert "issues" in data["endpoints"]
    assert "projects" in data["endpoints"]
