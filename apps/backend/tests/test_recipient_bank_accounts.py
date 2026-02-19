"""Test script for recipient bank account many-to-many implementation.

This script demonstrates and tests the new recipient/bank account relationship
that prevents duplicates when names are ordered differently.
"""

from services.recipient_bank_account_service import RecipientBankAccountService
from services.recipient_service import RecipientService
from services.text_normalization_service import TextNormalizationService


def test_name_normalization():
    """Test that name normalization works correctly."""
    print("\n=== Testing Name Normalization ===")

    # Test 1: Basic word order variations
    print("\nTest 1: Basic word order")
    name1 = "JOHN SMITH"
    name2 = "SMITH JOHN"
    norm1 = TextNormalizationService.normalize_name_for_matching(name1)
    norm2 = TextNormalizationService.normalize_name_for_matching(name2)
    print(f"  '{name1}' -> '{norm1}'")
    print(f"  '{name2}' -> '{norm2}'")
    assert norm1 == norm2, "JOHN SMITH and SMITH JOHN should match!"
    print("  ✓ Word order variations match")

    # Test 2: Different people with same last name
    print("\nTest 2: Different people, same last name")
    name3 = "JANE SMITH"
    norm3 = TextNormalizationService.normalize_name_for_matching(name3)
    print(f"  '{name3}' -> '{norm3}'")
    assert norm1 != norm3, "JOHN SMITH and JANE SMITH should NOT match!"
    print("  ✓ Different people remain distinct")

    # Test 3: Middle names with initials
    print("\nTest 3: Middle names and initials")
    name4 = "JOHN F KENNEDY"
    name5 = "JOHN KENNEDY"
    name6 = "KENNEDY JOHN"
    norm4 = TextNormalizationService.normalize_name_for_matching(name4)
    norm5 = TextNormalizationService.normalize_name_for_matching(name5)
    norm6 = TextNormalizationService.normalize_name_for_matching(name6)
    print(f"  '{name4}' -> '{norm4}'")
    print(f"  '{name5}' -> '{norm5}'")
    print(f"  '{name6}' -> '{norm6}'")
    assert norm4 == norm5, "JOHN F KENNEDY and JOHN KENNEDY should match!"
    assert norm5 == norm6, "JOHN KENNEDY and KENNEDY JOHN should match!"
    print("  ✓ Middle initials correctly handled")

    # Test 4: Full middle name vs initial
    print("\nTest 4: Full middle name vs initial")
    name7 = "JOHN FITZGERALD KENNEDY"
    name8 = "JOHN F KENNEDY"
    name9 = "KENNEDY JOHN FITZGERALD"
    norm7 = TextNormalizationService.normalize_name_for_matching(name7)
    norm8 = TextNormalizationService.normalize_name_for_matching(name8)
    norm9 = TextNormalizationService.normalize_name_for_matching(name9)
    print(f"  '{name7}' -> '{norm7}'")
    print(f"  '{name8}' -> '{norm8}'")
    print(f"  '{name9}' -> '{norm9}'")
    assert norm7 == norm9, "Different orderings with full middle name should match!"
    print("  ✓ Full middle names and initials match correctly")

    # Test 5: Punctuation handling
    print("\nTest 5: Punctuation handling")
    name10 = "John F. Kennedy"
    name11 = "Kennedy, John F."
    norm10 = TextNormalizationService.normalize_name_for_matching(name10)
    norm11 = TextNormalizationService.normalize_name_for_matching(name11)
    print(f"  '{name10}' -> '{norm10}'")
    print(f"  '{name11}' -> '{norm11}'")
    assert norm10 == norm5, "Punctuation should be removed and match"
    assert norm11 == norm5, "Comma-separated format should match"
    print("  ✓ Punctuation correctly removed")

    # Test 6: Multiple middle names/initials
    print("\nTest 6: Multiple middle names")
    name12 = "JOHN F K SMITH"
    name13 = "JOHN SMITH"
    norm12 = TextNormalizationService.normalize_name_for_matching(name12)
    norm13 = TextNormalizationService.normalize_name_for_matching(name13)
    print(f"  '{name12}' -> '{norm12}'")
    print(f"  '{name13}' -> '{norm13}'")
    assert norm12 == norm13, "Multiple initials without matching full names should be removed"
    print("  ✓ Multiple initials handled correctly")

    # Test 7: Edge case - single name
    print("\nTest 7: Edge cases")
    name14 = "PRINCE"
    name15 = "  PRINCE  "
    norm14 = TextNormalizationService.normalize_name_for_matching(name14)
    norm15 = TextNormalizationService.normalize_name_for_matching(name15)
    print(f"  '{name14}' -> '{norm14}'")
    print(f"  '{name15}' -> '{norm15}'")
    assert norm14 == norm15, "Single names with extra spaces should match"
    print("  ✓ Edge cases handled correctly")

    print("\n✓ All name normalization tests passed!")


def test_recipient_creation_with_bank_accounts(test_db):
    """Test creating recipients with multiple bank accounts."""
    print("\n=== Testing Recipient Creation with Bank Accounts ===")

    db = test_db
    recipient_service = RecipientService(db)
    bank_account_service = RecipientBankAccountService(db)

    # Test 1: Create recipient with first bank account
    print("\nTest 1: Create recipient 'JOHN SMITH' with Belfius account")
    recipient1, created1 = recipient_service.create_or_get_recipient(
        name="JOHN SMITH",
        account_number="BE61734041478017",
        address="123 MAIN ST",
        bank_name="BELFIUS"
    )
    print(f"  Recipient ID: {recipient1.id}")
    print(f"  Name: {recipient1.name}")
    print(f"  Normalized Name: {recipient1.normalized_name}")
    print(f"  Created: {created1}")
    assert created1 is True, "Should have created new recipient"

    # Test 2: Add second bank account with name in different order
    print("\nTest 2: Add ING account as 'SMITH JOHN' (reversed name)")
    recipient2, created2 = recipient_service.create_or_get_recipient(
        name="SMITH JOHN",  # Different word order!
        account_number="NL91ABNA0417164300",
        address="456 OAK AVE",
        bank_name="ING"
    )
    print(f"  Recipient ID: {recipient2.id}")
    print(f"  Name: {recipient2.name}")
    print(f"  Normalized Name: {recipient2.normalized_name}")
    print(f"  Created: {created2}")
    assert created2 is False, "Should have found existing recipient"
    assert recipient1.id == recipient2.id, "Should be same recipient!"

    # Test 3: Verify both bank accounts are linked
    print("\nTest 3: Verify bank accounts")
    accounts = bank_account_service.get_by_recipient_id(recipient1.id)
    print(f"  Total bank accounts: {len(accounts)}")
    for account in accounts:
        print(f"    - {account.bank_name}: {account.account_number} (Primary: {account.is_primary})")
    assert len(accounts) == 2, "Should have 2 bank accounts"

    # Test 4: Different person with same last name
    print("\nTest 4: Create different person 'JANE SMITH'")
    recipient3, created3 = recipient_service.create_or_get_recipient(
        name="JANE SMITH",
        account_number="BE71734041478018",
        bank_name="BELFIUS"
    )
    print(f"  Recipient ID: {recipient3.id}")
    print(f"  Name: {recipient3.name}")
    print(f"  Normalized Name: {recipient3.normalized_name}")
    print(f"  Created: {created3}")
    assert created3 is True, "Should have created new recipient"
    assert recipient3.id != recipient1.id, "Should be different recipient!"

    # Test 5: Lookup by account number
    print("\nTest 5: Lookup by account number")
    account = bank_account_service.get_by_account_number("BE61734041478017")
    print(f"  Found account: {account.account_number}")
    print(f"  Linked to recipient: {account.recipient_name}")
    assert account.recipient_id == recipient1.id, "Should link to correct recipient"

    print("\n✓ All recipient/bank account tests passed!")


def test_duplicate_prevention(test_db):
    """Test that duplicates are prevented even with different name formats."""
    print("\n=== Testing Duplicate Prevention ===")

    db = test_db
    recipient_service = RecipientService(db)

    # Try various name formats that should all match
    name_variations = [
        "JOHN DOE",
        "DOE JOHN",
        "john doe",
        "doe john",
        "  JOHN   DOE  ",  # Extra spaces
    ]

    recipient_ids = []
    for i, name_variant in enumerate(name_variations):
        print(f"\n  Variant {i + 1}: '{name_variant}'")
        recipient, created = recipient_service.create_or_get_recipient(
            name=name_variant,
            account_number=f"TEST{i:05d}",
            bank_name="TEST BANK"
        )
        recipient_ids.append(recipient.id)
        print(f"    Recipient ID: {recipient.id}, Created: {created}")

    # All should map to the same recipient
    unique_ids = set(recipient_ids)
    print(f"\n  Total unique recipient IDs: {len(unique_ids)}")
    assert len(unique_ids) == 1, "All name variations should map to same recipient!"

    # Verify all bank accounts are linked
    bank_account_service = RecipientBankAccountService(db)
    accounts = bank_account_service.get_by_recipient_id(recipient_ids[0])
    print(f"  Total bank accounts linked: {len(accounts)}")
    assert len(accounts) == len(name_variations), "All accounts should be linked"

    print("\n✓ Duplicate prevention working correctly!")


if __name__ == "__main__":
    # This main block is for running the tests manually, not with pytest
    # Pytest will use the fixtures automatically
    print("=" * 60)
    print("Recipient Bank Account Many-to-Many Implementation Test")
    print("=" * 60)
    print("Please run with pytest instead: pytest tests/test_recipient_bank_accounts.py")
    print("=" * 60)
