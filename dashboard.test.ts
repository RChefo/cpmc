/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * dashboard.test.ts — UI tests for the web dashboard (dashboard.html + dashboard.js)
 *
 * Each test boots the real markup and script in a fresh happy-dom window against a stubbed broker: fetch serves
 * /api/dashboard-state and records every POST, and a fake WebSocket lets a test push state or drop the connection.
 * No broker is started and nothing leaves the process.
 *
 * Run: bun test dashboard
 */

import { test, expect, describe, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const HTML = await Bun.file(`${import.meta.dir}/dashboard.html`).text();
const SCRIPT = await Bun.file(`${import.meta.dir}/dashboard.js`).text();
const BODY = HTML.slice(HTML.indexOf("<body>") + "<body>".length, HTML.indexOf("</body>")).replace(/<script\b[\s\S]*?<\/script>/g, "");

// --- Fixture: the shape getDashboardState() returns ---

const T0 = Date.parse("2026-10-22T09:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const NAMES: Record<string, string> = { a1: "alpha", b1: "beta", c1: "gamma", dashboard: "dashboard", cli: "cli" };
const PIDS: Record<string, number> = { a1: 11, b1: 12, c1: 13 };

type State = Record<string, any>;

function message(id: number, from_id: string, to_id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id, from_id, to_id, text, sent_at: at(id), delivered: false, acknowledged: false, msg_type: null, metadata: null,
    context_snapshot: null, session_id: "s1", pinned: 0, from_name: NAMES[from_id] ?? null, to_name: NAMES[to_id] ?? null,
    failed_at: null, fail_reason: null, ...extra,
  };
}

function fixture(): State {
  const peer = (id: string, status: string, group_id: string | null, summary: string, git_branch: string | null) => ({
    id, name: NAMES[id], pid: PIDS[id], cwd: "C:\\work\\atlas", git_root: "C:\\work\\atlas", git_branch, tty: null, summary, status,
    group_id, registered_at: at(0), last_seen: at(30),
  });
  const report = [
    "## Status",
    "| Area | State |",
    "|---|---|",
    "| API | done |",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "<img src=x onerror=\"window.__xss = 1\"> see https://example.com/docs and snake_case_name",
  ].join("\n");
  const pinnedReport = { ...message(2, "a1", "dashboard", report), pinned: 1 };
  return {
    peers: [peer("a1", "online", null, "Reviewing the API", null), peer("b1", "busy", "g1", "", "main"), peer("c1", "away", "g1", "Running tests", "main")],
    messages: [
      message(1, "dashboard", "a1", "Hello alpha", { delivered: true, acknowledged: true }),
      pinnedReport,
      message(3, "b1", "c1", "**Question:** Which port?", {
        msg_type: "question", delivered: true,
        metadata: JSON.stringify({ question: "Which port?", expected_format: "A number", context: "Dev server" }),
      }),
      message(4, "dashboard", "c1", "Please rerun the suite"),
      message(5, "dashboard", "gone1", "Are you there?", { to_name: "ghost", failed_at: at(6), fail_reason: "recipient disconnected before reading it" }),
      message(6, "cli", "a1", "Broker restarted", { delivered: true }),
    ],
    groups: [
      { id: "g1", name: "branch/main", member_count: 2, members: [{ id: "b1", name: "beta" }, { id: "c1", name: "gamma" }] },
      { id: "g2", name: "empty-team", member_count: 0, members: [] },
    ],
    typing: [],
    tasks: [
      { id: "t1", title: "Ship the fix", description: "Patch the handler", creator_id: "a1", assignee_id: "b1", group_id: null, status: "pending", result: "", created_at: at(3), completed_at: null, session_id: "s1" },
      { id: "t2", title: "Write docs", description: "", creator_id: "a1", assignee_id: "c1", group_id: null, status: "completed", result: "Merged", created_at: at(2), completed_at: at(4), session_id: "s1" },
    ],
    pinned: [pinnedReport],
    active_files: [
      { peer_id: "b1", peer_name: "beta", files: ["C:\\work\\atlas\\src\\a.ts", "C:\\work\\atlas\\src\\b.ts"] },
      { peer_id: "c1", peer_name: "gamma", files: ["C:\\work\\atlas\\src\\a.ts"] },
    ],
    approvals: [{ id: "ap1", requester_id: "b1", approver_id: "c1", action_description: "Force-push main", status: "pending", group_id: "g1", created_at: at(5), resolved_at: null, session_id: "s1" }],
    audit: [
      { id: 3, action: "proposal.vote", actor_id: "c1", actor_name: "gamma", details: 'approve on "Adopt Bun"', group_id: "g1", created_at: at(7) },
      { id: 2, action: "identity.mismatch", actor_id: "b1", actor_name: "beta", details: "/send-message from pid 99, peer pid 12", group_id: null, created_at: at(6) },
      { id: 1, action: "peer.register", actor_id: "a1", actor_name: "alpha", details: "alpha joined from C:\\work\\atlas", group_id: null, created_at: at(0) },
    ],
    reactions: { 2: [{ emoji: "\u{1F44D}", peer_id: "dashboard", peer_name: "dashboard" }, { emoji: "\u{1F44D}", peer_id: "b1", peer_name: "beta" }] },
    decisions: [
      { id: "d1", key: "api.style", value: "REST over RPC", rationale: "Simpler clients", author_id: "a1", author_name: "alpha", category: "architecture", status: "active", group_id: null, created_at: at(1), updated_at: at(1), session_id: "s1" },
      { id: "d2", key: "release.day", value: "Monday", rationale: "", author_id: "a1", author_name: "alpha", category: "release", status: "revoked", group_id: null, created_at: at(1), updated_at: at(2), session_id: "s1" },
    ],
    verifications: [
      { id: "v1", requester_id: "b1", verifier_id: "c1", claim: "Tests pass", evidence_needed: "CI log", files_to_check: '["src/a.ts"]', status: "pending", response: "", evidence: "", group_id: "g1", created_at: at(2), resolved_at: null, session_id: "s1" },
      { id: "v2", requester_id: "c1", verifier_id: "b1", claim: "Docs build", evidence_needed: "", files_to_check: "[]", status: "failed", response: "Broken link", evidence: "404 on /api", group_id: "g1", created_at: at(2), resolved_at: at(3), session_id: "s1" },
    ],
    proposals: [{
      id: "p1", author_id: "b1", author_name: "beta", title: "Adopt Bun", description: "Switch the runtime", required_votes: 2, status: "open", group_id: "g1",
      created_at: at(2), resolved_at: null, session_id: "s1",
      votes: [{ id: "pv1", proposal_id: "p1", voter_id: "c1", voter_name: "gamma", vote: "approve", reason: "Faster", created_at: at(7) }],
    }],
    session_id: "s1",
    uptime_ms: 60_000,
  };
}

// --- Harness ---

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.({}); }
  push(state: State) { this.onmessage?.({ data: JSON.stringify(state) }); }
  drop() { if (this.readyState === FakeSocket.CLOSED) return; this.readyState = FakeSocket.CLOSED; this.onclose?.({}); }
  close() { this.drop(); }
  send() { /* the dashboard never sends over the socket */ }
}

type Reply = { status?: number; json?: unknown };
type Options = { state?: State; body?: string; width?: number; storage?: Record<string, string>; post?: (path: string, body: any) => Reply | Promise<Reply> };

const settle = async (ms = 0) => {
  await new Promise((r) => setTimeout(r, ms));
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const click = async (el: Element | null) => { expect(el).toBeTruthy(); (el as HTMLElement).click(); await settle(); };
const keydown = (target: EventTarget, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); await settle(150); };

async function boot(opts: Options = {}) {
  GlobalRegistrator.register({ url: "http://127.0.0.1:7899/", width: opts.width ?? 1440, height: 900 });
  document.documentElement.setAttribute("data-theme", "dark");
  document.body.innerHTML = opts.body ?? BODY;
  for (const [k, v] of Object.entries(opts.storage ?? {})) localStorage.setItem(k, v);
  const env = {
    state: opts.state ?? fixture(),
    stateFails: false,
    calls: [] as { path: string; body: any }[],
    post: opts.post ?? ((): Reply => ({ json: { ok: true } })),
  };
  const respond = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json });
  (globalThis as any).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (url.startsWith("https://translate.googleapis.com/")) return respond(200, [[["\u0645\u0631\u062D\u0628\u0627", "x"]]]);
    const path = new URL(url, "http://127.0.0.1:7899").pathname;
    if (!init?.method || init.method === "GET") {
      if (env.stateFails) throw new TypeError("Failed to fetch");
      return respond(200, JSON.parse(JSON.stringify(env.state)));
    }
    const body = JSON.parse(String(init.body));
    env.calls.push({ path, body });
    const r = await env.post(path, body);
    return respond(r.status ?? 200, r.json ?? { ok: true });
  };
  FakeSocket.instances = [];
  (globalThis as any).WebSocket = FakeSocket;
  (0, eval)(SCRIPT);
  await settle(20);
  return {
    env,
    socket: () => FakeSocket.instances[FakeSocket.instances.length - 1]!,
    posts: (path: string) => env.calls.filter((c) => c.path === path).map((c) => c.body),
  };
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const msg = (id: number) => $(`article.msg[data-msg-id="${id}"]`);

// =============================================================================
// RENDERING
// =============================================================================

describe("Rendering", () => {
  test("shows the roster, rail counts and conversation from the broker state", async () => {
    await boot();
    expect($$(".peer-btn[data-id]").map((b) => b.getAttribute("data-id"))).toEqual(["a1", "b1", "c1"]);
    // Each row's accessible name is its visible label; status and summary describe it (WCAG 2.5.3).
    const beta = $('.peer-btn[data-id="b1"]');
    expect(beta.textContent).toBe("beta");
    expect(beta.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent)).toEqual(["Busy", "No summary yet"]);
    expect($$(".group-head .label").map((e) => e.textContent)).toEqual(["Lobby", "main"]);
    // Badges mark only what is waiting on someone; totals stay in the tab's label.
    const count = (s: string) => $(`[data-count="${s}"]`);
    expect(count("peers").textContent).toBe("");
    expect($("#tab-peers .sr-only").textContent).toBe("Peers — 3 peers connected");
    expect(count("tasks").textContent).toBe("1");
    expect(count("files").textContent).toBe("1"); // two peers edit src/a.ts
    expect(count("files").dataset.tone).toBe("bad");
    expect(count("proposals").textContent).toBe("1"); // open, and the dashboard has not voted
    expect(count("proposals").dataset.tone).toBe("warn");
    expect(count("decisions").textContent).toBe("");
    expect(count("approvals").textContent).toBe("1");
    expect($$("article.msg")).toHaveLength(6);
    expect($("#scope .scope-sub").textContent).toContain("6 messages");
  });

  test("shows each message's sender, recipient and real delivery state", async () => {
    await boot();
    const state = (id: number) => msg(id).querySelector(".track")?.getAttribute("data-state") ?? null;
    expect(state(1)).toBe("acknowledged");
    expect(state(4)).toBe("sent");
    expect(state(5)).toBe("failed");
    expect(state(2)).toBeNull(); // replies to the dashboard have no delivery track
    expect(msg(5).querySelector(".msg-fail")!.textContent).toContain("Recipient disconnected before reading it");
    expect(msg(5).querySelector(".msg-route")!.textContent).toContain("ghost"); // stored name of a departed peer
    expect(msg(1).querySelector(".msg-from")!.textContent).toBe("You");
  });

  test("renders markdown safely: tables, code, links, and markup as plain text", async () => {
    await boot();
    const body = msg(2).querySelector(".msg-body")!;
    expect(body.querySelector("table th")!.textContent).toBe("Area");
    expect(body.querySelector(".code pre")!.textContent).toBe("const x = 1;");
    expect(body.querySelector(".code-head span")!.textContent).toBe("ts");
    expect(body.querySelector("img")).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror="window.__xss = 1">');
    expect((globalThis as any).__xss).toBeUndefined();
    const link = body.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(body.textContent).toContain("snake_case_name");
    expect(body.querySelector("em")).toBeNull();
  });

  test("renders structured messages from their metadata", async () => {
    await boot();
    const m = msg(3);
    expect(m.querySelector(".kind")!.textContent).toBe("Question");
    const labels = [...m.querySelectorAll(".struct dt")].map((e) => e.textContent);
    expect(labels).toEqual(["Question", "Expected format", "Context"]);
  });

  test("lists approvals, which the old dashboard received but never showed", async () => {
    await boot({ storage: { "cp.section": "approvals" } });
    expect($("#panel-title").textContent).toBe("Approvals");
    expect($("#panel-body").textContent).toContain("Force-push main");
    expect($("#panel-body").textContent).toContain("Pending");
  });

  test("describes audit events in words and marks refusals", async () => {
    await boot({ storage: { "cp.section": "activity" } });
    const texts = $$(".event-text").map((e) => e.textContent);
    expect(texts).toEqual(["gamma voted to approve", "Refused a request made on behalf of beta", "alpha joined"]);
    expect($$(".event-icon")[1]!.dataset.tone).toBe("bad");
  });

  test("explains when the broker cannot be reached", async () => {
    GlobalRegistrator.register({ url: "http://127.0.0.1:7899/", width: 1440, height: 900 });
    document.body.innerHTML = BODY;
    (globalThis as any).fetch = async () => { throw new TypeError("Failed to fetch"); };
    FakeSocket.instances = [];
    (globalThis as any).WebSocket = FakeSocket;
    (0, eval)(SCRIPT);
    await settle(20);
    expect($("#timeline-col").textContent).toContain("Can't reach the broker");
    expect($("#conn").dataset.state).toBe("offline");
  });

  test("an outdated cached dashboard.html gets a reload notice instead of a broken page", async () => {
    await boot({ body: '<div class="app"></div>' });
    expect($('[role="alert"]').textContent).toContain("Ctrl+Shift+R");
  });

  test("hostile markdown cannot hang or overflow the renderer", async () => {
    const LS = String.fromCharCode(0x2028);
    const long = "see " + "`".repeat(4000) + "x " + "_".repeat(4000);
    const state = fixture();
    state.messages = [
      message(1, "a1", "dashboard", `- first${LS}- second`), // a line separator inside a list item
      message(2, "a1", "dashboard", ">".repeat(60) + " deep"), // nested quotes far past any sane depth
      message(3, "a1", "dashboard", long), // a line the inline parser would take super-linear time on
    ];
    const started = Date.now();
    await boot({ state });
    expect(Date.now() - started).toBeLessThan(3000);
    expect([...msg(1).querySelectorAll("li")].map((li) => li.textContent)).toEqual(["first", "second"]);
    expect(msg(2).querySelectorAll("blockquote").length).toBe(9); // nesting stops at 8 levels; the rest is text
    expect(msg(2).querySelector(".msg-body")!.textContent).toContain("deep");
    expect(msg(3).querySelector(".msg-body")!.textContent).toBe(long);
  });

  test("inputs that used to take seconds render quickly", async () => {
    const spaces = " ".repeat(60_000);
    const ticks = "x" + "`".repeat(1999); // a backtick run just under the inline limit: ~0.5-2.7 s per line before the fix
    const state = fixture();
    state.messages = [
      message(1, "a1", "dashboard", [ticks, ticks, ticks].join("\n")),
      message(2, "a1", "dashboard", "a|b\n" + spaces + "x"), // a table row followed by a long run of spaces
      message(3, "a1", "dashboard", "# a" + spaces + "b"), // a heading with a long run of spaces
      message(4, "a1", "dashboard", "[".repeat(60_000)), // excerpts (pins, announcements) of bracket and space runs
      message(5, "a1", "dashboard", spaces + "|"),
    ];
    state.pinned = [state.messages[3], state.messages[4]];
    const started = Date.now();
    await boot({ state });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(msg(1).querySelector(".msg-body")!.textContent).toBe(ticks.repeat(3));
    expect($("#pins").hidden).toBe(false);
  });
});

// =============================================================================
// PEERS, SCOPE AND COMPOSER
// =============================================================================

describe("Conversation and composer", () => {
  test("selecting a peer scopes the timeline, opens its details and addresses the composer", async () => {
    await boot();
    await click($('.peer-btn[data-id="c1"]'));
    expect($$("article.msg").map((a) => Number(a.dataset.msgId))).toEqual([3, 4]);
    // The docked details column shows the peer's tile and status, so the header stays compact.
    expect($("#scope .scope-title").textContent).toBe("Messages with gamma");
    expect($("#scope .tile")).toBeNull();
    expect(($("#recipient") as HTMLSelectElement).value).toBe("c1");
    expect($("#cp-root").dataset.ctx).toBe("open");
    expect($("#context").textContent).toContain("Running tests");
    await click($('.peer-btn[data-id="c1"]')); // clicking the selected peer shows all traffic again
    expect($$("article.msg")).toHaveLength(6);
  });

  test("sends exactly one request per submission and clears the draft on success", async () => {
    const { posts } = await boot();
    await click($('.peer-btn[data-id="a1"]'));
    const ta = $("#composer-text") as HTMLTextAreaElement;
    await type(ta, "  Ship it  ");
    keydown(ta, "Enter");
    keydown(ta, "Enter");
    keydown(ta, "Enter");
    await settle(20);
    expect(posts("/send-message")).toEqual([{ from_id: "dashboard", to_id: "a1", text: "Ship it" }]);
    expect(ta.value).toBe("");
    expect($("#composer-status").textContent).toContain("Sent to alpha");
  });

  test("keeps the draft and explains the broker's error when sending fails", async () => {
    await boot({ post: (path) => (path === "/send-message" ? { json: { ok: false, error: "Rate limited: max 60 messages per minute" } } : { json: { ok: true } }) });
    await click($('.peer-btn[data-id="a1"]'));
    const ta = $("#composer-text") as HTMLTextAreaElement;
    await type(ta, "Status?");
    keydown(ta, "Enter");
    await settle(20);
    expect(ta.value).toBe("Status?");
    expect($("#composer-alert").hidden).toBe(false);
    expect($("#composer-alert").textContent).toContain("Rate limited");
  });

  test("refuses messages over the broker's 64 KB limit without sending them", async () => {
    const { posts } = await boot();
    await click($('.peer-btn[data-id="a1"]'));
    const ta = $("#composer-text") as HTMLTextAreaElement;
    await type(ta, "x".repeat(65_537));
    expect(($("#send-btn") as HTMLButtonElement).disabled).toBe(true);
    expect($("#char-count").dataset.tone).toBe("bad");
    keydown(ta, "Enter");
    await settle(20);
    expect(posts("/send-message")).toHaveLength(0);
    expect($("#composer-alert").textContent).toContain("65,536");
  });

  test("never sends without an explicit recipient", async () => {
    const { posts } = await boot();
    const ta = $("#composer-text") as HTMLTextAreaElement;
    await type(ta, "Who gets this?");
    expect(($("#send-btn") as HTMLButtonElement).disabled).toBe(true);
    keydown(ta, "Enter");
    await settle(20);
    expect(posts("/send-message")).toHaveLength(0);
    expect($("#composer-alert").textContent).toContain("Choose who should receive");
  });

  test("follows the selection and recipient when the same session reconnects, and warns when it is gone", async () => {
    const { socket } = await boot();
    socket().open();
    await click($('.peer-btn[data-id="a1"]'));
    const next = fixture();
    next.peers[0].id = "a2"; // the same process (pid and directory) registered again with a new id
    socket().push(next);
    await settle();
    expect(($("#recipient") as HTMLSelectElement).value).toBe("a2");
    expect($(".peer.selected .peer-btn").getAttribute("data-id")).toBe("a2");
    expect($("#composer-status").textContent).toContain("alpha reconnected");
    expect($$("article.msg").map((a) => Number(a.dataset.msgId))).toEqual([1, 2, 6]); // its earlier messages stay in scope
    // The details column counts the earlier connection too, as the scope does.
    expect($("#context").textContent).toContain("1 sent · 2 received");
    expect($("#context").textContent).toContain("Ship the fix"); // a task alpha created before the reconnect
    const gone = fixture();
    gone.peers = gone.peers.filter((p: any) => p.name !== "alpha");
    socket().push(gone);
    await settle();
    expect($("#composer-alert").textContent).toContain("alpha is offline");
    await type($("#composer-text") as HTMLTextAreaElement, "hello?");
    expect(($("#send-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a reconnect clears an offline error that no longer applies", async () => {
    const { socket } = await boot();
    socket().open();
    await click($('.peer-btn[data-id="a1"]'));
    const gone = fixture();
    gone.peers = gone.peers.filter((p: any) => p.id !== "a1");
    socket().push(gone);
    await settle();
    const ta = $("#composer-text") as HTMLTextAreaElement;
    await type(ta, "still there?");
    keydown(ta, "Enter"); // refused locally: alpha is offline
    await settle(20);
    expect($("#composer-alert").textContent).toContain("alpha is offline");
    const back = fixture();
    back.peers[0].id = "a2";
    socket().push(back);
    await settle();
    expect($("#composer-alert").hidden).toBe(true);
    expect($("#composer-status").textContent).toContain("alpha reconnected");
  });

  test("a peer selected after it reconnected under a new name still shows its earlier messages", async () => {
    const { socket } = await boot();
    socket().open(); // the page has seen alpha (a1, pid 11) connected
    const next = fixture();
    next.peers[0] = { ...next.peers[0], id: "a2", name: "omega" }; // the same process, renamed after reconnecting
    socket().push(next);
    await settle();
    await click($('.peer-btn[data-id="a2"]'));
    expect($$("article.msg").map((a) => Number(a.dataset.msgId))).toEqual([1, 2, 6]);
  });

  test("a new session that takes over a departed peer's name does not inherit its messages", async () => {
    const { socket } = await boot();
    socket().open(); // the page has seen alpha (a1, pid 11) connected
    const next = fixture();
    next.peers[0] = { ...next.peers[0], id: "z9", pid: 99, cwd: "C:\\work\\other" }; // a different process, same name
    next.messages.push(message(7, "x0", "dashboard", "from a connection older than the page", { from_name: "alpha" }));
    socket().push(next);
    await settle();
    await click($('.peer-btn[data-id="z9"]'));
    // a1's messages and the older ones stored under "alpha" are not z9's: another process has used that name.
    expect($$("article.msg")).toHaveLength(0);
    expect($("#context").textContent).toContain("0 sent · 0 received");
  });

  test("an unrelated session that takes over a freed name does not capture the recipient", async () => {
    const { socket, posts } = await boot();
    socket().open();
    await click($('.peer-btn[data-id="a1"]'));
    const next = fixture();
    next.peers[0] = { ...next.peers[0], id: "z9", pid: 99, cwd: "C:\\work\\other" }; // same name, different process
    socket().push(next);
    await settle();
    expect(($("#recipient") as HTMLSelectElement).value).toBe("a1");
    expect($("#composer-alert").textContent).toContain("alpha is offline");
    await type($("#composer-text") as HTMLTextAreaElement, "for the old alpha");
    keydown($("#composer-text"), "Enter");
    await settle(20);
    expect(posts("/send-message")).toHaveLength(0);
  });

  test("peers that share a default name in different groups keep separate conversations", async () => {
    const state = fixture();
    state.peers[0].name = "claude-1"; // a1, Lobby
    state.peers[1].name = "claude-1"; // b1, group main
    state.messages = [
      message(1, "a1", "dashboard", "from the lobby one", { from_name: "claude-1" }),
      message(2, "b1", "dashboard", "from the branch one", { from_name: "claude-1" }),
      message(3, "x0", "dashboard", "from an earlier connection", { from_name: "claude-1" }),
    ];
    await boot({ state });
    await click($('.peer-btn[data-id="a1"]'));
    // With two live claude-1s, the stored name of a departed id cannot tell whose message it was.
    expect($$("article.msg").map((a) => Number(a.dataset.msgId))).toEqual([1]);
  });

  test("a stored name still finds a peer's earlier messages when it is unambiguous", async () => {
    const state = fixture();
    state.messages = [message(1, "x0", "dashboard", "before the reconnect", { from_name: "alpha" }), message(2, "a1", "dashboard", "after")];
    await boot({ state });
    await click($('.peer-btn[data-id="a1"]'));
    expect($$("article.msg").map((a) => Number(a.dataset.msgId))).toEqual([1, 2]);
  });

  test("a send that times out warns that the message may already have been delivered", async () => {
    await boot({ post: (path) => { if (path === "/send-message") { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; } return { json: { ok: true } }; } });
    await click($('.peer-btn[data-id="a1"]'));
    const ta = $("#composer-text") as HTMLTextAreaElement;
    await type(ta, "Deploy now");
    keydown(ta, "Enter");
    await settle(20);
    expect($("#composer-alert").textContent).toContain("may have been sent");
    expect(ta.value).toBe("Deploy now");
  });

  test("an unchanged snapshot does not touch the live regions", async () => {
    const { socket } = await boot();
    socket().open();
    await click($('.peer-btn[data-id="a1"]'));
    const ta = $("#composer-text") as HTMLTextAreaElement;
    await type(ta, "ping");
    keydown(ta, "Enter");
    await settle(20);
    expect($("#composer-status").textContent).toContain("Sent to alpha");
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((list) => mutations.push(...list));
    for (const id of ["composer-status", "conn", "search-count"]) observer.observe(document.getElementById(id)!, { childList: true, characterData: true, subtree: true });
    socket().push(fixture()); // the broker's periodic push of the same state
    await settle();
    observer.disconnect();
    expect(mutations).toHaveLength(0);
  });

  test("the first message of a session that started empty is announced", async () => {
    const state = fixture();
    state.messages = [];
    state.pinned = [];
    state.reactions = {};
    const { socket } = await boot({ state });
    socket().open();
    const next = fixture();
    next.messages = [message(1, "b1", "dashboard", "First one")];
    next.pinned = [];
    next.reactions = {};
    socket().push(next);
    await settle(1600);
    expect($("#announcer").textContent).toBe("New message from beta to You: First one");
    expect(msg(1).classList.contains("enter")).toBe(true);
  });

  test("new messages are announced once, without making the whole timeline a live region", async () => {
    const { socket } = await boot();
    socket().open();
    expect($("#timeline").getAttribute("aria-live")).toBe("off");
    const next = fixture();
    next.messages.push(message(7, "b1", "dashboard", "Build is green"));
    socket().push(next);
    await settle(1600);
    expect($("#announcer").textContent).toBe("New message from beta to You: Build is green");
  });

  test("search filters messages, counts matches, highlights them, and Escape clears it", async () => {
    await boot();
    const input = $("#search-input") as HTMLInputElement;
    await type(input, "suite");
    expect($$("article.msg").map((a) => Number(a.dataset.msgId))).toEqual([4]);
    expect($("#search-count").textContent).toBe("1 match");
    expect(msg(4).querySelector("mark")!.textContent).toBe("suite");
    keydown(input, "Escape");
    await settle();
    expect(input.value).toBe("");
    expect($$("article.msg")).toHaveLength(6);
  });

  test("translates a peer message to Arabic and back to the original", async () => {
    await boot();
    await click(msg(2).querySelector('[data-action="translate"]'));
    await settle(20);
    const body = msg(2).querySelector(".msg-body")!;
    expect(body.getAttribute("dir")).toBe("rtl");
    expect(body.getAttribute("lang")).toBe("ar");
    const toggle = msg(2).querySelector('[data-action="translate"]')!;
    expect(toggle.getAttribute("aria-label")).toBe("Translate to Arabic"); // one name; the state is aria-pressed
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await click(msg(2).querySelector('[data-action="show-original"]'));
    expect(msg(2).querySelector(".msg-body")!.hasAttribute("dir")).toBe(false);
    expect(msg(1).querySelector('[data-action="translate"]')).toBeNull(); // only peer messages are translatable
  });
});

// =============================================================================
// ACTIONS: exact request bodies the broker already accepts
// =============================================================================

describe("Actions", () => {
  test("completes a task", async () => {
    const { posts } = await boot({ storage: { "cp.section": "tasks" } });
    await click($('[data-action="complete-task"][data-id="t1"]'));
    expect(posts("/complete-task")).toEqual([{ task_id: "t1", peer_id: "dashboard", result: "" }]);
  });

  test("a succeeded action stays busy until the broker's next snapshot shows it", async () => {
    const { posts, socket } = await boot({ storage: { "cp.section": "tasks" } });
    socket().open();
    const check = () => $('[data-action="complete-task"][data-id="t1"]');
    await click(check());
    await settle(20);
    expect(check().getAttribute("aria-disabled")).toBe("true");
    await click(check()); // a second click before the snapshot arrives
    expect(posts("/complete-task")).toHaveLength(1);
    const next = fixture();
    next.tasks[0] = { ...next.tasks[0], status: "completed", completed_at: at(9) };
    socket().push(next);
    await settle();
    expect(check()).toBeNull(); // the snapshot shows it done, so the button is gone
  });

  test("focus stays on the same row when a list with repeated names re-renders", async () => {
    const state = fixture();
    state.tasks[1] = { ...state.tasks[1], assignee_id: "b1", status: "pending", completed_at: null }; // two open tasks for beta
    const { socket } = await boot({ state, storage: { "cp.section": "tasks" } });
    socket().open();
    const names = () => $$('#panel-body [data-action="select-peer"][data-id="b1"]');
    expect(names()).toHaveLength(2);
    names()[1]!.focus();
    const next = JSON.parse(JSON.stringify(state));
    next.tasks[0].description = "Patch the handler and add a test"; // any change that rebuilds the list
    socket().push(next);
    await settle();
    expect(document.activeElement).toBe(names()[1]!);
  });

  test("a busy control keeps keyboard focus while its message is re-rendered", async () => {
    await boot({ post: () => new Promise((ok) => setTimeout(() => ok({ json: { ok: true } }), 30)) });
    const pin = msg(4).querySelector('[data-action="pin"]') as HTMLButtonElement;
    pin.focus();
    await click(pin);
    const now = document.activeElement as HTMLElement;
    expect(now).not.toBe(pin); // the message was rebuilt to show the busy state…
    expect(now.closest("article")!.getAttribute("data-msg-id")).toBe("4"); // …and focus moved to its replacement
    expect(now.getAttribute("data-action")).toBe("pin");
    expect(now.getAttribute("aria-disabled")).toBe("true");
  });

  test("votes on an open proposal", async () => {
    const { posts } = await boot({ storage: { "cp.section": "proposals" } });
    await click($('[data-action="vote"][data-value="reject"]'));
    expect(posts("/vote-proposal")).toEqual([{ proposal_id: "p1", voter_id: "dashboard", vote: "reject", reason: "" }]);
  });

  test("pins from a message and unpins from the pinned strip", async () => {
    const { posts } = await boot();
    await click(msg(4).querySelector('[data-action="pin"]'));
    await click($('#pins [data-action="unpin"]'));
    expect(posts("/pin-message")).toEqual([{ message_id: 4, pinned: true }, { message_id: 2, pinned: false }]);
  });

  test("a reaction chip toggles the dashboard's own reaction", async () => {
    const { posts } = await boot();
    const chip = msg(2).querySelector(".reaction")!;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    await click(chip);
    expect(posts("/react")).toEqual([{ message_id: 2, peer_id: "dashboard", emoji: "\u{1F44D}", remove: true }]);
  });

  test("deleting a group asks for confirmation first", async () => {
    const { posts } = await boot({ storage: { "cp.section": "groups" } });
    await click($('[data-action="delete-group"][data-id="g1"]'));
    expect(posts("/delete-group")).toHaveLength(0);
    expect($(".confirm").textContent).toContain("Its 2 members move to the Lobby");
    await click($('[data-action="confirm-delete-group"]'));
    expect(posts("/delete-group")).toEqual([{ group_id: "g1" }]);
  });

  test("creating a group validates the name and shows the broker's error", async () => {
    const { posts } = await boot({ storage: { "cp.section": "groups" }, post: (path) => (path === "/create-group" ? { json: { ok: false, error: 'Group "ops" already exists' } } : { json: { ok: true } }) });
    const input = $("#group-name") as HTMLInputElement;
    const form = input.closest("form")!;
    input.value = "not valid!";
    form.requestSubmit();
    await settle();
    expect(posts("/create-group")).toHaveLength(0);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    input.value = "ops";
    form.requestSubmit();
    await settle(20);
    expect(posts("/create-group")).toEqual([{ name: "ops" }]);
    expect($("#group-name-msg").textContent).toBe('Group "ops" already exists');
  });

  test("moves a peer to another group only when Move is pressed", async () => {
    const { posts, socket } = await boot();
    socket().open(); // live updates: the next pushed snapshot, not a poll, ends the busy state
    await click($('.peer-btn[data-id="a1"]'));
    const move = () => $('[data-action="assign"][data-id="a1"]');
    expect(move().getAttribute("aria-disabled")).toBe("true"); // nothing to move yet
    const select = $("#ctx-group") as HTMLSelectElement;
    select.value = "g2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(20);
    expect(posts("/assign-group")).toHaveLength(0); // choosing only stages the move
    expect(($("#ctx-group") as HTMLSelectElement).value).toBe("g2");
    expect(move().hasAttribute("aria-disabled")).toBe(false);
    await click(move());
    await settle(20);
    await click(move()); // before the broker's snapshot arrives
    expect(posts("/assign-group")).toEqual([{ peer_id: "a1", group_id: "g2" }]);
    const moved = fixture();
    moved.peers[0].group_id = "g2";
    socket().push(moved);
    await settle();
    expect(($("#ctx-group") as HTMLSelectElement).value).toBe("g2");
    expect(move().getAttribute("aria-disabled")).toBe("true"); // nothing left to move
  });

  test("a failed action reports the broker's reason", async () => {
    await boot({ storage: { "cp.section": "tasks" }, post: () => ({ status: 403, json: { error: "This request must come from the peer's own process" } }) });
    await click($('[data-action="complete-task"][data-id="t1"]'));
    await settle(20);
    expect($(".toast[data-tone='bad']").textContent).toContain("Refused by the broker: This request must come from the peer's own process");
  });

  test("exports the conversation in the original text format", async () => {
    await boot();
    let blob: Blob | null = null;
    URL.createObjectURL = ((b: Blob) => { blob = b; return "blob:test"; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => { };
    document.addEventListener("click", (e) => { if ((e.target as Element).closest?.("a[download]")) e.preventDefault(); }, true);
    await click($("#export-btn"));
    // One "[time] from \u2192 to: text" entry per message; multi-line texts keep their newlines, as before.
    const text = await blob!.text();
    expect(text.split("\n")[0]).toMatch(/^\[.+\] Dashboard \u2192 alpha: Hello alpha$/);
    expect(text).toContain("] alpha \u2192 Dashboard: ## Status\n| Area | State |");
    expect(text).toContain("] Dashboard \u2192 ghost: Are you there?");
    expect(text).toContain("] CLI \u2192 alpha: Broker restarted");
  });

  test("inline markdown keeps identifiers intact and still finds links after them", async () => {
    const state = fixture();
    state.messages = [message(1, "a1", "dashboard", "Call respond_approval on my_peer_id, _really_ https://example.com/a_b, then **done**")];
    await boot({ state });
    const body = msg(1).querySelector(".msg-body")!;
    expect(body.textContent).toContain("respond_approval");
    expect([...body.querySelectorAll("em")].map((e) => e.textContent)).toEqual(["really"]);
    expect(body.querySelector("a")!.getAttribute("href")).toBe("https://example.com/a_b");
    expect(body.querySelector("strong")!.textContent).toBe("done");
  });
});

// =============================================================================
// CONNECTION
// =============================================================================

describe("Connection", () => {
  test("opens one WebSocket, applies pushed state, and reconnects after a drop", async () => {
    const { socket } = await boot();
    expect(FakeSocket.instances).toHaveLength(1);
    socket().open();
    await settle();
    expect($("#conn").dataset.state).toBe("live");
    const next = fixture();
    next.messages.push(message(7, "b1", "dashboard", "New from beta"));
    socket().push(next);
    await settle();
    expect(msg(7)).toBeTruthy();
    socket().drop();
    await settle();
    expect($("#conn").dataset.state).toBe("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1); // no duplicate socket while the old one is pending
    await settle(1100); // first backoff step
    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("goes offline when polling fails too, and keeps showing the last data", async () => {
    const { socket, env } = await boot();
    socket().open();
    socket().drop();
    env.stateFails = true;
    await click($("#conn-retry"));
    await settle(20);
    expect($("#conn").dataset.state).toBe("offline");
    expect($("#uptime").textContent).toBe("Broker unreachable");
    expect($$("article.msg")).toHaveLength(6);
    expect($("#composer-alert").textContent).toContain("broker is unreachable");
  });
});

// =============================================================================
// NAVIGATION AND KEYBOARD
// =============================================================================

describe("Navigation", () => {
  test("rail tabs switch sections, remember the choice, and collapse the panel", async () => {
    await boot();
    await click($("#tab-tasks"));
    expect($("#panel-title").textContent).toBe("Tasks");
    expect(localStorage.getItem("cp.section")).toBe("tasks");
    expect($("#tab-tasks").getAttribute("aria-selected")).toBe("true");
    await click($("#tab-tasks"));
    expect($("#cp-root").dataset.panel).toBe("closed");
    expect(localStorage.getItem("sidebar-state")).toBe("collapsed");
  });

  test("arrow keys move between rail tabs", async () => {
    await boot();
    const peers = $("#tab-peers");
    peers.focus();
    keydown(peers, "ArrowDown");
    await settle();
    expect($("#panel-title").textContent).toBe("Groups");
    expect(document.activeElement?.id).toBe("tab-groups");
  });

  test("Ctrl+K opens the command palette, which jumps to a peer", async () => {
    await boot();
    keydown(document, "k", { ctrlKey: true });
    await settle();
    expect(($("#palette") as HTMLDialogElement).open).toBe(true);
    const input = $("#palette-input") as HTMLInputElement;
    await type(input, "gamma");
    keydown(input, "Enter");
    await settle();
    expect(($("#palette") as HTMLDialogElement).open).toBe(false);
    expect($("#scope .scope-title").textContent).toBe("Messages with gamma");
  });

  test('"/" focuses the composer', async () => {
    await boot();
    keydown(document, "/");
    expect(document.activeElement?.id).toBe("composer-text");
  });

  test("the theme toggle switches and remembers the theme", async () => {
    await boot();
    await click($("#theme-btn"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
    expect($("#theme-btn").getAttribute("aria-label")).toBe("Switch to dark theme");
  });
});
