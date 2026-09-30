# pragma version ~=0.4.3
# pragma evm-version cancun

"""
@title MemoryChainCore — Central Memorial Registry, Candle Lighting & Moderation
@license MIT
@author ericozz
@notice Core contract for the Memory Chain protocol.

        Architecture:
        - Maintains an on-chain registry of pet memorials with Arweave URIs.
        - Handles candle lighting (paid tribute) with configurable pricing.
        - Stores per-memorial weighted report scores for community moderation.
        - Delegates moderation logic to an external ModerationModule via
          a 48-hour Timelock upgrade pattern (with cancellation support).
        - Granular pause controls for creation and candle operations.
        - 2-Step Ownership Transfer for safe Multisig migration.

        Immutability guarantees:
        - Once created, a memorial's arweave_uri, owner, and pet_name
          CANNOT be modified. This ensures permanent provenance.
        - Memorials are NOT deletable.

        Sybil resistance (V-01, V-02):
        - Economic barrier: configurable creation_fee required to create a memorial.
        - Only addresses that own a memorial can submit reports.
        - Time-weighted reporting: older accounts carry more influence.
        - Epoch-based tracking allows re-reporting after admin dismissal.
"""


# ──────────────────────────────────────────────────────────────
# External Interface
# ──────────────────────────────────────────────────────────────

interface IModerationModule:
    def is_hidden(report_weight: uint256, total_users: uint256) -> bool: pure
    def is_flagged(report_weight: uint256, total_users: uint256) -> bool: pure


# ──────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────

TIMELOCK_DELAY: constant(uint256) = 172800  # 48 hours in seconds
TIMELOCK_GRACE_PERIOD: constant(uint256) = 604800  # 7 дней в секундах

MIN_CANDLE_PRICE: constant(uint256) = 100_000_000_000_000       # 0.0001 ETH
MAX_CANDLE_PRICE: constant(uint256) = 10_000_000_000_000_000    # 0.01 ETH

MIN_CREATION_FEE: constant(uint256) = 100_000_000_000_000       # 0.0001 ETH
MAX_CREATION_FEE: constant(uint256) = 10_000_000_000_000_000    # 0.01 ETH

MAX_REPORTS: constant(uint256) = 999_999_999                    # Sentinel for force_ban

# Time-weighted report thresholds (seconds)
WEIGHT_TIER_1_DAYS: constant(uint256) = 604800    # 7 days
WEIGHT_TIER_2_DAYS: constant(uint256) = 2592000   # 30 days

# Константы длительности горения свечи (секунды)
DURATION_TIER_1: constant(uint256) = 3600    # 1 час
DURATION_TIER_2: constant(uint256) = 18000   # 5 часов
DURATION_TIER_3: constant(uint256) = 43200   # 12 часов
DURATION_TIER_4: constant(uint256) = 86400   # 24 часа

# Множители стоимости от базового candle_price
MULT_TIER_1: constant(uint256) = 1
MULT_TIER_2: constant(uint256) = 3
MULT_TIER_3: constant(uint256) = 6
MULT_TIER_4: constant(uint256) = 10

# Предохранитель горизонта горения (1 год)
MAX_EXPIRY_HORIZON: constant(uint256) = 31536000


# ──────────────────────────────────────────────────────────────
# Data Structures
# ──────────────────────────────────────────────────────────────

struct Memorial:
    owner: address
    arweave_uri: String[64]
    pet_name: String[128]
    created_at: uint256
    is_public: bool
    is_hidden: bool
    is_banned: bool


# ──────────────────────────────────────────────────────────────
# Storage Variables
# ──────────────────────────────────────────────────────────────

# Governance — 2-Step Ownership Transfer & Treasury
owner: public(address)
pending_owner: public(address)
treasury: public(address)

# Moderation module (upgradeable via Timelock)
moderation_module: public(address)
proposed_moderation_module: public(address)
moderation_module_timelock: public(uint256)

# Pricing
candle_price: public(uint256)
creation_fee: public(uint256)

# Granular pause controls
creation_paused: public(bool)
candles_paused: public(bool)

# Memorial registry
memorials: public(HashMap[uint256, Memorial])
memorial_count: public(uint256)

# Sybil-resistant user tracking
total_memorial_owners: public(uint256)
has_created_memorial: public(HashMap[address, bool])
user_joined_at: public(HashMap[address, uint256])

# Weighted report tracking with epoch support (V-07)
report_weight: public(HashMap[uint256, uint256])
report_epoch: public(HashMap[uint256, uint256])
has_reported: public(HashMap[uint256, HashMap[address, uint256]])

# Candle expiration & totals tracking
candle_expires_at: public(HashMap[uint256, uint256])
total_candles_lit: public(HashMap[uint256, uint256])


# ──────────────────────────────────────────────────────────────
# Events
# ──────────────────────────────────────────────────────────────

event MemorialCreated:
    tokenId: indexed(uint256)
    owner: indexed(address)
    pet_name: String[128]
    arweave_uri: String[64]
    created_at: uint256

event CandleLit:
    memorialId: indexed(uint256)
    lighter: indexed(address)
    amount: uint256
    candleType: uint8

event MemorialReported:
    memorialId: indexed(uint256)
    reporter: indexed(address)
    weight: uint256
    total_weight: uint256

event ModerationModuleProposed:
    newModule: address
    readyAt: uint256

event ModerationModuleProposalCancelled:
    cancelledModule: address

event ModerationModuleUpdated:
    newModule: address

event CandlePriceUpdated:
    newPrice: uint256

event CreationFeeUpdated:
    newFee: uint256

event PauseToggled:
    creationPaused: bool
    candlesPaused: bool

event MemorialVisibilityToggled:
    memorialId: indexed(uint256)
    is_public: bool

event OwnershipProposed:
    current_owner: indexed(address)
    pending_owner: indexed(address)

event OwnershipTransferred:
    previous_owner: indexed(address)
    new_owner: indexed(address)

event ReportsDismissed:
    memorialId: indexed(uint256)
    new_epoch: uint256

event MemorialBanned:
    memorialId: indexed(uint256)

event MemorialUnbanned:
    memorialId: indexed(uint256)

event TreasuryUpdated:
    new_treasury: indexed(address)



# ──────────────────────────────────────────────────────────────
# Constructor
# ──────────────────────────────────────────────────────────────

@deploy
def __init__(_moderation_module: address, _initial_candle_price: uint256, _initial_creation_fee: uint256):
    """
    @notice Deploy MemoryChainCore with initial moderation module, candle price, and creation fee.
    @param _moderation_module Address of the deployed ModerationModule contract.
    @param _initial_candle_price Initial price for lighting a candle (in wei).
    @param _initial_creation_fee Initial fee for creating a memorial (in wei).
    """
    self.owner = msg.sender
    self.treasury = msg.sender
    self.moderation_module = _moderation_module
    assert _initial_candle_price >= MIN_CANDLE_PRICE, "Price below minimum"
    assert _initial_candle_price <= MAX_CANDLE_PRICE, "Price above maximum"
    self.candle_price = _initial_candle_price
    assert _initial_creation_fee >= MIN_CREATION_FEE, "Fee below minimum"
    assert _initial_creation_fee <= MAX_CREATION_FEE, "Fee above maximum"
    self.creation_fee = _initial_creation_fee
    self.creation_paused = False
    self.candles_paused = False


# ──────────────────────────────────────────────────────────────
# Public Functions — Memorial Creation
# ──────────────────────────────────────────────────────────────

@external
@payable
def create_memorial(_pet_name: String[128], _arweave_uri: String[64], _is_public: bool):
    """
    @notice Create a new pet memorial. Immutable after creation.
            Requires creation_fee as economic Sybil barrier.
    @param _pet_name    Name of the pet (max 128 chars).
    @param _arweave_uri Arweave transaction ID for metadata (max 64 chars).
    @param _is_public   Whether the memorial is visible in the public gallery.
    """
    assert not self.creation_paused, "Creation paused"
    assert msg.value == self.creation_fee, "Exact creation fee required"

    self.memorial_count += 1
    token_id: uint256 = self.memorial_count

    self.memorials[token_id] = Memorial(
        owner=msg.sender,
        arweave_uri=_arweave_uri,
        pet_name=_pet_name,
        created_at=block.timestamp,
        is_public=_is_public,
        is_hidden=False,
        is_banned=False,
    )

    # Track unique memorial owners for Sybil-resistant moderation thresholds
    if not self.has_created_memorial[msg.sender]:
        self.has_created_memorial[msg.sender] = True
        self.total_memorial_owners += 1
        self.user_joined_at[msg.sender] = block.timestamp

    log MemorialCreated(
        tokenId=token_id,
        owner=msg.sender,
        pet_name=_pet_name,
        arweave_uri=_arweave_uri,
        created_at=block.timestamp,
    )


@external
def toggle_public(_memorial_id: uint256):
    """
    @notice Toggle public gallery visibility of a memorial. Memorial owner only.
    @param _memorial_id ID of the memorial to toggle.
    """
    assert _memorial_id > 0 and _memorial_id <= self.memorial_count, "Invalid memorial"
    assert not self.memorials[_memorial_id].is_banned, "Memorial is banned"
    assert self.memorials[_memorial_id].owner == msg.sender, "Not owner"

    # Cache current state in memory before toggling (gas optimization)
    current_visibility: bool = self.memorials[_memorial_id].is_public
    new_visibility: bool = not current_visibility
    self.memorials[_memorial_id].is_public = new_visibility

    log MemorialVisibilityToggled(memorialId=_memorial_id, is_public=new_visibility)


# ──────────────────────────────────────────────────────────────
# Public Functions — Candle Lighting
# ──────────────────────────────────────────────────────────────

@external
@payable
def light_candle(_memorial_id: uint256, _candle_type: uint8):
    """
    @notice Light a candle for a memorial with a deterministic tier (1-4).
            Requires exact payment matching candle_price * tier multiplier.
    @param _memorial_id ID of the memorial to honor.
    @param _candle_type Type/tier of candle (1-4).
    """
    assert not self.candles_paused, "Candles paused"
    assert _memorial_id > 0 and _memorial_id <= self.memorial_count, "Invalid memorial"
    assert not self.memorials[_memorial_id].is_banned, "Memorial is banned"
    assert _candle_type >= 1 and _candle_type <= 4, "Invalid candle type"

    duration: uint256 = DURATION_TIER_1
    multiplier: uint256 = MULT_TIER_1

    if _candle_type == 2:
        duration = DURATION_TIER_2
        multiplier = MULT_TIER_2
    elif _candle_type == 3:
        duration = DURATION_TIER_3
        multiplier = MULT_TIER_3
    elif _candle_type == 4:
        duration = DURATION_TIER_4
        multiplier = MULT_TIER_4

    required_price: uint256 = self.candle_price * multiplier
    assert msg.value == required_price, "Incorrect payment for tier"

    self._extend_candle_expiry(_memorial_id, duration)
    self.total_candles_lit[_memorial_id] += 1

    log CandleLit(
        memorialId=_memorial_id,
        lighter=msg.sender,
        amount=msg.value,
        candleType=_candle_type,
    )


@external
@payable
def donate_and_light(_memorial_id: uint256):
    """
    @notice Make an open donation to honor a memorial and extend its flame.
            Requires payment >= candle_price. Time added scales with full candle_price steps.
    @param _memorial_id ID of the memorial to honor.
    """
    assert not self.candles_paused, "Candles paused"
    assert _memorial_id > 0 and _memorial_id <= self.memorial_count, "Invalid memorial"
    assert not self.memorials[_memorial_id].is_banned, "Memorial is banned"
    assert msg.value >= self.candle_price, "Donation below candle price"

    # 1 базовый интервал (1 час) за каждый полный шаг текущей цены
    added_hours: uint256 = msg.value // self.candle_price
    
    duration: uint256 = added_hours * DURATION_TIER_1
    self._extend_candle_expiry(_memorial_id, duration)
    self.total_candles_lit[_memorial_id] += 1

    log CandleLit(
        memorialId=_memorial_id,
        lighter=msg.sender,
        amount=msg.value,
        candleType=0,
    )


# ──────────────────────────────────────────────────────────────
# Public Functions — Reporting (Time-Weighted + Epoch-Based)
# ──────────────────────────────────────────────────────────────

@external
def report_memorial(_memorial_id: uint256):
    """
    @notice Report a memorial for review. Sybil-guarded with time-weighted voting.
            - Caller must own a memorial (economic + identity barrier).
            - Each address can report a given memorial once per epoch.
            - Report weight scales with account age:
              < 7 days  → weight 1
              7–30 days → weight 2
              > 30 days → weight 3
    @param _memorial_id ID of the memorial to report.
    """
    assert _memorial_id > 0 and _memorial_id <= self.memorial_count, "Invalid memorial"
    assert not self.memorials[_memorial_id].is_banned, "Memorial already banned"
    assert self.has_created_memorial[msg.sender], "Sybil Guard: Must own a memorial to report"

    # Epoch-based duplicate check (V-07):
    # has_reported stores the epoch at which the user last reported.
    # A value less than current epoch means the user hasn't reported in this epoch.
    current_epoch: uint256 = self.report_epoch[_memorial_id]
    assert self.has_reported[_memorial_id][msg.sender] <= current_epoch, "Already reported"

    # Mark as reported in the current epoch
    # Store epoch + 1 so the comparison `<= current_epoch` fails on re-report
    self.has_reported[_memorial_id][msg.sender] = current_epoch + 1

    # Calculate time-weighted report score
    account_age: uint256 = block.timestamp - self.user_joined_at[msg.sender]
    weight: uint256 = 1
    if account_age >= WEIGHT_TIER_2_DAYS:
        weight = 3
    elif account_age >= WEIGHT_TIER_1_DAYS:
        weight = 2

    self.report_weight[_memorial_id] += weight

    # Community ratchet: once hidden by reports, lock is_hidden in storage until dismissed
    if not self.memorials[_memorial_id].is_hidden:
        if staticcall IModerationModule(self.moderation_module).is_hidden(
            self.report_weight[_memorial_id],
            self.total_memorial_owners,
        ):
            self.memorials[_memorial_id].is_hidden = True

    log MemorialReported(
        memorialId=_memorial_id,
        reporter=msg.sender,
        weight=weight,
        total_weight=self.report_weight[_memorial_id],
    )


# ──────────────────────────────────────────────────────────────
# View Functions — Moderation Status & Gallery Visibility
# ──────────────────────────────────────────────────────────────

@external
@view
def is_memorial_visible(_memorial_id: uint256) -> bool:
    """
    @notice Единая точка правды для отображения в публичной галерее.
    @return True, если мемориал публичен, не скрыт сообществом и не забанен Советом.
    """
    if _memorial_id == 0 or _memorial_id > self.memorial_count:
        return False

    mem: Memorial = self.memorials[_memorial_id]

    # Быстрый выход: автор сделал приватным или Совет наложил бан
    if not mem.is_public or mem.is_banned:
        return False

    # Проверка храповика сообщества
    if mem.is_hidden:
        return False

    # Динамическая проверка через текущий модуль
    return not staticcall IModerationModule(self.moderation_module).is_hidden(
        self.report_weight[_memorial_id],
        self.total_memorial_owners,
    )


@external
@view
def is_memorial_hidden(_memorial_id: uint256) -> bool:
    """
    @notice Check if a memorial should be hidden from the gallery (backward compatibility).
    @param _memorial_id ID of the memorial to check.
    @return True if the memorial is banned, hidden by community ratchet, or has enough reports.
    """
    if _memorial_id == 0 or _memorial_id > self.memorial_count:
        return False

    if self.memorials[_memorial_id].is_banned or self.memorials[_memorial_id].is_hidden:
        return True

    return staticcall IModerationModule(self.moderation_module).is_hidden(
        self.report_weight[_memorial_id],
        self.total_memorial_owners,
    )


@external
@view
def is_memorial_flagged(_memorial_id: uint256) -> bool:
    """
    @notice Check if a memorial should be flagged for review.
    @param _memorial_id ID of the memorial to check.
    @return True if the memorial has enough weighted reports to be flagged.
    """
    if _memorial_id == 0 or _memorial_id > self.memorial_count:
        return False

    return staticcall IModerationModule(self.moderation_module).is_flagged(
        self.report_weight[_memorial_id],
        self.total_memorial_owners,
    )


# ──────────────────────────────────────────────────────────────
# Owner Functions — 2-Step Ownership Transfer
# ──────────────────────────────────────────────────────────────

@external
def propose_owner(_new_owner: address):
    """
    @notice Propose a new owner. The new owner must call accept_ownership() to finalize.
    @param _new_owner Address of the proposed new owner.
    """
    assert msg.sender == self.owner, "Not owner"
    assert _new_owner != empty(address), "Invalid address"
    assert _new_owner != self.owner, "Already owner"

    self.pending_owner = _new_owner

    log OwnershipProposed(
        current_owner=msg.sender,
        pending_owner=_new_owner,
    )


@external
def accept_ownership():
    """
    @notice Accept pending ownership transfer. Only callable by pending_owner.
    """
    assert msg.sender == self.pending_owner, "Not pending owner"

    previous_owner: address = self.owner
    self.owner = self.pending_owner
    self.pending_owner = empty(address)

    log OwnershipTransferred(
        previous_owner=previous_owner,
        new_owner=self.owner,
    )


# ──────────────────────────────────────────────────────────────
# Owner Functions — Configuration
# ──────────────────────────────────────────────────────────────

@external
def set_candle_price(_new_price: uint256):
    """
    @notice Update the candle lighting price. Owner only.
    @param _new_price New price in wei. Must be within [MIN, MAX] bounds.
    """
    assert msg.sender == self.owner, "Not owner"
    assert _new_price >= MIN_CANDLE_PRICE, "Price below minimum"
    assert _new_price <= MAX_CANDLE_PRICE, "Price above maximum"

    self.candle_price = _new_price

    log CandlePriceUpdated(newPrice=_new_price)


@external
def set_creation_fee(_new_fee: uint256):
    """
    @notice Update the memorial creation fee. Owner only.
    @param _new_fee New fee in wei. Must be within [MIN_CREATION_FEE, MAX_CREATION_FEE] bounds.
    """
    assert msg.sender == self.owner, "Not owner"
    assert _new_fee >= MIN_CREATION_FEE, "Fee below minimum"
    assert _new_fee <= MAX_CREATION_FEE, "Fee above maximum"

    self.creation_fee = _new_fee

    log CreationFeeUpdated(newFee=_new_fee)


@external
def toggle_pause(_creation_paused: bool, _candles_paused: bool):
    """
    @notice Toggle granular pause controls. Owner only.
    @param _creation_paused Whether memorial creation is paused.
    @param _candles_paused  Whether candle lighting is paused.
    """
    assert msg.sender == self.owner, "Not owner"

    self.creation_paused = _creation_paused
    self.candles_paused = _candles_paused

    log PauseToggled(
        creationPaused=_creation_paused,
        candlesPaused=_candles_paused,
    )


@external
def set_treasury(_new_treasury: address):
    """
    @notice Update treasury address. Owner only.
    @param _new_treasury New treasury address.
    """
    assert msg.sender == self.owner, "Not owner"
    assert _new_treasury != empty(address), "Invalid treasury address"
    assert _new_treasury != self.treasury, "Already set to this address"

    self.treasury = _new_treasury

    log TreasuryUpdated(new_treasury=_new_treasury)


# ──────────────────────────────────────────────────────────────
# Internal Functions
# ──────────────────────────────────────────────────────────────

@internal
def _verify_moderation_module(_module: address):
    """
    @notice Smoke-test to verify that _module adheres to IModerationModule ABI.
            Reverts if _module is an EOA or does not return expected bool values.
    """
    assert _module != empty(address), "Invalid module address"

    # Зондирующий staticcall: если returndata пустой (EOA) или некорректный — транзакция упадет
    dummy_hidden: bool = staticcall IModerationModule(_module).is_hidden(0, 1)
    dummy_flagged: bool = staticcall IModerationModule(_module).is_flagged(0, 1)


@internal
def _extend_candle_expiry(_memorial_id: uint256, _duration: uint256):
    """
    @notice Extend candle burn duration with a cap at block.timestamp + MAX_EXPIRY_HORIZON.
    """
    current_expiry: uint256 = self.candle_expires_at[_memorial_id]
    start_time: uint256 = block.timestamp
    if current_expiry > block.timestamp:
        start_time = current_expiry

    new_expiry: uint256 = start_time + _duration
    max_allowed: uint256 = block.timestamp + MAX_EXPIRY_HORIZON
    if new_expiry > max_allowed:
        new_expiry = max_allowed

    self.candle_expires_at[_memorial_id] = new_expiry


# ──────────────────────────────────────────────────────────────
# Owner Functions — Moderation Module Upgrade (Timelock)
# ──────────────────────────────────────────────────────────────

@external
def propose_moderation_module(_new_module: address):
    """
    @notice Propose a new moderation module. Takes effect after TIMELOCK_DELAY.
    @param _new_module Address of the new ModerationModule contract.
    """
    assert msg.sender == self.owner, "Not owner"
    self._verify_moderation_module(_new_module)

    self.proposed_moderation_module = _new_module
    self.moderation_module_timelock = block.timestamp + TIMELOCK_DELAY

    log ModerationModuleProposed(
        newModule=_new_module,
        readyAt=self.moderation_module_timelock,
    )


@external
def cancel_moderation_module_proposal():
    """
    @notice Cancel a pending moderation module proposal. Owner only. (V-08)
    """
    assert msg.sender == self.owner, "Not owner"
    assert self.proposed_moderation_module != empty(address), "No module proposed"

    cancelled: address = self.proposed_moderation_module
    self.proposed_moderation_module = empty(address)
    self.moderation_module_timelock = 0

    log ModerationModuleProposalCancelled(cancelledModule=cancelled)


@external
def apply_moderation_module():
    """
    @notice Apply the previously proposed moderation module after the timelock expires.
            Reverts if the proposal has exceeded the execution grace period.
    """
    assert msg.sender == self.owner, "Not owner"
    assert self.proposed_moderation_module != empty(address), "No module proposed"
    assert block.timestamp >= self.moderation_module_timelock, "Timelock not expired"
    assert block.timestamp <= self.moderation_module_timelock + TIMELOCK_GRACE_PERIOD, "Proposal expired"

    # Повторная валидация перед окончательной фиксацией
    self._verify_moderation_module(self.proposed_moderation_module)

    self.moderation_module = self.proposed_moderation_module
    self.proposed_moderation_module = empty(address)
    self.moderation_module_timelock = 0

    log ModerationModuleUpdated(newModule=self.moderation_module)


# ──────────────────────────────────────────────────────────────
# Owner Functions — Fund Withdrawal & Admin Moderation
# ──────────────────────────────────────────────────────────────

@external
@nonreentrant
def withdraw():
    """
    @notice Withdraw accumulated payments to the treasury. Owner only.
            Uses raw_call for Gnosis Safe compatibility (V-04).
    """
    assert msg.sender == self.owner, "Not owner"
    balance: uint256 = self.balance
    assert balance > 0, "No balance"

    raw_call(self.treasury, b"", value=balance)


@external
def dismiss_reports(_memorial_id: uint256):
    """
    @notice Reset report weight, clear community hidden flag, and advance the epoch for a memorial. Owner only.
            Advancing the epoch allows users to re-report in the new epoch. (V-07)
    """
    assert msg.sender == self.owner, "Not owner"
    assert _memorial_id > 0 and _memorial_id <= self.memorial_count, "Invalid memorial"
    assert not self.memorials[_memorial_id].is_banned, "Memorial is banned; use unban"

    self.memorials[_memorial_id].is_hidden = False
    self.report_weight[_memorial_id] = 0
    self.report_epoch[_memorial_id] += 1

    log ReportsDismissed(
        memorialId=_memorial_id,
        new_epoch=self.report_epoch[_memorial_id],
    )


@external
def force_ban(_memorial_id: uint256):
    """
    @notice Force ban a memorial by setting is_banned to True. Owner only.
            The user's is_public preference is preserved.
    """
    assert msg.sender == self.owner, "Not owner"
    assert _memorial_id > 0 and _memorial_id <= self.memorial_count, "Invalid memorial"
    assert not self.memorials[_memorial_id].is_banned, "Already banned"
    
    self.memorials[_memorial_id].is_banned = True

    log MemorialBanned(memorialId=_memorial_id)


@external
def unban_memorial(_memorial_id: uint256):
    """
    @notice Unban a previously banned memorial by setting is_banned to False. Owner only.
    """
    assert msg.sender == self.owner, "Not owner"
    assert _memorial_id > 0 and _memorial_id <= self.memorial_count, "Invalid memorial"
    assert self.memorials[_memorial_id].is_banned, "Not banned"
    
    self.memorials[_memorial_id].is_banned = False

    log MemorialUnbanned(memorialId=_memorial_id)


