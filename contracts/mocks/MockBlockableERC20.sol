// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test token that can refuse transfers to chosen recipients, the way
///      USDC does for blocked addresses.
contract MockBlockableERC20 {
    string public name = "Blockable USD";
    string public symbol = "bUSD";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(!blocked[to], "Recipient blocked");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
