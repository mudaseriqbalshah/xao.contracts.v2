// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./StandingAgreement.sol";

/// @title StandingAgreementFactory — deploy one StandingAgreement per relationship (Phase 2A)
/// @notice Each agreement is a minimal-proxy clone. Only one of its own parties
///         can create it, so nobody can create agreements naming other people
///         as the proposer. The factory holds no funds and keeps no authority
///         over the agreements it creates.
contract StandingAgreementFactory {

    error ZeroAddress();
    error NotAParty();

    address public immutable implementation;

    address[] public allAgreements;
    mapping(address => address[]) public userAgreements;

    event AgreementCreated(
        address indexed agreement,
        address indexed partyA,
        address indexed partyB,
        StandingAgreement.AgreementKind kind,
        bytes32 termsHash
    );

    constructor(address _implementation) {
        if (_implementation == address(0)) revert ZeroAddress();
        implementation = _implementation;
    }

    /// @notice Create an agreement. The caller must be partyA or partyB.
    function createAgreement(StandingAgreement.AgreementInit calldata init)
        external
        returns (address agreement)
    {
        if (msg.sender != init.partyA && (init.partyB == address(0) || msg.sender != init.partyB)) {
            revert NotAParty();
        }

        agreement = Clones.clone(implementation);
        StandingAgreement(agreement).initialize(init);

        allAgreements.push(agreement);
        userAgreements[init.partyA].push(agreement);
        if (init.partyB != address(0)) {
            userAgreements[init.partyB].push(agreement);
        }

        emit AgreementCreated(agreement, init.partyA, init.partyB, init.kind, init.termsHash);
    }

    function getAgreementCount() external view returns (uint256) {
        return allAgreements.length;
    }

    function getUserAgreements(address user) external view returns (address[] memory) {
        return userAgreements[user];
    }
}
