// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentVault} from "./AgentVault.sol";
import {IFeedSource, IWETH, SafeERC20} from "./Interfaces.sol";

/// @title AgentVaultFactory
/// @notice Creates AgentVaults and keeps the token-to-Chainlink-feed list they price with.
/// Feeds given at deploy apply at once; any later change waits 24 hours after it is
/// proposed, in public, so a vault owner can react before a new feed takes effect.
contract AgentVaultFactory is IFeedSource {
    using SafeERC20 for address;

    struct Feed {
        address feed;
        uint32 maxAge;
    }

    uint256 public constant FEED_DELAY = 24 hours;

    address public admin;
    address public immutable baseToken;
    /// @notice Wrapped ETH: ETH sent with createVaultWith arrives in the vault as WETH.
    address public immutable weth;
    mapping(address token => Feed) private feeds;
    mapping(address token => Feed) public pendingFeed;
    mapping(address token => uint256) public pendingSince;
    mapping(address owner => address[]) private vaultsByOwner;
    address[] public allVaults;

    event VaultCreated(address indexed owner, address vault, address executor);
    event FeedProposed(address indexed token, address feed, uint32 maxAge, uint256 effectiveAt);
    event FeedSet(address indexed token, address feed, uint32 maxAge);
    event AdminSet(address admin);

    error NotAdmin();
    error TooEarly(uint256 effectiveAt);
    error NothingPending();

    constructor(address admin_, address baseToken_, address weth_, address[] memory tokens, Feed[] memory initial) {
        require(admin_ != address(0) && baseToken_ != address(0) && tokens.length == initial.length, "bad args");
        admin = admin_;
        baseToken = baseToken_;
        weth = weth_;
        for (uint256 i; i < tokens.length; ++i) {
            feeds[tokens[i]] = initial[i];
            emit FeedSet(tokens[i], initial[i].feed, initial[i].maxAge);
        }
    }

    function feedOf(address token) external view returns (address feed, uint32 maxAge) {
        Feed memory f = feeds[token];
        return (f.feed, f.maxAge);
    }

    function createVault(address executor, AgentVault.Policy calldata policy) external returns (AgentVault vault) {
        return _create(executor, policy, new address[](0), new address[](0));
    }

    /// @notice A vault with its tradable tokens and venues set, funded in the same transaction:
    /// ETH sent along arrives as WETH, and `depositAmount` of `depositToken` is moved from the
    /// caller (who approved this factory for it). Funds go only into the new vault.
    function createVaultWith(
        address executor,
        AgentVault.Policy calldata policy,
        address[] calldata tokens,
        address[] calldata adapters,
        address depositToken,
        uint256 depositAmount
    ) external payable returns (AgentVault vault) {
        vault = _create(executor, policy, tokens, adapters);
        if (msg.value > 0) {
            require(weth != address(0), "no weth");
            IWETH(weth).deposit{value: msg.value}();
            weth.safeTransfer(address(vault), msg.value);
        }
        if (depositAmount > 0) depositToken.safeTransferFrom(msg.sender, address(vault), depositAmount);
    }

    function _create(address executor, AgentVault.Policy calldata policy, address[] memory tokens, address[] memory adapters)
        private
        returns (AgentVault vault)
    {
        vault = new AgentVault(msg.sender, executor, this, baseToken, weth, policy, tokens, adapters);
        vaultsByOwner[msg.sender].push(address(vault));
        allVaults.push(address(vault));
        emit VaultCreated(msg.sender, address(vault), executor);
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return vaultsByOwner[owner];
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    // ------------------------------------------------------------------ feeds, behind a delay

    function proposeFeed(address token, address feed, uint32 maxAge) external {
        if (msg.sender != admin) revert NotAdmin();
        pendingFeed[token] = Feed(feed, maxAge);
        pendingSince[token] = block.timestamp;
        emit FeedProposed(token, feed, maxAge, block.timestamp + FEED_DELAY);
    }

    function applyFeed(address token) external {
        uint256 since = pendingSince[token];
        if (since == 0) revert NothingPending();
        if (block.timestamp < since + FEED_DELAY) revert TooEarly(since + FEED_DELAY);
        Feed memory f = pendingFeed[token];
        feeds[token] = f;
        delete pendingFeed[token];
        delete pendingSince[token];
        emit FeedSet(token, f.feed, f.maxAge);
    }

    function setAdmin(address admin_) external {
        if (msg.sender != admin) revert NotAdmin();
        admin = admin_;
        emit AdminSet(admin_);
    }
}
