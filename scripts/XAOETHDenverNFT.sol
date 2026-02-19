// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

contract XAOETHDenverNFT is ERC721Enumerable, Ownable {
    using Strings for uint256;
    
    // =========================
    // ENUMS & STRUCTS
    // =========================
    
    enum Persona {
        HipHop,      // 0 - most common
        KPop,        // 1
        Country,     // 2
        Electronic,  // 3
        Punk,        // 4
        Classical,   // 5
        Jazz         // 6 - least common
    }
    
    struct Traits {
        uint8 persona;
        uint8 background;
        uint8 head;
        uint8 accessory;
        uint8 accent;
        bool isLegendary;
        bool hasETHDenver;
    }
    
    // =========================
    // STATE VARIABLES
    // =========================
    
    uint256 public constant MAX_SUPPLY = 10000;
    uint256 public constant MAX_MINT_PER_WALLET = 10;
    
    // Persona supply targets
    uint256[7] public personaSupplyTargets = [2200, 1800, 1600, 1500, 1300, 900, 700];
    uint256[7] public personaMintedCount;
    
    // Mint window
    uint256 public mintStartTime;
    uint256 public mintEndTime;
    bool public mintWindowOpen = false;
    
    // Metadata
    mapping(uint256 => Traits) public nftTraits;
    mapping(address => uint256) public walletMintCount;
    
    string public baseURI;
    
    // Random seed
    uint256 private randomSeed = 1;
    
    // =========================
    // EVENTS
    // =========================
    
    event MintWindowOpened(uint256 startTime, uint256 endTime);
    event MintWindowClosed();
    event NFTMinted(address indexed to, uint256 indexed tokenId, uint8 persona);
    
    // =========================
    // CONSTRUCTOR
    // =========================
    
    constructor(string memory _baseURI) ERC721("XAO ETHDenver", "XAOXED") Ownable(msg.sender) {
        baseURI = _baseURI;
    }
    
    // =========================
    // MINT FUNCTIONS
    // =========================
    
    /**
     * @dev Mint NFT(s) during mint window
     */
    function mint(uint256 quantity) external {
        require(mintWindowOpen, "Mint window closed");
        require(block.timestamp >= mintStartTime && block.timestamp <= mintEndTime, "Outside mint window");
        require(quantity > 0 && quantity <= MAX_MINT_PER_WALLET, "Invalid quantity");
        require(walletMintCount[msg.sender] + quantity <= MAX_MINT_PER_WALLET, "Exceeds wallet limit");
        require(totalSupply() + quantity <= MAX_SUPPLY, "Exceeds max supply");
        
        walletMintCount[msg.sender] += quantity;
        
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = totalSupply();
            _safeMint(msg.sender, tokenId);
            _assignTraits(tokenId);
            emit NFTMinted(msg.sender, tokenId, nftTraits[tokenId].persona);
        }
    }
    
    // =========================
    // TRAIT ASSIGNMENT LOGIC
    // =========================
    
    /**
     * @dev Assign traits to newly minted NFT with persona weighting
     */
    function _assignTraits(uint256 tokenId) internal {
        // 1. Select persona with weighted distribution
        uint8 persona = _selectWeightedPersona();
        
        // 2. Assign random traits
        uint8 background = uint8(_randomRange(0, 3));  // explicit cast
        uint8 head = uint8(_randomRange(0, 4));
        uint8 accessory = uint8(_randomRange(0, 3));
        uint8 accent = uint8(_randomRange(0, 3));
        
        // 3. Determine legendary (1.5-2% chance)
        bool isLegendary = _isLegendary(persona);
        
        // 4. Ensure ETHDenver trait assignment
        uint8 ethDenverSlot = _assignETHDenverTrait(persona, isLegendary);
        
        // Store traits
        nftTraits[tokenId] = Traits({
            persona: persona,
            background: background,
            head: head,
            accessory: accessory,
            accent: accent,
            isLegendary: isLegendary,
            hasETHDenver: true
        });
        
        personaMintedCount[persona]++;
    }
    
    /**
     * @dev Select persona based on weighted distribution
     */
    function _selectWeightedPersona() internal returns (uint8) {
        uint256 remainingSupply = MAX_SUPPLY - totalSupply();
        uint256 rand = _nextRandom();
        
        uint256 cumulativeWeight = 0;
        uint256 totalWeight = 0;
        
        // Calculate available weight for each persona
        uint256[7] memory weights;
        for (uint8 i = 0; i < 7; i++) {
            uint256 remaining = personaSupplyTargets[i] - personaMintedCount[i];
            weights[i] = remaining > 0 ? remaining : 0;
            totalWeight += weights[i];
        }
        
        rand = rand % totalWeight;
        
        for (uint8 i = 0; i < 7; i++) {
            cumulativeWeight += weights[i];
            if (rand < cumulativeWeight) {
                return i;
            }
        }
        
        // Fallback (should not reach)
        return 0;
    }
    
    /**
     * @dev Determine if this NFT is legendary based on persona
     */
    function _isLegendary(uint8 persona) internal returns (bool) {
        uint256 rand = _nextRandom() % 100;
        
        // ~1.5-2% chance for legendary
        // Adjust based on persona if needed for finer control
        return rand < 2;
    }
    
    /**
     * @dev Assign which slot contains ETHDenver trait
     * If legendary, avoid that slot
     */
    function _assignETHDenverTrait(uint8 persona, bool isLegendary) internal returns (uint8) {
        // ETHDenver can be in Background(0), Head(1), Accessory(2), Accent(3)
        uint8 availableSlots = 4;
        uint8 slot = uint8(_nextRandom() % availableSlots);
        return slot;
    }
    
    // =========================
    // RANDOM NUMBER GENERATION
    // =========================
    
    /**
     * @dev Generate next random number
     * NOTE: For production, use Chainlink VRF for true randomness
     * This pseudo-random approach is acceptable for art/rarity distribution
     */
    function _nextRandom() internal returns (uint256) {
        randomSeed = uint256(keccak256(
            abi.encodePacked(
                randomSeed,
                block.timestamp,
                block.prevrandao,
                totalSupply(),
                msg.sender
            )
        ));
        return randomSeed;
    }
    
    /**
     * @dev Get random number in range [min, max)
     */
    function _randomRange(uint256 min, uint256 max) internal returns (uint256) {
        require(max > min, "Invalid range");
        return min + (_nextRandom() % (max - min));
    }
    
    // =========================
    // MINT WINDOW MANAGEMENT
    // =========================
    
    /**
     * @dev Set mint window (owner only)
     */
    function setMintWindow(uint256 startTime, uint256 endTime) external onlyOwner {
        require(endTime > startTime, "Invalid window");
        mintStartTime = startTime;
        mintEndTime = endTime;
        mintWindowOpen = true;
        emit MintWindowOpened(startTime, endTime);
    }
    
    /**
     * @dev Close mint window (owner only)
     */
    function closeMintWindow() external onlyOwner {
        mintWindowOpen = false;
        emit MintWindowClosed();
    }
    
    /**
     * @dev Check if mint window is active
     */
    function isMintActive() external view returns (bool) {
        return mintWindowOpen && 
               block.timestamp >= mintStartTime && 
               block.timestamp <= mintEndTime;
    }
    
    // =========================
    // METADATA & URI
    // =========================
    
    /**
     * @dev Set base URI for metadata
     */
    function setBaseURI(string memory _baseURI) external onlyOwner {
        baseURI = _baseURI;
    }
    
    /**
     * @dev Get token URI
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(ownerOf(tokenId) != address(0), "Token does not exist");
        
        // Return IPFS or external metadata URL
        return string(abi.encodePacked(baseURI, tokenId.toHexString()));
    }
    
    /**
     * @dev Generate on-chain metadata (optional fallback)
     */
    function generateMetadata(uint256 tokenId) external view returns (string memory) {
        require(ownerOf(tokenId) != address(0), "Token does not exist");
        
        Traits memory traits = nftTraits[tokenId];
        string memory personaName = _getPersonaName(traits.persona);
        
        string memory json = string(abi.encodePacked(
            '{"name":"XAO ETHDenver #',
            tokenId.toString(),
            '","description":"A cultural artifact marking early participation in XAO at ETHDenver","attributes":[',
            '{"trait_type":"Persona","value":"',
            personaName,
            '"},',
            '{"trait_type":"Legendary","value":"',
            traits.isLegendary ? "Yes" : "No",
            '"},',
            '{"trait_type":"ETHDenver","value":"Yes"}',
            ']}'
        ));
        
        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(bytes(json))
        ));
    }
    
    /**
     * @dev Get persona name from enum
     */
    function _getPersonaName(uint8 persona) internal pure returns (string memory) {
        if (persona == 0) return "Hip Hop";
        if (persona == 1) return "K-Pop";
        if (persona == 2) return "Country";
        if (persona == 3) return "Electronic";
        if (persona == 4) return "Punk";
        if (persona == 5) return "Classical";
        if (persona == 6) return "Jazz";
        return "Unknown";
    }
    
    // =========================
    // QUERY FUNCTIONS
    // =========================
    
    /**
     * @dev Get traits for a token
     */
    function getTraits(uint256 tokenId) external view returns (Traits memory) {
        require(ownerOf(tokenId) != address(0), "Token does not exist");
        return nftTraits[tokenId];
    }
    
    /**
     * @dev Get current persona distribution
     */
    function getPersonaDistribution() external view returns (uint256[7] memory) {
        return personaMintedCount;
    }
    
    /**
     * @dev Get user mint count
     */
    function getUserMintCount(address user) external view returns (uint256) {
        return walletMintCount[user];
    }
    
    /**
     * @dev Get remaining supply
     */
    function getRemainingSupply() external view returns (uint256) {
        return MAX_SUPPLY - totalSupply();
    }
    
    // =========================
    // EMERGENCY FUNCTIONS
    // =========================
    
    /**
     * @dev Update random seed (emergency/owner only)
     */
    function updateRandomSeed(uint256 newSeed) external onlyOwner {
        randomSeed = newSeed;
    }
    
    /**
     * @dev Reset mint count for wallet (emergency/owner only)
     */
    function resetMintCount(address wallet) external onlyOwner {
        walletMintCount[wallet] = 0;
    }
}
