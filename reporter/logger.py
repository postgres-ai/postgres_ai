import logging
import os
import sys
from typing import Optional


class _DynamicStdoutHandler(logging.Handler):
    """
    Write to the *current* sys.stdout at emit-time.

    This matters for pytest's capture (capsys), which swaps sys.stdout per-test; a
    StreamHandler created at import-time would hold a stale stream reference.
    """

    def emit(self, record: logging.LogRecord) -> None:
        msg = self.format(record)
        stream = sys.stdout
        stream.write(msg + "\n")
        stream.flush()


def get_logger(name: str = "reporter", log_level: Optional[int] = None) -> logging.Logger:
    """
    Return a configured logger for reporter code.

    - Formatter matches the style used in our other repo:
      "%(asctime)s - %(levelname)s - %(message)s"
    - Level defaults to REPORTER_LOG_LEVEL env var (INFO if unset).
    - Uses a dynamic stdout handler to cooperate with pytest capture.
    """
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    if log_level is None:
        level_name = os.environ.get("REPORTER_LOG_LEVEL", "INFO").upper()
        log_level = logging._nameToLevel.get(level_name, logging.INFO)  # type: ignore[attr-defined]

    app_handler = _DynamicStdoutHandler()
    app_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    app_handler.setLevel(log_level)

    logger.setLevel(log_level)
    logger.addHandler(app_handler)
    logger.propagate = False
    return logger


# Default logger used by reporter modules.
logger = get_logger()


