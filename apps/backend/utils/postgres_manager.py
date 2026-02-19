"""
PostgreSQL Server Management Utility

Manages the lifecycle of the local PostgreSQL server for development and testing.
Integrates with existing shell scripts for setup, start, and stop operations.
"""
import asyncio
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class PostgresManager:
    """
    Manages local PostgreSQL server lifecycle.

    This manager handles:
    - Detection of PostgreSQL data directory
    - Automatic setup if not initialized
    - Server startup with comprehensive error handling
    - Server shutdown with graceful termination
    - Audit logging for all operations
    """

    def __init__(self, backend_dir: Optional[Path] = None):
        """
        Initialise PostgreSQL manager.

        Args:
            backend_dir: Path to backend directory. If None, uses current file's parent.
        """
        if backend_dir is None:
            # Default to backend directory (parent of utils)
            backend_dir = Path(__file__).parent.parent

        self.backend_dir = backend_dir
        self.postgres_data_dir = backend_dir / "postgres_data"
        self.utils_dir = backend_dir / "utils"
        self.setup_script = self.utils_dir / "setup_local_postgres.sh"
        self.start_script = self.utils_dir / "start_postgres.sh"
        self.stop_script = self.utils_dir / "stop_postgres.sh"

    def is_initialized(self) -> bool:
        """
        Check if PostgreSQL data directory is initialized.

        Returns:
            bool: True if postgres_data/base directory exists
        """
        base_dir = self.postgres_data_dir / "base"
        initialized = base_dir.exists() and base_dir.is_dir()

        logger.debug(
            f"PostgreSQL initialization check: {initialized}",
            extra={
                "operation": "postgres_init_check",
                "resource_type": "database",
                "data_dir": str(self.postgres_data_dir),
                "initialized": initialized
            }
        )

        return initialized

    async def setup(self) -> bool:
        """
        Run PostgreSQL setup script to initialize data directory.

        This is an interactive process that may prompt for configuration.

        Returns:
            bool: True if setup succeeded

        Raises:
            RuntimeError: If setup script fails
        """
        if not self.setup_script.exists():
            error_msg = f"Setup script not found: {self.setup_script}"
            logger.error(
                error_msg,
                extra={
                    "operation": "postgres_setup",
                    "resource_type": "database",
                    "status": "failed",
                    "error_type": "FileNotFoundError"
                }
            )
            raise RuntimeError(error_msg)

        logger.info(
            "Running PostgreSQL setup script",
            extra={
                "operation": "postgres_setup",
                "resource_type": "database",
                "script": str(self.setup_script)
            }
        )

        try:
            # Run setup script (this may be interactive)
            process = await asyncio.create_subprocess_exec(
                str(self.setup_script),
                cwd=str(self.backend_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await process.communicate()

            if process.returncode == 0:
                logger.info(
                    "PostgreSQL setup completed successfully",
                    extra={
                        "operation": "postgres_setup",
                        "resource_type": "database",
                        "status": "success"
                    }
                )
                return True
            else:
                error_msg = f"Setup script failed with exit code {process.returncode}"
                logger.error(
                    error_msg,
                    extra={
                        "operation": "postgres_setup",
                        "resource_type": "database",
                        "status": "failed",
                        "exit_code": process.returncode,
                        "stderr": stderr.decode() if stderr else ""
                    }
                )
                raise RuntimeError(f"{error_msg}\n{stderr.decode() if stderr else ''}")

        except Exception as e:
            logger.error(
                "Failed to run PostgreSQL setup script",
                extra={
                    "operation": "postgres_setup",
                    "resource_type": "database",
                    "status": "failed",
                    "error_type": type(e).__name__
                },
                exc_info=True
            )
            raise RuntimeError(f"PostgreSQL setup failed: {str(e)}") from e

    async def start(self) -> bool:
        """
        Start PostgreSQL server using the start script.

        Returns:
            bool: True if server started successfully

        Raises:
            RuntimeError: If start script fails
        """
        if not self.start_script.exists():
            error_msg = f"Start script not found: {self.start_script}"
            logger.error(
                error_msg,
                extra={
                    "operation": "postgres_start",
                    "resource_type": "database",
                    "status": "failed",
                    "error_type": "FileNotFoundError"
                }
            )
            raise RuntimeError(error_msg)

        logger.info(
            "Starting PostgreSQL server",
            extra={
                "operation": "postgres_start",
                "resource_type": "database",
                "script": str(self.start_script)
            }
        )

        try:
            process = await asyncio.create_subprocess_exec(
                str(self.start_script),
                cwd=str(self.backend_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await process.communicate()

            if process.returncode == 0:
                logger.info(
                    "PostgreSQL server started successfully",
                    extra={
                        "operation": "postgres_start",
                        "resource_type": "database",
                        "status": "success",
                        "output": stdout.decode() if stdout else ""
                    }
                )
                return True
            else:
                # Check if already running (which is acceptable)
                output = stdout.decode() if stdout else ""
                if "already running" in output.lower():
                    logger.info(
                        "PostgreSQL server is already running",
                        extra={
                            "operation": "postgres_start",
                            "resource_type": "database",
                            "status": "already_running"
                        }
                    )
                    return True

                error_msg = f"Start script failed with exit code {process.returncode}"
                logger.error(
                    error_msg,
                    extra={
                        "operation": "postgres_start",
                        "resource_type": "database",
                        "status": "failed",
                        "exit_code": process.returncode,
                        "stderr": stderr.decode() if stderr else ""
                    }
                )
                raise RuntimeError(f"{error_msg}\n{stderr.decode() if stderr else ''}")

        except Exception as e:
            logger.error(
                "Failed to start PostgreSQL server",
                extra={
                    "operation": "postgres_start",
                    "resource_type": "database",
                    "status": "failed",
                    "error_type": type(e).__name__
                },
                exc_info=True
            )
            raise RuntimeError(f"PostgreSQL start failed: {str(e)}") from e

    async def stop(self) -> bool:
        """
        Stop PostgreSQL server using the stop script.

        Returns:
            bool: True if server stopped successfully

        Raises:
            RuntimeError: If stop script fails
        """
        if not self.stop_script.exists():
            error_msg = f"Stop script not found: {self.stop_script}"
            logger.error(
                error_msg,
                extra={
                    "operation": "postgres_stop",
                    "resource_type": "database",
                    "status": "failed",
                    "error_type": "FileNotFoundError"
                }
            )
            raise RuntimeError(error_msg)

        logger.info(
            "Stopping PostgreSQL server",
            extra={
                "operation": "postgres_stop",
                "resource_type": "database",
                "script": str(self.stop_script)
            }
        )

        try:
            process = await asyncio.create_subprocess_exec(
                str(self.stop_script),
                cwd=str(self.backend_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await process.communicate()

            if process.returncode == 0:
                logger.info(
                    "PostgreSQL server stopped successfully",
                    extra={
                        "operation": "postgres_stop",
                        "resource_type": "database",
                        "status": "success",
                        "output": stdout.decode() if stdout else ""
                    }
                )
                return True
            else:
                # Check if not running (which is acceptable)
                output = stdout.decode() if stdout else ""
                if "not running" in output.lower():
                    logger.info(
                        "PostgreSQL server was not running",
                        extra={
                            "operation": "postgres_stop",
                            "resource_type": "database",
                            "status": "not_running"
                        }
                    )
                    return True

                error_msg = f"Stop script failed with exit code {process.returncode}"
                logger.error(
                    error_msg,
                    extra={
                        "operation": "postgres_stop",
                        "resource_type": "database",
                        "status": "failed",
                        "exit_code": process.returncode,
                        "stderr": stderr.decode() if stderr else ""
                    }
                )
                raise RuntimeError(f"{error_msg}\n{stderr.decode() if stderr else ''}")

        except Exception as e:
            logger.error(
                "Failed to stop PostgreSQL server",
                extra={
                    "operation": "postgres_stop",
                    "resource_type": "database",
                    "status": "failed",
                    "error_type": type(e).__name__
                },
                exc_info=True
            )
            raise RuntimeError(f"PostgreSQL stop failed: {str(e)}") from e

    async def ensure_running(self) -> None:
        """
        Ensure PostgreSQL server is running, setting up if necessary.

        This is the primary method to call during application startup.

        Raises:
            RuntimeError: If setup or start operations fail
        """
        if not self.is_initialized():
            logger.warning(
                "PostgreSQL not initialized, running setup",
                extra={
                    "operation": "postgres_ensure_running",
                    "resource_type": "database",
                    "status": "initializing"
                }
            )
            await self.setup()

        await self.start()
