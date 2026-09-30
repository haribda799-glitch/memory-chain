"""
test_memory_chain.py — Comprehensive tests for the MemoryChain SBT contract.

Tests cover:
- Deployment & initial state
- Minting memorials
- Soulbound (transfer/approve reverts)
- ERC-5192 (locked interface)
- Reading memorials by ID and by owner
- mintFee (Phase 2)
- withdraw (Phase 2)
- tokenURI construction
- Edge cases & access control
"""
import boa
import pytest
from tests.conftest import (
    SAMPLE_PET_NAME,
    SAMPLE_ARWEAVE_TX,
    SAMPLE_PET_NAME_2,
    SAMPLE_ARWEAVE_TX_2,
)


# ──────────────────────────────────────────────────────────────
# Deployment & initial state
# ──────────────────────────────────────────────────────────────


class TestDeployment:
    def test_name(self, memorial):
        assert memorial.name() == "MemoryChain"

    def test_symbol(self, memorial):
        assert memorial.symbol() == "PMEM"

    def test_total_supply_zero(self, memorial):
        assert memorial.totalSupply() == 0

    def test_owner_is_deployer(self, memorial, owner):
        assert memorial.owner() == owner

    def test_mint_fee_zero(self, memorial):
        assert memorial.mintFee() == 0


# ──────────────────────────────────────────────────────────────
# Minting
# ──────────────────────────────────────────────────────────────


class TestMinting:
    def test_mint_memorial(self, memorial, alice):
        """Basic mint: creates token, stores data, increments supply."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

        assert memorial.totalSupply() == 1
        assert memorial.ownerOf(0) == alice
        assert memorial.balanceOf(alice) == 1

    def test_mint_stores_memorial_data(self, memorial, alice):
        """Memorial data struct is correctly stored."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

        data = memorial.getMemorial(0)
        assert data[0] == SAMPLE_PET_NAME      # petName
        assert data[1] == SAMPLE_ARWEAVE_TX     # arweaveTxId
        assert data[2] > 0                      # createdAt (timestamp)

    def test_mint_multiple(self, memorial, alice, bob):
        """Multiple users can mint, token IDs auto-increment."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)
        with boa.env.prank(bob):
            memorial.mintMemorial(SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2)

        assert memorial.totalSupply() == 2
        assert memorial.ownerOf(0) == alice
        assert memorial.ownerOf(1) == bob

    def test_mint_emits_event(self, memorial, alice):
        """MemorialCreated event is emitted on mint."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

        # Titanoboa captures events on the contract
        logs = memorial.get_logs()
        # Should have Transfer, MemorialCreated, and Locked events
        assert len(logs) > 0

    def test_anyone_can_mint(self, memorial, alice, bob):
        """Minting is permissionless (no minter role check)."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)
        with boa.env.prank(bob):
            memorial.mintMemorial(SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2)
        assert memorial.totalSupply() == 2


# ──────────────────────────────────────────────────────────────
# Soulbound (transfer always reverts)
# ──────────────────────────────────────────────────────────────


class TestSoulbound:
    def test_transfer_from_reverts(self, memorial, alice, bob):
        """transferFrom always reverts with 'SOULBOUND'."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

        with boa.reverts("SOULBOUND"):
            with boa.env.prank(alice):
                memorial.transferFrom(alice, bob, 0)

    def test_safe_transfer_from_reverts(self, memorial, alice, bob):
        """safeTransferFrom always reverts with 'SOULBOUND'."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

        with boa.reverts("SOULBOUND"):
            with boa.env.prank(alice):
                memorial.safeTransferFrom(alice, bob, 0)

    def test_approve_reverts(self, memorial, alice, bob):
        """approve always reverts with 'SOULBOUND'."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

        with boa.reverts("SOULBOUND"):
            with boa.env.prank(alice):
                memorial.approve(bob, 0)

    def test_set_approval_for_all_reverts(self, memorial, alice, bob):
        """setApprovalForAll always reverts with 'SOULBOUND'."""
        with boa.reverts("SOULBOUND"):
            with boa.env.prank(alice):
                memorial.setApprovalForAll(bob, True)


# ──────────────────────────────────────────────────────────────
# ERC-5192: Locked interface
# ──────────────────────────────────────────────────────────────


class TestERC5192:
    def test_locked_returns_true(self, memorial, alice):
        """locked() returns True for all valid tokens."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

        assert memorial.locked(0) is True

    def test_locked_invalid_token_reverts(self, memorial):
        """locked() reverts for non-existent tokens."""
        with boa.reverts("erc721: invalid token ID"):
            memorial.locked(999)


# ──────────────────────────────────────────────────────────────
# Reading memorials
# ──────────────────────────────────────────────────────────────


class TestReading:
    def test_get_memorial_by_id(self, memorial, alice):
        """getMemorial returns correct data for a valid token ID."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

        data = memorial.getMemorial(0)
        assert data[0] == SAMPLE_PET_NAME
        assert data[1] == SAMPLE_ARWEAVE_TX

    def test_get_memorial_nonexistent_reverts(self, memorial):
        """getMemorial reverts for non-existent tokens."""
        with boa.reverts("MemoryChain: memorial does not exist"):
            memorial.getMemorial(0)

    def test_get_memorials_by_owner(self, memorial, alice):
        """getMemorialsByOwner returns all token IDs for an owner."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)
            memorial.mintMemorial(SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2)

        result = memorial.getMemorialsByOwner(alice)
        assert len(result) == 2
        assert result[0] == 0
        assert result[1] == 1

    def test_get_memorials_by_owner_empty(self, memorial, alice):
        """getMemorialsByOwner returns empty array for address with no tokens."""
        result = memorial.getMemorialsByOwner(alice)
        assert len(result) == 0


# ──────────────────────────────────────────────────────────────
# tokenURI
# ──────────────────────────────────────────────────────────────


class TestTokenURI:
    def test_token_uri_format(self, memorial, alice):
        """tokenURI returns 'ar://{arweaveTxId}'."""
        with boa.env.prank(alice):
            memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

        uri = memorial.tokenURI(0)
        assert uri == f"ar://{SAMPLE_ARWEAVE_TX}"

    def test_token_uri_nonexistent_reverts(self, memorial):
        """tokenURI reverts for non-existent tokens."""
        with boa.reverts("erc721: invalid token ID"):
            memorial.tokenURI(999)


# ──────────────────────────────────────────────────────────────
# Phase 2: mintFee
# ──────────────────────────────────────────────────────────────


class TestMintFee:
    def test_owner_can_set_fee(self, memorial, owner):
        """Owner can set the minting fee."""
        with boa.env.prank(owner):
            memorial.setMintFee(1000)
        assert memorial.mintFee() == 1000

    def test_non_owner_cannot_set_fee(self, memorial, alice):
        """Non-owner cannot set the minting fee."""
        with boa.reverts():
            with boa.env.prank(alice):
                memorial.setMintFee(1000)

    def test_mint_with_fee_requires_payment(self, memorial, owner, alice):
        """If fee > 0, minting without payment reverts."""
        with boa.env.prank(owner):
            memorial.setMintFee(1000)  # 1000 wei

        with boa.reverts("MemoryChain: insufficient mint fee"):
            with boa.env.prank(alice):
                memorial.mintMemorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX)

    def test_mint_with_fee_succeeds(self, memorial, owner, alice):
        """Minting with sufficient payment succeeds."""
        fee = 1000
        with boa.env.prank(owner):
            memorial.setMintFee(fee)

        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            memorial.mintMemorial(
                SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, value=fee
            )
        assert memorial.totalSupply() == 1

    def test_mint_with_overpayment_succeeds(self, memorial, owner, alice):
        """Minting with more than the required fee succeeds."""
        fee = 1000
        with boa.env.prank(owner):
            memorial.setMintFee(fee)

        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            memorial.mintMemorial(
                SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, value=fee * 10
            )
        assert memorial.totalSupply() == 1


# ──────────────────────────────────────────────────────────────
# Phase 2: withdraw
# ──────────────────────────────────────────────────────────────


class TestWithdraw:
    def test_owner_can_withdraw(self, memorial, owner, alice):
        """Owner can withdraw accumulated fees."""
        fee = 10**15  # 0.001 ETH
        with boa.env.prank(owner):
            memorial.setMintFee(fee)

        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            memorial.mintMemorial(
                SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, value=fee
            )

        owner_balance_before = boa.env.get_balance(owner)
        with boa.env.prank(owner):
            memorial.withdraw()
        owner_balance_after = boa.env.get_balance(owner)

        assert owner_balance_after - owner_balance_before == fee

    def test_non_owner_cannot_withdraw(self, memorial, alice):
        """Non-owner cannot withdraw."""
        with boa.reverts():
            with boa.env.prank(alice):
                memorial.withdraw()

    def test_withdraw_nothing_reverts(self, memorial, owner):
        """Withdraw with zero balance reverts."""
        with boa.reverts("MemoryChain: nothing to withdraw"):
            with boa.env.prank(owner):
                memorial.withdraw()
