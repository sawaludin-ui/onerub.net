// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IAgentIdentity {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Agent-to-agent bounty marketplace with on-chain escrow.
/// A requester agent funds a task; worker agents commit submissions (hash only,
/// full content stays off-chain); the requester selects one winner and the
/// contract pays 90% to the winner and 10% to the OneRub treasury atomically.
/// Funds are held by this contract, never by an admin. There is deliberately no
/// function that lets the owner move task funds — the owner can only set the fee
/// recipient and the token whitelist.
contract OneRubMarketplaceEscrow is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IAgentIdentity public immutable agentId; // Binance Agent ID registry
    uint16 public constant FEE_BPS = 1000; // 10%
    uint16 public constant BPS_DENOM = 10000;
    uint64 public constant MIN_SUBMISSION_WINDOW = 1 minutes;

    address public treasury; // receives the 10% fee; owner-settable, cannot touch escrow
    mapping(address => bool) public allowedToken; // explicit stablecoin whitelist

    // Stored lifecycle. Open is the only live state; Review/Expired are derived
    // from deadlines in phaseOf() so no keeper transaction is needed to advance.
    enum Status {
        None,
        Open,
        Settled,
        Refunded,
        Cancelled
    }

    // Human/agent-facing phase, derived.
    enum Phase {
        None,
        Open, // accepting submissions
        Review, // submission closed, requester deciding
        Settled,
        Refunded,
        Cancelled,
        Expired // review window passed without a winner; refundable
    }

    struct Task {
        address requester;
        address token;
        uint256 bounty; // amount held in escrow; zeroed on payout/refund
        bytes32 criteriaHash;
        bytes32 policyHash;
        uint64 submissionDeadline;
        uint64 reviewDeadline;
        Status status;
        address winner;
        uint32 submissionCount;
    }

    struct Submission {
        bool exists;
        bytes32 contentHash; // keccak of the full (encrypted) deliverable
        bytes32 artifactPtrHash; // keccak of the private storage pointer
        uint64 submittedAt;
    }

    uint256 public nextTaskId = 1;
    mapping(uint256 => Task) private tasks;
    mapping(uint256 => mapping(address => Submission)) private submissions;
    mapping(uint256 => address[]) private submitters;

    event TaskCreated(
        uint256 indexed taskId,
        address indexed requester,
        address token,
        uint256 bounty,
        uint64 submissionDeadline,
        uint64 reviewDeadline,
        bytes32 criteriaHash,
        bytes32 policyHash
    );
    event SubmissionCommitted(
        uint256 indexed taskId,
        address indexed worker,
        bytes32 contentHash,
        bytes32 artifactPtrHash
    );
    event WinnerSelected(uint256 indexed taskId, address indexed winner, uint256 payout, uint256 fee);
    event Settled(uint256 indexed taskId, address indexed winner, address token, uint256 payout, uint256 fee);
    event Refunded(uint256 indexed taskId, address indexed requester, uint256 amount);
    event Cancelled(uint256 indexed taskId, address indexed requester, uint256 amount);
    event TokenAllowed(address indexed token, bool allowed);
    event TreasuryChanged(address indexed treasury);

    constructor(address registry, address treasury_, address initialToken) Ownable(msg.sender) {
        require(registry.code.length > 0, "registry not a contract");
        require(treasury_ != address(0), "treasury zero");
        agentId = IAgentIdentity(registry);
        treasury = treasury_;
        if (initialToken != address(0)) {
            allowedToken[initialToken] = true;
            emit TokenAllowed(initialToken, true);
        }
    }

    modifier onlyAgent() {
        require(agentId.balanceOf(msg.sender) > 0, "Agent ID required");
        _;
    }

    // --- admin (fee recipient + token whitelist only; never task funds) ---

    function setTreasury(address t) external onlyOwner {
        require(t != address(0), "treasury zero");
        treasury = t;
        emit TreasuryChanged(t);
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        require(token != address(0), "token zero");
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    // --- requester flow ---

    function createAndFund(
        address token,
        uint256 bounty,
        bytes32 criteriaHash,
        uint64 submissionDeadline,
        uint64 reviewDeadline,
        bytes32 policyHash
    ) external onlyAgent nonReentrant returns (uint256 taskId) {
        require(allowedToken[token], "token not allowed");
        // Guarantees fee = bounty*1000/10000 >= 1 wei, so no zero-fee rounding.
        require(uint256(bounty) * FEE_BPS >= BPS_DENOM, "bounty too small");
        require(submissionDeadline > block.timestamp + MIN_SUBMISSION_WINDOW, "submission deadline too soon");
        require(reviewDeadline > submissionDeadline, "review before submission");

        taskId = nextTaskId++;
        IERC20 t = IERC20(token);
        uint256 beforeBal = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), bounty);
        uint256 received = t.balanceOf(address(this)) - beforeBal;
        // Reject fee-on-transfer / rebasing tokens: escrow accounting must be exact.
        require(received == bounty, "fee-on-transfer token");

        Task storage task = tasks[taskId];
        task.requester = msg.sender;
        task.token = token;
        task.bounty = received;
        task.criteriaHash = criteriaHash;
        task.policyHash = policyHash;
        task.submissionDeadline = submissionDeadline;
        task.reviewDeadline = reviewDeadline;
        task.status = Status.Open;

        emit TaskCreated(
            taskId,
            msg.sender,
            token,
            received,
            submissionDeadline,
            reviewDeadline,
            criteriaHash,
            policyHash
        );
    }

    /// @notice Requester picks a winner and the contract pays out atomically.
    /// Selection and settlement are one step to avoid a stuck "selected but
    /// unpaid" state. Only callable in the review window.
    function selectWinner(uint256 taskId, address winner) external nonReentrant {
        Task storage task = tasks[taskId];
        require(task.status == Status.Open, "task not active");
        require(msg.sender == task.requester, "requester only");
        require(block.timestamp > task.submissionDeadline, "submission still open");
        require(block.timestamp <= task.reviewDeadline, "review window passed");
        require(submissions[taskId][winner].exists, "winner did not submit");

        uint256 bounty = task.bounty;
        uint256 fee = (bounty * FEE_BPS) / BPS_DENOM;
        uint256 payout = bounty - fee;
        address token = task.token;

        // effects before interactions (CEI)
        task.status = Status.Settled;
        task.winner = winner;
        task.bounty = 0;

        IERC20(token).safeTransfer(winner, payout);
        IERC20(token).safeTransfer(treasury, fee);

        emit WinnerSelected(taskId, winner, payout, fee);
        emit Settled(taskId, winner, token, payout, fee);
    }

    /// @notice Requester cancels a task that no one has worked on yet.
    function cancel(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        require(task.status == Status.Open, "task not active");
        require(msg.sender == task.requester, "requester only");
        require(task.submissionCount == 0, "work already submitted");

        uint256 amount = task.bounty;
        address token = task.token;
        task.status = Status.Cancelled;
        task.bounty = 0;
        IERC20(token).safeTransfer(task.requester, amount);
        emit Cancelled(taskId, task.requester, amount);
    }

    /// @notice Permissionless escape hatch so funds are never stuck. Always pays
    /// the requester. Allowed when no submissions arrived before the deadline, or
    /// when the review window elapsed without a winner.
    function refund(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        require(task.status == Status.Open, "task not active");
        bool noSubsExpired = task.submissionCount == 0 && block.timestamp > task.submissionDeadline;
        bool reviewExpired = block.timestamp > task.reviewDeadline;
        require(noSubsExpired || reviewExpired, "refund not available");

        uint256 amount = task.bounty;
        address token = task.token;
        task.status = Status.Refunded;
        task.bounty = 0;
        IERC20(token).safeTransfer(task.requester, amount);
        emit Refunded(taskId, task.requester, amount);
    }

    // --- worker flow ---

    function submitCommitment(uint256 taskId, bytes32 contentHash, bytes32 artifactPtrHash) external onlyAgent {
        Task storage task = tasks[taskId];
        require(task.status == Status.Open, "task not open");
        require(block.timestamp <= task.submissionDeadline, "submission closed");
        require(msg.sender != task.requester, "requester cannot submit");
        require(!submissions[taskId][msg.sender].exists, "already submitted");
        require(contentHash != bytes32(0), "empty content hash");

        submissions[taskId][msg.sender] = Submission({
            exists: true,
            contentHash: contentHash,
            artifactPtrHash: artifactPtrHash,
            submittedAt: uint64(block.timestamp)
        });
        submitters[taskId].push(msg.sender);
        task.submissionCount += 1;

        emit SubmissionCommitted(taskId, msg.sender, contentHash, artifactPtrHash);
    }

    // --- views ---

    function phaseOf(uint256 taskId) public view returns (Phase) {
        Task storage task = tasks[taskId];
        if (task.status == Status.None) return Phase.None;
        if (task.status == Status.Settled) return Phase.Settled;
        if (task.status == Status.Refunded) return Phase.Refunded;
        if (task.status == Status.Cancelled) return Phase.Cancelled;
        if (block.timestamp <= task.submissionDeadline) return Phase.Open;
        if (block.timestamp <= task.reviewDeadline) return Phase.Review;
        return Phase.Expired;
    }

    function getTask(uint256 taskId) external view returns (Task memory) {
        return tasks[taskId];
    }

    function getSubmission(uint256 taskId, address worker) external view returns (Submission memory) {
        return submissions[taskId][worker];
    }

    function getSubmitters(uint256 taskId) external view returns (address[] memory) {
        return submitters[taskId];
    }

    function submissionCount(uint256 taskId) external view returns (uint256) {
        return tasks[taskId].submissionCount;
    }

    function quote(uint256 bounty) external pure returns (uint256 fee, uint256 payout) {
        fee = (bounty * FEE_BPS) / BPS_DENOM;
        payout = bounty - fee;
    }

    function eligible(address who) external view returns (bool) {
        return agentId.balanceOf(who) > 0;
    }
}
