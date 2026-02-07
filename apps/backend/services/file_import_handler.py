"""
File Import Handler Service

Service for managing file I/O operations during import.
Handles temporary file creation, cleanup, and file operations.
Separates infrastructure concerns from business logic.
"""
import os
import tempfile
from typing import Optional, Tuple


class FileImportHandler:
    """Handler for file operations during import process"""

    @staticmethod
    def save_upload_to_temp(file_content: bytes, file_extension: str = ".csv") -> str:
        """
        Save uploaded file content to temporary file.

        Args:
            file_content: The file content as bytes
            file_extension: The file extension (default: .csv)

        Returns:
            Path to the temporary file

        Raises:
            IOError: If file cannot be written
        """
        if not file_extension.startswith('.'):
            file_extension = '.' + file_extension

        try:
            with tempfile.NamedTemporaryFile(
                    delete=False,
                    suffix=file_extension,
                    mode='wb'
            ) as tmp_file:
                tmp_file.write(file_content)
                return tmp_file.name
        except IOError as e:
            raise IOError(f"Failed to create temporary file: {str(e)}")

    @staticmethod
    def cleanup_temp_file(file_path: str) -> bool:
        """
        Clean up temporary file.

        Args:
            file_path: Path to the temporary file

        Returns:
            True if successfully deleted or file doesn't exist, False on error
        """
        try:
            if os.path.exists(file_path):
                os.unlink(file_path)
            return True
        except OSError as e:
            print(f"Warning: Failed to delete temporary file {file_path}: {str(e)}")
            return False

    @staticmethod
    def validate_csv_file(filename: str) -> bool:
        """
        Validate that file is a CSV file.

        Args:
            filename: The filename to validate

        Returns:
            True if file is CSV, False otherwise
        """
        if not filename:
            return False
        return filename.lower().endswith('.csv')

    @staticmethod
    def validate_file_size(file_size: int, max_size_mb: int = 50) -> Tuple[bool, Optional[str]]:
        """
        Validate file size.

        Args:
            file_size: Size of file in bytes
            max_size_mb: Maximum allowed file size in MB (default: 50)

        Returns:
            Tuple of (is_valid, error_message)
        """
        max_size_bytes = max_size_mb * 1024 * 1024

        if file_size > max_size_bytes:
            return False, f"File size exceeds maximum of {max_size_mb}MB"

        if file_size == 0:
            return False, "File is empty"

        return True, None
