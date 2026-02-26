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
}): Promise<{ pubKey: string; signature: string }> {
  const { secretKey, publicKey } = ed.keygen();

  const payload = JSON.stringify({
    ...opts.details,
    gate: opts.gate,
    safe: opts.safe,
    runId: opts.runId,
  });
  const message = new TextEncoder().encode(payload);
  const signature = ed.sign(message, secretKey);

  const db = getDb();
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
  db.close();

  return {
    pubKey: Buffer.from(publicKey).toString('hex'),
    signature: Buffer.from(signature).toString('hex'),
  };
}

async function main() {
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const prNumber = process.env.PR_NUMBER ?? '0';

  const gates = [
    { gate: 'integrity',    safe: process.env.GATE_INTEGRITY    !== 'false', details: {} },
    { gate: 'mutation',     safe: process.env.GATE_MUTATION     !== 'false', details: { score: process.env.MUTATION_SCORE } },
    { gate: 'constitution', safe: process.env.GATE_CONSTITUTION !== 'false', details: {} },
    { gate: 'oracle',       safe: process.env.GATE_ORACLE       !== 'false', details: { confidence: process.env.ORACLE_CONFIDENCE } },
  ];

  const records: Array<{ gate: string; safe: boolean; signature: string; pubKey: string }> = [];

  for (const g of gates) {
    const record = await recordVerdict({ runId, prNumber, ...g });
    records.push({ ...g, ...record });
    console.log(`Recorded: ${g.gate} (safe=${g.safe}) sig=${record.signature.slice(0, 16)}...`);
  }

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
    `_All verdicts signed with short-lived ed25519 keys. Verify with \`npm run citadel:verify\`._`,
  ].join('\n');

  fs.writeFileSync('citadel-provenance-report.md', md);
  console.log('Provenance layer: all verdicts recorded and signed.');
}

main().catch(e => { console.error(e); process.exit(1); });
