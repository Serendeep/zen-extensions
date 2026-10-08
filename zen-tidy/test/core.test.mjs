import { test } from "node:test";
import assert from "node:assert/strict";
import {
  domainOf, tokenize, matchExistingFolders, bucketByRules, BUILT_IN_BUCKETS, buildProposals,
  tokenLabel, recheck, planRestore, residue, applyWithRollback, withTimeout, checkCapabilities,
  mlGate, disableAiPlan, createRunGuard, resolveUnsorted, withUnsorted,
} from "../core.mjs";

const tab = (id, url, title = id, extra = {}) => ({ id, url, title, pinned: false, folderId: null, position: 0, ...extra });
const byId = tabs => new Map(tabs.map(t => [t.id, t]));

test("domainOf strips www and survives garbage", () => {
  assert.equal(domainOf("https://www.github.com/x"), "github.com");
  assert.equal(domainOf("not a url"), "");
});

test("tokenize lowercases and drops stop words", () => {
  assert.deepEqual(tokenize("The Rust Book & Tokio"), ["rust", "book", "tokio"]);
});

test("existing-folder matching: precedence, domain dominance, Unsorted excluded", () => {
  const inFolder = [
    tab("g1", "https://github.com/a", "repo a", { folderId: "work", pinned: true }),
    tab("g2", "https://github.com/b", "repo b", { folderId: "work", pinned: true }),
    tab("r1", "https://github.com/rust", "rust thing", { folderId: "rust", pinned: true }),
    tab("r2", "https://doc.rust-lang.org", "book", { folderId: "rust", pinned: true }),
    tab("r3", "https://blog.rust-lang.org", "blog", { folderId: "rust", pinned: true }),
    tab("u1", "https://example.com", "misc", { folderId: "uns", pinned: true }),
  ];
  const folders = [
    { id: "work", label: "Work", tabIds: ["g1", "g2"] },
    { id: "rust", label: "Rust", tabIds: ["r1", "r2", "r3"] },
    { id: "uns", label: "Unsorted", tabIds: ["u1"] },
    { id: "late", label: "Rust", tabIds: [] },
  ];
  const cases = [
    // [title, url, expected folder]
    ["Rust async patterns", "https://github.com/x/y", "work"], // domain beats title token
    ["Learning Rust", "https://example.org", "rust"], // token match; earliest of two "Rust" folders
    ["Some misc", "https://example.com/z", undefined], // Unsorted never matches
    ["blog post", "https://blog.rust-lang.org/2", undefined], // rust-lang domain is not dominant in "rust" (1 of 3)
  ];
  for (const [title, url, expected] of cases) {
    const c = tab("c", url, title);
    const { assigned } = matchExistingFolders([c], folders, byId([...inFolder, c]), "uns");
    assert.equal(assigned.get("c"), expected, title);
  }
});

test("existing-folder matching: a single stray domain tab does not own the domain", () => {
  const all = [
    tab("a", "https://github.com/1", "x", { folderId: "f" }),
    tab("b", "https://jira.example.com", "y", { folderId: "f" }),
    tab("c", "https://jira.example.com/2", "z", { folderId: "f" }),
  ];
  const cand = tab("n", "https://github.com/new", "nothing");
  const { assigned, rest } = matchExistingFolders([cand], [{ id: "f", label: "Tickets", tabIds: ["a", "b", "c"] }], byId([...all, cand]), null);
  assert.equal(assigned.size, 0);
  assert.equal(rest.length, 1);
});

test("bucketByRules: user rule beats bucket, small buckets fall through", () => {
  const tabs = [
    tab("1", "https://github.com/a"), tab("2", "https://gist.github.com/b"),
    tab("3", "https://youtube.com/v"),
    tab("4", "https://corp.internal.dev/x"), tab("5", "https://corp.internal.dev/y"),
  ];
  const { groups, rest } = bucketByRules(tabs, [{ domain: "internal.dev", label: "Work" }], BUILT_IN_BUCKETS);
  assert.deepEqual(groups, [{ label: "Code", tabIds: ["1", "2"] }, { label: "Work", tabIds: ["4", "5"] }]);
  assert.deepEqual(rest.map(t => t.id), ["3"]);
});

test("buildProposals: existing, new, below-minimum to Unsorted, Unsorted off, empty", () => {
  const base = {
    existing: new Map([["a", "f1"]]),
    folders: [{ id: "f1", label: "Rust", tabIds: [] }],
    ruleGroups: [{ label: "Code", tabIds: ["b", "c"] }],
    clusters: [{ label: "Solo", tabIds: ["d"] }],
    leftovers: ["e"],
    unsortedEnabled: true,
    unsortedId: "u9",
  };
  assert.deepEqual(buildProposals(base), [
    { label: "Rust", tabIds: ["a"], target: "existing", folderId: "f1" },
    { label: "Code", tabIds: ["b", "c"], target: "new" },
    { label: "Unsorted", tabIds: ["e", "d"], target: "unsorted", folderId: "u9" },
  ]);
  assert.equal(buildProposals({ ...base, unsortedEnabled: false }).some(p => p.target === "unsorted"), false);
  assert.deepEqual(buildProposals({ ...base, existing: new Map(), ruleGroups: [], clusters: [], leftovers: [], unsortedEnabled: false }), []);
});

test("tokenLabel picks the most common title word", () => {
  assert.equal(tokenLabel(["Tokio docs", "Tokio runtime", "async"]), "Tokio");
  assert.equal(tokenLabel([]), "Group");
});

test("recheck keeps unchanged tabs, including tabs that started in Unsorted", () => {
  const prior = byId([tab("loose", "u"), tab("uns", "u", "t", { pinned: true, folderId: "U" }), tab("gone", "u"), tab("repinned", "u")]);
  const live = byId([tab("loose", "u"), tab("uns", "u", "t", { pinned: true, folderId: "U" }), tab("repinned", "u", "t", { pinned: true })]);
  assert.deepEqual(recheck(prior, live), ["loose", "uns"]);
});

test("planRestore returns loose and Unsorted tabs to their exact prior place and never deletes non-empty folders", () => {
  const prior = byId([
    tab("loose", "u", "t", { position: 4 }),
    tab("uns", "u", "t", { pinned: true, folderId: "U", position: 1 }),
    tab("vanished", "u", "t", { position: 9 }),
    tab("untouched", "u", "t", { position: 2 }),
  ]);
  const live = byId([
    tab("loose", "u", "t", { pinned: true, folderId: "NEW", position: 0 }),
    tab("uns", "u", "t", { pinned: true, folderId: "NEW", position: 1 }),
    tab("untouched", "u", "t", { position: 2 }),
  ]);
  // Structure, folder cleanup, park at container end, then ascending moves (indices are
  // only valid once pinned folder tabs and placeholders are gone).
  assert.deepEqual(planRestore(prior, live, ["NEW"]), [
    { op: "ungroup", tabId: "uns" },
    { op: "addToFolder", tabId: "uns", folderId: "U" },
    { op: "ungroup", tabId: "loose" },
    { op: "unpin", tabId: "loose" },
    { op: "removeFolderIfEmpty", folderId: "NEW" },
    { op: "park", tabId: "uns", folderId: "U" },
    { op: "park", tabId: "loose", folderId: null },
    { op: "move", tabId: "uns", folderId: "U", position: 1 },
    { op: "move", tabId: "loose", folderId: null, position: 4 },
  ]);
  assert.equal(planRestore(prior, live, []).some(s => s.op === "delete"), false);
});

test("applyWithRollback: mid-apply failure restores and reports honestly", async () => {
  const at = (id, position, extra = {}) => tab(id, "u", id, { position, ...extra });
  const prior = byId([at("a", 0), at("b", 1)]);
  let live = byId([at("a", 0), at("b", 1)]);
  const io = {
    apply: async () => {
      live = byId([at("a", 0, { pinned: true, folderId: "F" }), at("b", 1, { pinned: true })]);
      throw new Error("createFolder renamed");
    },
    snapshot: () => live,
    runSteps: async () => {
      live = byId([at("a", 0), at("b", 1)]);
    },
  };
  const ok = await applyWithRollback(io, prior, () => ["F"]);
  assert.equal(ok.ok, false);
  assert.equal(ok.message, "Tidy failed, nothing changed");

  const stuckIo = { ...io, runSteps: async () => { throw new Error("rollback failed too"); } };
  const bad = await applyWithRollback(stuckIo, prior, () => ["F"]);
  assert.deepEqual(bad.stuck, ["a", "b"]);
  assert.match(bad.message, /2 tab\(s\) could not be restored/);

  const misplacedIo = { ...io, runSteps: async () => { live = byId([at("a", 1), at("b", 0)]); } };
  const misplaced = await applyWithRollback(misplacedIo, prior, () => ["F"]);
  assert.deepEqual(misplaced.stuck, ["a", "b"], "order counts as state: no false 'nothing changed'");

  const fine = await applyWithRollback({ ...io, apply: async () => {} }, prior, () => []);
  assert.deepEqual(fine, { ok: true });
});

test("withTimeout: stalled AI yields timedOut, fast AI yields value", async () => {
  assert.deepEqual(await withTimeout(new Promise(() => {}), 20), { timedOut: true });
  assert.deepEqual(await withTimeout(Promise.resolve(7), 1000), { timedOut: false, value: 7 });
});

test("checkCapabilities: missing ML degrades, missing folder API disables", () => {
  const all = { "gZenFolders.createFolder": true, "gZenWorkspaces.activeWorkspace": true, "gBrowser.ungroupTab": true, "gBrowser.unpinTab": true, "gBrowser.pinTab": true, "gBrowser.moveTabTo": true };
  assert.deepEqual(checkCapabilities(all), { enabled: true, aiAvailable: false, missingRequired: [], missingOptional: ["SmartTabGroupingManager"] });
  const broken = checkCapabilities({ ...all, "gZenFolders.createFolder": false, SmartTabGroupingManager: true });
  assert.equal(broken.enabled, false);
  assert.deepEqual(broken.missingRequired, ["gZenFolders.createFolder"]);
});

test("mlGate and disableAiPlan follow opt-in and ownership rules", () => {
  assert.equal(mlGate({ mlPref: false, tidyAiSetting: true, declined: false }), "prompt");
  assert.equal(mlGate({ mlPref: false, tidyAiSetting: true, declined: true }), "rules-only");
  assert.equal(mlGate({ mlPref: true, tidyAiSetting: true, declined: false }), "use-ai");
  assert.equal(mlGate({ mlPref: true, tidyAiSetting: false, declined: false }), "rules-only");
  assert.deepEqual(disableAiPlan({ mlPref: true, enabledByTidy: true }), { revertPref: true, clearOwnership: true });
  assert.deepEqual(disableAiPlan({ mlPref: true, enabledByTidy: false }), { revertPref: false, clearOwnership: false });
});

test("run guard discards stale generations and holds one apply lock per space", () => {
  const g = createRunGuard();
  const first = g.start("s1");
  const second = g.start("s1");
  assert.equal(g.isCurrent("s1", first), false);
  assert.equal(g.isCurrent("s1", second), true);
  assert.equal(g.tryLock("s1"), true);
  assert.equal(g.tryLock("s1"), false);
  assert.equal(g.tryLock("s2"), true);
  g.unlock("s1");
  assert.equal(g.tryLock("s1"), true);
});

test("resolveUnsorted: per-space ids, stale ids dropped, corrupt pref tolerated", () => {
  const json = withUnsorted({ s2: "f2" }, "s1", "f1");
  assert.deepEqual(resolveUnsorted(json, "s1", id => id === "f1"), { id: "f1", map: { s1: "f1", s2: "f2" } });
  assert.deepEqual(resolveUnsorted(json, "s1", () => false), { id: null, map: { s2: "f2" } });
  assert.deepEqual(resolveUnsorted("{nope", "s1", () => true), { id: null, map: {} });
  assert.equal(resolveUnsorted(json, "s3", () => true).id, null);
});

test("parseRules reads user rules and skips junk", async () => {
  const { parseRules } = await import("../core.mjs");
  assert.deepEqual(parseRules("www.GitHub.com=Code; bad; linear.app = Work ;=x"), [
    { domain: "github.com", label: "Code" },
    { domain: "linear.app", label: "Work" },
  ]);
  assert.deepEqual(parseRules(undefined), []);
});

test("parseShortcut matches exact modifiers only", async () => {
  const { parseShortcut } = await import("../core.mjs");
  const m = parseShortcut("Alt+Shift+T");
  const ev = o => ({ key: "T", altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...o });
  assert.equal(m(ev({ altKey: true, shiftKey: true })), true);
  assert.equal(m(ev({ altKey: true, shiftKey: true, ctrlKey: true })), false);
  assert.equal(m(ev({ altKey: true })), false);
  assert.equal(parseShortcut("Hyper+T"), null);
  assert.equal(parseShortcut(""), null);
});

test("chooseLabel replaces generic model names with the shared site or a real title word", async () => {
  const { chooseLabel, isGenericLabel } = await import("../core.mjs");
  const t = (title, url) => ({ title, url });
  assert.equal(chooseLabel("Rust Programming", [t("a", "https://x.com")]), "Rust Programming");
  assert.equal(isGenericLabel("Sign In"), true);
  assert.equal(isGenericLabel("Signs"), true);
  assert.equal(isGenericLabel("Rust"), false);
  const logins = [t("Sign in - Google Accounts", "https://accounts.google.com/a"), t("Sign in", "https://accounts.google.com/b"), t("Login", "https://github.com/login")];
  assert.equal(chooseLabel("Signs", logins), "Google");
  const mixed = [t("Sign in to Linear", "https://linear.app/login"), t("Linear issues", "https://a.com"), t("Sign in", "https://b.org")];
  assert.equal(chooseLabel("", mixed), "Linear");
  assert.equal(chooseLabel("Login", [t("Sign in", "not a url")]), "Group");
});
