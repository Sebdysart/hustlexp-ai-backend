import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import Database from 'better-sqlite3';
import fs from 'fs';

// Required for synchronous signing (noble/ed25519 v3)
ed.hashes.sha512 = sha512;

const DB_PATH = process.env.CITADEL_DB ?? 'citadel-provenance.sqlite';

function getDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS verdicts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL,
      pr_number  TEXT NOT NULL,
      gate       TEXT NOT NULL,
      safe       INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      signature  TEXT NOT NULL,
      pub_key    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export async function recordVerdict(opts: {
  runId: string;
  prNumber: string;
  gate: string;
  safe: boolean;
  details: Record<string, unknown>;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  db: Database.Database;
}): Promise<{ pubKey: string; signature: string }> {
  const { secretKey, publicKey, db } = opts;

  const payload = JSON.stringify({
    ...opts.details,
    gate: opts.gate,
    safe: opts.safe,
    runId: opts.runId,
    prNumber: opts.prNumber,
  });
  const message = new TextEncoder().encode(payload);
  const signature = ed.sign(message, secretKey);

  db.prepare(`
    INSERT INTO verdicts (run_id, pr_number, gate, safe, payload, signature, pub_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.runId,
    opts.prNumber,
    opts.gate,
    opts.safe ? 1 : 0,
    payload,
    Buffer.from(signature).toString('hex'),
    Buffer.from(publicKey).toString('hex'),
  );

  return {
    pubKey: Buffer.from(publicKey).toString('hex'),
    signature: Buffer.from(signature).toString('hex'),
  };
}

async function main() {
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const prNumber = process.env.PR_NUMBER ?? '0';

  const { secretKey, publicKey } = ed.keygen();
  const db = getDb();

  const gates = [
    { gate: 'INTEGRITY',    safe: process.env.GATE_INTEGRITY    === 'true', details: {} },
    { gate: 'MUTATION',     safe: process.env.GATE_MUTATION     === 'true', details: { score: process.env.MUTATION_SCORE } },
    { gate: 'CONSTITUTION', safe: process.env.GATE_CONSTITUTION === 'true', details: {} },
    { gate: 'ORACLE',       safe: process.env.GATE_ORACLE       === 'true', details: { confidence: process.env.ORACLE_CONFIDENCE } },
  ];

  const records: Array<{ gate: string; safe: boolean; signature: string; pubKey: string }> = [];

  for (const g of gates) {
    const record = await recordVerdict({ runId, prNumber, secretKey, publicKey, db, ...g });
    records.push({ ...g, ...record });
    console.warn(`Recorded: ${g.gate} (safe=${g.safe}) sig=${record.signature.slice(0, 16)}...`);
  }

  db.close();

  // Generate provenance summary for PR comment
  const md = [
    `## Cryptographic Provenance`,
    `**Run ID:** \`${runId}\` | **PR:** #${prNumber}`,
    '',
    '| Gate | Safe | Signature (first 24 chars) | Public Key (first 24 chars) |',
    '|------|------|---------------------------|----------------------------|',
    ...records.map(r =>
      `| ${r.gate} | ${r.safe ? 'YES' : 'NO'} | \`${r.signature.slice(0, 24)}...\` | \`${r.pubKey.slice(0, 24)}...\` |`
    ),
    '',
    `_All verdicts signed with ed25519 (run-scoped key pair). Signatures stored in citadel-provenance.sqlite._`,
  ].join('\n');

  fs.writeFileSync('citadel-provenance-report.md', md);
  console.warn('Provenance layer: all verdicts recorded and signed.');

  const allSafe = records.every(r => r.safe);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `provenance_signed=true\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `all_gates_safe=${allSafe}\n`);
  }

  process.exit(allSafe ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
