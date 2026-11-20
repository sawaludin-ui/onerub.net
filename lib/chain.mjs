import { JsonRpcProvider, Contract, Interface, isAddress } from "ethers";
import deployment from "./deployment.json" with { type: "json" };
import abi from "./office-abi.json" with { type: "json" };
import { RANKS, dailyTasks, wibDay } from "./tasks.mjs";
export { deployment, abi };
export const officeInterface = new Interface(abi);
export const RPC_URLS = [
  process.env.BSC_RPC_URL,
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed.bnbchain.org",
].filter(Boolean);
export function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
export async function readChain(fn) {
  let last;
  for (const rpc of RPC_URLS) {
    const provider = new JsonRpcProvider(rpc, 56, {
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
    evidence: a.evidence,
    feedback: a.feedback,
  };
}
export async function officeState(address) {
  return readChain(async (c) => {
    const [count, approved, awards, workCount, recent, currentDay, reviewer] =
      await Promise.all([
        c.employeeCount(),
        c.totalApproved(),
        c.totalAwards(),
        c.assignmentCount(),
        c.getRecentAssignments(0, 30),
        c.currentDay(),
        c.reviewer(),
      ]);
    const roster = [];
    for (let start = 0; start < Number(count); start += 100)
      roster.push(...(await c.getEmployeeAddresses(start, 100)));
    const identity = new Contract(
      deployment.registry,
      ["function handleOf(address) view returns(string)"],
      c.runner,
    );
    const employees = await Promise.all(
      roster.map(async (a) => {
        const [e, handle] = await Promise.all([
          c.employees(a),
          identity.handleOf(a).catch(() => null),
        ]);
        return {
          ...employeeView(a, e),
          agentId: handle ? handle + ".ai" : null,
        };
      }),
    );
    const result = {
      deployment,
      reviewer,
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
    if (address && isAddress(address)) {
      result.employee = employeeView(address, await c.employees(address));
      result.hasAgentId =
        (await new Contract(
          deployment.registry,
          ["function balanceOf(address) view returns(uint256)"],
          c.runner,
        ).balanceOf(address)) > 0n;
      const id = await c.assignmentId(address, currentDay),
        a = await c.getAssignment(id);
      result.today =
        a.employee === "0x0000000000000000000000000000000000000000"
          ? null
          : assignmentView(id, a);
      result.tasks = dailyTasks(Number(currentDay), result.employee.rank);
    }
    return result;
  });
}
