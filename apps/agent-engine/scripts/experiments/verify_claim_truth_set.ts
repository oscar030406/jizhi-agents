/**
 * Self-check for data/experiments/claim_truth_set.json.
 *
 * Three things must hold before the truth set is worth measuring against:
 *   1. every claim text is actually extractable by the audited system's own
 *      extractTeachingText (imported, not re-implemented — a copy would drift);
 *   2. every supported_by_corpus claim's cited chunks really come back from the
 *      scene's evidence_query;
 *   3. every true_beyond_corpus claim's probe terms really are absent from that
 *      retrieval (otherwise it is not "beyond corpus").
 *
 * Run (proxy must be stripped — Clash is resident on this box):
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy NO_PROXY="*" \
 *     npx tsx --tsconfig "<OpenMAIC>/tsconfig.json" verify_claim_truth_set.ts
 */
import { readFileSync } from 'node:fs';
import { extractTeachingText } from '../../../classroom/lib/generation/hallucination-audit';

const SET_PATH = 'D:/UserData/Desktop/挑战杯/apps/agent-engine/data/experiments/claim_truth_set.json';
const EVIDENCE_URL = 'http://127.0.0.1:8001/internal/v1/personalize/evidence';
const TOKEN = 'demo-internal-token';

type Claim = {
  id: string;
  text: string;
  truth: 'supported_by_corpus' | 'planted_false' | 'true_beyond_corpus';
  sources?: string[];
  probe?: string[];
};
type Scene = { id: string; title: string; evidence_query: string; content: unknown; claims: Claim[] };

const data = JSON.parse(readFileSync(SET_PATH, 'utf8')) as {
  meta: { retrieval_top_k: number };
  scenes: Scene[];
};
const topK = data.meta.retrieval_top_k;
const fails: string[] = [];
const counts: Record<string, number> = {
  supported_by_corpus: 0,
  planted_false: 0,
  true_beyond_corpus: 0,
};
const ids = new Set<string>();

async function retrieve(query: string) {
  const url = `${EVIDENCE_URL}?query=${encodeURIComponent(query)}&top_k=${topK}`;
  const res = await fetch(url, { headers: { 'x-internal-token': TOKEN } });
  if (!res.ok) throw new Error(`evidence ${res.status} for ${query}`);
  const body = (await res.json()) as {
    data?: { chunks?: Array<{ source_id: string; content: string }> };
  };
  return body.data?.chunks ?? [];
}

for (const scene of data.scenes) {
  const text = extractTeachingText(scene.content);
  for (const c of scene.claims) {
    if (ids.has(c.id)) fails.push(`${c.id}: duplicate claim id`);
    ids.add(c.id);
    counts[c.truth] = (counts[c.truth] ?? 0) + 1;
    if (!text.includes(c.text)) fails.push(`${c.id}: NOT extractable by extractTeachingText`);
  }
  if (scene.claims.length < 4 || scene.claims.length > 5) {
    fails.push(`${scene.id}: ${scene.claims.length} claims (want 4-5)`);
  }
}

async function main() {
for (const scene of data.scenes) {
  const chunks = await retrieve(scene.evidence_query);
  const gotIds = new Set(chunks.map((c) => c.source_id));
  const corpus = chunks.map((c) => c.content).join('\n').toLowerCase();
  for (const c of scene.claims) {
    if (c.truth === 'supported_by_corpus') {
      for (const src of c.sources ?? []) {
        if (!gotIds.has(src)) fails.push(`${c.id}: cited ${src} not in top_${topK} of "${scene.evidence_query}"`);
      }
      if (!c.sources?.length) fails.push(`${c.id}: supported claim without sources`);
    }
    if (c.truth === 'true_beyond_corpus') {
      if (!c.probe?.length) fails.push(`${c.id}: beyond-corpus claim without probe terms`);
      for (const p of c.probe ?? []) {
        if (corpus.includes(p.toLowerCase())) {
          fails.push(`${c.id}: probe "${p}" IS present in retrieved evidence — not beyond corpus`);
        }
      }
    }
  }
  console.log(`${scene.id} "${scene.evidence_query}" → ${[...gotIds].join(', ')}`);
}

console.log('\ncounts:', counts, 'total:', Object.values(counts).reduce((a, b) => a + b, 0));
if (fails.length) {
  console.error(`\nFAIL (${fails.length}):`);
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('OK — all claims extractable, sources retrievable, probes absent.');
}

main();
