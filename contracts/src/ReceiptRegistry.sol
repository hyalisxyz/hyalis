// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ReceiptRegistry
/// @notice Public record of agent receipts. Once per epoch the backend publishes the Merkle root
/// of every receipt written in that epoch. Roots can only be added, in increasing epoch order,
/// after the epoch has ended, and each root names the root before it. So history can grow but
/// cannot be rewritten, and an epoch cannot be filled in later.
/// There is no owner, no upgrade and no pause. If the publisher key is lost or rotated, a new
/// registry is deployed and the old one stays readable.
///
/// Merkle format, identical to the backend (src/receipts/merkle.ts):
///   leaf = keccak256(0x00 ‖ recordHash)       recordHash = keccak256(canonical JSON of the receipt)
///   node = keccak256(0x01 ‖ min(a, b) ‖ max(a, b))
contract ReceiptRegistry {
    struct Anchor {
        bytes32 root;
        bytes32 prevRoot;
        uint32 leafCount;
        uint64 anchoredAt;
    }

    /// @notice The only address that may publish roots. Fixed at deploy.
    address public immutable publisher;

    /// @notice Epoch length. Epoch n covers [n * epochSeconds, (n + 1) * epochSeconds).
    uint64 public immutable epochSeconds;

    /// @notice Latest anchored epoch and root; zero before the first anchor.
    uint64 public lastEpoch;
    bytes32 public lastRoot;
    uint64 public anchorCount;

    mapping(uint64 epoch => Anchor) private anchors;

    event Anchored(uint64 indexed epoch, bytes32 root, bytes32 prevRoot, uint32 leafCount);

    error NotPublisher();
    error EpochNotAfterLast(uint64 epoch, uint64 lastEpoch);
    error EpochNotEnded(uint64 epoch);
    error WrongPrevRoot(bytes32 expected, bytes32 given);
    error EmptyRoot();
    error NoLeaves();

    constructor(address publisher_, uint64 epochSeconds_) {
        require(publisher_ != address(0), "publisher is zero");
        require(epochSeconds_ >= 60, "epoch too short");
        publisher = publisher_;
        epochSeconds = epochSeconds_;
    }

    /// @notice Publishes the root of `epoch`, which must have ended.
    /// @param prevRoot Must equal `lastRoot`; links this root to the previous one.
    function anchor(uint64 epoch, bytes32 root, bytes32 prevRoot, uint32 leafCount) external {
        if (msg.sender != publisher) revert NotPublisher();
        if (anchorCount != 0 && epoch <= lastEpoch) revert EpochNotAfterLast(epoch, lastEpoch);
        if (block.timestamp < (uint256(epoch) + 1) * epochSeconds) revert EpochNotEnded(epoch);
        if (prevRoot != lastRoot) revert WrongPrevRoot(lastRoot, prevRoot);
        if (root == bytes32(0)) revert EmptyRoot();
        if (leafCount == 0) revert NoLeaves();

        anchors[epoch] = Anchor({root: root, prevRoot: prevRoot, leafCount: leafCount, anchoredAt: uint64(block.timestamp)});
        lastEpoch = epoch;
        lastRoot = root;
        unchecked {
            ++anchorCount;
        }
        emit Anchored(epoch, root, prevRoot, leafCount);
    }

    /// @notice The anchor for `epoch`; all fields are zero if it was never anchored.
    function anchorOf(uint64 epoch) external view returns (Anchor memory) {
        return anchors[epoch];
    }

    /// @notice Leaf for a receipt, from the keccak256 of its canonical JSON.
    function leafOf(bytes32 recordHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), recordHash));
    }

    /// @notice True if `leaf` is under the root anchored for `epoch`.
    function verifyLeaf(uint64 epoch, bytes32 leaf, bytes32[] calldata proof) public view returns (bool) {
        bytes32 root = anchors[epoch].root;
        if (root == bytes32(0)) return false;
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(bytes1(0x01), h, p)) : keccak256(abi.encodePacked(bytes1(0x01), p, h));
        }
        return h == root;
    }

    /// @notice True if the receipt with this hash is under the root anchored for `epoch`.
    function verifyRecord(uint64 epoch, bytes32 recordHash, bytes32[] calldata proof) external view returns (bool) {
        return verifyLeaf(epoch, leafOf(recordHash), proof);
    }
}
