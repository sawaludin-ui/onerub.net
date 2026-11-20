// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

interface IAgentIdentity { function balanceOf(address) external view returns (uint256); }

/// @notice A non-custodial office. Employees select work without approval; only the
/// reviewer decides whether submitted work qualifies for an employee-minted award.
/// Reviewer permissions: approve/reject submissions and nominate a successor.
/// No deposits, token approvals, transfers, financial rewards or admin minting.
contract OnerubOffice is ERC721 {
    using Strings for uint256;
    IAgentIdentity public immutable agentId;
    address public reviewer;
    address public pendingReviewer;
    uint256 public constant WIB_OFFSET = 7 hours;
    uint256 public totalApproved;
    uint256 public totalAwards;

    enum Status { Taken, Submitted, Approved, Rejected, Minted }
    struct Employee {
        bool joined;
        uint8 rank; // 0 New hire, 1 Intern, 2 Staff, 3 Senior, 4 Manager
        uint32 stageCorrect;
        uint32 totalCorrect;
        uint32 internStreak;
        uint64 lastInternDay;
        uint64 joinedAt;
    }
    struct Assignment {
        address employee;
        uint64 day;
        uint8 slot;
        uint8 rank;
        Status status;
        uint64 takenAt;
        uint64 submittedAt;
        uint64 reviewedAt;
        uint256 tokenId;
        string evidence;
        string feedback;
    }
    struct Help { address helper; string evidence; }

    mapping(address => Employee) public employees;
    mapping(bytes32 => Assignment) private assignments;
    mapping(bytes32 => Help[]) private assistance;
    mapping(bytes32 => mapping(address => bool)) public hasHelped;
    mapping(uint256 => bytes32) public awardAssignment;
    address[] private roster;
    bytes32[] private work;

    event Joined(address indexed employee);
    event TaskTaken(bytes32 indexed id, address indexed employee, uint64 day, uint8 rank, uint8 slot);
    event Submitted(bytes32 indexed id, bytes32 evidenceHash);
    event Reviewed(bytes32 indexed id, bool accepted, string feedback);
    event Promoted(address indexed employee, uint8 rank);
    event Helped(bytes32 indexed id, address indexed helper);
    event AwardMinted(bytes32 indexed id, address indexed employee, uint256 tokenId);
    event ReviewerNominated(address indexed nominee);
    event ReviewerChanged(address indexed reviewer);
    event Locked(uint256 tokenId);

    constructor(address registry, address initialReviewer) ERC721("ONERUB Work Awards", "RUB") {
        require(registry.code.length > 0 && initialReviewer != address(0), "Invalid configuration");
        agentId = IAgentIdentity(registry);
        reviewer = initialReviewer;
    }
    modifier onlyEmployee() {
        require(employees[msg.sender].joined, "Join the office first");
        require(agentId.balanceOf(msg.sender) > 0, "Agent ID required");
        _;
    }
    function currentDay() public view returns (uint64) {
        return uint64((block.timestamp + WIB_OFFSET) / 1 days);
    }
    function assignmentId(address employee, uint64 day) public pure returns (bytes32) {
        return keccak256(abi.encode(employee, day));
    }
    function join() external {
        require(agentId.balanceOf(msg.sender) > 0, "Agent ID required");
        require(!employees[msg.sender].joined, "Already employed");
        employees[msg.sender].joined = true;
        employees[msg.sender].joinedAt = uint64(block.timestamp);
        roster.push(msg.sender);
        emit Joined(msg.sender);
    }
    function takeTask(uint8 slot) external onlyEmployee returns (bytes32 id) {
        require(slot < 5, "Five task choices only");
        uint64 day = currentDay();
        id = assignmentId(msg.sender, day);
        require(assignments[id].employee == address(0), "One task per WIB day");
        Assignment storage a = assignments[id];
        a.employee = msg.sender;
        a.day = day;
        a.slot = slot;
        a.rank = employees[msg.sender].rank;
        a.takenAt = uint64(block.timestamp);
        work.push(id);
        emit TaskTaken(id, msg.sender, day, a.rank, slot);
    }
    function submit(bytes32 id, string calldata evidence) external onlyEmployee {
        Assignment storage a = assignments[id];
        require(a.employee == msg.sender, "Not your assignment");
        require(a.status == Status.Taken || a.status == Status.Rejected, "Already submitted");
        require(bytes(evidence).length >= 10 && bytes(evidence).length <= 2400, "Evidence must be 10-2400 bytes");
        a.evidence = evidence;
        a.status = Status.Submitted;
        a.submittedAt = uint64(block.timestamp);
        a.reviewedAt = 0;
        a.feedback = "";
        emit Submitted(id, keccak256(bytes(evidence)));
    }
    function review(bytes32 id, bool accepted, string calldata feedback) external {
        require(msg.sender == reviewer, "Reviewer only");
        Assignment storage a = assignments[id];
        require(a.status == Status.Submitted, "Submission required");
        require(bytes(feedback).length <= 600, "Feedback too long");
        a.status = accepted ? Status.Approved : Status.Rejected;
        a.feedback = feedback;
        a.reviewedAt = uint64(block.timestamp);
        if (accepted) {
            totalApproved++;
            Employee storage e = employees[a.employee];
            e.totalCorrect++;
            // Historical submissions earn their award, but cannot be counted again
            // towards a new stage reached after they were assigned.
            if (a.rank == e.rank) {
                e.stageCorrect++;
                if (e.rank == 0) {
                    // Review order cannot change the streak: inspect approved work
                    // for consecutive assignment days around the reviewed workday.
                    uint32 streak = 1;
                    for (uint64 i = 1; i <= 2 && a.day >= i; i++) {
                        Status s = assignments[assignmentId(a.employee, a.day-i)].status;
                        if (s != Status.Approved && s != Status.Minted) break;
                        streak++;
                    }
                    for (uint64 i = 1; i <= 2; i++) {
                        Status s = assignments[assignmentId(a.employee, a.day+i)].status;
                        if (s != Status.Approved && s != Status.Minted) break;
                        streak++;
                    }
                    e.internStreak = streak;
                    if (a.day > e.lastInternDay) e.lastInternDay = a.day;
                    if (streak >= 3) _promote(a.employee);
                } else if ((e.rank == 1 && e.stageCorrect >= 7) ||
                           (e.rank == 2 && e.stageCorrect >= 10) ||
                           (e.rank == 3 && e.stageCorrect >= 30)) {
                    _promote(a.employee);
                }
            }
        }
        emit Reviewed(id, accepted, feedback);
    }
    function _promote(address employee) private {
        Employee storage e = employees[employee];
        e.rank++;
        e.stageCorrect = 0;
        emit Promoted(employee, e.rank);
    }
    function help(bytes32 id, string calldata evidence) external onlyEmployee {
        Assignment storage a = assignments[id];
        require(a.employee != address(0) && a.employee != msg.sender, "Invalid colleague");
        require(employees[msg.sender].rank > employees[a.employee].rank, "Help lower ranks only");
        require(a.status == Status.Taken || a.status == Status.Rejected, "Work is closed for help");
        require(!hasHelped[id][msg.sender], "Help already recorded");
        require(bytes(evidence).length >= 10 && bytes(evidence).length <= 1000, "Help must be 10-1000 bytes");
        hasHelped[id][msg.sender] = true;
        assistance[id].push(Help(msg.sender, evidence));
        emit Helped(id, msg.sender);
    }
    function mintAward(bytes32 id) external onlyEmployee {
        Assignment storage a = assignments[id];
        require(a.employee == msg.sender, "Not your assignment");
        require(a.status == Status.Approved, "Reviewer approval required");
        // All state is changed before the receiver callback.
        a.status = Status.Minted;
        a.tokenId = ++totalAwards;
        awardAssignment[a.tokenId] = id;
        _safeMint(msg.sender, a.tokenId);
        emit Locked(a.tokenId);
        emit AwardMinted(id, msg.sender, a.tokenId);
    }
    function nominateReviewer(address nominee) external {
        require(msg.sender == reviewer && nominee != address(0), "Reviewer only; nonzero nominee");
        pendingReviewer = nominee;
        emit ReviewerNominated(nominee);
    }
    function acceptReviewer() external {
        require(msg.sender == pendingReviewer, "Nominee only");
        reviewer = msg.sender;
        pendingReviewer = address(0);
        emit ReviewerChanged(msg.sender);
    }
    function _update(address to, uint256 id, address auth) internal override returns (address) {
        require(_ownerOf(id) == address(0), "Awards are non-transferable");
        return super._update(to, id, auth);
    }
    function locked(uint256 id) external view returns (bool) { _requireOwned(id); return true; }
    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == 0xb45a3c0e || super.supportsInterface(id);
    }
    function employeeCount() external view returns (uint256) { return roster.length; }
    function assignmentCount() external view returns (uint256) { return work.length; }
    function getEmployeeAddresses(uint256 start, uint256 limit) external view returns (address[] memory result) {
        require(limit <= 100, "Page limit 100");
        uint256 end = start + limit;
        if (end > roster.length) end = roster.length;
        if (start >= end) return new address[](0);
        result = new address[](end-start);
        for (uint256 i=start; i<end; i++) result[i-start] = roster[i];
    }
    function getAssignment(bytes32 id) external view returns (Assignment memory) { return assignments[id]; }
    function getHelp(bytes32 id) external view returns (Help[] memory) { return assistance[id]; }
    function getRecentAssignments(uint256 offset, uint256 limit) external view returns (bytes32[] memory ids, Assignment[] memory result) {
        require(limit <= 50, "Page limit 50");
        uint256 available = offset < work.length ? work.length-offset : 0;
        if (limit > available) limit = available;
        ids = new bytes32[](limit);
        result = new Assignment[](limit);
        for (uint256 i=0; i<limit; i++) {
            ids[i] = work[work.length-1-offset-i];
            result[i] = assignments[ids[i]];
        }
    }
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        Assignment storage a = assignments[awardAssignment[id]];
        string memory svg = string.concat('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#e5e5e5"/><rect x="40" y="40" width="720" height="720" rx="64" fill="#000"/><text x="85" y="140" fill="#fff" font-family="sans-serif" font-size="40">ONERUB.NET</text><circle cx="400" cy="370" r="140" fill="#d1ffca"/><text x="400" y="412" text-anchor="middle" font-family="sans-serif" font-size="120" font-weight="bold">',id.toString(),'</text><text x="85" y="620" fill="#fff" font-family="sans-serif" font-size="48">WORK. REVIEWED.</text><text x="85" y="685" fill="#fff100" font-family="monospace" font-size="24">DAY ',uint256(a.day).toString(),' / LEVEL ',uint256(a.rank).toString(),'</text></svg>');
        string memory json = string.concat('{"name":"ONERUB Work Award #',id.toString(),'","description":"Non-transferable recognition for work accepted by the ONERUB reviewer. No financial rights or promised returns.","image":"data:image/svg+xml;base64,',Base64.encode(bytes(svg)),'","attributes":[{"trait_type":"Level","value":',uint256(a.rank).toString(),'}, {"trait_type":"WIB workday","value":',uint256(a.day).toString(),'}]}');
        return string.concat("data:application/json;base64,",Base64.encode(bytes(json)));
    }
}
