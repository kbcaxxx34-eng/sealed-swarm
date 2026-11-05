// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint64, externalEuint64, eaddress} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title SealedSwarmAuction
/// @notice Sealed-bid, second-price (Vickrey) auctions where every bid stays encrypted with
///         Zama FHE. Bidders can be people or AI agents. In the SealedSwarm app, each agent is an
///         Ethereum address controlled by a NEAR account through NEAR Chain Signatures.
/// @dev    Only two values are ever decrypted, and only after the auction closes: the winner
///         and the price it pays (the second-highest bid, or the reserve if higher). Losing bids
///         are never revealed to anyone except the bidder who placed them.
contract SealedSwarmAuction is ZamaEthereumConfig {
    struct Auction {
        address seller;
        uint64 reservePrice;
        uint64 endTime;
        uint32 bidCount;
        bool closed;
        bool revealed;
        address winner; // clear, set by reveal()
        uint64 price; // clear, set by reveal()
        string item;
    }

    struct SealedState {
        euint64 highest;
        euint64 second;
        eaddress leader;
        eaddress finalWinner; // set by close(), publicly decryptable
        euint64 finalPrice; // set by close(), publicly decryptable
    }

    uint64 public constant MIN_DURATION = 60;
    uint64 public constant MAX_DURATION = 30 days;
    uint32 public constant MAX_BIDS = 64;

    uint256 public auctionCount;

    mapping(uint256 => Auction) private _auctions;
    mapping(uint256 => SealedState) private _sealed;
    mapping(uint256 => mapping(address => bool)) public hasBid;
    mapping(uint256 => mapping(address => euint64)) private _bids;

    event AuctionCreated(uint256 indexed id, address indexed seller, string item, uint64 endTime, uint64 reservePrice);
    event BidPlaced(uint256 indexed id, address indexed bidder, uint32 bidCount);
    event AuctionClosed(uint256 indexed id, bytes32 winnerHandle, bytes32 priceHandle);
    event AuctionRevealed(uint256 indexed id, address winner, uint64 price);

    error InvalidDuration();
    error UnknownAuction();
    error AuctionEnded();
    error AuctionNotEnded();
    error AlreadyBid();
    error TooManyBids();
    error AlreadyClosed();
    error NotClosed();
    error AlreadyRevealed();

    /// @notice Creates an auction. The reserve price is public; bids are not.
    function createAuction(string calldata item, uint64 duration, uint64 reservePrice) external returns (uint256 id) {
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert InvalidDuration();
        id = ++auctionCount;

        Auction storage a = _auctions[id];
        a.seller = msg.sender;
        a.reservePrice = reservePrice;
        a.endTime = uint64(block.timestamp) + duration;
        a.item = item;

        SealedState storage s = _sealed[id];
        s.highest = FHE.asEuint64(0);
        s.second = FHE.asEuint64(0);
        s.leader = FHE.asEaddress(address(0));
        FHE.allowThis(s.highest);
        FHE.allowThis(s.second);
        FHE.allowThis(s.leader);

        emit AuctionCreated(id, msg.sender, item, a.endTime, reservePrice);
    }

    /// @notice Places one encrypted bid. The value is encrypted in the bidder's browser and is
    ///         compared on-chain without ever being decrypted.
    function placeBid(uint256 id, externalEuint64 encryptedBid, bytes calldata inputProof) external {
        Auction storage a = _auctions[id];
        if (a.seller == address(0)) revert UnknownAuction();
        if (block.timestamp >= a.endTime || a.closed) revert AuctionEnded();
        if (hasBid[id][msg.sender]) revert AlreadyBid();
        if (a.bidCount >= MAX_BIDS) revert TooManyBids();

        euint64 bid = FHE.fromExternal(encryptedBid, inputProof);

        SealedState storage s = _sealed[id];
        ebool aboveHighest = FHE.gt(bid, s.highest);
        ebool aboveSecond = FHE.gt(bid, s.second);

        // second = bid > highest ? highest : (bid > second ? bid : second)
        s.second = FHE.select(aboveHighest, s.highest, FHE.select(aboveSecond, bid, s.second));
        // highest = max(bid, highest); leader follows the highest bid (ties keep the earlier bidder)
        s.highest = FHE.select(aboveHighest, bid, s.highest);
        s.leader = FHE.select(aboveHighest, FHE.asEaddress(msg.sender), s.leader);

        FHE.allowThis(s.second);
        FHE.allowThis(s.highest);
        FHE.allowThis(s.leader);

        // the bidder (and only the bidder) can decrypt its own bid
        _bids[id][msg.sender] = bid;
        FHE.allowThis(bid);
        FHE.allow(bid, msg.sender);

        hasBid[id][msg.sender] = true;
        a.bidCount += 1;
        emit BidPlaced(id, msg.sender, a.bidCount);
    }

    /// @notice Closes the auction after its end time. Computes the encrypted outcome and marks
    ///         only the winner and the clearing price as publicly decryptable.
    /// @dev    No sale (winner = address(0), price = 0) if the highest bid is below the reserve.
    function close(uint256 id) external {
        Auction storage a = _auctions[id];
        if (a.seller == address(0)) revert UnknownAuction();
        if (block.timestamp < a.endTime) revert AuctionNotEnded();
        if (a.closed) revert AlreadyClosed();
        a.closed = true;

        SealedState storage s = _sealed[id];
        euint64 reserve = FHE.asEuint64(a.reservePrice);
        ebool meetsReserve = FHE.ge(s.highest, reserve);

        s.finalWinner = FHE.select(meetsReserve, s.leader, FHE.asEaddress(address(0)));
        s.finalPrice = FHE.select(meetsReserve, FHE.max(s.second, reserve), FHE.asEuint64(0));

        FHE.allowThis(s.finalWinner);
        FHE.allowThis(s.finalPrice);
        FHE.makePubliclyDecryptable(s.finalWinner);
        FHE.makePubliclyDecryptable(s.finalPrice);

        emit AuctionClosed(id, FHE.toBytes32(s.finalWinner), FHE.toBytes32(s.finalPrice));
    }

    /// @notice Publishes the decrypted outcome on-chain. Anyone can call it with the result and
    ///         proof returned by the Zama relayer; the KMS signatures are verified here.
    function reveal(uint256 id, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof) external {
        Auction storage a = _auctions[id];
        if (!a.closed) revert NotClosed();
        if (a.revealed) revert AlreadyRevealed();

        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(_sealed[id].finalWinner);
        handles[1] = FHE.toBytes32(_sealed[id].finalPrice);
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);

        (address winner, uint64 price) = abi.decode(abiEncodedCleartexts, (address, uint64));
        a.winner = winner;
        a.price = price;
        a.revealed = true;
        emit AuctionRevealed(id, winner, price);
    }

    // ---------------------------------------------------------------- views

    function getAuction(uint256 id) external view returns (Auction memory) {
        return _auctions[id];
    }

    /// @notice Handles of the publicly decryptable outcome (zero until close()).
    function getResultHandles(uint256 id) external view returns (bytes32 winnerHandle, bytes32 priceHandle) {
        SealedState storage s = _sealed[id];
        return (FHE.toBytes32(s.finalWinner), FHE.toBytes32(s.finalPrice));
    }

    /// @notice Encrypted handle of a bidder's own bid; only that bidder can decrypt it.
    function getBid(uint256 id, address bidder) external view returns (euint64) {
        return _bids[id][bidder];
    }
}
