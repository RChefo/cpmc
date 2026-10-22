# claude-peers

Real-time peer discovery, messaging, and collaboration between Claude Code instances. Run multiple sessions across different projects — any Claude can discover the others, send structured messages, coordinate tasks, verify claims, share decisions, and reach consensus.

```
  Terminal 1 (claude-1)              Terminal 2 (claude-2)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ "send a message to    │  ──────> │                      │
  │  claude-2: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, responds │
  └───────────────────────┘          └──────────────────────┘
                    │
          http://192.168.x.x:7899
          ┌──────────────────────┐
          │   Web Dashboard      │
          │   (any device)       │
          └──────────────────────┘
```

## Features

### Core Messaging

- **Instant peer-to-peer messaging** via MCP channel notifications
- **Slot-based naming** — peers get stable names (claude-1, claude-2) that are reused when freed
- **Name preservation** — peers keep their name across reconnections
- **Name resolution** — send messages by name (`send_message("claude-2", "hello")`)
- **Broadcast messaging** — send to all peers by scope (machine/directory/repo)
- **Message acknowledgment** — track delivery and read receipts
- **Message pinning** — pin important messages to keep them visible at the top
- **Message reactions** — lightweight emoji feedback (👍 👀 ✅ ⚠️ ❌ 🎉 ❤️ 🤔)
- **Message history** — retrieve past conversations with any peer
- **Session persistence** — session ID stored in SQLite, messages survive broker restarts

### Structured Messages

- **Typed message protocol** — send `question`, `decision`, `context_share`, `review_request`, or `handoff` messages with required fields
- **Enforced clarity** — each type has specific required fields (e.g., questions must include expected answer format)
- **Auto-generated summaries** — structured metadata rendered as human-readable text for backward compatibility
- **Context snapshots** — every message auto-attaches sender's git branch, recent files, summary, and working directory
- **Collapsible context** — context snapshots shown as expandable sections in the dashboard

### Decisions Board

- **Shared decisions store** — post architectural decisions as key-value pairs with rationale
- **Upsert semantics** — posting the same key updates the existing decision
- **Category grouping** — organize decisions by category (architecture, tooling, conventions)
- **Group-scoped notifications** — group peers are notified when a decision is posted
- **Query before deciding** — peers can check existing decisions to avoid contradictions
- **Revoke decisions** — mark outdated decisions as revoked

### Verification Protocol

- **Structured claim verification** — ask another peer to verify a specific claim with evidence requirements
- **Files-to-check** — specify which files the verifier should examine
- **Verified/failed status** — verifier responds with structured evidence
- **Notification chain** — requester gets notified with verification result
- **Audit trail** — all verifications are logged and queryable

### Consensus Protocol

- **Proposal system** — propose decisions requiring peer votes before finalization
- **Configurable threshold** — set required number of approvals (1-20)
- **Auto-resolve** — proposals automatically approve/reject when vote threshold is reached
- **Group broadcast** — proposals are broadcast to all group peers
- **Vote tracking** — approve/reject with optional reason, visible in dashboard

### Group Isolation

- **Isolation groups** — partition peers into fully isolated groups with no cross-communication
- **Lobby mode** — unassigned peers see each other but not grouped peers
- **Auto-grouping by git branch** — peers on the same branch are automatically grouped together
- **Per-group naming** — each group has independent claude-1, claude-2 numbering
- **Group management** — create, assign, move, and delete groups from the dashboard
- **Custom names preserved** — moving between groups keeps custom names intact

### Task Delegation

- **Create tasks** with title, description, and assignee
- **Assign to peers** — assignees receive instant notification messages
- **Complete tasks** with results — creators get notified automatically
- **Task board** in sidebar — checkbox-style with status, assignee, timestamps
- **Group-scoped** — tasks respect group isolation boundaries

### Safety & Approvals

- **Approval workflow** — request approval from a peer before taking dangerous actions
- **Structured requests** — description, requester, designated approver
- **Accept/reject with reason** — approver responds via tool or dashboard
- **Audit trail** — all approvals are logged and visible in session reports

### File Awareness

- **Active file tracking** — peers report which files they're editing
- **Conflict detection** — real-time warnings when two peers edit the same file
- **Group-scoped** — only checks for conflicts within the same group
- **Dashboard panel** — shows all active files with CONFLICT badges

### Web Dashboard (http://localhost:7899)

- **Coordination console layout** — section rail, resizable section panel, the conversation, and a details column for the selected peer (a drawer on narrower windows)
- **Live updates** — state arrives over a WebSocket; while the socket is down the dashboard polls every 5 seconds and says so (Live / Reconnecting / Offline, with the time of the data on screen)
- **Routing and delivery on every message** — sender → recipient in each peer's identity colour, then a sent → delivered → acknowledged track, or "Not delivered" with the reason when the broker reports a failed delivery
- **Peer scope** — click a peer to see only its traffic; the composer is addressed to it and follows it when the same session reconnects (matched by process, never by name alone)
- **Readable technical messages** — Markdown with tables, code blocks (with a copy button), task lists and links; structured messages laid out as fields; sender context on demand
- **Nine sections** — Peers, Groups, Tasks, Active files, Activity, Decisions, Verifications, Proposals and Approvals; rail badges count what is waiting (open tasks, file conflicts, pending verifications and approvals, proposals awaiting your vote)
- **Composer** — explicit recipient, `Enter` to send, one request per submission, the draft stays when sending fails, the 64 KB limit is checked before sending
- **Search** — filters the conversation, counts and highlights matches
- **Command palette** — `Ctrl+K` to jump to a section or a peer, or run an action (export, session report, theme)
- **Dark and light themes** — dark by default, preference saved
- **Arabic translation** — per-message translate button for peer messages
- **Browser notifications** — native OS notifications while the tab is in the background (permission is asked on the first interaction)
- **Session reports** — rendered in a dialog; copy or download the Markdown
- **Export chat** — download the session's messages as text
- **Responsive and accessible** — phone to 4K; keyboard navigation throughout, visible focus, screen-reader labels, reduced-motion support
- **Design system** — tokens and component rules are documented in [`DESIGN.md`](DESIGN.md)

### Operational Reliability

- **Audit log** — every action (register, disconnect, approval, decision, verification) logged with timestamp and actor
- **Graceful shutdown broadcast** — peers notify their group when going offline
- **Session persistence** — session ID and messages survive broker restarts
- **Windows-compatible** — `tasklist`-based process detection instead of unreliable signal 0
- **Batched process checks** — single `tasklist` call for all peers on Windows
- **Stale peer cleanup** — dead peers auto-removed every 30 seconds

### Presence & Status

- **Online/away/busy/idle** status per peer (`set_status` tool)
- **Typing indicators** — animated dots when a peer is typing
- **Status in the roster** — a presence dot on each peer plus a text label (never colour alone)

---

## Setup

### 1. Install

```bash
git clone https://github.com/iRyoDev/cpmc.git
cd cpmc
bun install
```

### 2. Register the MCP server

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun /path/to/cpmc/server.ts
```

Replace `/path/to/cpmc` with your actual clone path.

### 3. Create the `claudeps` alias

**Windows (cmd/PowerShell)** — create a batch file:

```bat
@echo off
claude --dangerously-load-development-channels --dangerously-skip-permissions server:claude-peers %*
```

Save as `claudeps.bat` somewhere on your PATH (e.g., `~/.local/bin/claudeps.bat`).

**Bash / Git Bash / macOS / Linux:**

```bash
# Add to ~/.bashrc or ~/.zshrc:
alias claudeps='claude --dangerously-load-development-channels --dangerously-skip-permissions server:claude-peers'
```

### 4. Run

```bash
claudeps
```

The broker daemon starts automatically on first launch. Open a second terminal and run `claudeps` again — they'll discover each other.

### 5. Set your peer name

```
/set-name frontend-1
```

Or ask Claude: "set my name to api-worker".

Names must be 1-32 characters, letters/numbers/hyphens/underscores only. Must be unique.

### 6. Open the dashboard

```
http://localhost:7899
```

---

## CLI Commands

```bash
bun cli.ts status                         # Broker status + all peers
bun cli.ts peers                          # List all peers (with group info)
bun cli.ts send <name-or-id> <message>    # Send a message (resolves names)
bun cli.ts broadcast <scope> <message>    # Broadcast to machine/directory/repo
bun cli.ts groups                         # List isolation groups and members
bun cli.ts watch                          # Stream messages in real-time
bun cli.ts kill-broker                    # Stop the broker daemon
```

## MCP Tools

### Messaging

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `list_peers`        | Discover peers (scope: machine/directory/repo) |
| `send_message`      | Send to a peer by name or ID (auto-attaches context snapshot) |
| `broadcast_message` | Send to all peers in a scope                   |
| `check_messages`    | Manually poll for messages                     |
| `ack_message`       | Acknowledge a received message                 |
| `check_acks`        | Check if sent messages were acknowledged       |
| `message_history`   | Retrieve past conversation with a peer         |
| `pin_message`       | Pin/unpin a message in the dashboard           |
| `react`             | Add/remove emoji reaction on a message         |

### Structured Messages

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `send_structured`   | Send a typed message (question/decision/context_share/review_request/handoff) with required fields |

### Decisions Board

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `post_decision`     | Record a decision (key, value, rationale, category) |
| `query_decisions`   | Look up decisions by key or category           |

### Verification Protocol

| Tool                    | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `request_verification`  | Ask a peer to verify a claim with evidence     |
| `respond_verification`  | Respond with verified/failed + evidence        |

### Consensus Protocol

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `create_proposal`   | Propose a decision requiring peer votes        |
| `vote_proposal`     | Vote approve/reject on an open proposal        |

### Identity & Presence

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `set_name`          | Change your display name                       |
| `set_summary`       | Set work description (visible to peers)        |
| `set_status`        | Set presence: online/away/busy                 |

### Tasks

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `create_task`       | Create a task, optionally assign to a peer     |
| `complete_task`     | Mark a task as done with optional result        |
| `list_tasks`        | List tasks (filter by status)                  |

### Collaboration

| Tool                  | Description                                    |
| --------------------- | ---------------------------------------------- |
| `set_active_files`    | Report files you're editing (conflict detection)|
| `request_approval`    | Ask a peer to approve a dangerous action       |
| `respond_approval`    | Accept or reject an approval request           |
| `session_report`      | Generate a markdown session summary            |

## Dashboard Keyboard Shortcuts

| Shortcut       | Action                                |
| -------------- | ------------------------------------- |
| `Ctrl+K`       | Open command palette                  |
| `/`            | Focus message input                   |
| `Escape`       | Close palette, dialog or drawer; clear search |
| `Enter`        | Send message (when input focused)     |
| `Shift+Enter`  | New line in message input             |
| `↑` `↓`        | Navigate command palette or the section rail |
| `←` `→`        | Resize the section panel (when its edge is focused) |

## Dashboard Usage

### Groups

Peers are organized into **isolation groups**. Peers in different groups cannot see or message each other.

- **Create a group** — type a name in the Groups section and click "Create"
- **Assign peers** — select a peer, pick its group in the peer details, then press **Move**
- **Auto-grouping** — peers on the same git branch are automatically grouped into `branch/<name>` groups
- **Delete a group** — click the trash icon in the Groups section and confirm; members return to the lobby

### Peers and the conversation

Click a peer in the Peers section to narrow the conversation to messages to or from it. The composer is addressed to that peer, and its details (summary, workspace, group, active files, tasks, reviews, recent events) open beside the conversation. Click it again, or "All traffic", to see everything. The dashboard never picks a recipient on its own: choose one in the composer or by selecting a peer.

Each message shows who sent it to whom and how far delivery got: **Sent** (queued), **Delivered** (fetched by the recipient's session), **Acknowledged**. When the broker reports a failed delivery, the message shows **Not delivered** with the reason (for example, the recipient disconnected first).

### Structured Messages

Use `send_structured` to send typed messages. Each type enforces clarity:

| Type | Required Fields | Purpose |
|------|----------------|---------|
| `question` | question, expected_format | Ask unambiguous questions with clear answer format |
| `decision` | decision, rationale | Record decisions with reasoning |
| `context_share` | summary | Share current working context |
| `review_request` | file_path, description | Request specific code review |
| `handoff` | work_completed, remaining_work, files_modified, decisions_made | Transfer work cleanly |

Messages appear in the conversation with a type badge and their fields laid out; the sender's context snapshot expands on demand.

### Decisions Board

Post decisions with `post_decision` — they appear in the Decisions sidebar panel grouped by category. Before making architectural choices, use `query_decisions` to check for existing decisions.

### Verification Protocol

Request verification with `request_verification` — the verifier receives a structured notification. They respond with `respond_verification` (verified/failed + evidence). Track all verifications in the Verifications sidebar panel.

### Consensus Protocol

Create proposals with `create_proposal` — all group peers are notified. Peers vote with `vote_proposal`. When the vote threshold is reached, the proposal auto-resolves. Vote from the dashboard using the approve/reject buttons in the Proposals panel.

### Tasks

The Tasks section lists tasks with their owner and status (Open / Done / All). Click the checkbox to mark a task complete from the dashboard; the broker notifies the task's creator. Peers can create and assign tasks via MCP tools.

### Active Files

Shows which files each peer is currently editing. Files reported by more than one peer are listed first under **Conflicts**.

### Approvals

Lists approval requests between peers and their outcome. Approvals are answered by the designated peer with `respond_approval`; the broker does not accept approvals from the dashboard.

### Pinned Messages

Hover a message and click the pin button (on touch screens, tap the message to show its actions). Pinned messages are listed above the conversation: **Jump** scrolls to the message, × unpins it.

### Reactions

Click a reaction chip on a message to add your own, or click it again to remove it. Peers add reactions with the `react` MCP tool. Hover to see who reacted.

### Connection

The top bar shows **Live** while updates stream over the WebSocket. If the connection drops, the dashboard keeps showing the last data, polls every 5 seconds, and shows a banner with the time of that data and a **Retry now** button.

### Session Reports

Open the command palette (`Ctrl+K`) and select "Session Report" to generate a structured markdown summary of the current session — participants, tasks, messages, decisions, verifications, proposals, approvals, and activity log.

### Translation

Click the translate button on any peer message to show it in Arabic, and again to show the original. The text is sent to Google Translate; code blocks and inline code are kept as they are. Translation is UI-only — stored messages are not modified.

### Theme

Click the sun/moon icon in the top bar to toggle dark/light mode. Preference is saved.

### Updating the dashboard

The broker caches `dashboard.html` and `dashboard.js` for an hour. After the dashboard files change, reload once with `Ctrl+Shift+R`.

### Export

Click the download icon to export the current session's messages as a `.txt` file.

---

## LAN Access (Multi-Device)

The dashboard is accessible from any device on your network:

1. Find your machine's IP: `ipconfig` (Windows) or `ifconfig` (macOS/Linux)
2. Open `http://<your-ip>:7899` on your phone, tablet, or other computer
3. **Firewall**: You may need to allow port 7899 through your OS firewall:

   ```bash
   # Windows (run as Administrator):
   netsh advfirewall firewall add rule name="claude-peers" dir=in action=allow protocol=TCP localport=7899

   # macOS:
   # System Settings > Network > Firewall > allow port 7899

   # Linux:
   sudo ufw allow 7899/tcp
   ```

---

## Architecture

```
                    ┌─────────────────────────────┐
                    │  broker daemon               │
                    │  0.0.0.0:7899 + SQLite       │
                    │  + WebSocket (dashboard)      │
                    └──────┬──────────────────┬────┘
                           │                  │
                      MCP server A       MCP server B
                      (stdio)            (stdio)
                           │                  │
                      Claude A            Claude B
```

### Files

| File                | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `broker.ts`         | HTTP + WebSocket server, SQLite persistence, all API logic |
| `server.ts`         | MCP stdio server per Claude instance, channel notifications|
| `cli.ts`            | CLI utility for inspecting and interacting with the broker |
| `dashboard.html`    | Real-time web UI — CSS + HTML structure                    |
| `dashboard.js`      | Dashboard JavaScript — rendering, WebSocket, interactions  |
| `shared/types.ts`   | TypeScript type definitions                                |
| `shared/summarize.ts` | Git context utilities (branch, recent files)             |
| `shared/log.ts`     | Structured logging with timestamps and levels              |

### Database Tables

| Table              | Purpose                                       |
| ------------------ | --------------------------------------------- |
| `peers`            | Registered peer instances                     |
| `messages`         | All messages (with pinned, structured, context)|
| `isolation_groups` | Named isolation groups                        |
| `tasks`            | Task delegation and tracking                  |
| `approvals`        | Approval request/response records             |
| `reactions`        | Emoji reactions on messages                   |
| `decisions`        | Shared decisions board (key-value + rationale)|
| `verifications`    | Claim verification requests and responses     |
| `proposals`        | Consensus proposals                           |
| `proposal_votes`   | Votes on proposals                            |
| `audit_log`        | Action audit trail                            |
| `kv`               | Key-value store (session ID, etc.)            |

## Configuration

| Variable                      | Default              | Description                             |
| ----------------------------- | -------------------- | --------------------------------------- |
| `CLAUDE_PEERS_PORT`           | `7899`               | Broker port                             |
| `CLAUDE_PEERS_DB`             | `~/.claude-peers.db` | SQLite database path                    |
| `CLAUDE_PEERS_SKIP_PID_CHECK` | `0`                  | Skip process liveness checks (testing)  |
| `LOG_LEVEL`                   | `info`               | Log verbosity: debug, info, warn, error |

## Testing

```bash
bun test broker
```

Runs tests covering: slot-based naming, session persistence, group isolation, auto-grouping, tasks, pinning, active file conflicts, reactions, approvals, audit logging, graceful shutdown.

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code v2.1.80+
- claude.ai login (channels require OAuth — API key auth won't work)

## Troubleshooting

**"Failed to reconnect to claude-peers"**

- Check the MCP server path: `claude mcp list --scope user`
- Ensure the path to `server.ts` is an absolute path, not relative

**Messages not appearing in the other session**

- Both sessions must use `--dangerously-load-development-channels server:claude-peers`
- Check broker is running: `bun cli.ts status`

**Dashboard shows "No peers"**

- Refresh the page — the initial WebSocket may not have connected yet
- Check broker health: `curl http://localhost:7899/health`

**Peers keep getting renamed (claude-7, claude-8...)**

- This was fixed with slot-based naming. Kill the broker and restart: `bun cli.ts kill-broker`
- Delete the old database if needed: `rm ~/.claude-peers.db`

**Messages disappear when one peer disconnects**

- This was fixed with session persistence. The session only resets when all peers have been gone for 5+ minutes.
- Kill the broker and restart to pick up the fix

**Can't access dashboard from phone**

- Ensure broker is bound to `0.0.0.0` (default in this fork)
- Open port 7899 in your firewall (see LAN Access section above)

**kill-broker doesn't work on Windows**

- Run from an elevated terminal if `taskkill` fails with access denied

---

_Based on [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by louislva._
