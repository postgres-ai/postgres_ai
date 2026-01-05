"""
TaskPilot API Routes

All API endpoints are organized by resource type.
"""

from fastapi import APIRouter

from app.api import auth, issues, projects, comments, users, analytics

router = APIRouter()

# Include all route modules
router.include_router(auth.router, prefix="/auth", tags=["Authentication"])
router.include_router(users.router, prefix="/users", tags=["Users"])
router.include_router(projects.router, prefix="/projects", tags=["Projects"])
router.include_router(issues.router, prefix="/issues", tags=["Issues"])
router.include_router(comments.router, prefix="/issues/{issue_id}/comments", tags=["Comments"])
router.include_router(analytics.router, prefix="/analytics", tags=["Analytics"])


@router.get("/")
async def api_root():
    """API root endpoint."""
    return {
        "message": "TaskPilot API v1",
        "endpoints": {
            "auth": "/api/v1/auth",
            "users": "/api/v1/users",
            "projects": "/api/v1/projects",
            "issues": "/api/v1/issues",
            "analytics": "/api/v1/analytics",
        }
    }
