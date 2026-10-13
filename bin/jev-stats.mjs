#!/usr/bin/env node
import { readLedger, computeStats, formatStats, ledgerPath } from "../src/ledger.mjs";

const file = process.argv[2] ?? ledgerPath();
const records = readLedger({ file });

if (!records.length) {
  process.stdout.write(`Jev Router: No decisions found in ${file}\n`);
  process.exit(0);
}

const stats = computeStats(records);
process.stdout.write(`${formatStats(stats)}\n`);
