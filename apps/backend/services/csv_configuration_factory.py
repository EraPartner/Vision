"""
CSV Configuration Factory

Factory for creating and validating CSV import configurations.
This is the Information Expert for configuration construction and validation.
"""
from typing import Dict, Any, Optional


class CSVConfigurationError(Exception):
    """Exception raised for invalid CSV configuration"""
    pass


class CSVConfigurationFactory:
    """Factory for creating and validating CSV import configurations"""

    # Default configuration
    DEFAULT_CONFIG = {
        "encoding": "utf-8",
        "separator": ",",
        "skip_rows": 0,
    }

    @staticmethod
    def create_custom_config(
            bank_name: str,
            date_format: str,
            date_column: str,
            recipient_column: str,
            amount_column: str,
            memo_column: Optional[str] = None,
            separator: str = ",",
            encoding: str = "utf-8",
            skip_rows: int = 0
    ) -> Dict[str, Any]:
        """
        Create and validate a custom CSV configuration.

        Args:
            bank_name: Name of the bank
            date_format: Date format string (e.g., '%m/%d/%Y')
            date_column: Column name for date
            recipient_column: Column name for recipient
            amount_column: Column name for amount
            memo_column: Optional column name for memo
            separator: CSV separator character
            encoding: File encoding
            skip_rows: Number of rows to skip

        Returns:
            Validated configuration dictionary

        Raises:
            CSVConfigurationError: If configuration is invalid
        """
        # Validate required parameters
        if not bank_name or not bank_name.strip():
            raise CSVConfigurationError("bank_name is required")

        if not date_format or not date_format.strip():
            raise CSVConfigurationError("date_format is required")

        if not date_column or not date_column.strip():
            raise CSVConfigurationError("date_column is required")

        if not recipient_column or not recipient_column.strip():
            raise CSVConfigurationError("recipient_column is required")

        if not amount_column or not amount_column.strip():
            raise CSVConfigurationError("amount_column is required")

        # Validate separator
        if not separator or len(separator) > 1:
            raise CSVConfigurationError("separator must be a single character")

        # Validate encoding
        try:
            "test".encode(encoding)
        except LookupError:
            raise CSVConfigurationError(f"Invalid encoding: {encoding}")

        # Validate skip_rows
        if skip_rows < 0:
            raise CSVConfigurationError("skip_rows must be non-negative")

        # Build configuration
        config = {
            "bank_name": bank_name.strip(),
            "encoding": encoding,
            "separator": separator,
            "skip_rows": skip_rows,
            "date_format": date_format.strip(),
            "column_mapping": {
                "date": date_column.strip(),
                "recipient": recipient_column.strip(),
                "amount": amount_column.strip(),
                "memo": memo_column.strip() if memo_column else ""
            }
        }

        return config

    @staticmethod
    def validate_config(config: Dict[str, Any]) -> bool:
        """
        Validate a configuration dictionary.

        Args:
            config: Configuration to validate

        Returns:
            True if valid

        Raises:
            CSVConfigurationError: If configuration is invalid
        """
        if not isinstance(config, dict):
            raise CSVConfigurationError("Configuration must be a dictionary")

        required_keys = ["bank_name", "date_format", "column_mapping"]
        for key in required_keys:
            if key not in config:
                raise CSVConfigurationError(f"Missing required key: {key}")

        if not isinstance(config.get("column_mapping"), dict):
            raise CSVConfigurationError("column_mapping must be a dictionary")

        required_columns = ["date", "recipient", "amount"]
        for col in required_columns:
            if col not in config["column_mapping"]:
                raise CSVConfigurationError(f"Missing required column mapping: {col}")

        return True

    @staticmethod
    def get_default_config(bank_name: str) -> Dict[str, Any]:
        """
        Get default configuration with bank name.

        Args:
            bank_name: The bank name

        Returns:
            Default configuration dictionary
        """
        config = CSVConfigurationFactory.DEFAULT_CONFIG.copy()
        config["bank_name"] = bank_name
        return config

    @staticmethod
    def merge_with_defaults(config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Merge provided configuration with defaults.

        Args:
            config: Configuration to merge

        Returns:
            Merged configuration
        """
        merged = CSVConfigurationFactory.DEFAULT_CONFIG.copy()
        merged.update(config)
        return merged
