// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev The little of an NFT collection a perk looks at: who holds how many.
contract MockERC721Holder {
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public ownerOf;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
        balanceOf[to]++;
    }

    function move(address to, uint256 id) external {
        require(ownerOf[id] == msg.sender, "not the holder");
        balanceOf[msg.sender]--;
        balanceOf[to]++;
        ownerOf[id] = to;
    }
}
