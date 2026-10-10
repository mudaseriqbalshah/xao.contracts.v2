// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./TourShell.sol";

/// @title TourFactory — deploy one TourShell per tour (Phase 2A)
/// @notice Each shell is a CREATE2 minimal-proxy clone owned by the caller, so
///         its address is known from the tour id before it is deployed. The
///         factory holds no funds and keeps no authority over the shells it creates.
contract TourFactory {

    error ZeroAddress();

    address public immutable shellImplementation;
    address public immutable tpaImplementation;
    address public immutable graphRegistry;

    address[] public allTours;
    mapping(address => address[]) public userTours;
    mapping(bytes32 => address)   public tourById;

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

    /// @notice Create a TourShell owned by the caller. `tourId` is an optional
    ///         client-chosen id; see deriveTourId for the id the tour ends up with.
    ///         The same tour cannot be created twice.
    function createTourShell(
        bytes32 tourId,
        string calldata tourMetaCID,
        bytes32 tourMetaHash
    ) external returns (address shell) {
        bytes32 id = deriveTourId(msg.sender, tourId, tourMetaCID, tourMetaHash);

        shell = Clones.cloneDeterministic(shellImplementation, _salt(id));
        TourShell(shell).initialize(
            msg.sender,
            graphRegistry,
            tpaImplementation,
            id,
            tourMetaCID,
            tourMetaHash
        );

        allTours.push(shell);
        userTours[msg.sender].push(shell);
        tourById[id] = shell;

        emit TourShellCreated(shell, msg.sender, id);
    }

    /// @notice The tour id `owner` would get. It always includes the owner, so
    ///         nobody else can take an id first.
    function deriveTourId(
        address owner,
        bytes32 tourId,
        string calldata tourMetaCID,
        bytes32 tourMetaHash
    ) public pure returns (bytes32) {
        if (tourId != bytes32(0)) {
            return keccak256(abi.encodePacked(owner, tourId));
        }
        return keccak256(abi.encodePacked(owner, tourMetaHash, tourMetaCID));
    }

    /// @notice Address a tour id will deploy to, before it is created.
    function predictTourShell(bytes32 tourId) external view returns (address) {
        return Clones.predictDeterministicAddress(shellImplementation, _salt(tourId));
    }

    function getTourCount() external view returns (uint256) {
        return allTours.length;
    }

    function getUserTours(address user) external view returns (address[] memory) {
        return userTours[user];
    }

    function _salt(bytes32 tourId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("TOUR", tourId));
    }
}
