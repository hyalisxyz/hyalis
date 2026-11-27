// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, IAggregatorV3, IVenueAdapter, IFeedSource, IWETH, SafeERC20} from "./Interfaces.sol";

/// @title AgentVault
/// @notice One user's funds, traded by an AI agent within limits the user sets and the
/// contract enforces.
///
///  - The owner deposits by plain transfer, withdraws any token at any time (even while paused),
///    sets the limits, chooses the tokens and venues, and can revoke the agent at once.
///  - The executor (the agent's key) can only swap. It cannot withdraw, change limits, or send
///    tokens anywhere but back into this vault.
///  - Every swap is valued with Chainlink and checked against: allowed tokens and venues, a
///    maximum trade size, a daily volume cap, a per-token holding cap, and a minimum output
///    implied by the oracle price minus the allowed slippage. The output is measured from this
///    vault's own balances, not taken from the venue's word.
///  - Each swap records the hash of the agent's decision receipt, linking the on-chain trade
///    to the sealed reason for it.
///  - When the owner stops the agent, the executor may hand everything back, but only to the
///    owner: returnToOwner has no recipient argument. WETH comes back as ETH.
contract AgentVault {
    using SafeERC20 for address;

    struct Policy {
        /// @notice Largest single trade, in USD with 8 decimals.
        uint256 maxTradeUsd;
        /// @notice Total traded per UTC day, in USD with 8 decimals.
        uint256 maxDailyUsd;
        /// @notice Largest value held in any one non-base token after a buy, USD 8 decimals; 0 = no cap.
        uint256 maxTokenUsd;
        /// @notice How far below the oracle-implied output a fill may land, in basis points.
        uint16 maxSlippageBps;
    }

    uint16 public constant MAX_SLIPPAGE_CAP_BPS = 500;

    address public immutable owner;
    IFeedSource public immutable feeds;
    /// @notice The token positions are measured against (USDG); never subject to the holding cap.
    address public immutable baseToken;
    /// @notice Wrapped ETH, returned to the owner as ETH.
    address public immutable weth;

    address public executor;
    bool public paused;
    Policy public policy;
    mapping(address token => bool) public tokenAllowed;
    mapping(address adapter => bool) public adapterAllowed;

    uint64 public day;
    uint256 public dayVolumeUsd;
    uint256 private locked = 1;

    event ExecutorSet(address executor);
    event PolicySet(Policy policy);
    event TokenAllowed(address token, bool allowed);
    event AdapterAllowed(address adapter, bool allowed);
    event Paused(bool paused);
    event Withdrawn(address token, uint256 amount, address to);
    event Returned(address token, uint256 amount);
    event Swapped(
        address indexed adapter,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 valueInUsd,
        bytes32 decision
    );

    error NotOwner();
    error NotExecutor();
    error IsPaused();
    error Reentrant();
    error BadPolicy();
    error TokenNotAllowed(address token);
    error AdapterNotAllowed(address adapter);
    error SameToken();
    error ZeroAmount();
    error NoFeed(address token);
    error BadPrice(address token);
    error StalePrice(address token, uint256 updatedAt);
    error TradeTooLarge(uint256 valueUsd, uint256 maxUsd);
    error DailyLimit(uint256 wouldBeUsd, uint256 maxUsd);
    error HoldingLimit(address token, uint256 valueUsd, uint256 maxUsd);
    error OutputTooLow(uint256 amountOut, uint256 required);
    error OverSpent(uint256 spent, uint256 amountIn);
    error NotOwnerOrExecutor();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrant();
        locked = 2;
        _;
        locked = 1;
    }

    /// @param tokens_ Tokens the agent may trade besides the base token; each must have a feed.
    /// @param adapters_ Venues the agent may route through.
    constructor(
        address owner_,
        address executor_,
        IFeedSource feeds_,
        address baseToken_,
        address weth_,
        Policy memory policy_,
        address[] memory tokens_,
        address[] memory adapters_
    ) {
        require(owner_ != address(0) && address(feeds_) != address(0) && baseToken_ != address(0), "zero address");
        owner = owner_;
        feeds = feeds_;
        baseToken = baseToken_;
        weth = weth_;
        executor = executor_;
        _setPolicy(policy_);
        tokenAllowed[baseToken_] = true;
        emit ExecutorSet(executor_);
        emit TokenAllowed(baseToken_, true);
        for (uint256 i; i < tokens_.length; ++i) {
            (address feed,) = feeds_.feedOf(tokens_[i]);
            if (feed == address(0)) revert NoFeed(tokens_[i]);
            tokenAllowed[tokens_[i]] = true;
            emit TokenAllowed(tokens_[i], true);
        }
        for (uint256 i; i < adapters_.length; ++i) {
            adapterAllowed[adapters_[i]] = true;
            emit AdapterAllowed(adapters_[i], true);
        }
    }

    // ------------------------------------------------------------------ owner

    function setExecutor(address executor_) external onlyOwner {
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    function setPolicy(Policy calldata p) external onlyOwner {
        _setPolicy(p);
    }

    function setTokens(address[] calldata tokens, bool allowed) external onlyOwner {
        for (uint256 i; i < tokens.length; ++i) {
            if (allowed) {
                (address feed,) = feeds.feedOf(tokens[i]);
                if (feed == address(0)) revert NoFeed(tokens[i]);
            }
            tokenAllowed[tokens[i]] = allowed;
            emit TokenAllowed(tokens[i], allowed);
        }
    }

    function setAdapters(address[] calldata adapters, bool allowed) external onlyOwner {
        for (uint256 i; i < adapters.length; ++i) {
            adapterAllowed[adapters[i]] = allowed;
            emit AdapterAllowed(adapters[i], allowed);
        }
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    /// @notice Always available to the owner, paused or not.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        token.safeTransfer(to, amount);
        emit Withdrawn(token, amount, to);
    }

    /// @notice Hands the whole balance of each token back to the owner, and nowhere else. The
    /// owner or the executor may call it (the executor, when the owner stops the agent from the
    /// app). WETH is unwrapped and sent as ETH.
    function returnToOwner(address[] calldata tokens) external nonReentrant {
        if (msg.sender != owner && msg.sender != executor) revert NotOwnerOrExecutor();
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            uint256 b = IERC20(t).balanceOf(address(this));
            if (b == 0) continue;
            if (t == weth && weth != address(0)) {
                IWETH(weth).withdraw(b);
                (bool ok,) = owner.call{value: b}("");
                // A wallet that cannot take ETH (some smart wallets) gets WETH instead, so funds
                // never stay stuck here because of how the owner's wallet handles ETH.
                if (!ok) {
                    IWETH(weth).deposit{value: b}();
                    t.safeTransfer(owner, b);
                }
            } else {
                t.safeTransfer(owner, b);
            }
            emit Returned(t, b);
        }
    }

    /// @dev ETH arrives only from unwrapping WETH on the way back to the owner.
    receive() external payable {
        require(msg.sender == weth, "no ETH");
    }

    function _setPolicy(Policy memory p) private {
        if (p.maxSlippageBps > MAX_SLIPPAGE_CAP_BPS || p.maxTradeUsd == 0 || p.maxDailyUsd < p.maxTradeUsd) revert BadPolicy();
        policy = p;
        emit PolicySet(p);
    }

    // ------------------------------------------------------------------ executor

    /// @notice Swaps `amountIn` of `tokenIn` for at least `minOut` of `tokenOut` through an
    /// allowed adapter, within the policy. `decision` is the hash of the agent's receipt.
    function swap(
        address adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data,
        bytes32 decision
    ) external nonReentrant returns (uint256 amountOut) {
        if (msg.sender != executor) revert NotExecutor();
        if (paused) revert IsPaused();
        if (!adapterAllowed[adapter]) revert AdapterNotAllowed(adapter);
        if (!tokenAllowed[tokenIn]) revert TokenNotAllowed(tokenIn);
        if (!tokenAllowed[tokenOut]) revert TokenNotAllowed(tokenOut);
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert ZeroAmount();

        (uint256 valueIn, uint256 required) = _checkAndBook(tokenIn, tokenOut, amountIn, minOut);
        amountOut = _execute(adapter, tokenIn, tokenOut, amountIn, required, data);
        _checkHolding(tokenOut);
        emit Swapped(adapter, tokenIn, tokenOut, amountIn, amountOut, valueIn, decision);
    }

    /// @dev Values the trade, enforces size and daily volume, books the volume, and returns the
    /// least output allowed: the oracle-implied amount minus the slippage allowance, or `minOut`
    /// if that is higher.
    function _checkAndBook(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        private
        returns (uint256 valueIn, uint256 required)
    {
        Policy memory p = policy;
        (uint256 priceIn, uint8 decIn) = _price(tokenIn);
        valueIn = (amountIn * priceIn) / 10 ** decIn; // USD, 8 decimals
        if (valueIn > p.maxTradeUsd) revert TradeTooLarge(valueIn, p.maxTradeUsd);
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 vol = today == day ? dayVolumeUsd + valueIn : valueIn;
        if (vol > p.maxDailyUsd) revert DailyLimit(vol, p.maxDailyUsd);
        day = today;
        dayVolumeUsd = vol;

        (uint256 priceOut, uint8 decOut) = _price(tokenOut);
        uint256 floor = (((valueIn * 10 ** decOut) / priceOut) * (10_000 - p.maxSlippageBps)) / 10_000;
        required = minOut > floor ? minOut : floor;
    }

    /// @dev Runs the swap and measures it from this vault's balances.
    function _execute(address adapter, address tokenIn, address tokenOut, uint256 amountIn, uint256 required, bytes calldata data)
        private
        returns (uint256 amountOut)
    {
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        tokenIn.forceApprove(adapter, amountIn);
        IVenueAdapter(adapter).swap(tokenIn, tokenOut, amountIn, required, address(this), data);
        tokenIn.forceApprove(adapter, 0);
        uint256 spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        if (spent > amountIn) revert OverSpent(spent, amountIn);
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < required) revert OutputTooLow(amountOut, required);
    }

    function _checkHolding(address token) private view {
        uint256 cap = policy.maxTokenUsd;
        if (cap == 0 || token == baseToken) return;
        (uint256 price, uint8 dec) = _price(token);
        uint256 held = (IERC20(token).balanceOf(address(this)) * price) / 10 ** dec;
        if (held > cap) revert HoldingLimit(token, held, cap);
    }

    // ------------------------------------------------------------------ views

    /// @notice Oracle price of a token in USD with 8 decimals, and the token's decimals.
    function _price(address token) internal view returns (uint256 price, uint8 decimals) {
        (address feed, uint32 maxAge) = feeds.feedOf(token);
        if (feed == address(0)) revert NoFeed(token);
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
        if (answer <= 0) revert BadPrice(token);
        // Stock feeds go quiet outside market hours, so trading stops with them.
        if (block.timestamp > updatedAt + maxAge) revert StalePrice(token, updatedAt);
        uint8 fd = IAggregatorV3(feed).decimals();
        price = fd == 8 ? uint256(answer) : fd > 8 ? uint256(answer) / 10 ** (fd - 8) : uint256(answer) * 10 ** (8 - fd);
        decimals = IERC20(token).decimals();
    }

    function priceOf(address token) external view returns (uint256 usd8) {
        (usd8,) = _price(token);
    }
}
