// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IGraphAuthorizer.sol";
import "./StakingParent.sol";

/// @title StakingParentFactory — deploy one StakingParent per project (Phase 2A foundation)
/// @notice Each container is a minimal-proxy clone. A personal container is
///         created by its owner; an org container by the org wallet or one of
///         its operators. The factory holds no funds and keeps no authority
///         over the containers it creates.
contract StakingParentFactory {

    error ZeroAddress();
    error NotAuthorized();

    address public immutable implementation;
    address public immutable graphRegistry;

    address[] public allParents;
    mapping(address => address[]) public ownerParents;

    event StakingParentCreated(
        address indexed stakingParent,
        address indexed owner,
        StakingParent.OwnerMode ownerMode
    );

    constructor(address _implementation, address _graphRegistry) {
        if (_implementation == address(0) || _graphRegistry == address(0)) revert ZeroAddress();
        implementation = _implementation;
        graphRegistry  = _graphRegistry;
    }

    /// @notice Create a container. Personal: the caller must be `owner`. Org:
    ///         the caller must be `owner` or an operator of the org wallet.
    function createStakingParent(
        address owner,
        StakingParent.OwnerMode ownerMode,
        bytes32 metaHash,
        string calldata metaCID
    ) external returns (address parent) {
        if (owner == address(0)) revert ZeroAddress();
        if (msg.sender != owner) {
            if (ownerMode != StakingParent.OwnerMode.Org || !_isOrgOperator(owner, msg.sender)) {
                revert NotAuthorized();
            }
        }

        parent = Clones.clone(implementation);
        StakingParent(parent).initialize(owner, ownerMode, graphRegistry, metaHash, metaCID);

        allParents.push(parent);
        ownerParents[owner].push(parent);

        emit StakingParentCreated(parent, owner, ownerMode);
    }

    function getParentCount() external view returns (uint256) {
        return allParents.length;
    }

    function getOwnerParents(address owner) external view returns (address[] memory) {
        return ownerParents[owner];
    }

    function _isOrgOperator(address org, address caller) internal view returns (bool) {
        if (org.code.length == 0) return false;
        (bool ok, bytes memory data) = org.staticcall(
            abi.encodeCall(IGraphAuthorizer.isGraphOperator, (caller))
        );
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }
}
