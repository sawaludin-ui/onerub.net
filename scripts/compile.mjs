import fs from "node:fs";
import path from "node:path";
import solc from "solc";
export function compile({ writeAbi = true } = {}) {
  const sources = Object.fromEntries(
    ["OnerubOffice.sol", "MockAgentID.sol"].map((n) => [
      n,
      { content: fs.readFileSync(`contracts/${n}`, "utf8") },
    ]),
  );
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"],
        },
      },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (p) => {
        try {
          return {
            contents: fs.readFileSync(path.resolve("node_modules", p), "utf8"),
          };
        } catch {
          return { error: `Missing import ${p}` };
        }
      },
    }),
  );
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length)
    throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  fs.mkdirSync("artifacts", { recursive: true });
  fs.mkdirSync("lib", { recursive: true });
  for (const file of Object.keys(output.sources))
    if (!input.sources[file])
      input.sources[file] = {
        content: fs.readFileSync(path.resolve("node_modules", file), "utf8"),
      };
  fs.writeFileSync("artifacts/compiler-input.json", JSON.stringify(input));
  fs.writeFileSync("artifacts/compiler-version.txt", solc.version());
  for (const [file, cs] of Object.entries(output.contracts))
    for (const [name, c] of Object.entries(cs)) {
      if (!c.evm.bytecode.object) continue;
      const artifact = {
        name,
        source: file,
        abi: c.abi,
        bytecode: "0x" + c.evm.bytecode.object,
        deployedBytecode: "0x" + c.evm.deployedBytecode.object,
        metadata: c.metadata,
      };
      fs.writeFileSync(
        `artifacts/${name}.json`,
        JSON.stringify(artifact, null, 2),
      );
      if (writeAbi && name === "OnerubOffice")
        fs.writeFileSync("lib/office-abi.json", JSON.stringify(c.abi, null, 2));
    }
  return output;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve("scripts/compile.mjs")
) {
  compile();
  const a = JSON.parse(fs.readFileSync("artifacts/OnerubOffice.json"));
  console.log(
    JSON.stringify({
      compiled: a.name,
      compiler: solc.version(),
      runtimeBytes: (a.deployedBytecode.length - 2) / 2,
    }),
  );
}
