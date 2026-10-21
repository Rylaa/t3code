# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. When you return to a large thread
after Claude's prompt cache expires, a **Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Full** and keep the full
history for that message. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

## Ultracode and workflows

Ultracode has Claude plan each task as a multi-agent workflow. Turn it on with
**Ultracode** in the composer's reasoning menu (thread settings on mobile); it
works at any reasoning level. Models without the toggle do not support it, and Claude Code
must have workflows enabled (see `/config` in Claude Code).

Workflows Claude starts, with or without Ultracode, appear under **Workflows** in
the thread details panel and in the mobile **Agents** sheet. Each run shows its
phases and agents, **View script** opens the script Claude wrote for it, and
**Stop** ends that workflow while the rest of the turn keeps going.

On web and desktop, **Open in panel** on a run, **Workflows** in the right panel's **+**
menu, or **Show workflows** in the command palette opens the **Workflows** panel. It lists
every agent with what it is doing now, its result or error, and its model, tokens, and tool
calls.

## Claude in Chrome

**Claude in Chrome** in the composer's reasoning menu (thread settings on mobile) lets Claude
drive your own Chrome, with the sites you are signed in to. It needs the Claude in Chrome
extension installed in Chrome on the environment's machine.

The switch is off by default, and only you can turn it on, in the thread itself: agents cannot,
and default models and scheduled tasks never carry it. It stays on when you switch the thread to
another Claude model that offers it. New threads, forks, and threads that Claude or a scheduled
task starts begin with it off; a scheduled task that wakes the thread itself uses the switch
from your last message in that thread.

Changing the switch restarts the thread's Claude session at your next message. While Claude still
runs background agents or commands, that message is refused until they finish or you press
**Stop**.

`--chrome` in the instance's **Launch arguments** (**Settings > Providers**) turns it on for every
Claude thread and model, whatever the switch says. T3 Code's built-in browser works either way.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins also
contribute skills under names such as `plugin:review`. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## MCP servers

Send `/mcp` to see the thread's MCP servers. While the Claude session runs, each
server's status is live, with its tools and any error; otherwise it is as of when
the session started. **Refresh** reads it again. Servers are grouped by status,
those that need attention first, and T3 Code's own server leads its group as
**T3 Code**.

To retry a server, open it and choose **Reconnect**. Reconnect is unavailable
while the agent is working on a turn.

A server that needs you to sign in shows **Sign in**. Choose it, then **Open
sign-in page**, and approve in your browser; the server connects on its own.
When your browser is not on the computer that runs T3 Code, such as on your phone
or with a remote environment, the page you land on after approving shows a
connection error. Copy that page's address from the browser's address bar,
paste it into the field under **Sign in**, and choose **Finish sign-in**. A
sign-in you leave unfinished expires after five minutes. For a claude.ai
connector, choose **Authorize on claude.ai**, authorize it there, then choose
**Check connection**.

The sign-in is Claude Code's own, so Claude Code in a terminal on the computer
that runs T3 Code uses it too. **Sign out** on a connected server removes it for
every Claude Code session on that computer; choose **Sign in** again to
reconnect, or to sign in with another account. Sign out is unavailable while the
agent is working on a turn. If **Sign in** is not offered, run the command the
server shows on the computer that runs T3 Code, then reconnect. T3 Code does not
turn servers off or on, because Claude saves that choice for your terminal
sessions too; use `/mcp` in Claude Code for that.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Unfinished tasks stay visible
between turns in the same Claude session.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
