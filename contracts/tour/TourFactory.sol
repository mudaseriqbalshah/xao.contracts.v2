// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./TourShell.sol";

/// @title TourFactory — deploy one TourShell per tour (Phase 2A)
/// @notice Each shell is a minimal-proxy clone owned by the caller. The factory
///         holds no funds and keeps no authority over the shells it creates.
contract TourFactory {

    error ZeroAddress();

    address public immutable shellImplementation;
    address public immutable tpaImplementation;
    address public immutable graphRegistry;

    address[] public allTours;
    mapping(address => address[]) public userTours;

    event TourShellCreated(address indexed tourShell, address indexed owner, bytes32 indexed tourId);

    constructor(address _shellImplementation, address _tpaImplementation, address _graphRegistry) {
        if (
            _shellImplementation == address(0) ||
            _tpaImplementation == address(0) ||
            _graphRegistry == address(0)
        ) revert ZeroAddress();

        shellImplementation = _shellImplementation;
        tpaImplementation   = _tpaImplementation;
        graphRegistry       = _graphRegistry;
    }

    /// @notice Create a TourShell owned by the caller. Pass `tourId = 0` to
    ///         have the shell derive it from the owner and metadata.
    function createTourShell(
        bytes32 tourId,
        string calldata tourMetaCID,
        bytes32 tourMetaHash
    ) external returns (address shell) {
        shell = Clones.clone(shellImplementation);
        TourShell(shell).initialize(
            msg.sender,
            graphRegistry,
            tpaImplementation,
            tourId,
            tourMetaCID,
            tourMetaHash
        );

        allTours.push(shell);
        userTours[msg.sender].push(shell);

        emit TourShellCreated(shell, msg.sender, TourShell(shell).tourId());
    }

    function getTourCount() external view returns (uint256) {
        return allTours.length;
    }

    function getUserTours(address user) external view returns (address[] memory) {
        return userTours[user];
    }
}
