// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IMarketplaceAgentIdentityV2 {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Receipt-gated agent marketplace. The hosted evaluator is an explicit
/// trusted signer: signatures attest private-artifact admission and selection,
/// not cryptographic proof of judgment quality or future storage availability.
/// V1 is separate and unchanged. No owner function can withdraw task escrow.
contract OneRubMarketplaceEscrowV2 is ReentrancyGuard, Ownable, EIP712 {
    using SafeERC20 for IERC20;
    uint16 public constant PROTOCOL_REVISION = 3;
    uint32 public constant MIN_VALID_SUBMISSIONS = 1;
    uint16 public constant FEE_BPS = 1000;
    uint16 public constant BPS_DENOM = 10000;
    uint64 public constant MIN_SUBMISSION_WINDOW = 2 minutes;
    uint64 public constant MIN_REVIEW_WINDOW = 60 minutes;
    uint32 public constant MAX_PARTICIPANTS = 64;
    uint32 public constant MAX_ARTIFACT_BYTES = 512 * 1024;
    uint32 public constant MAX_TOTAL_BYTES = MAX_PARTICIPANTS * MAX_ARTIFACT_BYTES;
    bytes32 public constant UPLOAD_RECEIPT_TYPEHASH = keccak256("UploadReceipt(uint256 taskId,address worker,bytes32 contentHash,bytes32 artifactPtrHash,uint32 size,uint64 expiresAt)");
    bytes32 public constant REVIEW_DECISION_TYPEHASH = keccak256("ReviewDecision(uint256 taskId,address winner,bytes32 contentHash,bytes32 artifactPtrHash,bytes32 candidatesHash,bytes32 criteriaHash,bytes32 policyHash,uint64 expiresAt,bool accepted)");

    IMarketplaceAgentIdentityV2 public immutable agentId;
    // Default for NEW tasks only. Existing task signer snapshots never change.
    address public evaluator;
    mapping(address => bool) public revokedEvaluator;
    address public treasury;
    mapping(address => bool) public allowedToken;
    enum Status { None, Open, Settled, Refunded, Cancelled }
    enum Phase { None, Open, Review, Settled, Refunded, Cancelled, Expired }
    struct Task {
        address requester;
        address token;
        uint256 bounty;
        bytes32 criteriaHash;
        bytes32 policyHash;
        uint64 submissionDeadline;
        uint64 reviewDeadline;
        Status status;
        address winner;
        uint32 submissionCount;
        address feeRecipient;
        uint32 totalBytes;
        bytes32 candidatesHash;
        address evaluatorSigner;
    }
    struct Submission {
        bool exists;
        bytes32 contentHash;
        bytes32 artifactPtrHash;
        uint64 submittedAt;
        uint32 size;
    }
    uint256 public nextTaskId = 1;
    mapping(uint256 => Task) private tasks;
    mapping(uint256 => mapping(address => Submission)) private submissions;
    mapping(uint256 => address[]) private submitters;
    event TaskCreated(uint256 indexed taskId,address indexed requester,address token,uint256 bounty,uint64 submissionDeadline,uint64 reviewDeadline,bytes32 criteriaHash,bytes32 policyHash);
    event SubmissionCommitted(uint256 indexed taskId,address indexed worker,bytes32 contentHash,bytes32 artifactPtrHash,uint32 size,bytes32 candidatesHash);
    event WinnerSelected(uint256 indexed taskId,address indexed winner,uint256 payout,uint256 fee);
    event Settled(uint256 indexed taskId,address indexed winner,address token,uint256 payout,uint256 fee);
    event EvaluationAccepted(uint256 indexed taskId,bytes32 indexed decisionDigest,bool accepted);
    event Refunded(uint256 indexed taskId,address indexed requester,uint256 amount);
    event Cancelled(uint256 indexed taskId,address indexed requester,uint256 amount);
    event TokenAllowed(address indexed token,bool allowed);
    event TreasuryChanged(address indexed treasury);
    event EvaluatorChanged(address indexed previous,address indexed current);
    event EvaluatorRevoked(address indexed signer,bytes32 indexed reasonHash);

    /// @notice Rotation affects only future funded tasks; revocation is permanent.
    /// Revoked active tasks can only cancel/refund, never migrate to a new signer.
    function setEvaluator(address next) external onlyOwner {
        require(next != address(0) && !revokedEvaluator[next],"invalid evaluator");
        emit EvaluatorChanged(evaluator,next);evaluator=next;
    }
    function revokeEvaluator(address signer,bytes32 reasonHash) external onlyOwner {
        require(signer != address(0) && reasonHash != bytes32(0),"revocation disclosure required");
        require(!revokedEvaluator[signer],"already revoked");
        revokedEvaluator[signer]=true;emit EvaluatorRevoked(signer,reasonHash);
    }

    constructor(address registry,address treasury_,address initialToken,address evaluator_)
        Ownable(msg.sender) EIP712("ONERUB Marketplace Escrow","2")
    {
        require(registry.code.length > 0,"registry not a contract");
        require(treasury_ != address(0),"treasury zero");
        require(evaluator_ != address(0),"evaluator zero");
        require(initialToken.code.length > 0,"token not a contract");
        agentId = IMarketplaceAgentIdentityV2(registry);
        evaluator = evaluator_;
        treasury = treasury_;
        allowedToken[initialToken] = true;
        emit TokenAllowed(initialToken,true);
    }
    modifier onlyAgent() { require(agentId.balanceOf(msg.sender) > 0,"Agent ID required"); _; }
    function setTreasury(address t) external onlyOwner {
        require(t != address(0),"treasury zero"); treasury=t; emit TreasuryChanged(t);
    }
    function setAllowedToken(address token,bool allowed) external onlyOwner {
        require(token.code.length > 0,"token not a contract"); allowedToken[token]=allowed; emit TokenAllowed(token,allowed);
    }
    function createAndFund(address token,uint256 bounty,bytes32 criteriaHash,uint64 submissionDeadline,uint64 reviewDeadline,bytes32 policyHash)
        external onlyAgent nonReentrant returns(uint256 taskId)
    {
        require(!revokedEvaluator[evaluator],"evaluator revoked");
        require(allowedToken[token],"token not allowed");
        require(bounty >= 10,"bounty too small");
        require(criteriaHash != bytes32(0) && policyHash != bytes32(0),"empty task commitment");
        require(submissionDeadline >= block.timestamp + MIN_SUBMISSION_WINDOW,"submission deadline too soon");
        require(uint256(reviewDeadline) >= uint256(submissionDeadline) + MIN_REVIEW_WINDOW,"review window too short");
        taskId=nextTaskId++;
        IERC20 asset=IERC20(token);
        uint256 beforeBal=asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender,address(this),bounty);
        require(asset.balanceOf(address(this))-beforeBal == bounty,"fee-on-transfer token");
        Task storage t=tasks[taskId];
        t.requester=msg.sender;t.token=token;t.bounty=bounty;t.criteriaHash=criteriaHash;t.policyHash=policyHash;
        t.submissionDeadline=submissionDeadline;t.reviewDeadline=reviewDeadline;t.status=Status.Open;t.feeRecipient=treasury;t.evaluatorSigner=evaluator;
        emit TaskCreated(taskId,msg.sender,token,bounty,submissionDeadline,reviewDeadline,criteriaHash,policyHash);
    }
    function uploadReceiptDigest(uint256 taskId,address worker,bytes32 contentHash,bytes32 artifactPtrHash,uint32 size,uint64 expiresAt)
        public view returns(bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(UPLOAD_RECEIPT_TYPEHASH,taskId,worker,contentHash,artifactPtrHash,size,expiresAt)));
    }
    function submitCommitment(uint256 taskId,bytes32 contentHash,bytes32 artifactPtrHash,uint32 size,uint64 expiresAt,bytes calldata signature)
        external onlyAgent
    {
        Task storage t=tasks[taskId];
        require(t.status == Status.Open,"task not open");
        require(!revokedEvaluator[t.evaluatorSigner],"evaluator revoked");
        require(block.timestamp <= t.submissionDeadline,"submission closed");
        require(msg.sender != t.requester,"requester cannot submit");
        require(!submissions[taskId][msg.sender].exists,"already submitted");
        require(t.submissionCount < MAX_PARTICIPANTS,"participant limit");
        require(size >= 10 && size <= MAX_ARTIFACT_BYTES,"artifact size outside limits");
        require(uint256(t.totalBytes)+size <= MAX_TOTAL_BYTES,"task byte limit");
        require(contentHash != bytes32(0) && artifactPtrHash != bytes32(0),"empty commitment");
        require(expiresAt >= block.timestamp && expiresAt <= t.submissionDeadline,"receipt expired or invalid");
        require(ECDSA.recover(uploadReceiptDigest(taskId,msg.sender,contentHash,artifactPtrHash,size,expiresAt),signature)==t.evaluatorSigner,"invalid upload receipt");
        submissions[taskId][msg.sender]=Submission(true,contentHash,artifactPtrHash,uint64(block.timestamp),size);
        submitters[taskId].push(msg.sender);
        t.submissionCount+=1;t.totalBytes+=size;
        t.candidatesHash=keccak256(abi.encode(t.candidatesHash,msg.sender,contentHash,artifactPtrHash,size));
        emit SubmissionCommitted(taskId,msg.sender,contentHash,artifactPtrHash,size,t.candidatesHash);
    }
    function reviewDigest(uint256 taskId,address winner,uint64 expiresAt,bool accepted) public view returns(bytes32) {
        Task storage t=tasks[taskId];
        Submission storage s=submissions[taskId][winner];
        return _hashTypedDataV4(keccak256(abi.encode(REVIEW_DECISION_TYPEHASH,taskId,winner,accepted?s.contentHash:bytes32(0),accepted?s.artifactPtrHash:bytes32(0),t.candidatesHash,t.criteriaHash,t.policyHash,expiresAt,accepted)));
    }
    function _reviewWindow(Task storage t,uint64 expiresAt) private view {
        require(t.status == Status.Open,"task not active");
        require(block.timestamp > t.submissionDeadline,"submission still open");
        require(block.timestamp <= t.reviewDeadline,"review window passed");
        require(expiresAt >= block.timestamp && expiresAt <= t.reviewDeadline,"decision expired or invalid");
        require(!revokedEvaluator[t.evaluatorSigner],"evaluator revoked");
        require(t.submissionCount >= MIN_VALID_SUBMISSIONS,"one submission required");
    }
    /// @notice Anyone can relay the published policy-bound signed decision.
    /// Only this task's funded escrow is paid to its signed winner and fee snapshot.
    function selectWinner(uint256 taskId,address winner,uint64 expiresAt,bytes calldata signature) external nonReentrant {
        Task storage t=tasks[taskId];
        require(agentId.balanceOf(t.requester)>0,"requester Agent ID required");
        _reviewWindow(t,expiresAt);
        require(submissions[taskId][winner].exists,"winner did not submit");
        require(agentId.balanceOf(winner)>0,"winner Agent ID required");
        bytes32 digest=reviewDigest(taskId,winner,expiresAt,true);
        require(ECDSA.recover(digest,signature)==t.evaluatorSigner,"invalid review decision");
        uint256 bounty=t.bounty;
        uint256 fee=bounty/10;
        uint256 payout=bounty-fee;
        t.status=Status.Settled;t.winner=winner;t.bounty=0;
        IERC20(t.token).safeTransfer(winner,payout);
        IERC20(t.token).safeTransfer(t.feeRecipient,fee);
        emit EvaluationAccepted(taskId,digest,true);
        emit WinnerSelected(taskId,winner,payout,fee);
        emit Settled(taskId,winner,t.token,payout,fee);
    }
    /// @notice A signed no-acceptable-work decision refunds the requester. It is
    /// bound to every admitted commitment, task rubric, policy and this contract.
    /// Anyone can relay this decision; funds always return to the requester.
    function rejectAll(uint256 taskId,uint64 expiresAt,bytes calldata signature) external nonReentrant {
        Task storage t=tasks[taskId];_reviewWindow(t,expiresAt);
        bytes32 digest=reviewDigest(taskId,address(0),expiresAt,false);
        require(ECDSA.recover(digest,signature)==t.evaluatorSigner,"invalid rejection decision");
        emit EvaluationAccepted(taskId,digest,false);_refund(taskId,t,false);
    }
    function cancel(uint256 taskId) external nonReentrant {
        Task storage t=tasks[taskId];require(t.status==Status.Open,"task not active");
        require(msg.sender==t.requester,"requester only");require(t.submissionCount==0,"work already submitted");
        _refund(taskId,t,true);
    }
    function refund(uint256 taskId) external nonReentrant {
        Task storage t=tasks[taskId];require(t.status==Status.Open,"task not active");
        require(revokedEvaluator[t.evaluatorSigner]||(t.submissionCount==0 && block.timestamp>t.submissionDeadline)||block.timestamp>t.reviewDeadline,"refund not available");
        _refund(taskId,t,false);
    }
    function _refund(uint256 taskId,Task storage t,bool cancelled) private {
        uint256 amount=t.bounty;t.bounty=0;t.status=cancelled?Status.Cancelled:Status.Refunded;
        IERC20(t.token).safeTransfer(t.requester,amount);
        if(cancelled)emit Cancelled(taskId,t.requester,amount);else emit Refunded(taskId,t.requester,amount);
    }
    function phaseOf(uint256 taskId) external view returns(Phase) {
        Task storage t=tasks[taskId];
        if(t.status==Status.None)return Phase.None;if(t.status==Status.Settled)return Phase.Settled;
        if(t.status==Status.Refunded)return Phase.Refunded;if(t.status==Status.Cancelled)return Phase.Cancelled;
        if(block.timestamp<=t.submissionDeadline)return Phase.Open;if(block.timestamp<=t.reviewDeadline)return Phase.Review;return Phase.Expired;
    }
    function getTask(uint256 taskId) external view returns(Task memory){return tasks[taskId];}
    function getSubmission(uint256 taskId,address worker) external view returns(Submission memory){return submissions[taskId][worker];}
    function getSubmitters(uint256 taskId) external view returns(address[] memory){return submitters[taskId];}
    function getSubmittersPage(uint256 taskId,uint256 offset,uint256 limit) external view returns(address[] memory page){
        require(limit>0 && limit<=MAX_PARTICIPANTS,"invalid page limit");uint256 count=submitters[taskId].length;
        if(offset>=count)return new address[](0);uint256 length=count-offset;if(length>limit)length=limit;
        page=new address[](length);for(uint256 i=0;i<length;i++)page[i]=submitters[taskId][offset+i];
    }
    function candidatesHash(uint256 taskId) external view returns(bytes32){return tasks[taskId].candidatesHash;}
    function submissionCount(uint256 taskId) external view returns(uint256){return tasks[taskId].submissionCount;}
    function quote(uint256 bounty) external pure returns(uint256 fee,uint256 payout){fee=bounty/10;payout=bounty-fee;}
    function eligible(address who) external view returns(bool){return agentId.balanceOf(who)>0;}
}
