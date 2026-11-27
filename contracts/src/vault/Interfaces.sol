// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice A swap venue the vault can route through. The adapter pulls `amountIn` of
/// `tokenIn` from the caller and sends the output to `recipient`. The vault never trusts the
/// return value: it measures its own balances before and after.
interface IVenueAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, bytes calldata data)
        external
        returns (uint256 amountOut);
}

/// @notice Where vaults read their price feeds.
interface IFeedSource {
    /// @return feed Chainlink aggregator for the token in USD, zero if none.
    /// @return maxAge Seconds after which an answer counts as stale.
    function feedOf(address token) external view returns (address feed, uint32 maxAge);
}

/// @dev Tokens that return nothing (or false) from transfer/approve are handled the same way.
library SafeERC20 {
    error TokenCallFailed(address token);

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed(token);
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    /// @dev Sets an allowance even for tokens that require it to be zero first.
    function forceApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            _call(token, abi.encodeCall(IERC20.approve, (spender, 0)));
            _call(token, abi.encodeCall(IERC20.approve, (spender, amount)));
        }
    }
}
