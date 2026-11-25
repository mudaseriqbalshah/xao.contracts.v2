// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test token whose transferFrom reports failure by returning false instead of reverting,
///      the way some tokens do.
contract MockFalseTransferFromERC20 {
    string public name = "False USD";
    string public symbol = "fUSD";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransferFrom;

    function setFailTransferFrom(bool fail) external {
        failTransferFrom = fail;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransferFrom) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
