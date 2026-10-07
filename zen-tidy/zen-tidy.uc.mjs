// Zen Tidy browser glue. All decisions live in core.mjs; this file reads Zen state,
// renders the preview, and executes plans.
import {
  DEFAULTS, BUILT_IN_BUCKETS, matchExistingFolders, bucketByRules, buildProposals, tokenLabel,
  recheck, planRestore, residue, applyWithRollback, withTimeout, checkCapabilities, mlGate,
  disableAiPlan, createRunGuard, resolveUnsorted, withUnsorted, parseRules, parseShortcut,
} from "./core.mjs";

const PREF = "extensions.zen-tidy.";
const STG_URL = "moz-src:///browser/components/tabbrowser/SmartTabGrouping.sys.mjs";
const UNDO_TOAST_MS = 10000;
const HTML = "http://www.w3.org/1999/xhtml";

const prefs = {
  bool: (k, d) => Services.prefs.getBoolPref(PREF + k, d),
  str: (k, d) => Services.prefs.getStringPref(PREF + k, d),
  setBool: (k, v) => Services.prefs.setBoolPref(PREF + k, v),
  setStr: (k, v) => Services.prefs.setStringPref(PREF + k, v),
};

// Run guards are per space, shared across windows of this process.
const guard = (globalThis.__zenTidyGuard ??= createRunGuard());

function capabilityEnv() {
  let stg = false;
  try {
    stg = typeof ChromeUtils.importESModule(STG_URL).SmartTabGroupingManager === "function";
  } catch {
    // optional tier
  }
  return {
    "gZenFolders.createFolder": typeof gZenFolders?.createFolder === "function",
    "gZenWorkspaces.activeWorkspace": typeof gZenWorkspaces?.activeWorkspace === "string",
    "gBrowser.ungroupTab": typeof gBrowser?.ungroupTab === "function",
    "gBrowser.unpinTab": typeof gBrowser?.unpinTab === "function",
    "gBrowser.pinTab": typeof gBrowser?.pinTab === "function",
    "gBrowser.moveTabTo": typeof gBrowser?.moveTabTo === "function",
    SmartTabGroupingManager: stg,
  };
}

// ---------- reading Zen state ----------

// linkedPanel is null for not-yet-loaded (lazy) tabs, so ids come from a WeakMap.
const tabIds = (globalThis.__zenTidyTabIds ??= new WeakMap());
let nextTabId = 0;
const tabId = tab => {
  if (!tabIds.has(tab)) tabIds.set(tab, `zt-${Date.now()}-${nextTabId++}`);
  return tabIds.get(tab);
};
const isReal = tab => !tab.hasAttribute("zen-empty-tab");
const realTabs = folder => folder.tabs.filter(isReal);
const foldersIn = space =>
  [...document.querySelectorAll("zen-folder")].filter(f => f.getAttribute("zen-workspace-id") === space);
const folderById = id => document.getElementById(id);

function tabInfo(tab) {
  const folder = tab.group?.isZenFolder ? tab.group : null;
  return {
    id: tabId(tab),
    title: tab.label,
    url: tab.linkedBrowser?.currentURI?.spec ?? "",
    pinned: tab.pinned,
    folderId: folder?.id ?? null,
    // _tPos no longer exists in this Firefox; the strip index is what moveTabTo takes.
    position: folder ? realTabs(folder).indexOf(tab) : gBrowser.tabs.indexOf(tab),
  };
}

function readSpace(space, unsortedId) {
  const loose = gBrowser.tabs.filter(
    t => !t.pinned && !t.group && isReal(t) && !t.hasAttribute("zen-essential") && t.getAttribute("zen-workspace-id") === space
  );
  const unsorted = unsortedId ? realTabs(folderById(unsortedId)) : [];
  const folders = foldersIn(space);
  const all = [...loose, ...unsorted, ...folders.flatMap(realTabs)];
  return {
    candidates: [...loose, ...unsorted],
    tabsById: new Map(all.map(t => [tabId(t), t])),
    infoById: new Map(all.map(t => [tabId(t), tabInfo(t)])),
    folders: folders.map(f => ({ id: f.id, label: f.label, tabIds: realTabs(f).map(tabId) })),
  };
}

function liveInfo(ids) {
  const live = new Map();
  for (const id of ids) {
    const tab = gBrowser.tabs.find(t => tabId(t) === id);
    if (tab && !tab.closing) live.set(id, tabInfo(tab));
  }
  return live;
}

const windowsOnSpace = space =>
  [...Services.wm.getEnumerator("navigator:browser")].filter(w => w.gZenWorkspaces?.activeWorkspace === space).length;

// ---------- AI ----------

let aiAvailable = false;

async function runAi(tabs, threshold) {
  const { SmartTabGroupingManager } = ChromeUtils.importESModule(STG_URL);
  const mgr = new SmartTabGroupingManager();
  // The constructor re-applies browser.tabs.groups.smart.agglomerativeThresholdInt (650 in Zen),
  // so the threshold must be set afterwards.
  mgr.config.clustering.agglomerativeThreshold = threshold;
  const result = await mgr.generateClusters(tabs);
  const groups = result.clusterRepresentations.filter(r => r.tabs.length >= DEFAULTS.minTabs);
  const clusters = [];
  for (const g of groups) {
    // generateGroupLabels only names the first cluster; name each group separately.
    const label = await mgr.getPredictedLabelForGroup(g.tabs, tabs.filter(t => !g.tabs.includes(t)));
    clusters.push({ label: label || tokenLabel(g.tabs.map(t => t.label)), tabIds: g.tabs.map(tabId) });
  }
  return clusters;
}

async function enableAi() {
  if (!Services.prefs.getBoolPref("browser.ml.enable", false)) {
    Services.prefs.setBoolPref("browser.ml.enable", true);
    prefs.setBool("mlEnabledByTidy", true);
  }
  // The first model download takes ~15 s; start it now so the next Tidy can use AI.
  const { SmartTabGroupingManager } = ChromeUtils.importESModule(STG_URL);
  new SmartTabGroupingManager().preloadAllModels(() => {}).catch(e => console.warn("Zen Tidy: model preload failed", e));
}

function onAiSettingChanged() {
  if (prefs.bool("ai", true)) return;
  const plan = disableAiPlan({
    mlPref: Services.prefs.getBoolPref("browser.ml.enable", false),
    enabledByTidy: prefs.bool("mlEnabledByTidy", false),
  });
  if (plan.revertPref) {
    Services.prompt.alert(window, "Zen Tidy", "Zen Tidy turned on Firefox's on-device AI, so it's turning it off again. This also turns it off for other features that use it.");
    Services.prefs.setBoolPref("browser.ml.enable", false);
  }
  if (plan.clearOwnership) prefs.setBool("mlEnabledByTidy", false);
}

// ---------- planning ----------

async function plan(space) {
  const unsorted = resolveUnsorted(prefs.str("unsortedMap", "{}"), space, id => !!folderById(id) && foldersIn(space).includes(folderById(id)));
  prefs.setStr("unsortedMap", JSON.stringify(unsorted.map));
  const state = readSpace(space, unsorted.id);
  const candidates = state.candidates.map(t => state.infoById.get(tabId(t)));

  const existing = matchExistingFolders(candidates, state.folders, state.infoById, unsorted.id);
  const rules = bucketByRules(existing.rest, parseRules(prefs.str("rules", "")), BUILT_IN_BUCKETS);

  const notes = [];
  let clusters = [];
  let gate = aiAvailable
    ? mlGate({ mlPref: Services.prefs.getBoolPref("browser.ml.enable", false), tidyAiSetting: prefs.bool("ai", true), declined: prefs.bool("aiDeclined", false) })
    : "rules-only";
  if (!aiAvailable && prefs.bool("ai", true)) notes.push("AI unavailable on this Zen version: rules only.");
  if (gate === "use-ai" && rules.rest.length >= DEFAULTS.minTabs) {
    const leftovers = rules.rest.map(t => state.tabsById.get(t.id));
    const threshold = Number(prefs.str("grouping", String(DEFAULTS.clusterThreshold))) || DEFAULTS.clusterThreshold;
    const ai = await withTimeout(runAi(leftovers, threshold).catch(e => ({ error: e })), DEFAULTS.aiTimeoutMs);
    if (ai.timedOut) notes.push("AI took too long, rules only this time.");
    else if (ai.value?.error) {
      notes.push("AI failed, rules only this time.");
      console.warn("Zen Tidy:", ai.value.error);
    } else clusters = ai.value;
  }
  const clustered = new Set(clusters.flatMap(c => c.tabIds));
  const leftovers = rules.rest.map(t => t.id).filter(id => !clustered.has(id));

  // Tabs already in Unsorted that would land in Unsorted again stay put.
  const proposals = buildProposals({
    existing: existing.assigned, folders: state.folders, ruleGroups: rules.groups, clusters, leftovers,
    unsortedEnabled: prefs.bool("unsorted", true), unsortedId: unsorted.id,
  }).map(p => (p.target === "unsorted" && unsorted.id ? { ...p, tabIds: p.tabIds.filter(id => state.infoById.get(id).folderId !== unsorted.id) } : p))
    .filter(p => p.tabIds.length);

  return { proposals, notes, gate, state, unsortedId: unsorted.id, unsortedMap: unsorted.map, prior: new Map(candidates.map(c => [c.id, c])) };
}

// ---------- executing plans ----------

let selfMutating = 0;

async function runSteps(steps) {
  selfMutating++;
  try {
    for (const s of steps) {
      const tab = s.tabId ? gBrowser.tabs.find(t => tabId(t) === s.tabId) : null;
      if (s.tabId && !tab) continue;
      if (s.op === "ungroup") gBrowser.ungroupTab(tab);
      else if (s.op === "unpin") gBrowser.unpinTab(tab);
      else if (s.op === "addToFolder") folderById(s.folderId)?.addTabs([tab]);
      else if (s.op === "park") park(tab, s.folderId);
      else if (s.op === "move") moveTo(tab, s.folderId, s.position);
      else if (s.op === "removeFolderIfEmpty") {
        const f = folderById(s.folderId);
        // Never delete() a folder holding real tabs: Zen closes them.
        if (f && realTabs(f).length === 0) await f.delete();
      }
    }
  } finally {
    selfMutating--;
  }
}

function park(tab, folderId) {
  const container = folderId ? realTabs(folderById(folderId) ?? { tabs: [] }) : gBrowser.tabs;
  const last = container.at(-1);
  if (last && last !== tab) gBrowser.moveTabAfter(tab, last);
}

function moveTo(tab, folderId, position) {
  if (!folderId) return gBrowser.moveTabTo(tab, { tabIndex: position });
  const siblings = realTabs(folderById(folderId) ?? { tabs: [] }).filter(t => t !== tab);
  const before = siblings[position];
  if (before) gBrowser.moveTabBefore(tab, before);
  else if (siblings.length) gBrowser.moveTabAfter(tab, siblings.at(-1));
}

// Re-check, then send new folders that fell below the minimum to Unsorted (or leave them loose).
function finalize(proposals, prior, unsortedEnabled) {
  const keep = new Set(recheck(prior, liveInfo([...prior.keys()])));
  const kept = proposals.map(p => ({ ...p, tabIds: p.tabIds.filter(id => keep.has(id)) }));
  const short = kept.filter(p => p.target === "new" && p.tabIds.length < DEFAULTS.minTabs);
  const result = kept.filter(p => p.tabIds.length && !short.includes(p));
  const spill = short.flatMap(p => p.tabIds);
  if (spill.length && unsortedEnabled) {
    const uns = result.find(p => p.target === "unsorted");
    if (uns) uns.tabIds = [...uns.tabIds, ...spill];
    else result.push({ label: DEFAULTS.unsortedLabel, tabIds: spill, target: "unsorted" });
  }
  return result;
}

async function apply(space, planned, chosen) {
  const allIds = chosen.flatMap(p => p.tabIds);
  const proposals = finalize(chosen, new Map(allIds.map(id => [id, planned.prior.get(id)])), prefs.bool("unsorted", true));
  const ids = proposals.flatMap(p => p.tabIds);
  // Only tabs Tidy will move are restorable; a tab the user changed during preview is left alone.
  const prior = new Map(ids.map(id => [id, planned.prior.get(id)]));
  const created = [];
  const lastAccessedDesc = (a, b) => b.lastAccessed - a.lastAccessed;

  const result = await applyWithRollback(
    {
      apply: async () => {
        selfMutating++;
        try {
          for (const p of proposals) {
            const tabs = p.tabIds.map(id => planned.state.tabsById.get(id)).sort(lastAccessedDesc);
            const target = p.folderId ? folderById(p.folderId) : null;
            if (target) {
              tabs.forEach(t => gBrowser.pinTab(t));
              target.addTabs(tabs);
            } else {
              const folder = gZenFolders.createFolder(tabs, { label: p.label, workspaceId: space, collapsed: true });
              created.push(folder.id);
              if (p.target === "unsorted") prefs.setStr("unsortedMap", withUnsorted(planned.unsortedMap, space, folder.id));
            }
          }
        } finally {
          selfMutating--;
        }
      },
      snapshot: () => liveInfo(ids),
      runSteps,
    },
    prior,
    () => created
  );
  return { result, prior, created };
}

// ---------- undo ----------

let lastTidy = null; // { space, prior, created, ids, valid }

function trackUndo(space, prior, created) {
  const ids = new Set(prior.keys());
  const watched = new Set(created);
  const expire = e => {
    if (selfMutating || !lastTidy) return;
    const t = e.target;
    const touched = (t.localName === "tab" && ids.has(tabId(t))) || (t.id && watched.has(t.id)) || (t.group && watched.has(t.group.id));
    if (touched) lastTidy.valid = false;
  };
  const events = ["TabClose", "TabMove", "TabGrouped", "TabUngrouped", "TabPinned", "TabUnpinned", "TabGroupUpdate", "TabGroupRemoved"];
  lastTidy?.cleanup?.();
  events.forEach(ev => window.addEventListener(ev, expire, true));
  lastTidy = { space, prior, created, valid: true, cleanup: () => events.forEach(ev => window.removeEventListener(ev, expire, true)) };
}

async function undo() {
  const t = lastTidy;
  if (!t?.valid) return toast("Nothing to undo (layout changed since the last Tidy).");
  if (windowsOnSpace(t.space) > 1) return toast("Close other windows on this space to undo.");
  if (!guard.tryLock(t.space)) return;
  try {
    const ids = [...t.prior.keys()];
    await runSteps(planRestore(t.prior, liveInfo(ids), t.created));
    const stuck = residue(t.prior, liveInfo(ids));
    toast(stuck.length ? `Undo left ${stuck.length} tab(s) out of place.` : "Tidy undone.");
  } finally {
    guard.unlock(t.space);
    t.cleanup();
    lastTidy = null;
  }
}

// ---------- UI ----------

const CSS = `
#zen-tidy-preview { position: fixed; z-index: 10000; top: 64px; left: 16px; width: 340px; max-height: 70vh; overflow: auto;
  background: var(--zen-colors-tertiary, Canvas); color: CanvasText; border-radius: 12px; padding: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,.35); font: menu; }
#zen-tidy-preview h3 { margin: 0 0 8px; font-size: 1.1em; }
#zen-tidy-preview .card { display: flex; gap: 8px; align-items: center; padding: 6px; border-radius: 8px; margin: 4px 0; }
#zen-tidy-preview .card[data-over] { outline: 2px dashed currentColor; }
#zen-tidy-preview .card input[type=text] { flex: 1; min-width: 0; background: transparent; color: inherit; border: 1px solid transparent; border-radius: 6px; padding: 2px 4px; }
#zen-tidy-preview .card input[type=text]:focus { border-color: currentColor; }
#zen-tidy-preview .note, #zen-tidy-preview .foot { opacity: .8; font-size: .9em; margin: 6px 0; }
#zen-tidy-preview .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
#zen-tidy-toast { position: fixed; z-index: 10001; bottom: 16px; left: 16px; padding: 8px 12px; border-radius: 10px;
  background: var(--zen-colors-tertiary, Canvas); color: CanvasText; box-shadow: 0 4px 16px rgba(0,0,0,.3); font: menu; display: flex; gap: 10px; align-items: center; }
`;

const el = (tag, props = {}, ...kids) => {
  const node = document.createElementNS(HTML, tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
};

function toast(text, action) {
  document.getElementById("zen-tidy-toast")?.remove();
  const node = el("div", { id: "zen-tidy-toast" }, text);
  if (action) node.append(el("button", { textContent: action.label, onclick: () => { node.remove(); action.run(); } }));
  document.documentElement.append(node);
  setTimeout(() => node.remove(), UNDO_TOAST_MS);
}

function closePreview() {
  document.getElementById("zen-tidy-preview")?.remove();
  window.removeEventListener("TabOpen", markStale, true);
  window.removeEventListener("TabClose", markStale, true);
  window.removeEventListener("TabPinned", markStale, true);
  window.removeEventListener("TabGrouped", markStale, true);
}

function markStale() {
  const box = document.getElementById("zen-tidy-preview");
  if (!box || box.querySelector(".stale") || selfMutating) return;
  box.prepend(el("div", { className: "note stale" }, "Tabs changed. ", el("button", { textContent: "Refresh", onclick: () => tidy() })));
}

function renderPreview(space, generation, planned) {
  closePreview();
  const box = el("div", { id: "zen-tidy-preview", role: "dialog", ariaLabel: "Zen Tidy preview" });
  box.append(el("h3", { textContent: "Tidy this space" }));
  planned.notes.forEach(n => box.append(el("div", { className: "note", textContent: n })));

  if (planned.gate === "prompt") {
    const optIn = el("div", { className: "note" },
      "Group leftovers with Firefox's on-device AI? This turns on browser.ml.enable and downloads the models once. Nothing leaves your device.");
    optIn.append(el("div", { className: "row" },
      el("button", { textContent: "Not now", onclick: () => { prefs.setBool("aiDeclined", true); optIn.remove(); } }),
      el("button", { textContent: "Enable AI", onclick: async () => { prefs.setBool("aiDeclined", false); optIn.remove(); await enableAi(); toast("AI enabled. It'll be used from your next Tidy."); } })));
    box.append(optIn);
  }

  const multiWindow = windowsOnSpace(space) > 1;
  if (multiWindow) box.append(el("div", { className: "note", textContent: "Close other windows on this space to Tidy." }));

  let proposals = planned.proposals.map((p, i) => ({ ...p, key: i, on: true }));
  if (!proposals.length) {
    box.append(el("div", { className: "note", textContent: "Nothing to tidy: no loose tabs in this space." }));
    box.append(el("div", { className: "row" }, el("button", { textContent: "Close", onclick: closePreview })));
    return document.documentElement.append(box);
  }

  const list = el("div");
  const foot = el("div", { className: "foot" });
  const draw = () => {
    list.replaceChildren(...proposals.map(p => card(p)));
    const on = proposals.filter(p => p.on);
    const n = on.reduce((sum, p) => sum + p.tabIds.length, 0);
    foot.textContent = `${n} ${n === 1 ? "tab" : "tabs"} will be pinned into ${on.length} ${on.length === 1 ? "folder" : "folders"}.`;
    if (!prefs.bool("seenCtrlWNote", false)) foot.textContent += " Tabs in folders are pinned: Ctrl+W unloads them instead of closing.";
  };
  let dragging = null;
  const card = p => {
    const node = el("div", { className: "card", draggable: true },
      el("input", { type: "checkbox", checked: p.on, ariaLabel: `Include ${p.label}`, onchange: e => { p.on = e.target.checked; draw(); } }),
      el("input", { type: "text", value: p.label, readOnly: p.target === "existing", ariaLabel: "Folder name", oninput: e => { p.label = e.target.value; } }),
      el("span", { textContent: `${p.tabIds.length}` }));
    node.ondragstart = () => { dragging = p; };
    node.ondragover = e => { if (dragging && dragging !== p) { e.preventDefault(); node.dataset.over = ""; } };
    node.ondragleave = () => delete node.dataset.over;
    node.ondrop = () => {
      if (!dragging || dragging === p) return;
      p.tabIds = [...p.tabIds, ...dragging.tabIds];
      proposals = proposals.filter(x => x !== dragging);
      dragging = null;
      draw();
    };
    return node;
  };
  draw();

  const applyBtn = el("button", { textContent: "Apply", disabled: multiWindow, onclick: async () => {
    if (!guard.isCurrent(space, generation) || !guard.tryLock(space)) return;
    try {
      const chosen = proposals.filter(p => p.on && p.label.trim()).map(({ key, on, ...p }) => p);
      closePreview();
      const { result, prior, created } = await apply(space, planned, chosen);
      prefs.setBool("seenCtrlWNote", true);
      if (!result.ok) {
        console.error("Zen Tidy apply failed", result.error, result.stuck);
        return toast(result.message);
      }
      trackUndo(space, prior, created);
      toast(`Tidied ${prior.size} tabs.`, { label: "Undo", run: undo });
    } finally {
      guard.unlock(space);
    }
  } });
  box.append(list, foot, el("div", { className: "row" }, el("button", { textContent: "Cancel", onclick: closePreview }), applyBtn));
  document.documentElement.append(box);
  ["TabOpen", "TabClose", "TabPinned", "TabGrouped"].forEach(ev => window.addEventListener(ev, markStale, true));
}

// ---------- entry ----------

async function tidy() {
  const space = gZenWorkspaces.activeWorkspace;
  if (guard.isLocked(space)) return;
  const generation = guard.start(space);
  try {
    const planned = await plan(space);
    if (guard.isCurrent(space, generation)) renderPreview(space, generation, planned);
  } catch (e) {
    console.error("Zen Tidy:", e);
    toast("Zen Tidy hit an error. Details are in the Browser Console.");
  }
}

function init() {
  const caps = checkCapabilities(capabilityEnv());
  if (!caps.enabled) {
    console.warn("Zen Tidy disabled, missing:", caps.missingRequired);
    return toast(`Zen Tidy doesn't support this Zen version yet (missing ${caps.missingRequired.join(", ")}).`);
  }
  aiAvailable = caps.aiAvailable;
  document.documentElement.append(el("style", { textContent: CSS }));

  const matches = parseShortcut(prefs.str("shortcut", "Alt+Shift+T")) ?? parseShortcut("Alt+Shift+T");
  window.addEventListener("keydown", e => {
    if (!matches(e)) return;
    e.preventDefault();
    tidy();
  }, true);

  const menu = document.getElementById("tabContextMenu");
  if (menu) {
    const item = document.createXULElement("menuitem");
    item.setAttribute("label", "Undo last Tidy");
    item.addEventListener("command", undo);
    menu.addEventListener("popupshowing", () => item.toggleAttribute("disabled", !lastTidy?.valid));
    menu.append(item);
  }
  Services.prefs.addObserver(PREF + "ai", onAiSettingChanged);
  window.addEventListener("unload", () => Services.prefs.removeObserver(PREF + "ai", onAiSettingChanged), { once: true });
}

if (gBrowserInit?.delayedStartupFinished) init();
else {
  const onStartup = subject => {
    if (subject !== window) return;
    Services.obs.removeObserver(onStartup, "browser-delayed-startup-finished");
    init();
  };
  Services.obs.addObserver(onStartup, "browser-delayed-startup-finished");
}
