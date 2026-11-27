// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVenueAdapter, IERC20} from "../src/vault/Interfaces.sol";

/// @notice Test-only adapters that misbehave, to prove the vault does not trust venues.

/// Takes the input and pays back only `payBps` of a 1:1 output from its own balance.
contract ShortPayAdapter is IVenueAdapter {
    uint256 public payBps;

    constructor(uint256 payBps_) {
        payBps = payBps_;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, bytes calldata)
        external
        returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = (minOut * payBps) / 10_000;
        IERC20(tokenOut).transfer(recipient, out);
        return minOut; // lies about the amount
    }
}

/// Tries to pull twice the allowed input.
contract GreedyAdapter is IVenueAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, bytes calldata)
        external
        returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(recipient, minOut);
        return minOut;
    }
}


/// @dev A vault owner that refuses ETH (like some smart wallets) but can call the vault.
contract RejectEth {
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "call failed");
        return ret;
    }

    receive() external payable {
        revert("no ETH");
    }
}
