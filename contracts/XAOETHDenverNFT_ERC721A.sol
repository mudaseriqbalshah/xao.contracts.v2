// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "erc721a/contracts/ERC721A.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @title XAOETHDenverNFT_ERC721A_TraitLayers
 * @dev ERC721A with 5 trait layer images (bg, body, head, accessories, item)
 * @author https://www.cryptohawking.com
 */
contract XAOETHDenverNFT_ERC721A is ERC721A, Ownable {
    using Strings for uint256;
    
    // =========================
    // ENUMS & STRUCTS
    // =========================
    
    enum Persona {
        Classic,      // 0
        Country,      // 1
        Electronic,   // 2
        HipHop,       // 3
        Jazz,         // 4
        KPop,         // 5
        Punk          // 6
    }
    
    struct TraitCombo {
        uint8 persona;      // 0-7
        uint8 bg;           // 0-2
        uint8 body;         // 0 (only 1 per persona)
        uint8 head;         // 0-4 (varies per persona)
        uint8 accessories;  // 0-4 (varies per persona)
        uint8 item;         // 0-4 (varies per persona)
        uint8 legendary;    // 0-1
        uint8 ethDenverSlot;// 0-4 (which trait is ETHDenver marked)
    }
    
    // =========================
    // CONSTANTS
    // =========================
    
    uint256 public constant MAX_SUPPLY = 10000;
    uint256 public constant MAX_MINT_PER_WALLET = 10;
    
    // Persona supply targets - 7 personas (no Folk)
    uint16[7] public personaSupplyTargets = [
        900,  // 0: Classic
        1600, // 1: Country
        1500, // 2: Electronic
        2200, // 3: Hip-Hop
        700,  // 4: Jazz
        1800, // 5: K-Pop
        1300  // 6: Punk
    ];
    // TOTAL: 10,000
    

    
    // =========================
    // TRAIT STRUCTURE CONFIG
    // =========================
    
    // Trait counts per persona: [headMax, accessoriesMax, itemMax]
    // All personas: bg=0-2 (always), body=0 (always)
    struct PersonaTraitCounts {
        uint8 headMax;
        uint8 accessoriesMax;
        uint8 itemMax;
    }
    
    mapping(uint8 => PersonaTraitCounts) public personaTraits;
    bool private personaTraitsInitialized = false;
    
    function _initPersonaTraits() internal {
        if (personaTraitsInitialized) return;
        
        // Persona 0: Classic - head(0-4), accessories(0-2), item(0-2)
        personaTraits[0] = PersonaTraitCounts(4, 2, 2);
        // Persona 1: Country - head(0-3), accessories(0-3), item(0-2)
        personaTraits[1] = PersonaTraitCounts(3, 3, 2);
        // Persona 2: Electronic - head(0-3), accessories(0-2), item(0-4)
        personaTraits[2] = PersonaTraitCounts(3, 2, 4);
        // Persona 3: Hip-Hop - head(0-3), accessories(0-3), item(0-2)
        personaTraits[3] = PersonaTraitCounts(3, 3, 2);
        // Persona 4: Jazz - head(0-3), accessories(0-2), item(0-3)
        personaTraits[4] = PersonaTraitCounts(3, 2, 3);
        // Persona 5: K-Pop - head(0-3), accessories(0-2), item(0-3)
        personaTraits[5] = PersonaTraitCounts(3, 2, 3);
        // Persona 6: Punk - head(0-3), accessories(0-4), item(0-4)
        personaTraits[6] = PersonaTraitCounts(3, 4, 4);
        
        personaTraitsInitialized = true;
    }
    
    // =========================
    // STATE VARIABLES
    // =========================
    
    mapping(uint8 => uint16) public personaMintedCount;
    uint256 public mintStartTime;
    uint256 public mintEndTime;
    bool public mintWindowOpen = false;
    mapping(uint256 => TraitCombo) public tokenTraits;
    mapping(address => uint8) public walletMintCount;
    mapping(address => uint256) public lastMintAt;  // Track last mint time per user
    string public baseURI;
    bool public metadataFrozen = false;
    uint256 private nonce = 0;
    uint256 public cooldown = 0;  // Cooldown in seconds (0 = no cooldown)
    
    // =========================
    // EVENTS
    // =========================
    
    event MintWindowSet(uint256 indexed startTime, uint256 indexed endTime);
    event MintWindowClosed();
    event XAONFTMinted(address indexed to, uint256 indexed tokenId, uint8 persona, bool isLegendary);
    event MetadataFrozen();
    
    // =========================
    // CONSTRUCTOR
    // =========================
    
    constructor(string memory _baseURI) ERC721A("XAO ETHDenver", "XAOXED") Ownable(msg.sender) {
        baseURI = _baseURI;
        _initPersonaTraits();
    }
    
    // =========================
    // MINT FUNCTION
    // =========================
    
    function mint() external {
        require(mintWindowOpen, "Mint window not open");
        require(block.timestamp >= mintStartTime && block.timestamp <= mintEndTime, "Outside mint window");
        require(walletMintCount[msg.sender] < MAX_MINT_PER_WALLET, "Wallet limit exceeded");
        require(totalSupply() < MAX_SUPPLY, "Max supply exceeded");
        require(block.timestamp >= lastMintAt[msg.sender] + cooldown, "Cooldown active");
        
        lastMintAt[msg.sender] = block.timestamp;
        walletMintCount[msg.sender] += 1;
        uint256 tokenId = totalSupply();
        _mint(msg.sender, 1);
        _assignTraits(tokenId);
    }
    
    // =========================
    // TRAIT ASSIGNMENT LOGIC
    // =========================
    
    function _assignTraits(uint256 tokenId) internal {
        uint8 persona = _selectWeightedPersona();
        personaMintedCount[persona]++;
        
        // Get persona-specific trait counts
        PersonaTraitCounts memory traitCounts = personaTraits[persona];
        
        // Generate traits with persona-specific ranges
        uint8 bg = uint8(_randomInRange(3));                              // Always 0-2 for all personas
        uint8 body = 0;                                                    // Always 0 for all personas
        uint8 head = uint8(_randomInRange(traitCounts.headMax + 1));      // Persona-specific max
        uint8 accessories = uint8(_randomInRange(traitCounts.accessoriesMax + 1)); // Persona-specific max
        uint8 item = uint8(_randomInRange(traitCounts.itemMax + 1));      // Persona-specific max
        uint8 legendary = _generateLegendary();
        uint8 ethDenverSlot = uint8(_randomInRange(5));
        
        tokenTraits[tokenId] = TraitCombo({
            persona: persona,
            bg: bg,
            body: body,
            head: head,
            accessories: accessories,
            item: item,
            legendary: legendary,
            ethDenverSlot: ethDenverSlot
        });
        
        emit XAONFTMinted(msg.sender, tokenId, persona, legendary == 1);
    }
    
    function _selectWeightedPersona() internal returns (uint8) {
        uint256 rand = _random();
        uint16[7] memory weights;
        uint256 totalWeight = 0;
        
        for (uint8 i = 0; i < 7; i++) {
            uint16 remaining = personaSupplyTargets[i] - personaMintedCount[i];
            weights[i] = remaining > 0 ? remaining : 0;
            totalWeight += weights[i];
        }
        
        require(totalWeight > 0, "All personas minted out");
        rand = rand % totalWeight;
        uint256 cumulative = 0;
        
        for (uint8 i = 0; i < 7; i++) {
            cumulative += weights[i];
            if (rand < cumulative) {
                return i;
            }
        }
        
        return 0;
    }
    
    function _generateLegendary() internal returns (uint8) {
        uint256 rand = _random() % 100;
        return rand < 2 ? 1 : 0;
    }
    
    // =========================
    // RANDOMNESS
    // =========================
    
    function _random() internal returns (uint256) {
        nonce++;
        return uint256(keccak256(abi.encodePacked(
            block.timestamp,
            block.prevrandao,
            totalSupply(),
            msg.sender,
            nonce
        )));
    }
    
    function _randomInRange(uint256 max) internal returns (uint256) {
        return _random() % max;
    }
    
    // =========================
    // MINT WINDOW MANAGEMENT
    // =========================
    
    function setMintWindow(uint256 _startTime, uint256 _endTime) external onlyOwner {
        require(_endTime > _startTime, "Invalid window");
        mintStartTime = _startTime;
        mintEndTime = _endTime;
        mintWindowOpen = true;
        emit MintWindowSet(_startTime, _endTime);
    }
    
    function closeMintWindow() external onlyOwner {
        mintWindowOpen = false;
        emit MintWindowClosed();
    }
    
    function setCooldown(uint256 _cooldown) external onlyOwner {
        cooldown = _cooldown;
    }
    
    function getTimeUntilNextMint(address user) external view returns (uint256) {
        uint256 nextMintTime = lastMintAt[user] + cooldown;
        if (block.timestamp >= nextMintTime) {
            return 0;
        }
        return nextMintTime - block.timestamp;
    }
    
    // =========================
    // METADATA & URI
    // =========================
    
    function setBaseURI(string memory _baseURI) external onlyOwner {
        require(!metadataFrozen, "Metadata frozen");
        baseURI = _baseURI;
    }
    
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_exists(tokenId), "Token does not exist");
        
        TraitCombo memory traits = tokenTraits[tokenId];
        
        // Build trait image URLs using baseURI
        string memory personaName = _getPersonaName(traits.persona);
        
        string memory bgUrl = string(abi.encodePacked(
            baseURI, personaName, "/bg/", _toString(traits.bg), ".png"
        ));
        
        string memory bodyUrl = string(abi.encodePacked(
            baseURI, personaName, "/body/", _toString(traits.body), ".png"
        ));
        
        string memory headUrl = string(abi.encodePacked(
            baseURI, personaName, "/head/", _toString(traits.head), ".png"
        ));
        
        string memory accessoriesUrl = string(abi.encodePacked(
            baseURI, personaName, "/accessories/", _toString(traits.accessories), ".png"
        ));
        
        string memory itemUrl = string(abi.encodePacked(
            baseURI, personaName, "/item/", _toString(traits.item), ".png"
        ));
        
        // Build attributes with image URLs for each layer
        bytes memory attributes = abi.encodePacked(
            '[',
            '{"trait_type":"Persona","value":"', personaName, '"},',
            '{"trait_type":"BG","value":"BG_', _toString(traits.bg), '","image_url":"', bgUrl, '"},',
            '{"trait_type":"Body","value":"Body_', _toString(traits.body), '","image_url":"', bodyUrl, '"},',
            '{"trait_type":"Head","value":"Head_', _toString(traits.head), '","image_url":"', headUrl, '"},',
            '{"trait_type":"Accessories","value":"Acc_', _toString(traits.accessories), '","image_url":"', accessoriesUrl, '"},',
            '{"trait_type":"Item","value":"Item_', _toString(traits.item), '","image_url":"', itemUrl, '"},',
            '{"trait_type":"Legendary","value":"', (traits.legendary == 1 ? "True" : "False"), '"},',
            '{"trait_type":"ETHDenver","value":"Slot_', _toString(traits.ethDenverSlot), '"}',
            ']'
        );
        
        // Primary image is background layer
        bytes memory json = abi.encodePacked(
            '{',
            '"name":"XAO ETHDenver #', _toString(tokenId), '",',
            '"description":"A cultural artifact marking early participation at XAO ETHDenver 2025",',
            '"image":"', bgUrl, '",',
            '"attributes":', attributes,
            '}'
        );
        
        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(json)
        ));
    }
    
    function getMetadata(uint256 tokenId) external view returns (string memory) {
        return tokenURI(tokenId);
    }
    
    // =========================
    // HELPER FUNCTIONS
    // =========================
    
    function _getPersonaName(uint8 persona) internal pure returns (string memory) {
        if (persona == 0) return "Classic";
        if (persona == 1) return "Country";
        if (persona == 2) return "Electronic";
        if (persona == 3) return "Hip-Hop";
        if (persona == 4) return "Jazz";
        if (persona == 5) return "K-POP";
        if (persona == 6) return "Punk";
        return "Unknown";
    }
    
    function _toString(uint256 value) internal override pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
    
    // =========================
    // QUERY FUNCTIONS
    // =========================
    
    function getTraits(uint256 tokenId) external view returns (TraitCombo memory) {
        require(_exists(tokenId), "Token does not exist");
        return tokenTraits[tokenId];
    }
    
    function getPersonaStatus() external view returns (uint16[7] memory) {
        uint16[7] memory status;
        for (uint8 i = 0; i < 7; i++) {
            status[i] = personaMintedCount[i];
        }
        return status;
    }
    
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }
    
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
