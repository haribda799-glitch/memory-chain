import pytest
import boa
from tests.conftest import SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2

CREATION_FEE = 2_000_000_000_000_000  # 0.002 ETH

# ──────────────────────────────────────────────────────────────
# Memorial Creation & Duplicates
# ──────────────────────────────────────────────────────────────

class TestMemorialCreation:
    def test_create_memorial_success(self, core, alice):
        """Successful creation of a memorial with the creation fee."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
        
        assert core.memorial_count() == 1
        assert core.total_memorial_owners() == 1
        assert core.has_created_memorial(alice) is True
        
        memorial = core.memorials(1)
        assert memorial[0] == alice
        assert memorial[1] == SAMPLE_ARWEAVE_TX
        assert memorial[2] == SAMPLE_PET_NAME
        assert memorial[4] is True # is_public

    def test_create_memorial_insufficient_fee(self, core, alice):
        """Reverts if the creation fee is not paid."""
        boa.env.set_balance(alice, 10**18)
        with boa.reverts("Exact creation fee required"):
            with boa.env.prank(alice):
                core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE - 1)

    def test_create_memorial_overpayment_reverts(self, core, alice):
        """Reverts if creation fee has overpayment (exact fee required)."""
        boa.env.set_balance(alice, 10**18)
        with boa.reverts("Exact creation fee required"):
            with boa.env.prank(alice):
                core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE + 1)

    def test_duplicate_check_has_created_memorial(self, core, alice):
        """User can create multiple memorials, but `has_created_memorial` tracks them once."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
            core.create_memorial(SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2, True, value=CREATION_FEE)
        
        assert core.memorial_count() == 2
        assert core.total_memorial_owners() == 1  # Alice only counts once
        assert core.has_created_memorial(alice) is True


# ──────────────────────────────────────────────────────────────
# Candle Lighting
# ──────────────────────────────────────────────────────────────

class TestCandleLighting:
    def test_light_candle_tiers_and_multipliers(self, core, alice, bob):
        """Test lighting candle with exact multiplier pricing for tiers 1-4."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
        
        price = core.candle_price()
        boa.env.set_balance(bob, 10**18)
        
        # Tier 1: mult 1
        with boa.env.prank(bob):
            core.light_candle(1, 1, value=price * 1)
        # Tier 2: mult 3
        with boa.env.prank(bob):
            core.light_candle(1, 2, value=price * 3)
        # Tier 3: mult 6
        with boa.env.prank(bob):
            core.light_candle(1, 3, value=price * 6)
        # Tier 4: mult 10
        with boa.env.prank(bob):
            core.light_candle(1, 4, value=price * 10)

        assert core.total_candles_lit(1) == 4
        # Total spent on candles = price * (1 + 3 + 6 + 10) = price * 20
        assert boa.env.get_balance(core.address) == CREATION_FEE + price * 20

    def test_light_candle_incorrect_payment_reverts(self, core, alice, bob):
        """Overpayment or underpayment for tier reverts."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)

        price = core.candle_price()
        boa.env.set_balance(bob, 10**18)

        with boa.env.prank(bob):
            # Underpayment
            with boa.reverts("Incorrect payment for tier"):
                core.light_candle(1, 1, value=price - 1)
            # Overpayment (e.g. paying price * 2 for tier 1)
            with boa.reverts("Incorrect payment for tier"):
                core.light_candle(1, 1, value=price * 2)

    def test_donate_and_light(self, core, alice, bob):
        """Test open donation with donate_and_light."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)

        price = core.candle_price()
        boa.env.set_balance(bob, 10**18)

        # Donation below minimum reverts
        with boa.env.prank(bob):
            with boa.reverts("Donation below candle price"):
                core.donate_and_light(1, value=1)

        # Valid donation (5 * price)
        memorial = core.memorials(1)
        created_at = memorial[3]
        with boa.env.prank(bob):
            core.donate_and_light(1, value=price * 5)
        
        assert core.total_candles_lit(1) == 1
        # 5 hours = 5 * 3600 = 18000s
        assert core.candle_expires_at(1) == created_at + 18000
        assert boa.env.get_balance(core.address) == CREATION_FEE + price * 5

    def test_donate_and_light_horizon_cap(self, core, alice, bob):
        """Horizon cap: expiry never exceeds block.timestamp + MAX_EXPIRY_HORIZON (31536000)."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)

        price = core.candle_price()
        huge_amount = 100 * 10**18 # 100 ETH -> millions of hours
        boa.env.set_balance(bob, huge_amount + 10**18)

        memorial = core.memorials(1)
        created_at = memorial[3]
        with boa.env.prank(bob):
            core.donate_and_light(1, value=huge_amount)

        assert core.candle_expires_at(1) == created_at + 31536000

    def test_banned_memorial_cannot_light_candle(self, core, owner, alice, bob):
        """Banned memorials cannot receive candles; private and unbanned memorials can."""
        boa.env.set_balance(alice, 10**18)
        boa.env.set_balance(bob, 10**18)
        price = core.candle_price()

        # 1. Private memorial CAN light candle
        with boa.env.prank(alice):
            core.create_memorial("Private Pet", "arweave-private", False, value=CREATION_FEE)
        with boa.env.prank(bob):
            core.light_candle(1, 1, value=price)
        assert core.total_candles_lit(1) == 1

        # 2. Banned memorial CANNOT light candle or receive donation
        with boa.env.prank(owner):
            core.force_ban(1)

        with boa.env.prank(bob):
            with boa.reverts("Memorial is banned"):
                core.light_candle(1, 1, value=price)
            with boa.reverts("Memorial is banned"):
                core.donate_and_light(1, value=price)

        # 3. After unban, candle lighting works again
        with boa.env.prank(owner):
            core.unban_memorial(1)

        with boa.env.prank(bob):
            core.light_candle(1, 1, value=price)
        assert core.total_candles_lit(1) == 2

    def test_light_candle_invalid_memorial_id_reverts_first(self, core, bob):
        """Identifier validation precedes economic validation (CEI)."""
        boa.env.set_balance(bob, 10**18)
        with boa.env.prank(bob):
            with boa.reverts("Invalid memorial"):
                core.light_candle(999, 1, value=0)
            with boa.reverts("Invalid memorial"):
                core.donate_and_light(999, value=0)


# ──────────────────────────────────────────────────────────────
# Visibility Toggling
# ──────────────────────────────────────────────────────────────

class TestVisibilityToggling:
    def test_toggle_public_success(self, core, alice):
        """Owner can toggle visibility between public and private."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
            assert core.memorials(1)[4] is True
            core.toggle_public(1)
            assert core.memorials(1)[4] is False
            core.toggle_public(1)
            assert core.memorials(1)[4] is True

    def test_toggle_public_non_owner_reverts(self, core, alice, bob):
        """Non-owner cannot toggle visibility."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
        with boa.env.prank(bob):
            with boa.reverts("Not owner"):
                core.toggle_public(1)

    def test_toggle_public_banned_memorial_reverts(self, core, owner, alice):
        """Banned memorial cannot be toggled by owner."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
        with boa.env.prank(owner):
            core.force_ban(1)
        with boa.env.prank(alice):
            with boa.reverts("Memorial is banned"):
                core.toggle_public(1)


# ──────────────────────────────────────────────────────────────
# Moderation (Time-Weighted & Epochs)
# ──────────────────────────────────────────────────────────────

class TestModeration:
    def test_time_weighted_reporting_sequential(self, core, users):
        """Test that report weight scales with account age (1, 2, 3)."""
        target_memorial = 1
        boa.env.set_balance(users[0], 10**18)
        with boa.env.prank(users[0]):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
            
        boa.env.set_balance(users[1], 10**18)
        with boa.env.prank(users[1]):
            core.create_memorial(SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2, True, value=CREATION_FEE) # age > 30 days later
            
        boa.env.time_travel(25 * 24 * 3600) # 25 days pass
        
        boa.env.set_balance(users[2], 10**18)
        with boa.env.prank(users[2]):
            core.create_memorial(SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2, True, value=CREATION_FEE) # age 8 days later
            
        boa.env.time_travel(6 * 24 * 3600) # 6 days pass
        
        boa.env.set_balance(users[3], 10**18)
        with boa.env.prank(users[3]):
            core.create_memorial(SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2, True, value=CREATION_FEE) # age 1 day later
            
        boa.env.time_travel(2 * 24 * 3600) # 2 days pass. Total 33 days from users[1] creation.

        # users[1] age: 33 days (weight 3)
        # users[2] age: 8 days (weight 2)
        # users[3] age: 2 days (weight 1)
        
        with boa.env.prank(users[1]):
            core.report_memorial(target_memorial)
        assert core.report_weight(target_memorial) == 3
        
        with boa.env.prank(users[2]):
            core.report_memorial(target_memorial)
        assert core.report_weight(target_memorial) == 5
        
        with boa.env.prank(users[3]):
            core.report_memorial(target_memorial)
        assert core.report_weight(target_memorial) == 6

    def test_epoch_based_reporting(self, core, owner, alice, bob):
        """User can re-report a memorial after the epoch is advanced via dismiss_reports."""
        boa.env.set_balance(alice, 10**18)
        boa.env.set_balance(bob, 10**18)
        
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
            
        with boa.env.prank(bob):
            core.create_memorial(SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2, True, value=CREATION_FEE)
            
        # Report (Epoch 0)
        with boa.env.prank(bob):
            core.report_memorial(1)
            
        assert core.report_weight(1) == 1
        assert core.has_reported(1, bob) == 1 # stores epoch + 1
        
        # Double reporting fails
        with boa.reverts("Already reported"):
            with boa.env.prank(bob):
                core.report_memorial(1)
                
        # Owner dismisses reports
        with boa.env.prank(owner):
            core.dismiss_reports(1)
            
        assert core.report_weight(1) == 0
        assert core.report_epoch(1) == 1
        
        # Bob can report again in Epoch 1
        with boa.env.prank(bob):
            core.report_memorial(1)
            
        assert core.report_weight(1) == 1
        assert core.has_reported(1, bob) == 2

    def test_banned_memorial_cannot_be_reported(self, core, owner, alice, bob):
        """Banned memorial cannot be reported."""
        boa.env.set_balance(alice, 10**18)
        boa.env.set_balance(bob, 10**18)

        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
        with boa.env.prank(bob):
            core.create_memorial(SAMPLE_PET_NAME_2, SAMPLE_ARWEAVE_TX_2, True, value=CREATION_FEE)

        # Owner bans memorial 1
        with boa.env.prank(owner):
            core.force_ban(1)

        # Bob attempts to report memorial 1
        with boa.env.prank(bob):
            with boa.reverts("Memorial already banned"):
                core.report_memorial(1)



# ──────────────────────────────────────────────────────────────
# Timelock & Ownership
# ──────────────────────────────────────────────────────────────

class TestTimelock:
    def test_change_moderation_module_timelock(self, core, owner):
        """Attempting to apply before 48 hours should fail."""
        import src.ModerationModule as ModerationModule
        with boa.env.prank(owner):
            new_mod_module = ModerationModule.deploy()
            core.propose_moderation_module(new_mod_module.address)
        
        # Immediate apply should revert
        with boa.reverts("Timelock not expired"):
            with boa.env.prank(owner):
                core.apply_moderation_module()
                
        # Advance time by 47 hours
        boa.env.time_travel(47 * 3600)
        with boa.reverts("Timelock not expired"):
            with boa.env.prank(owner):
                core.apply_moderation_module()

        # Advance time by 1 more hour
        boa.env.time_travel(3600)
        with boa.env.prank(owner):
            core.apply_moderation_module()
            
        assert core.moderation_module() == new_mod_module.address

    def test_cancel_moderation_module_proposal(self, core, owner):
        """Owner can cancel a proposed moderation module."""
        import src.ModerationModule as ModerationModule
        with boa.env.prank(owner):
            new_mod_module = ModerationModule.deploy()
            core.propose_moderation_module(new_mod_module.address)
            core.cancel_moderation_module_proposal()
            
        assert core.proposed_moderation_module() == "0x0000000000000000000000000000000000000000"
        assert core.moderation_module_timelock() == 0

    def test_apply_moderation_module_expired_proposal(self, core, owner):
        """Applying after timelock + TIMELOCK_GRACE_PERIOD reverts with Proposal expired."""
        import src.ModerationModule as ModerationModule
        with boa.env.prank(owner):
            new_mod_module = ModerationModule.deploy()
            core.propose_moderation_module(new_mod_module.address)
            
        # Advance beyond timelock delay (48h) + grace period (7 days)
        boa.env.time_travel(172800 + 604800 + 1)
        
        with boa.reverts("Proposal expired"):
            with boa.env.prank(owner):
                core.apply_moderation_module()

    def test_propose_invalid_module_reverts(self, core, owner, alice):
        """Proposing an EOA or zero address must revert due to _verify_moderation_module."""
        # Zero address reverts
        with boa.env.prank(owner):
            with boa.reverts("Invalid module address"):
                core.propose_moderation_module("0x0000000000000000000000000000000000000000")

        # EOA address reverts (call fails / empty returndata)
        with boa.env.prank(owner):
            with boa.reverts():
                core.propose_moderation_module(alice)

class TestOwnership:
    def test_two_step_ownership_transfer(self, core, owner, alice):
        """2-step ownership transfer requires propose and accept."""
        # Only owner can propose
        with boa.reverts("Not owner"):
            with boa.env.prank(alice):
                core.propose_owner(alice)
                
        # Owner proposes alice
        with boa.env.prank(owner):
            core.propose_owner(alice)
            
        assert core.pending_owner() == alice
        assert core.owner() == owner
        
        # Only alice can accept
        with boa.reverts("Not pending owner"):
            with boa.env.prank(owner):
                core.accept_ownership()
                
        # Alice accepts
        with boa.env.prank(alice):
            core.accept_ownership()
            
        assert core.owner() == alice
        assert core.pending_owner() == "0x0000000000000000000000000000000000000000"


# ──────────────────────────────────────────────────────────────
# Withdraw
# ──────────────────────────────────────────────────────────────

class TestWithdraw:
    def test_withdraw_to_multisig(self, core, owner, alice, bob):
        """Withdraw funds to the owner when treasury is default owner."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
            
        price = core.candle_price()
        boa.env.set_balance(bob, 10**18)
        with boa.env.prank(bob):
            core.donate_and_light(1, value=price * 5)
            
        contract_balance_before = boa.env.get_balance(core.address)
        assert contract_balance_before == CREATION_FEE + price * 5
        
        owner_balance_before = boa.env.get_balance(owner)
        
        # Withdraw
        with boa.env.prank(owner):
            core.withdraw()
            
        assert boa.env.get_balance(core.address) == 0
        assert boa.env.get_balance(owner) == owner_balance_before + CREATION_FEE + price * 5

    def test_set_treasury(self, core, owner, alice):
        """Test treasury getter, setter access control, and validation."""
        assert core.treasury() == owner
        
        new_treasury = boa.env.generate_address()
        
        # Non-owner cannot update treasury
        with boa.env.prank(alice):
            with boa.reverts("Not owner"):
                core.set_treasury(new_treasury)
                
        # Cannot set to zero address
        with boa.env.prank(owner):
            with boa.reverts("Invalid treasury address"):
                core.set_treasury("0x0000000000000000000000000000000000000000")
                
        # Cannot set to current treasury
        with boa.env.prank(owner):
            with boa.reverts("Already set to this address"):
                core.set_treasury(owner)
                
        # Owner successfully updates treasury
        with boa.env.prank(owner):
            core.set_treasury(new_treasury)
            
        assert core.treasury() == new_treasury

    def test_withdraw_to_separate_treasury(self, core, owner, alice, bob):
        """Withdraw funds routed to dedicated treasury address, not owner."""
        treasury_addr = boa.env.generate_address()
        with boa.env.prank(owner):
            core.set_treasury(treasury_addr)
            
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
            
        price = core.candle_price()
        boa.env.set_balance(bob, 10**18)
        with boa.env.prank(bob):
            core.donate_and_light(1, value=price * 5)
            
        owner_balance_before = boa.env.get_balance(owner)
        treasury_balance_before = boa.env.get_balance(treasury_addr)
        
        # Withdraw called by owner
        with boa.env.prank(owner):
            core.withdraw()
            
        assert boa.env.get_balance(core.address) == 0
        # Owner balance unchanged
        assert boa.env.get_balance(owner) == owner_balance_before
        # Treasury receives all funds
        assert boa.env.get_balance(treasury_addr) == treasury_balance_before + CREATION_FEE + price * 5

    def test_withdraw_guards(self, core, owner, alice):
        """Withdraw requires owner and positive balance."""
        with boa.env.prank(alice):
            with boa.reverts("Not owner"):
                core.withdraw()
                
        with boa.env.prank(owner):
            with boa.reverts("No balance"):
                core.withdraw()


# ──────────────────────────────────────────────────────────────
# Admin Moderation (force_ban, unban_memorial & dismiss_reports)
# ──────────────────────────────────────────────────────────────

class TestAdminModeration:
    def test_force_ban_and_unban_memorial_lifecycle(self, core, owner, alice):
        """force_ban sets is_banned, is_memorial_visible returns False, dismiss_reports is blocked until unban."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
        
        memorial_id = 1
        # Memorial struct: (owner, arweave_uri, pet_name, created_at, is_public, is_hidden, is_banned)
        assert core.memorials(memorial_id)[4] is True   # is_public
        assert core.memorials(memorial_id)[5] is False  # is_hidden
        assert core.memorials(memorial_id)[6] is False  # is_banned
        assert core.is_memorial_visible(memorial_id) is True
        assert core.is_memorial_hidden(memorial_id) is False
        
        # 1. Owner applies force_ban
        with boa.env.prank(owner):
            core.force_ban(memorial_id)
            
        assert core.memorials(memorial_id)[6] is True   # is_banned
        assert core.memorials(memorial_id)[4] is True   # author's is_public preserved
        assert core.is_memorial_visible(memorial_id) is False
        assert core.is_memorial_hidden(memorial_id) is True
        
        # 2. dismiss_reports while banned MUST revert
        with boa.env.prank(owner):
            with boa.reverts("Memorial is banned; use unban"):
                core.dismiss_reports(memorial_id)

        # 3. Owner unbans memorial
        with boa.env.prank(owner):
            core.unban_memorial(memorial_id)
            
        assert core.memorials(memorial_id)[6] is False  # is_banned cleared
        assert core.memorials(memorial_id)[4] is True   # is_public still True
        assert core.is_memorial_visible(memorial_id) is True
        assert core.is_memorial_hidden(memorial_id) is False

    def test_force_ban_preserves_private_status(self, core, owner, alice):
        """Private memorial remains unlisted after unban."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, False, value=CREATION_FEE)
        
        memorial_id = 1
        assert core.memorials(memorial_id)[4] is False  # is_public = False
        assert core.is_memorial_visible(memorial_id) is False
        assert core.is_memorial_hidden(memorial_id) is False
        
        # Owner applies force_ban
        with boa.env.prank(owner):
            core.force_ban(memorial_id)
            
        assert core.memorials(memorial_id)[6] is True
        assert core.is_memorial_hidden(memorial_id) is True
        assert core.is_memorial_visible(memorial_id) is False
        
        # Owner unbans
        with boa.env.prank(owner):
            core.unban_memorial(memorial_id)
            
        assert core.memorials(memorial_id)[6] is False
        assert core.memorials(memorial_id)[4] is False  # author's private preference preserved
        assert core.is_memorial_visible(memorial_id) is False
        assert core.is_memorial_hidden(memorial_id) is False

    def test_force_ban_non_owner_reverts(self, core, alice):
        """Non-owner cannot call force_ban."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
            with boa.reverts("Not owner"):
                core.force_ban(1)

    def test_unban_memorial_non_owner_reverts(self, core, alice):
        """Non-owner cannot call unban_memorial."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
            with boa.reverts("Not owner"):
                core.unban_memorial(1)

    def test_dismiss_reports_non_owner_reverts(self, core, alice):
        """Non-owner cannot call dismiss_reports."""
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
            with boa.reverts("Not owner"):
                core.dismiss_reports(1)


# ──────────────────────────────────────────────────────────────
# Public View Methods Graceful Exit
# ──────────────────────────────────────────────────────────────

class TestPublicViewMethodsGracefulExit:
    def test_nonexistent_memorial_returns_false_without_revert(self, core, alice):
        """Nonexistent memorial IDs (0 or > memorial_count) return False safely."""
        # Before any memorial exists
        assert core.memorial_count() == 0
        assert core.is_memorial_visible(0) is False
        assert core.is_memorial_hidden(0) is False
        assert core.is_memorial_flagged(0) is False
        assert core.is_memorial_visible(1) is False
        assert core.is_memorial_hidden(1) is False
        assert core.is_memorial_flagged(1) is False
        assert core.is_memorial_visible(999) is False
        assert core.is_memorial_hidden(999) is False
        assert core.is_memorial_flagged(999) is False

        # After a memorial is created
        boa.env.set_balance(alice, 10**18)
        with boa.env.prank(alice):
            core.create_memorial(SAMPLE_PET_NAME, SAMPLE_ARWEAVE_TX, True, value=CREATION_FEE)
        assert core.memorial_count() == 1

        # Existing memorial #1
        assert core.is_memorial_visible(1) is True
        assert core.is_memorial_hidden(1) is False
        assert core.is_memorial_flagged(1) is False

        # Still safe for invalid IDs
        assert core.is_memorial_visible(0) is False
        assert core.is_memorial_hidden(0) is False
        assert core.is_memorial_flagged(0) is False
        assert core.is_memorial_visible(2) is False
        assert core.is_memorial_hidden(2) is False
        assert core.is_memorial_flagged(2) is False
        assert core.is_memorial_visible(100) is False
        assert core.is_memorial_hidden(100) is False
        assert core.is_memorial_flagged(100) is False



