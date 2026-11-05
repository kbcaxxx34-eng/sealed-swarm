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
///
///         Buyer pools (group buying): several bidders can each put an encrypted contribution
///         into a pool. The contract adds the contributions under encryption and, when the pool
///         creator submits it, the pool total competes as one bid. Nobody, including the other
///         members, learns any member's contribution. If the pool wins, it pays the second price;
///         each member can decrypt its own contribution and the pool total (and nothing else) to
///         compute its pro-rata share of that price.
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
    uint32 public constant MAX_POOL_MEMBERS = 16;

    struct Pool {
        address creator;
        uint32 members;
        bool submitted;
    }

    uint256 public auctionCount;

    mapping(uint256 => Auction) private _auctions;
    mapping(uint256 => SealedState) private _sealed;
    mapping(uint256 => mapping(address => bool)) public hasBid;
    mapping(uint256 => mapping(address => euint64)) private _bids;
    mapping(uint256 => uint256) public poolCount;
    mapping(uint256 => mapping(uint256 => Pool)) private _pools;
    mapping(uint256 => mapping(uint256 => euint64)) private _poolTotals;
    mapping(uint256 => mapping(uint256 => address[])) private _poolMembers;
    mapping(uint256 => mapping(address => uint256)) public poolOf;

    event AuctionCreated(uint256 indexed id, address indexed seller, string item, uint64 endTime, uint64 reservePrice);
    event BidPlaced(uint256 indexed id, address indexed bidder, uint32 bidCount);
    event PoolJoined(uint256 indexed id, uint256 indexed poolId, address indexed member, uint32 members);
    event PoolSubmitted(uint256 indexed id, uint256 indexed poolId, address poolAddress, uint32 members, uint32 bidCount);
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
    error UnknownPool();
    error PoolFull();
    error PoolAlreadySubmitted();
    error NotPoolCreator();

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
        Auction storage a = _openAuction(id);
        if (hasBid[id][msg.sender]) revert AlreadyBid();
        if (a.bidCount >= MAX_BIDS) revert TooManyBids();

        euint64 bid = FHE.fromExternal(encryptedBid, inputProof);
        _keepOwnBid(id, bid);
        _enter(id, bid, msg.sender);
        emit BidPlaced(id, msg.sender, a.bidCount);
    }

    /// @notice Puts an encrypted contribution into a buyer pool. poolId = 0 opens a new pool with
    ///         the caller as its creator. A pool member cannot also bid alone in the same auction.
    function joinPool(uint256 id, uint256 poolId, externalEuint64 encryptedContribution, bytes calldata inputProof)
        external
        returns (uint256)
    {
        _openAuction(id);
        if (hasBid[id][msg.sender]) revert AlreadyBid();
        if (poolId == 0) {
            poolId = ++poolCount[id];
            _pools[id][poolId].creator = msg.sender;
            _poolTotals[id][poolId] = FHE.asEuint64(0);
        }
        Pool storage p = _pools[id][poolId];
        if (p.creator == address(0)) revert UnknownPool();
        if (p.submitted) revert PoolAlreadySubmitted();
        if (p.members >= MAX_POOL_MEMBERS) revert PoolFull();

        euint64 c = FHE.fromExternal(encryptedContribution, inputProof);
        _keepOwnBid(id, c);

        // total += c, saturating at the euint64 maximum instead of wrapping around
        euint64 total = _poolTotals[id][poolId];
        euint64 sum = FHE.add(total, c);
        total = FHE.select(FHE.lt(sum, total), FHE.asEuint64(type(uint64).max), sum);
        FHE.allowThis(total);
        _poolTotals[id][poolId] = total;

        p.members += 1;
        _poolMembers[id][poolId].push(msg.sender);
        poolOf[id][msg.sender] = poolId;
        emit PoolJoined(id, poolId, msg.sender, p.members);
        return poolId;
    }

    /// @notice The pool creator submits the pool: its encrypted total competes as one bid, under
    ///         the pool's own address. Every member may then decrypt the pool total.
    function submitPool(uint256 id, uint256 poolId) external {
        Auction storage a = _openAuction(id);
        Pool storage p = _pools[id][poolId];
        if (p.creator == address(0)) revert UnknownPool();
        if (p.creator != msg.sender) revert NotPoolCreator();
        if (p.submitted) revert PoolAlreadySubmitted();
        if (a.bidCount >= MAX_BIDS) revert TooManyBids();
        p.submitted = true;

        euint64 total = _poolTotals[id][poolId];
        address[] storage members = _poolMembers[id][poolId];
        for (uint256 i = 0; i < members.length; i++) FHE.allow(total, members[i]);

        address pa = poolAddress(id, poolId);
        _enter(id, total, pa);
        emit PoolSubmitted(id, poolId, pa, p.members, a.bidCount);
    }

    /// @notice The address a pool bids under (and wins under). Not a real account.
    function poolAddress(uint256 id, uint256 poolId) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("SealedSwarm.pool", address(this), id, poolId)))));
    }

    function _openAuction(uint256 id) private view returns (Auction storage a) {
        a = _auctions[id];
        if (a.seller == address(0)) revert UnknownAuction();
        if (block.timestamp >= a.endTime || a.closed) revert AuctionEnded();
    }

    // the bidder (and only the bidder) can decrypt its own bid or contribution
    function _keepOwnBid(uint256 id, euint64 v) private {
        _bids[id][msg.sender] = v;
        FHE.allowThis(v);
        FHE.allow(v, msg.sender);
        hasBid[id][msg.sender] = true;
    }

    // Enters an encrypted bid into the running (highest, second, leader) state.
    function _enter(uint256 id, euint64 bid, address bidder) private {
        SealedState storage s = _sealed[id];
        ebool aboveHighest = FHE.gt(bid, s.highest);
        ebool aboveSecond = FHE.gt(bid, s.second);

        // second = bid > highest ? highest : (bid > second ? bid : second)
        s.second = FHE.select(aboveHighest, s.highest, FHE.select(aboveSecond, bid, s.second));
        // highest = max(bid, highest); leader follows the highest bid (ties keep the earlier bidder)
        s.highest = FHE.select(aboveHighest, bid, s.highest);
        s.leader = FHE.select(aboveHighest, FHE.asEaddress(bidder), s.leader);

        FHE.allowThis(s.second);
        FHE.allowThis(s.highest);
        FHE.allowThis(s.leader);
        _auctions[id].bidCount += 1;
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

    function getPool(uint256 id, uint256 poolId)
        external
        view
        returns (address creator, uint32 members, bool submitted, address bidderAddress)
    {
        Pool storage p = _pools[id][poolId];
        return (p.creator, p.members, p.submitted, poolAddress(id, poolId));
    }

    function getPoolMembers(uint256 id, uint256 poolId) external view returns (address[] memory) {
        return _poolMembers[id][poolId];
    }

    /// @notice Encrypted pool total; members can decrypt it once the pool is submitted.
    function getPoolTotal(uint256 id, uint256 poolId) external view returns (euint64) {
        return _poolTotals[id][poolId];
    }

    /// @notice Encrypted handle of a bidder's own bid (or pool contribution); only that bidder can decrypt it.
    function getBid(uint256 id, address bidder) external view returns (euint64) {
        return _bids[id][bidder];
    }
}
