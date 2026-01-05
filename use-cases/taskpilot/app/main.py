"""
TaskPilot API - Main FastAPI Application

A Linear/Jira clone designed as a playground for postgres_ai monitoring.
"""

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
import orjson

from app.config import settings
from app.api import router as api_router
from app.models.database import engine, async_session


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup
    print(f"🚀 TaskPilot starting in {settings.APP_ENV} mode")
    print(f"📊 Database: {settings.DATABASE_URL.split('@')[1] if '@' in settings.DATABASE_URL else 'local'}")

    yield

    # Shutdown
    print("👋 TaskPilot shutting down")
    await engine.dispose()


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="TaskPilot API",
        description="A Linear clone for Self-Driving Postgres testing",
        version="0.1.0",
        docs_url="/docs" if settings.DEBUG else None,
        redoc_url="/redoc" if settings.DEBUG else None,
        default_response_class=ORJSONResponse,
        lifespan=lifespan,
    )

    # CORS middleware - restrict origins even in development
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.ALLOWED_ORIGINS,  # Always use explicit origins
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    )

    # Request timing middleware
    @app.middleware("http")
    async def add_process_time_header(request: Request, call_next):
        start_time = datetime.now(timezone.utc)
        response = await call_next(request)
        process_time = (datetime.now(timezone.utc) - start_time).total_seconds() * 1000
        response.headers["X-Process-Time"] = f"{process_time:.2f}ms"
        return response

    # Global exception handler - return generic errors in production
    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        if settings.is_development:
            # In development, include error details
            return ORJSONResponse(
                status_code=500,
                content={"detail": str(exc), "type": type(exc).__name__},
            )
        # In production, return generic error
        return ORJSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
        )

    # Include API routes
    app.include_router(api_router, prefix="/api/v1")

    # Health check endpoint
    @app.get("/health")
    async def health_check() -> dict[str, Any]:
        """Health check endpoint for monitoring."""
        return {
            "status": "healthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "version": "0.1.0",
            "environment": settings.APP_ENV,
        }

    # Root endpoint
    @app.get("/")
    async def root() -> dict[str, str]:
        """Root endpoint."""
        return {
            "name": "TaskPilot API",
            "version": "0.1.0",
            "docs": "/docs",
        }

    return app


# Create application instance
app = create_app()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.DEBUG,
    )
