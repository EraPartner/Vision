"""
Logging configuration for the Financial Transaction Manager

Provides structured logging with appropriate formatting for different environments.
"""
import json
import logging
from datetime import datetime
from typing import Any, Dict


class JSONFormatter(logging.Formatter):
    """
    JSON formatter for structured logging in production.
    Useful for log aggregation and analysis.
    """

    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON"""
        log_obj: Dict[str, Any] = {
            "timestamp": datetime.now().isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Add exception info if present
        if record.exc_info:
            log_obj["exception"] = self.formatException(record.exc_info)

        # Add extra fields
        if hasattr(record, "user_id"):
            log_obj["user_id"] = record.user_id
        if hasattr(record, "request_id"):
            log_obj["request_id"] = record.request_id

        return json.dumps(log_obj)


class SimpleFormatter(logging.Formatter):
    """
    Simple formatter for development logging.
    More readable for humans.
    """

    def format(self, record: logging.LogRecord) -> str:
        """Format log record with color and structure"""
        timestamp = datetime.fromtimestamp(record.created).strftime("%Y-%m-%d %H:%M:%S")
        return f"[{timestamp}] {record.levelname:8s} {record.name}: {record.getMessage()}"


def setup_logging(
        name: str,
        level: int = logging.INFO,
        use_json: bool = False
) -> logging.Logger:
    """
    Setup and return a logger instance

    Args:
        name: Logger name (usually __name__)
        level: Logging level
        use_json: Use JSON formatter instead of simple formatter

    Returns:
        Configured logger instance
    """
    logger = logging.getLogger(name)
    logger.setLevel(level)

    # Avoid adding handlers multiple times
    if logger.handlers:
        return logger

    # Console handler
    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)

    # Choose formatter
    formatter = JSONFormatter() if use_json else SimpleFormatter()
    console_handler.setFormatter(formatter)

    logger.addHandler(console_handler)

    return logger


# Module-level logger
logger = setup_logging(__name__)
