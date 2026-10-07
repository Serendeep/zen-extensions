// Zen Tidy pure logic. No browser globals: zen-tidy.uc.mjs maps real tabs to
// these plain objects and executes the returned plans.

/**
 * @typedef {{ id: string, title: string, url: string, pinned: boolean,
 *   folderId: string | null, position: number }} TabInfo
 *   position = index among the folder's children, or global tab index if loose.
 * @typedef {{ id: string, label: string, tabIds: string[] }} FolderInfo
 *   Folders in sidebar order.
 * @typedef {{ label: string, tabIds: string[], target: "new" | "existing" | "unsorted",
 *   folderId?: string }} Proposal
 */

export const DEFAULTS = Object.freeze({
  minTabs: 2,
  aiTimeoutMs: 5000,
  clusterThreshold: 0.75,
  unsortedLabel: "Unsorted",
});

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "my", "new", "&", "-",
]);

// Strips "www." only, no public-suffix list; add one if co.uk-style domains misgroup.
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w && !STOP_WORDS.has(w));
}

// A folder only "owns" a domain that is >=50% of its tabs and >=2 tabs.
function dominantDomains(folder, tabsById) {
  const counts = new Map();
  for (const id of folder.tabIds) {
    const d = domainOf(tabsById.get(id)?.url ?? "");
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const owned = new Map();
  for (const [d, n] of counts) {
    if (n >= 2 && n * 2 >= folder.tabIds.length) owned.set(d, n);
  }
  return owned;
}

/**
 * Match candidate tabs into existing folders (Unsorted excluded).
 * Precedence: domain > title token > strength > earliest folder.
 * @param {TabInfo[]} candidates
 * @param {FolderInfo[]} folders
 * @param {Map<string, TabInfo>} tabsById every tab, including those already in folders
 * @param {string | null} unsortedId
 */
export function matchExistingFolders(candidates, folders, tabsById, unsortedId) {
  const keyed = folders
    .filter(f => f.id !== unsortedId)
    .map((f, order) => ({ f, order, domains: dominantDomains(f, tabsById), tokens: new Set(tokenize(f.label)) }));
  const assigned = new Map();
  const rest = [];
  for (const tab of candidates) {
    const domain = domainOf(tab.url);
    const words = new Set(tokenize(tab.title));
    let best = null;
    for (const k of keyed) {
      const domainHits = k.domains.get(domain) ?? 0;
      const tokenHits = [...k.tokens].filter(t => words.has(t)).length;
      if (!domainHits && !tokenHits) continue;
      const score = [domainHits ? 1 : 0, domainHits || tokenHits, -k.order];
      if (!best || compareScore(score, best.score) > 0) best = { score, id: k.f.id };
    }
    if (best) assigned.set(tab.id, best.id);
    else rest.push(tab);
  }
  return { assigned, rest };
}

function compareScore(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * User domain rules first, then built-in buckets. Buckets under minTabs fall through.
 * @param {TabInfo[]} tabs
 * @param {{ domain: string, label: string }[]} userRules
 * @param {Record<string, string[]>} buckets label -> domains (suffix match)
 */
export function bucketByRules(tabs, userRules, buckets, minTabs = DEFAULTS.minTabs) {
  const groups = new Map();
  const unmatched = [];
  for (const tab of tabs) {
    const d = domainOf(tab.url);
    const rule = userRules.find(r => d === r.domain || d.endsWith("." + r.domain));
    const label =
      rule?.label ??
      Object.keys(buckets).find(b => buckets[b].some(bd => d === bd || d.endsWith("." + bd)));
    if (label) groups.set(label, [...(groups.get(label) ?? []), tab]);
    else unmatched.push(tab);
  }
  const kept = [];
  for (const [label, members] of groups) {
    if (members.length >= minTabs) kept.push({ label, tabIds: members.map(t => t.id) });
    else unmatched.push(...members);
  }
  return { groups: kept, rest: unmatched };
}

export const BUILT_IN_BUCKETS = Object.freeze({
  Code: ["github.com", "gitlab.com", "codeberg.org"],
  Docs: ["developer.mozilla.org", "docs.rs", "readthedocs.io"],
  Video: ["youtube.com", "twitch.tv"],
  Social: ["reddit.com", "x.com", "news.ycombinator.com"],
  "Mail & Calendar": ["mail.google.com", "calendar.google.com", "outlook.live.com"],
});

/**
 * Assemble preview proposals. Clusters/rule groups below minTabs go to Unsorted
 * (or stay loose when Unsorted is off).
 * @param {{ existing: Map<string, string>, folders: FolderInfo[], ruleGroups: {label: string, tabIds: string[]}[],
 *   clusters: {label: string, tabIds: string[]}[], leftovers: string[], unsortedEnabled: boolean,
 *   unsortedId: string | null, minTabs?: number }} input
 * @returns {Proposal[]}
 */
export function buildProposals(input) {
  const { existing, folders, ruleGroups, clusters, unsortedEnabled, unsortedId } = input;
  const minTabs = input.minTabs ?? DEFAULTS.minTabs;
  const proposals = [];
  for (const f of folders) {
    const ids = [...existing].filter(([, fid]) => fid === f.id).map(([tid]) => tid);
    if (ids.length) proposals.push({ label: f.label, tabIds: ids, target: "existing", folderId: f.id });
  }
  const leftovers = [...input.leftovers];
  for (const g of [...ruleGroups, ...clusters]) {
    if (g.tabIds.length >= minTabs) proposals.push({ label: g.label, tabIds: g.tabIds, target: "new" });
    else leftovers.push(...g.tabIds);
  }
  if (unsortedEnabled && leftovers.length) {
    const unsorted = { label: DEFAULTS.unsortedLabel, tabIds: leftovers, target: "unsorted" };
    proposals.push(unsortedId ? { ...unsorted, folderId: unsortedId } : unsorted);
  }
  return proposals;
}

/** Fallback label when no model label exists: most common title word. */
export function tokenLabel(titles) {
  const counts = new Map();
  for (const t of titles) for (const w of new Set(tokenize(t))) counts.set(w, (counts.get(w) ?? 0) + 1);
  const [word] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ["Group"];
  return word[0].toUpperCase() + word.slice(1);
}

const sameState = (a, b) =>
  a.pinned === b.pinned && a.folderId === b.folderId;

/**
 * Keep only tabs still open and still in their collected state.
 * @param {Map<string, TabInfo>} prior @param {Map<string, TabInfo>} live
 */
export function recheck(prior, live) {
  return [...prior.keys()].filter(id => live.has(id) && sameState(prior.get(id), live.get(id)));
}

/**
 * Steps that move every surviving tab back to its prior state (used by undo and rollback).
 * Never deletes a folder with tabs: removal is only requested for Tidy-created folders.
 * @param {Map<string, TabInfo>} prior
 * @param {Map<string, TabInfo>} live
 * @param {string[]} createdFolderIds
 */
export function planRestore(prior, live, createdFolderIds) {
  // Three phases: pinned folder tabs and Zen's placeholder tabs shift every index,
  // so positions are only meaningful once all structure is back and Tidy folders are gone.
  const moved = [...prior.values()]
    .filter(p => live.has(p.id) && !sameAt(p, live.get(p.id)))
    .sort((a, b) => a.position - b.position);
  const structure = moved.flatMap(p => {
    const now = live.get(p.id);
    return [
      now.folderId && { op: "ungroup", tabId: p.id },
      now.pinned && !p.pinned && { op: "unpin", tabId: p.id },
      p.folderId && { op: "addToFolder", tabId: p.id, folderId: p.folderId },
    ].filter(Boolean);
  });
  const cleanup = createdFolderIds.map(id => ({ op: "removeFolderIfEmpty", folderId: id }));
  // Park every tab at the end of its container first, so each placement only moves a tab
  // backwards and never shifts tabs already placed.
  const park = moved.map(p => ({ op: "park", tabId: p.id, folderId: p.folderId }));
  const moves = moved.map(p => ({ op: "move", tabId: p.id, folderId: p.folderId, position: p.position }));
  return [...structure, ...cleanup, ...park, ...moves];
}

const sameAt = (a, b) => sameState(a, b) && a.position === b.position;

/** Tabs not back in their exact prior place (pin, folder and position) after a restore. */
export function residue(prior, live) {
  return [...prior.values()].filter(p => live.has(p.id) && !sameAt(p, live.get(p.id))).map(p => p.id);
}

/**
 * Run apply steps; on any error restore everything to prior and report honestly.
 * @param {object} io
 * @param {() => Promise<void>} io.apply runs every apply step
 * @param {() => Map<string, TabInfo>} io.snapshot reads live tab state
 * @param {(steps: object[]) => Promise<void>} io.runSteps executes restore steps
 * @param {Map<string, TabInfo>} prior
 * @param {() => string[]} createdFolderIds folders created so far
 */
export async function applyWithRollback(io, prior, createdFolderIds) {
  try {
    await io.apply();
    return { ok: true };
  } catch (error) {
    try {
      await io.runSteps(planRestore(prior, io.snapshot(), createdFolderIds()));
    } catch {
      // reported through residue below
    }
    const stuck = residue(prior, io.snapshot());
    return { ok: false, error, stuck, message: stuck.length ? `Tidy failed: ${stuck.length} tab(s) could not be restored` : "Tidy failed, nothing changed" };
  }
}

/** Race a promise against a timer. The promise keeps running after timeout. */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([
    promise.then(value => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

export const REQUIRED_APIS = Object.freeze([
  "gZenFolders.createFolder",
  "gZenWorkspaces.activeWorkspace",
  "gBrowser.ungroupTab",
  "gBrowser.unpinTab",
  "gBrowser.pinTab",
  "gBrowser.moveTabTo",
]);
export const OPTIONAL_APIS = Object.freeze(["SmartTabGroupingManager"]);

/**
 * Capability tiers. env maps API path -> present?
 * @param {Record<string, boolean>} env
 */
export function checkCapabilities(env) {
  const missingRequired = REQUIRED_APIS.filter(a => !env[a]);
  const missingOptional = OPTIONAL_APIS.filter(a => !env[a]);
  return { enabled: missingRequired.length === 0, aiAvailable: missingOptional.length === 0, missingRequired, missingOptional };
}

/**
 * What the ML gate should do on a Tidy.
 * @param {{ mlPref: boolean, tidyAiSetting: boolean, declined: boolean }} s
 * @returns {"use-ai" | "prompt" | "rules-only"}
 */
export function mlGate({ mlPref, tidyAiSetting, declined }) {
  if (!tidyAiSetting) return "rules-only";
  if (mlPref) return "use-ai";
  return declined ? "rules-only" : "prompt";
}

/**
 * Turning Tidy's AI off reverts browser.ml.enable only if Tidy set it.
 * @param {{ mlPref: boolean, enabledByTidy: boolean }} s
 */
export function disableAiPlan({ mlPref, enabledByTidy }) {
  return { revertPref: enabledByTidy && mlPref, clearOwnership: enabledByTidy };
}

/** Per-space run counter + apply lock. */
export function createRunGuard() {
  const gens = new Map();
  const locks = new Set();
  return {
    start(space) {
      const g = (gens.get(space) ?? 0) + 1;
      gens.set(space, g);
      return g;
    },
    isCurrent: (space, g) => gens.get(space) === g,
    tryLock(space) {
      if (locks.has(space)) return false;
      locks.add(space);
      return true;
    },
    unlock: space => locks.delete(space),
    isLocked: space => locks.has(space),
  };
}

/**
 * Unsorted folder ids per space, stored as JSON in a pref.
 * Returns the valid id for this space or null, plus the cleaned map to store.
 * @param {string} json @param {string} spaceId @param {(id: string) => boolean} existsInSpace
 */
export function resolveUnsorted(json, spaceId, existsInSpace) {
  let map = {};
  try {
    const parsed = JSON.parse(json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) map = parsed;
  } catch {
    // corrupt pref: start fresh
  }
  const id = typeof map[spaceId] === "string" && existsInSpace(map[spaceId]) ? map[spaceId] : null;
  const { [spaceId]: _drop, ...others } = map;
  return { id, map: id ? map : others };
}

export const withUnsorted = (map, spaceId, folderId) => JSON.stringify({ ...map, [spaceId]: folderId });

/** "github.com=Code; linear.app=Work" -> [{ domain, label }]; malformed parts skipped. */
export function parseRules(text) {
  return (text ?? "")
    .split(/[;\n]/)
    .map(part => part.split("="))
    .filter(kv => kv.length === 2 && kv[0].trim() && kv[1].trim())
    .map(([d, l]) => ({ domain: d.trim().toLowerCase().replace(/^www\./, ""), label: l.trim() }));
}

/** "Alt+Shift+T" -> matcher for KeyboardEvent-like objects; null if unparseable. */
export function parseShortcut(text) {
  const parts = (text ?? "").split("+").map(p => p.trim().toLowerCase()).filter(Boolean);
  const key = parts.pop();
  if (!key || parts.some(m => !["alt", "shift", "ctrl", "control", "meta", "accel"].includes(m))) return null;
  const want = { alt: parts.includes("alt"), shift: parts.includes("shift"), ctrl: parts.includes("ctrl") || parts.includes("control"), meta: parts.includes("meta") };
  return e =>
    e.key?.toLowerCase() === key && e.altKey === want.alt && e.shiftKey === want.shift && e.ctrlKey === want.ctrl && e.metaKey === want.meta;
}
