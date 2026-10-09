// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IGraphParties.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IGraphAuthorizer.sol";

/// @dev Test stand-in for a party-based contract (e.g. a show) with operators.
contract MockGraphNode is IGraphParties, IGraphAuthorizer {
    address public override partyA;
    address public override partyB;
    mapping(address => bool) public override isGraphOperator;

    constructor(address _partyA, address _partyB) {
        partyA = _partyA;
        partyB = _partyB;
    }

    function setOperator(address op, bool allowed) external {
        isGraphOperator[op] = allowed;
    }
}

/// @dev Test stand-in for an org wallet: not a party-based contract, but it
///      names operators who may act as it.
contract MockOrgWallet is IGraphAuthorizer {
    mapping(address => bool) public override isGraphOperator;

    function setOperator(address op, bool allowed) external {
        isGraphOperator[op] = allowed;
    }
}

/// @dev Test helper: deploys an uninitialized minimal-proxy clone.
contract MockCloner {
    event Cloned(address clone);

    function clone(address implementation) external returns (address instance) {
        instance = Clones.clone(implementation);
        emit Cloned(instance);
    }
}
