from services.iban import is_valid_iban, normalize_iban

VALID_IBANS = [
    # Examples from various countries
    "BE68539007547034",  # Belgium (from examples)
    "BE68 5390 0754 7034",  # with spaces
    "GB82 WEST 1234 5698 7654 32",  # UK example
    "DE89 3704 0044 0532 0130 00",  # Germany
    "FR14 2004 1010 0505 0001 3M02 606",  # France
    "NL91 ABNA 0417 1643 00",  # Netherlands
]

INVALID_IBANS = [
    "BE00 0000 0000 0000",  # incorrect check digits
    "GB00 WEST 1234 5698 7654 32",  # invalid checksum
    "INVALIDIBAN12345",
    "",
    "DE8937040044053201300X",  # invalid char
]


def test_valid_ibans():
    for iban in VALID_IBANS:
        assert is_valid_iban(iban), f"Expected valid: {iban}"


def test_invalid_ibans():
    for iban in INVALID_IBANS:
        assert not is_valid_iban(iban), f"Expected invalid: {iban}"


def test_normalize_iban():
    assert normalize_iban("be68 5390 0754 7034") == "BE68539007547034"
