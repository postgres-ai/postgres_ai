"""
PostgresAI Express Checkup - Python SDK

Install:
    pip install postgresai-checkup

Or with extras:
    pip install postgresai-checkup[psycopg2]
    pip install postgresai-checkup[psycopg3]
"""

from setuptools import setup, find_packages

setup(
    name="postgresai-checkup",
    version="0.1.0",
    description="PostgreSQL health checks - unused indexes, bloat, and more",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="PostgresAI",
    author_email="team@postgres.ai",
    url="https://github.com/postgres-ai/postgresai",
    packages=find_packages(),
    python_requires=">=3.8",
    install_requires=[],
    extras_require={
        "psycopg2": ["psycopg2-binary>=2.9"],
        "psycopg3": ["psycopg[binary]>=3.0"],
        "django": ["django>=3.2"],
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Database",
        "Framework :: Django",
    ],
    entry_points={
        "console_scripts": [
            "pgai-checkup=postgresai_checkup.cli:main",
        ],
    },
)
