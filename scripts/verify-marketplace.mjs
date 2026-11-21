import fs from "node:fs";
const deployment = JSON.parse(fs.readFileSync("lib/marketplace-deployment.json"));
if (!deployment.address) throw Error("Not deployed");
const input = JSON.parse(fs.readFileSync("artifacts/compiler-input.json"));
const body = {
  stdJsonInput: input,
  compilerVersion: deployment.compiler.replace(/\.Emscripten\.clang$/, ""),
  contractIdentifier: "OneRubMarketplaceEscrow.sol:OneRubMarketplaceEscrow",
};
const response = await fetch(`https://sourcify.dev/server/v2/verify/56/${deployment.address}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const result = await response.json();
console.log(JSON.stringify({ status: response.status, ...result }));
fs.mkdirSync(".local", { recursive: true });
fs.writeFileSync(".local/marketplace-verification.json", JSON.stringify(result, null, 2));
if (!response.ok) process.exitCode = 1;
