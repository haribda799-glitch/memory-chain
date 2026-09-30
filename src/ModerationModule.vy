# pragma version ~=0.4.3
# pragma evm-version cancun

"""
@title ModerationModule — Stateless moderation rule engine
@license MIT
@author ericozz
@notice Pure logic module for community-driven moderation.
        Implements ceiling division to eliminate truncation bias
        and enforces a minimum user quorum to prevent early-stage Sybil censorship.

        Invariants:
        1. Ceiling Division: thresholds never drop below the declared percentage.
        2. Cold Start Guard: automatic hiding requires at least MIN_COMMUNITY_QUORUM users.
        3. Flagging active at all stages to provide early warning to the Council.
"""

# Минимальный размер сообщества для включения автоматического скрытия
MIN_COMMUNITY_QUORUM: constant(uint256) = 20

# Процентные ставки порогов
HIDDEN_PERCENT: constant(uint256) = 20
FLAGGED_PERCENT: constant(uint256) = 5

# Минимальные абсолютные барьеры
MIN_FLAGGED_THRESHOLD: constant(uint256) = 2


@external
@pure
def is_hidden(report_weight: uint256, total_users: uint256) -> bool:
    """
    @notice Determines if a memorial should be hidden from the gallery.
    @dev Uses ceiling division: (users * 20 + 99) // 100.
         Requires total_users >= MIN_COMMUNITY_QUORUM to prevent cheap early Sybil attacks.
    @param report_weight Accumulated weighted report score on the memorial.
    @param total_users   Total number of memorial owners (Sybil-resistant base).
    @return True if quorum reached and report_weight >= ceil(20% of total_users).
    """
    # Защита от деления на 0 и атаки ранней стадии
    if total_users < MIN_COMMUNITY_QUORUM:
        return False

    # Ceil division: гарантирует округление строго вверх
    threshold: uint256 = (total_users * HIDDEN_PERCENT + 99) // 100

    return report_weight >= threshold


@external
@pure
def is_flagged(report_weight: uint256, total_users: uint256) -> bool:
    """
    @notice Determines if a memorial should be flagged for review.
    @dev Operates even before quorum to alert Council dashboard. Uses ceiling division.
    @param report_weight Accumulated weighted report score on the memorial.
    @param total_users   Total number of memorial owners (Sybil-resistant base).
    @return True if report_weight >= max(ceil(5% of total_users), MIN_FLAGGED_THRESHOLD).
    """
    if total_users == 0:
        return False

    # Ceil division: (users * 5 + 99) // 100
    threshold: uint256 = (total_users * FLAGGED_PERCENT + 99) // 100
    if threshold < MIN_FLAGGED_THRESHOLD:
        threshold = MIN_FLAGGED_THRESHOLD

    return report_weight >= threshold
