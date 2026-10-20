// Plan 30 §5.3 discovery metrics. score(records) -> { summary, perItem, notes }.
//
// Everything is derived from the recorded run, not from the service's own accounting:
//   * "raw" measures are re-derived from the streamed text (calls[0].response.content), applying the
//     same line rules as claude.js discoverDestination — blank and structural lines skipped, one
//     trailing comma stripped before JSON.parse — so a dropped line is counted, not guessed.
//   * name-quality defects use the Plan 27 W4 measures (F-27-32/F-27-33) on the RAW model items,
//     i.e. before the service's own backstops (stripEditorialNamePrefix, sanitizeGeneratedAliases)
//     had a chance to hide them. "Survivors" are measured on the service output.
//   * F-27-33's durable rule: a bracket RATE is not a quality measure. The descriptive-bracket count
//     below is a heuristic classifier (a bracket is "allowed" only if it holds a branch/street, a
//     local-script or romanized form, or a short capitalised alternate name), and the notes print
//     the flagged rows so a human reads them before trusting the number.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISCOVERY_CATEGORIES, normalizeName, stripEditorialNamePrefix } from '../../../../src/services/claude.js';
import { EVAL_DATA_DIR } from '../runner.mjs';
import { max, median } from './common.mjs';

// claude.js STRUCTURAL_LINE_RE (not exported): pure JSON-array / markdown-fence scaffolding.
const STRUCTURAL_LINE_RE = /^(\[|\]|```json|```)$/;

const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;
const BRANCH_WORD_RE = /\b(location|branch|store|outlet|flagship|street|road|rd|st|lane|district|station|mall|floor|building|hall|exit|gate|entrance|terminal)\b/i;
const SHORT_NAME_RE = /^[A-Z][\p{L}'’.-]*(\s+[A-Z][\p{L}'’.-]*){0,4}$/u;
const BRACKET_RE = /[(（[【]([^)）\]】]*)[)）\]】]/g;

// Plan 36 W2. Backs D-36-4 (logistics stay out of Discovery): an item whose name is itself a piece of
// travel plumbing (airport, station, ride-hailing app, bank/ATM, health, visa, SIM, tourist office, post
// office) is not a place to go. A name-based heuristic, case-insensitive and word-bounded, so a
// restaurant called "Bank Street Cafe" is a false positive and the count is a signal to read, not a verdict.
const LOGISTICS_RE = /\b(?:(?:international\s+)?airport|(?:railway|train)\s+station|bus\s+(?:station|terminal)|metro\s+line|ferry\s+terminal|grab|ride[-\s]?hailing|taxi\s+app|atm|bank|hospital|clinic|pharmacy|visa\s+office|immigration|sim\s+(?:card|counter)|tourist\s+information(?:\s+cent(?:re|er))?|post\s+office)\b/i;
const isLogistics = (name) => LOGISTICS_RE.test(name);
const COLLAPSE_OUTPUT_TOKENS = 12000;
const THIN_CATEGORY_ITEMS = 8;

function canonicalCategory(raw) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, '_');
  return DISCOVERY_CATEGORIES.includes(normalized) ? normalized : null;
}

function rawStreamedText(record) {
  const blocks = record.calls?.[0]?.response?.content ?? [];
  return blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

// Thinking tokens. Plan 34 W4: the exact API count (usage.output_tokens_details.thinking_tokens on each
// call's response) is preferred whenever every call in the record carries it; the record's top-level
// `usage` does not carry it. Plan 30 W3's estimate is the fallback for records without it, and is
// kept alongside so the two can be compared.
//
// W3 estimate: thinking text is empty under the default display "omitted", so thinking tokens are
// estimated as output minus the text's tokens, the text taken at 0.429 tokens per character — the
// ratio of the Haiku 5.5 `thinking: disabled` run (alt-disabled-low, 2026-10-18), where output is
// all text.
const TEXT_TOKENS_PER_CHAR = 0.429;

function estimatedThinkingTokens(record) {
  if (!thinkingBlockCount(record)) return 0;
  const textTokens = Math.round(rawStreamedText(record).length * TEXT_TOKENS_PER_CHAR);
  return Math.max(0, (record.usage?.output_tokens ?? 0) - textTokens);
}

// Exact only when every call carries a finite count (sum over calls); otherwise null.
function exactThinkingTokens(record) {
  const counts = (record.calls ?? []).map((c) => c.response?.usage?.output_tokens_details?.thinking_tokens);
  const allExact = counts.length > 0 && counts.every((x) => typeof x === 'number' && Number.isFinite(x));
  return allExact ? counts.reduce((s, x) => s + x, 0) : null;
}

function thinkingBlockCount(record) {
  return (record.calls?.[0]?.response?.content ?? []).filter((b) => b.type === 'thinking').length;
}

// Same line handling as discoverDestination's processLine, counting instead of logging.
function parseRaw(record) {
  const categories = [];
  let droppedLines = 0;
  let unknownCategories = 0;
  for (const line of rawStreamedText(record).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || STRUCTURAL_LINE_RE.test(trimmed)) continue;
    const candidate = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
    let obj;
    try {
      obj = JSON.parse(candidate);
    } catch {
      droppedLines += 1;
      continue;
    }
    if (!obj || !obj.category || !Array.isArray(obj.items)) continue;
    const category = canonicalCategory(obj.category);
    if (!category) {
      unknownCategories += 1;
      continue;
    }
    categories.push({ category, items: obj.items.filter((item) => item && item.name) });
  }
  return { categories, droppedLines, unknownCategories };
}

// Same depth-zero colon scan as stripEditorialNamePrefix, used to count names that still carry a
// colon after the service's backstop (its guards deliberately leave some).
function hasDepthZeroColon(name) {
  let depth = 0;
  for (const ch of name) {
    if ('([【（'.includes(ch)) depth += 1;
    else if (')]】）'.includes(ch)) depth = Math.max(0, depth - 1);
    else if ((ch === ':' || ch === '：') && depth === 0) return true;
  }
  return false;
}

const hasDashClause = (name) => /\s[-–—]\s|[–—]/.test(name);

function bracketContents(name) {
  return [...name.matchAll(BRACKET_RE)].map((m) => m[1].trim()).filter(Boolean);
}

function isAllowedBracket(content) {
  return CJK_RE.test(content) || BRANCH_WORD_RE.test(content) || SHORT_NAME_RE.test(content);
}

const hasDescriptiveBracket = (name) => bracketContents(name).some((c) => !isAllowedBracket(c));

function loadExclusionSets() {
  const path = join(EVAL_DATA_DIR, 'discovery-exclusions.json');
  if (!existsSync(path)) return {};
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  return Object.fromEntries(
    Object.entries(stored.destinations).map(([id, d]) => [id, new Set(d.names.map(normalizeName))]),
  );
}

function analyse(record, exclusionSets) {
  const raw = parseRaw(record);
  const rawItems = raw.categories.flatMap((c) => c.items);
  const logistics = rawItems.filter((item) => isLogistics(item.name)).length;
  const rawEssentials = raw.categories.filter((c) => c.category === 'essentials').flatMap((c) => c.items);
  const logisticsEssentials = rawEssentials.filter((item) => isLogistics(item.name)).length;

  const seen = new Set();
  let duplicateDrops = 0;
  let repeatsOfExcluded = 0;
  const excluded = record.variant === 'exclusions' ? exclusionSets[record.fixtureId] : null;
  for (const item of rawItems) {
    const key = normalizeName(stripEditorialNamePrefix(item.name));
    if (excluded?.has(key)) repeatsOfExcluded += 1;
    if (seen.has(key)) duplicateDrops += 1;
    else seen.add(key);
  }

  const defects = { editorialPrefix: 0, dashClause: 0, aliasIdentical: 0, descriptiveBracket: 0, anyBracket: 0 };
  const flagged = [];
  for (const item of rawItems) {
    const name = item.name;
    if (stripEditorialNamePrefix(name) !== name) { defects.editorialPrefix += 1; flagged.push(`prefix: ${name}`); }
    if (hasDashClause(name)) { defects.dashClause += 1; flagged.push(`dash: ${name}`); }
    if (Array.isArray(item.aliases)
      && item.aliases.some((a) => typeof a === 'string' && normalizeName(a) === normalizeName(name))) {
      defects.aliasIdentical += 1;
      flagged.push(`alias=name: ${name}`);
    }
    if (hasDescriptiveBracket(name)) { defects.descriptiveBracket += 1; flagged.push(`bracket: ${name}`); }
    if (bracketContents(name).length) defects.anyBracket += 1;
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const outputItems = output.flatMap((c) => c.items);
  const perCategoryCounts = DISCOVERY_CATEGORIES.map(
    (category) => output.filter((c) => c.category === category).reduce((n, c) => n + c.items.length, 0),
  );
  // Plan 36 W2: a "collapse" is a short run (under 12,000 output tokens) whose categories mostly come
  // back thin (under 8 items). DISCOVERY_CATEGORIES lists essentials first, so index 0 is essentials.
  const collapsed = (record.usage?.output_tokens ?? Infinity) < COLLAPSE_OUTPUT_TOKENS
    && perCategoryCounts.filter((n) => n < THIN_CATEGORY_ITEMS).length > perCategoryCounts.length / 2;
  const colonSurvivors = outputItems.filter((item) => hasDepthZeroColon(item.name)).length;
  const firstCategoryMs = record.extra?.categoryTimes?.[0]?.t ?? null;
  const thinkingTokensEstimate = estimatedThinkingTokens(record);
  const thinkingTokensExactCount = exactThinkingTokens(record);

  return {
    record,
    raw,
    rawItemCount: rawItems.length,
    outputItemCount: outputItems.length,
    categoriesWithItems: perCategoryCounts.filter((n) => n > 0).length,
    perCategoryCounts,
    essentialsCount: perCategoryCounts[DISCOVERY_CATEGORIES.indexOf('essentials')],
    rawEssentialsCount: rawEssentials.length,
    collapsed,
    logistics,
    logisticsEssentials,
    duplicateDrops,
    repeatsOfExcluded,
    defects,
    flagged,
    colonSurvivors,
    firstCategoryMs,
    thinkingBlocks: thinkingBlockCount(record),
    thinkingTokens: thinkingTokensExactCount ?? thinkingTokensEstimate,
    thinkingTokensExact: thinkingTokensExactCount !== null,
    thinkingTokensEstimate,
    costPerItem: outputItems.length ? record.costUsd / outputItems.length : null,
  };
}

const pct = (n, d) => (d ? `${n}/${d} (${((100 * n) / d).toFixed(1)}%)` : `${n}/0`);

function summarise(analyses, prefix = '') {
  const label = (text) => `${prefix}${text}`;
  const n = analyses.length;
  const sum = (pick) => analyses.reduce((s, a) => s + pick(a), 0);
  const rawItems = sum((a) => a.rawItemCount);
  const defect = (key) => sum((a) => a.defects[key]);
  const mediansPerCategory = analyses.map((a) => median(a.perCategoryCounts));
  const minsPerCategory = analyses.map((a) => Math.min(...a.perCategoryCounts));
  const costs = analyses.map((a) => a.costPerItem).filter((c) => c !== null);
  const exactCount = analyses.filter((a) => a.thinkingTokensExact).length;

  return {
    [label('generations')]: n,
    [label('categories with items: worst / median (of 8)')]: `${Math.min(...analyses.map((a) => a.categoriesWithItems))} / ${median(analyses.map((a) => a.categoriesWithItems))}`,
    [label('items per category: median of medians / worst min')]: `${median(mediansPerCategory)} / ${Math.min(...minsPerCategory)}`,
    [label('total items: median / min')]: `${median(analyses.map((a) => a.outputItemCount))} / ${Math.min(...analyses.map((a) => a.outputItemCount))}`,
    [label('dropped unparseable lines')]: pct(sum((a) => a.raw.droppedLines), sum((a) => a.raw.categories.length + a.raw.droppedLines)),
    [label('duplicate-name drops')]: pct(sum((a) => a.duplicateDrops), rawItems),
    [label('editorial prefix (raw model output)')]: pct(defect('editorialPrefix'), rawItems),
    [label('colon survivors (service output)')]: pct(sum((a) => a.colonSurvivors), sum((a) => a.outputItemCount)),
    [label('dash-appended clause (raw)')]: pct(defect('dashClause'), rawItems),
    [label('alias identical to name (raw)')]: pct(defect('aliasIdentical'), rawItems),
    [label('description-in-brackets (heuristic, raw)')]: pct(defect('descriptiveBracket'), rawItems),
    [label('any bracket (NOT a quality measure, F-27-33)')]: pct(defect('anyBracket'), rawItems),
    [label('time to first category ms: median / max')]: `${median(analyses.map((a) => a.firstCategoryMs))} / ${max(analyses.map((a) => a.firstCategoryMs))}`,
    [label('cost per usable item ($): median / worst')]: costs.length ? `${median(costs).toFixed(5)} / ${Math.max(...costs).toFixed(5)}` : '—',
    [label('collapse runs (output < 12,000 tokens and most categories under 8)')]: pct(analyses.filter((a) => a.collapsed).length, n),
    [label('essentials: median / min items')]: `${median(analyses.map((a) => a.essentialsCount))} / ${Math.min(...analyses.map((a) => a.essentialsCount))}`,
    [label('categories under 8 items (all generations)')]: pct(
      sum((a) => a.perCategoryCounts.filter((c) => c < THIN_CATEGORY_ITEMS).length), n * DISCOVERY_CATEGORIES.length,
    ),
    [label('logistics entries (raw, any category)')]: pct(sum((a) => a.logistics), rawItems),
    [label('logistics in essentials (raw)')]: pct(sum((a) => a.logisticsEssentials), sum((a) => a.rawEssentialsCount)),
    [label('thinking blocks (total)')]: sum((a) => a.thinkingBlocks),
    [label('thinking tokens: median / max (share of output)')]: `${median(analyses.map((a) => a.thinkingTokens))} / ${max(analyses.map((a) => a.thinkingTokens))} (${(100 * sum((a) => a.thinkingTokens) / Math.max(1, sum((a) => a.record.usage.output_tokens))).toFixed(0)}%)`,
    [label('thinking tokens source')]: `${exactCount}/${n} exact (API thinking_tokens); ${n - exactCount} estimated`,
    [label('est. thinking tokens (Plan 30 W3 estimate): median / max')]: `${median(analyses.map((a) => a.thinkingTokensEstimate))} / ${max(analyses.map((a) => a.thinkingTokensEstimate))}`,
  };
}

export function score(records) {
  const exclusionSets = loadExclusionSets();
  const analyses = records.map((record) => analyse(record, exclusionSets));
  if (!analyses.length) return { summary: {}, perItem: [], notes: ['no records'] };

  const summary = summarise(analyses);
  for (const variant of ['first', 'exclusions']) {
    const subset = analyses.filter((a) => a.record.variant === variant);
    if (!subset.length) continue;
    Object.assign(summary, {
      [`${variant}: generations`]: subset.length,
      [`${variant}: total items median / min`]: `${median(subset.map((a) => a.outputItemCount))} / ${Math.min(...subset.map((a) => a.outputItemCount))}`,
      [`${variant}: items per category median of medians`]: median(subset.map((a) => median(a.perCategoryCounts))),
      [`${variant}: categories worst`]: Math.min(...subset.map((a) => a.categoriesWithItems)),
    });
  }
  const excl = analyses.filter((a) => a.record.variant === 'exclusions');
  if (excl.length) {
    summary['exclusions: raw items repeating an excluded name'] = pct(
      excl.reduce((s, a) => s + a.repeatsOfExcluded, 0), excl.reduce((s, a) => s + a.rawItemCount, 0),
    );
  }

  const perItem = analyses.map((a) => ({
    item: `${a.record.fixtureId}/${a.record.variant}`,
    cats: `${a.categoriesWithItems}/8`,
    perCat: a.perCategoryCounts.join(','),
    ess: a.essentialsCount,
    collapse: a.collapsed,
    items: a.outputItemCount,
    raw: a.rawItemCount,
    dropped: a.raw.droppedLines,
    dups: a.duplicateDrops,
    exclRepeats: a.record.variant === 'exclusions' ? a.repeatsOfExcluded : '—',
    prefix: a.defects.editorialPrefix,
    dash: a.defects.dashClause,
    aliasEq: a.defects.aliasIdentical,
    descBr: a.defects.descriptiveBracket,
    logi: a.logistics,
    ttfcMs: a.firstCategoryMs,
    wallS: Math.round(a.record.wallMs / 1000),
    outTok: a.record.usage.output_tokens,
    stop: a.record.stopReason ?? (a.record.error ? 'error' : 'none'),
    think: a.thinkingBlocks,
    thinkTok: a.thinkingTokens,
    thinkExact: a.thinkingTokensExact,
    costUsd: a.record.costUsd,
    perItemUsd: a.costPerItem === null ? '—' : Number(a.costPerItem.toFixed(5)),
    error: a.record.error ? a.record.error.message.slice(0, 60) : '',
  }));

  const flagged = [...new Set(analyses.flatMap((a) => a.flagged))];
  const notes = [
    'perCat order is ' + DISCOVERY_CATEGORIES.join(', ') + '. Raw measures re-parse the streamed text with the service\'s line rules; defect counts are per raw model item before the service\'s backstops.',
    `${flagged.length} distinct flagged raw names (read them before trusting the heuristic counts, F-27-33): ${flagged.slice(0, 14).join(' | ')}${flagged.length > 14 ? ' | …' : ''}`,
  ];
  return { summary, perItem, notes };
}
