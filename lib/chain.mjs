import {
  JsonRpcProvider,
  FetchRequest,
  Contract,
  Interface,
  ZeroAddress,
} from "ethers";
import deployment from "./deployment.json" with { type: "json" };
import abi from "./office-abi.json" with { type: "json" };
import { RANKS, dailyTasks } from "./tasks.mjs";
export { deployment, abi };
export const officeInterface = new Interface(abi);
export const RPC_URLS = [
  process.env.BSC_RPC_URL,
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-rpc.publicnode.com",
].filter(Boolean);
export function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
export async function readChain(fn) {
  let last;
  for (const rpc of new Set(RPC_URLS)) {
    const request = new FetchRequest(rpc);
    request.timeout = 6000;
    const provider = new JsonRpcProvider(request, deployment.chainId, {
      staticNetwork: true,
      batchMaxCount: 10,
    });
    try {
      if (!deployment.address) throw Error("Office contract is not deployed");
      return await fn(
        new Contract(deployment.address, abi, provider),
        provider,
      );
    } catch (e) {
      last = e;
    } finally {
      provider.destroy();
    }
  }
  throw last;
}
export function employeeView(address, e) {
  return {
    address,
    joined: e.joined,
    rank: Number(e.rank),
    rankName: RANKS[Number(e.rank)],
    stageCorrect: Number(e.stageCorrect),
    totalCorrect: Number(e.totalCorrect),
    internStreak: Number(e.internStreak),
    joinedAt: Number(e.joinedAt),
  };
}
export function publicText(record, field) {
  // Solidity strings can contain bytes that the ABI decoder cannot display as UTF-8.
  try {
    return record[field];
  } catch {
    return "[Unreadable on-chain text]";
  }
}
export function assignmentView(id, a) {
  return {
    id,
    employee: a.employee,
    day: Number(a.day),
    slot: Number(a.slot),
    rank: Number(a.rank),
    status: Number(a.status),
    takenAt: Number(a.takenAt),
    submittedAt: Number(a.submittedAt),
    reviewedAt: Number(a.reviewedAt),
    tokenId: a.tokenId.toString(),
    evidence: publicText(a, "evidence"),
    feedback: publicText(a, "feedback"),
  };
}
export async function readRoster(c, identity, count, call) {
  const employees = [];
  for (let start = 0; start < count; start += 100) {
    const page = await c.getEmployeeAddresses(start, 100, call);
    // Bound RPC fan-out independently of the number of employees on the board.
    for (let offset = 0; offset < page.length; offset += 6) {
      const batch = await Promise.all(
        page.slice(offset, offset + 6).map(async (address) => {
          const [record, handle] = await Promise.all([
            c.employees(address, call),
            identity.handleOf(address, call).catch(() => null),
          ]);
          return {
            ...employeeView(address, record),
            agentId: handle ? `${handle}.ai` : null,
          };
        }),
      );
      employees.push(...batch);
    }
  }
  return employees;
}

// Only the public roster is shared. Membership and today's assignment are always read fresh.
let rosterCache;
function rosterFor(c, count, approved, call) {
  const key = `${count}:${approved}`;
  if (rosterCache?.key === key && Date.now() < rosterCache.expires)
    return rosterCache.promise;
  const identity = new Contract(
    deployment.registry,
    ["function handleOf(address) view returns(string)"],
    c.runner,
  );
  const entry = { key, expires: Infinity, promise: null };
  entry.promise = readRoster(c, identity, Number(count), call)
    .then((employees) => {
      entry.expires = Date.now() + 15_000;
      return employees;
    })
    .catch((error) => {
      if (rosterCache === entry) rosterCache = undefined;
      throw error;
    });
  rosterCache = entry;
  return entry.promise;
}

export async function officeState(address) {
  return readChain(async (c, provider) => {
    const blockNumber = await provider.getBlockNumber();
    const call = { blockTag: blockNumber };
    const [count, approved, awards, workCount, recent, currentDay, reviewer] =
      await Promise.all([
        c.employeeCount(call),
        c.totalApproved(call),
        c.totalAwards(call),
        c.assignmentCount(call),
        c.getRecentAssignments(0, 30, call),
        c.currentDay(call),
        c.reviewer(call),
      ]);
    const employees = await rosterFor(c, count, approved, call);
    const result = {
      deployment,
      reviewer,
      blockNumber,
      day: Number(currentDay),
      stats: {
        employees: Number(count),
        approved: Number(approved),
        awards: Number(awards),
        assignments: Number(workCount),
      },
      employees,
      assignments: recent[0].map((id, i) => assignmentView(id, recent[1][i])),
    };
    if (address) {
      const registry = new Contract(
        deployment.registry,
        ["function balanceOf(address) view returns(uint256)"],
        provider,
      );
      const [record, balance, id] = await Promise.all([
        c.employees(address, call),
        registry.balanceOf(address, call),
        c.assignmentId(address, currentDay, call),
      ]);
      result.employee = employeeView(address, record);
      result.hasAgentId = balance > 0n;
      const a = await c.getAssignment(id, call);
      result.today = a.employee === ZeroAddress ? null : assignmentView(id, a);
      result.tasks = dailyTasks(Number(currentDay), result.employee.rank);
    }
    return result;
  });
}
