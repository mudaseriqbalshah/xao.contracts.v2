// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IShowBundle.sol";

/// @title EntryValidator — door scanning for one show (Phase 2A)
/// @notice Controls who may scan, when and at which gates, logs every scan
///         attempt, and tells the ticket contract to mark a ticket as used.
///         It handles no funds, prices or identity.
/// @dev Deployed as a minimal-proxy clone by ShowFactory and set up via
///      initialize(). QR parsing happens in the app; this contract only ever
///      receives a token id and an optional gate id.
contract EntryValidator {

    error AlreadyInitialized();
    error ZeroAddress();
    error InvalidScanWindow();
    error NotAdmin();
    error NotScanner();
    error ScanningPaused();
    error ScanWindowClosed();
    error InvalidGate();

    address public eventRoot;          // the ShowInstance
    address public ticketContract;

    uint64 public scanStart;           // entry opens (doors)
    uint64 public scanEnd;

    bool public paused;

    mapping(address => bool) public isScanner;
    mapping(bytes32 => bool) public validGate;
    bool public gatesEnabled;

    bool public initialized;

    event ValidatorInitialized(
        address indexed eventRoot,
        address indexed ticketContract,
        uint64 scanStart,
        uint64 scanEnd
    );

    event ScannerAdded(address indexed scanner);
    event ScannerRemoved(address indexed scanner);

    event ValidatorPaused(bool paused);
    event ScanWindowUpdated(uint64 scanStart, uint64 scanEnd);

    event GateUpdated(bytes32 indexed gateId, bool allowed);
    event GatesEnabled(bool enabled);

    /// @notice A scan before doors open: the ticket is genuine, entry is not yet granted.
    event TicketAuthenticated(uint256 indexed tokenId, address indexed scanner, uint64 time);

    event ScanAttempt(
        uint256 indexed tokenId,
        address indexed scanner,
        bytes32 indexed gateId,
        bool accepted,
        uint64 time
    );

    /// @dev The show itself, or either of its parties acting directly.
    modifier onlyAdmin() {
        if (msg.sender != eventRoot && !IShowInstanceLike(eventRoot).isParty(msg.sender)) revert NotAdmin();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    /// @param _initialScanner optional; lets the show's creator scan at the door
    ///        without a separate setup step.
    function initialize(
        address _eventRoot,
        address _ticketContract,
        uint64 _scanStart,
        uint64 _scanEnd,
        address _initialScanner
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_eventRoot == address(0) || _ticketContract == address(0)) revert ZeroAddress();
        if (_scanStart >= _scanEnd) revert InvalidScanWindow();

        initialized    = true;
        eventRoot      = _eventRoot;
        ticketContract = _ticketContract;
        scanStart      = _scanStart;
        scanEnd        = _scanEnd;

        emit ValidatorInitialized(_eventRoot, _ticketContract, _scanStart, _scanEnd);

        if (_initialScanner != address(0)) {
            isScanner[_initialScanner] = true;
            emit ScannerAdded(_initialScanner);
        }
    }

    // ─── ADMIN ────────────────────────────────────────────────────────────

    function addScanner(address scanner) external onlyAdmin {
        if (scanner == address(0)) revert ZeroAddress();
        isScanner[scanner] = true;
        emit ScannerAdded(scanner);
    }

    function removeScanner(address scanner) external onlyAdmin {
        isScanner[scanner] = false;
        emit ScannerRemoved(scanner);
    }

    function setPaused(bool p) external onlyAdmin {
        paused = p;
        emit ValidatorPaused(p);
    }

    function setScanWindow(uint64 start, uint64 end) external onlyAdmin {
        if (start >= end) revert InvalidScanWindow();
        scanStart = start;
        scanEnd   = end;
        emit ScanWindowUpdated(start, end);
    }

    function setGate(bytes32 gateId, bool allowed) external onlyAdmin {
        validGate[gateId] = allowed;
        emit GateUpdated(gateId, allowed);
    }

    function setGatesEnabled(bool enabled) external onlyAdmin {
        gatesEnabled = enabled;
        emit GatesEnabled(enabled);
    }

    // ─── SCANNING ─────────────────────────────────────────────────────────

    /// @notice Scan a ticket.
    ///         Before `scanStart` → authentication only: nothing is marked.
    ///         Inside the window  → the first scan grants entry and returns
    ///         true; a repeat scan is counted on the ticket and returns false.
    ///         An unknown or refunded ticket returns false and never reverts.
    function scanTicket(uint256 tokenId, bytes32 gateId) external returns (bool accepted) {
        if (!isScanner[msg.sender]) revert NotScanner();
        if (paused) revert ScanningPaused();
        if (block.timestamp > scanEnd) revert ScanWindowClosed();
        if (gatesEnabled && !validGate[gateId]) revert InvalidGate();

        IShowTicketLike ticket = IShowTicketLike(ticketContract);
        uint64 nowTs = uint64(block.timestamp);

        if (!ticket.exists(tokenId)) {
            emit ScanAttempt(tokenId, msg.sender, gateId, false, nowTs);
            return false;
        }

        if (block.timestamp < scanStart) {
            emit TicketAuthenticated(tokenId, msg.sender, nowTs);
            return false;
        }

        accepted = ticket.scan(tokenId, gateId);
        emit ScanAttempt(tokenId, msg.sender, gateId, accepted, nowTs);
    }
}
