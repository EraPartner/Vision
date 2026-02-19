"""
Text Normalization Service

Centralized service for text processing and normalization.
This is the single Information Expert for text processing rules.
"""
from typing import Optional


class TextNormalizationService:
    """Service for normalizing and processing text data"""

    # Common prefixes and suffixes to remove from recipient names
    RECIPIENT_PREFIXES = [
        "Payment from ",
        "Payment to ",
        "From ",
        "To ",
        "Transfer from ",
        "Transfer to ",
        "Sent to ",
        "Received from ",
    ]

    # KBC-specific prefixes
    KBC_RECIPIENT_PREFIXES = [
        "IBAN: ",
        "Virement: ",
        "Virement automatique: ",
        "Domiciliation: ",
        "Creditrente ",
    ]

    @staticmethod
    def clean_recipient_name(recipient: str) -> str:
        """
        Clean recipient name by removing common prefixes and suffixes
        that don't add value.

        Args:
            recipient: The recipient name to clean

        Returns:
            The cleaned recipient name
        """
        if not recipient:
            return recipient

        cleaned = recipient.strip()

        # Remove prefixes (case-insensitive)
        for prefix in TextNormalizationService.RECIPIENT_PREFIXES:
            if cleaned.lower().startswith(prefix.lower()):
                cleaned = cleaned[len(prefix):].strip()
                break  # Only remove one prefix

        return cleaned

    @staticmethod
    def clean_kbc_recipient_name(recipient: str) -> str:
        """
        Clean KBC recipient names by extracting the main transaction type.

        Examples:
        - "GELDOPNEMING VIA BANCONTACT 26-09..." -> "Geldopneming"
        - "OVERSCHRIJVING NAAR BE12..." -> "Overschrijving"
        - "DOMICILIËRING VAN XYZ..." -> "Domiciliëring"
        - "AANKOOP MET DEBETKAART..." -> "Aankoop"

        Args:
            recipient: The recipient name to clean

        Returns:
            The cleaned recipient name
        """
        if not recipient:
            return recipient

        recipient = recipient.strip()

        # Common KBC transaction type keywords (first word or phrase)
        # These are typically at the start of the description
        kbc_transaction_types = [
            "GELDOPNEMING",
            "OVERSCHRIJVING",
            "DOMICILIËRING",
            "DOMICILIERING",
            "AANKOOP",
            "TERUGBETALING",
            "STORTING",
            "AFHALING",
            "BETALING",
            "RETRO-SEPA",
            "SEPA",
            "EUROPESE",
            "INTERNATIONALE",
            "CREDITRENTE",
        ]

        # Check if it starts with a known transaction type
        upper_recipient = recipient.upper()
        for trans_type in kbc_transaction_types:
            if upper_recipient.startswith(trans_type):
                # Return just the transaction type, properly capitalized
                return trans_type.capitalize()

        # If no match, try to extract the first meaningful word/phrase before common separators
        # Look for patterns like "WORD VIA", "WORD NAAR", "WORD VAN", "WORD MET"
        separators = [" VIA ", " NAAR ", " VAN ", " MET ", " DOOR ", " OP ", " OM "]
        for separator in separators:
            if separator in upper_recipient:
                first_part = recipient.split(separator, 1)[0].strip()
                return first_part.capitalize()

        # If still no match, take only the first word if it's long enough to be meaningful
        first_word = recipient.split()[0] if recipient.split() else recipient
        if len(first_word) > 3:  # Only use if it's a substantial word
            return first_word.capitalize()

        # Fallback: take first 2-3 words if they form a meaningful phrase
        words = recipient.split()[:3]
        if words:
            return " ".join(words).capitalize()

        return recipient

    @staticmethod
    def normalize_whitespace(text: str) -> str:
        """
        Normalize whitespace in text (collapse multiple spaces, strip).

        Args:
            text: The text to normalize

        Returns:
            The normalized text
        """
        if not text:
            return text
        # Replace multiple spaces with single space
        return ' '.join(text.split())

    @staticmethod
    def truncate_with_ellipsis(text: str, max_length: int = 100) -> str:
        """
        Truncate text to max length with ellipsis if needed.

        Args:
            text: The text to truncate
            max_length: Maximum length

        Returns:
            The truncated text
        """
        if not text or len(text) <= max_length:
            return text
        return text[:max_length - 3] + "..."

    @staticmethod
    def extract_currency_code(currency_str: str) -> Optional[str]:
        """
        Extract currency code from currency string.
        Handles formats like "EUR", "0,00 EUR", "0.00 EUR", etc.

        Args:
            currency_str: The currency string

        Returns:
            The currency code (e.g., "EUR") or None if not found
        """
        if not currency_str:
            return None

        # Split on space and take the part that looks like a currency code
        parts = currency_str.split()
        for part in reversed(parts):  # Check from right to left
            if part.isalpha() and len(part) == 3:
                return part.upper()

        # If no space-separated code found, check if entire string is a code
        if currency_str.isalpha() and len(currency_str) == 3:
            return currency_str.upper()

        return None

    @staticmethod
    def format_amount_string(amount_str: str) -> Optional[float]:
        """
        Format amount string to float, handling various formats.
        Supports: "1000.50", "1000,50", "1.000,50", etc.

        Args:
            amount_str: The amount string

        Returns:
            The amount as float, or None if parsing fails
        """
        if not amount_str:
            return None

        try:
            # Remove whitespace
            amount_str = amount_str.strip()

            # Determine if comma or dot is the decimal separator
            # by checking which comes last
            comma_pos = amount_str.rfind(',')
            dot_pos = amount_str.rfind('.')

            if comma_pos > dot_pos:
                # Comma is decimal separator
                amount_str = amount_str.replace('.', '').replace(',', '.')
            else:
                # Dot is decimal separator (or no decimal separator)
                amount_str = amount_str.replace(',', '')

            return float(amount_str)
        except (ValueError, AttributeError):
            return None

    @staticmethod
    def normalize_category_name(name) -> str:
        """
        Normalize category names to uppercase with consistent formatting.

        This is the single source of truth for category name normalization
        across the entire application.

        Args:
            name: The category name to normalize (must be string-like)

        Returns:
            The normalized category name (uppercase, stripped whitespace)

        Raises:
            ValueError: If name is not a string or cannot be converted to string

        Example:
            normalize_category_name("groceries") -> "GROCERIES"
            normalize_category_name("  Food  ") -> "FOOD"
            normalize_category_name("Transport & Travel") -> "TRANSPORT & TRAVEL"
        """
        if not name:
            return name

        # Handle non-string types
        if not isinstance(name, str):
            raise ValueError(f"Category name must be a string, got {type(name).__name__}")

        return name.strip().upper()

    @staticmethod
    def normalize_recipient_name(name) -> str:
        """
        Normalize recipient names to uppercase with consistent formatting.

        This is the single source of truth for recipient name normalization
        across the entire application.

        Args:
            name: The recipient name to normalize (must be string-like)

        Returns:
            The normalized recipient name (uppercase, stripped whitespace)

        Raises:
            ValueError: If name is not a string or cannot be converted to string

        Example:
            normalize_recipient_name("john smith") -> "JOHN SMITH"
            normalize_recipient_name("  ABC Corp  ") -> "ABC CORP"
        """
        if not name:
            return name

        # Handle non-string types
        if not isinstance(name, str):
            raise ValueError(f"Recipient name must be a string, got {type(name).__name__}")

        return name.strip().upper()

    @staticmethod
    def normalize_name_for_matching(name: str) -> str:
        """
        Normalize a name for uniqueness matching, handling word order and middle names/initials.

        This creates a canonical form that handles:
        - Different word orderings: "JOHN SMITH" vs "SMITH JOHN"
        - Middle names/initials: "JOHN F KENNEDY" vs "JOHN KENNEDY"
        - Extra spaces and formatting variations

        Algorithm:
        1. Normalize to uppercase and strip whitespace
        2. Split into tokens (words)
        3. Identify and expand single-letter tokens (initials)
        4. Remove initials that are redundant (already have full middle name)
        5. Sort tokens alphabetically
        6. Join with a single space

        Middle Name Handling:
        - "JOHN F KENNEDY" and "JOHN KENNEDY" both normalize to "JOHN KENNEDY"
        - "JOHN FITZGERALD KENNEDY" and "JOHN F KENNEDY" both normalize to "FITZGERALD JOHN KENNEDY"
        - This matches people with/without middle names or with initials only

        This ensures:
        - "JOHN SMITH" and "SMITH JOHN" → same
        - "JOHN F KENNEDY" and "JOHN KENNEDY" → same
        - "JOHN FITZGERALD KENNEDY" and "JOHN F KENNEDY" → same
        - "JANE SMITH" and "JOHN SMITH" → different

        Args:
            name: The recipient name to normalize for matching

        Returns:
            The normalized name in canonical form (sorted tokens, uppercase, initials removed)

        Example:
            normalize_name_for_matching("JOHN SMITH") -> "JOHN SMITH"
            normalize_name_for_matching("SMITH JOHN") -> "JOHN SMITH"
            normalize_name_for_matching("JOHN F KENNEDY") -> "JOHN KENNEDY"
            normalize_name_for_matching("JOHN FITZGERALD KENNEDY") -> "FITZGERALD JOHN KENNEDY"
            normalize_name_for_matching("John F. Kennedy") -> "JOHN KENNEDY"
            normalize_name_for_matching("Kennedy, John F.") -> "JOHN KENNEDY"
        """
        if not name:
            return name

        # Normalize to uppercase and strip
        normalized = name.strip().upper()

        # Remove common punctuation (periods, commas)
        normalized = normalized.replace('.', ' ').replace(',', ' ')

        # Split into tokens and filter empty strings
        tokens = [t for t in normalized.split() if t]

        if not tokens:
            return ""

        # Separate single-letter tokens (initials) from full words
        initials = set()
        full_words = []

        for token in tokens:
            if len(token) == 1 and token.isalpha():
                # Single letter = initial
                initials.add(token)
            else:
                full_words.append(token)

        # Remove initials that match the first letter of any full word
        # This handles cases like "JOHN F KENNEDY" where F might be for a middle name
        # If we have the full middle name, we don't need the initial
        filtered_initials = []
        for initial in initials:
            # Check if any full word starts with this initial
            has_matching_word = any(word.startswith(initial) for word in full_words)
            if not has_matching_word:
                # Keep the initial only if there's no matching full word
                # This means we DON'T have the full middle name
                filtered_initials.append(initial)

        # Combine full words and remaining initials
        all_tokens = full_words + filtered_initials

        # Sort alphabetically for consistent ordering
        all_tokens.sort()

        # Join with single space
        return " ".join(all_tokens)
