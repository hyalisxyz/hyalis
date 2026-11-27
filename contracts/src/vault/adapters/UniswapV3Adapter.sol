// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVenueAdapter, SafeERC20} from "../Interfaces.sol";

/// @dev The one call of Uniswap's SwapRouter02 (IV3SwapRouter) this adapter makes.
interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title UniswapV3Adapter
/// @notice Routes a vault's swap through Uniswap V3's SwapRouter02, in one pool or two.
///
/// `data` names the pool fee tiers only: abi.encode(uint24 fee) for one pool, or
/// abi.encode(uint24 fee1, address mid, uint24 fee2) for two pools through `mid`. The path is
/// built here from the vault's own tokenIn and tokenOut, so a route can never start or end
/// anywhere else; a poor fee choice can only make the swap fail the vault's oracle floor.
/// Holds nothing between calls: it pulls exactly amountIn, the router spends all of it, and
/// the output goes straight to the recipient.
contract UniswapV3Adapter is IVenueAdapter {
    using SafeERC20 for address;

    IV3SwapRouter public immutable router;

    error BadRoute();

    constructor(IV3SwapRouter router_) {
        require(address(router_) != address(0), "zero router");
        router = router_;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, bytes calldata data)
        external
        returns (uint256 amountOut)
    {
        bytes memory path;
        if (data.length == 32) {
            uint24 fee = abi.decode(data, (uint24));
            path = abi.encodePacked(tokenIn, fee, tokenOut);
        } else if (data.length == 96) {
            (uint24 fee1, address mid, uint24 fee2) = abi.decode(data, (uint24, address, uint24));
            if (mid == tokenIn || mid == tokenOut || mid == address(0)) revert BadRoute();
            path = abi.encodePacked(tokenIn, fee1, mid, fee2, tokenOut);
        } else {
            revert BadRoute();
        }

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.forceApprove(address(router), amountIn);
        amountOut = router.exactInput(IV3SwapRouter.ExactInputParams({path: path, recipient: recipient, amountIn: amountIn, amountOutMinimum: minOut}));
        tokenIn.forceApprove(address(router), 0);
    }
}
