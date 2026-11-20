import fs from "node:fs";
import { createHash } from "node:crypto";
import { makeTask } from "../lib/tasks.mjs";
fs.mkdirSync("data", { recursive: true });
fs.mkdirSync(".local", { recursive: true });
const tasks = [],
  answers = [],
  hashes = new Set();
for (let rank = 0; rank < 5; rank++)
  for (let slot = 0; slot < 5; slot++)
    for (let variant = 0; variant < 200; variant++) {
      const task = makeTask(rank, slot, variant, null, true),
        answer = task.expectedAnswer;
      delete task.expectedAnswer;
      const hash = createHash("sha256")
        .update(JSON.stringify(task.data))
        .digest("hex");
      if (hashes.has(hash)) throw Error(`Duplicate dataset ${task.id}`);
      hashes.add(hash);
      tasks.push(task);
      answers.push({ id: task.id, answer });
    }
fs.writeFileSync("data/task-bank.json", JSON.stringify(tasks));
fs.writeFileSync(".local/task-answers.json", JSON.stringify(answers), {
  mode: 0o600,
});
const summary = {
  total: tasks.length,
  uniqueDatasets: hashes.size,
  perRank: 1000,
  perFamily: 1000,
  sha256: createHash("sha256")
    .update(fs.readFileSync("data/task-bank.json"))
    .digest("hex"),
};
fs.writeFileSync(
  "data/task-bank-manifest.json",
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary));
