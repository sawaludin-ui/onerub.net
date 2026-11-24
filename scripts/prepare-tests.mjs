// Node.js: compile isolated V2 fixtures only; never deploy or rewrite tracked ABI.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import solc from 'solc';
import {compileMarketplaceV2} from './compile-marketplace-v2.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
export function prepareTests() {
  const names = ['OneRubMarketplaceEscrowV2', 'MockAgentID', 'MockERC20'];
  const hash = createHash('sha256').update(solc.version());
  for (const name of [...names.map(n => 'contracts/' + n + '.sol'), 'scripts/compile-marketplace-v2.mjs', 'package-lock.json']) hash.update(name).update(fs.readFileSync(path.join(root, name)));
  const digest = hash.digest('hex');
  const directory = path.join(root, 'artifacts/marketplace-v2');
  const marker = path.join(directory, 'test-fixtures.sha256');
  const valid = names.every(n => {try {const a = JSON.parse(fs.readFileSync(path.join(directory, n + '.json'))); return a.bytecode?.startsWith('0x') && a.abi?.length;} catch {return false;}});
  if (valid && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === digest) return {compiled: false, digest};
  compileMarketplaceV2({writeAbi: false});
  fs.writeFileSync(marker, digest);
  return {compiled: true, digest};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(prepareTests()));
