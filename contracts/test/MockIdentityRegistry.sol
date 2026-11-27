// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test-only stand-in for the ERC-8004 Identity Registry, written for our tests.
/// It behaves like the deployed registry where the backend depends on it: ids start at 0,
/// `register(string)` emits `Registered`, a missing id reverts with `ERC721NonexistentToken`,
/// and only the owner can move a token or change its URI. It is not a full ERC-721.
contract MockIdentityRegistry {
    uint256 private _lastId;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => string) private _uris;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    error ERC721NonexistentToken(uint256 tokenId);

    function register(string memory agentURI) external returns (uint256 agentId) {
        agentId = _lastId++;
        _owners[agentId] = msg.sender;
        _uris[agentId] = agentURI;
        emit Transfer(address(0), msg.sender, agentId);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _owners[tokenId];
        if (o == address(0)) revert ERC721NonexistentToken(tokenId);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return _uris[tokenId];
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(msg.sender == ownerOf(agentId), "Not authorized");
        _uris[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(msg.sender == ownerOf(tokenId) && from == msg.sender && to != address(0), "Not authorized");
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }
}
