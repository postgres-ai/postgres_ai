"""
TaskPilot Configuration

Environment-based configuration using Pydantic Settings.
"""

from typing import List, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
    )

    # Application
    APP_ENV: str = "development"
    DEBUG: bool = True
    SECRET_KEY: str = "taskpilot-dev-secret-key-change-in-production"

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://taskpilot:taskpilot@localhost:5433/taskpilot"
    DATABASE_POOL_SIZE: int = 20
    DATABASE_MAX_OVERFLOW: int = 10
    DATABASE_POOL_TIMEOUT: int = 30

    # Redis
    REDIS_URL: str = "redis://localhost:6380/0"

    # CORS
    ALLOWED_ORIGINS: List[str] = ["http://localhost:3000", "http://localhost:8000"]

    # JWT
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # Pagination
    DEFAULT_PAGE_SIZE: int = 20
    MAX_PAGE_SIZE: int = 100

    # File uploads
    MAX_UPLOAD_SIZE: int = 10 * 1024 * 1024  # 10 MB
    UPLOAD_DIR: str = "uploads"

    # Feature flags
    ENABLE_WEBHOOKS: bool = True
    ENABLE_NOTIFICATIONS: bool = True
    ENABLE_ANALYTICS: bool = True


# Create global settings instance
settings = Settings()
