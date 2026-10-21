<div align="center">
 <img src="public/logo.svg" alt="CloudCLI UI" width="64" height="64">
 <h1>Cloud CLI (aka Claude Code UI)</h1>
 <p>A desktop and mobile UI for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a>, and <a href="https://developers.openai.com/codex">Codex</a>.<br>Use it locally or remotely to view your active projects and sessions from everywhere.</p>
</div>

<p align="center">
 <a href="https://cloudcli.ai">CloudCLI Cloud</a> · <a href="https://cloudcli.ai/docs">Documentation</a> · <a href="https://discord.gg/buxwujPNRE">Discord</a> · <a href="https://github.com/siteboon/claudecodeui/issues">Bug Reports</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
 <a href="https://cloudcli.ai"><img src="https://img.shields.io/badge/☁️_CloudCLI_Cloud-Try_Now-0066FF?style=for-the-badge" alt="CloudCLI Cloud"></a>
 <a href="https://discord.gg/buxwujPNRE"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord"></a>
 <br><br>
 <a href="https://trendshift.io/repositories/15586" target="_blank"><img src="https://trendshift.io/api/badge/repositories/15586" alt="siteboon%2Fclaudecodeui | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>

<div align="right"><i><b>English</b> · <a href="./docs/README.ru.md">Русский</a> · <a href="./docs/README.de.md">Deutsch</a> · <a href="./docs/README.ko.md">한국어</a> · <a href="./docs/README.zh-CN.md">简体中文</a> · <a href="./docs/README.zh-TW.md">繁體中文</a> · <a href="./docs/README.ja.md">日本語</a> · <a href="./docs/README.tr.md">Türkçe</a> · <a href="./docs/README.id.md">Bahasa Indonesia</a></i></div>

---

## Screenshots

<div align="center">

<table>
<tr>
<td align="center">
<h3>Desktop View</h3>
<img src="public/screenshots/desktop-main.png" alt="Desktop Interface" width="400">
<br>
<em>Main interface showing project overview and chat</em>
</td>
<td align="center">
<h3>Mobile Experience</h3>
<img src="public/screenshots/mobile-chat.png" alt="Mobile Interface" width="250">
<br>
<em>Responsive mobile design with touch navigation</em>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<h3>CLI Selection</h3>
<img src="public/screenshots/cli-selection.png" alt="CLI Selection" width="400">
<br>
<em>Select between Claude Code, Cursor CLI and Codex</em>
</td>
</tr>
</table>



</div>

## Features

- **Responsive Design** - Works seamlessly across desktop, tablet, and mobile so you can also use Agents from mobile 
- **Interactive Chat Interface** - Built-in chat interface for seamless communication with the Agents
- **Integrated Shell Terminal** - Direct access to the Agents CLI through built-in shell functionality
- **File Explorer** - Interactive file tree with syntax highlighting and live editing
- **Git Explorer** - View, stage and commit your changes. You can also switch branches 
- **Browser Use** - Open browser sessions for web research, testing, and agent-driven browser tasks
- **Session Management** - Resume conversations, manage multiple sessions, and track history
- **Plugin System** - Extend CloudCLI with custom plugins — add new tabs, backend services, and integrations. [Build your own →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)
- **TaskMaster AI Integration** *(Optional)* - Advanced project management with AI-powered task planning, PRD parsing, and workflow automation
- **Model Compatibility** - Works with Claude and GPT model families (the full list of supported models is available at runtime via `GET /api/providers/:provider/models`)


## Quick Start

### CloudCLI Cloud (Recommended)

The fastest way to get started — no local setup required. Get a fully managed, containerized development environment accessible from the web, mobile app, API, or your favorite IDE.

**[Get started with CloudCLI Cloud](https://cloudcli.ai)**

### Self-Hosted (Open source)

#### npm

Try CloudCLI UI instantly with **npx** (requires **Node.js** v22+):

```
npx @cloudcli-ai/cloudcli
```

Or install **globally** for regular use:

```
npm install -g @cloudcli-ai/cloudcli
cloudcli
```

Open `http://localhost:3001` — all your existing sessions are discovered automatically.

Visit the **[documentation →](https://cloudcli.ai/docs)** for full configuration options, PM2, remote server setup and more.

#### Docker Sandboxes (Experimental)

Run agents in isolated sandboxes with hypervisor-level isolation. Starts Claude Code by default. Requires the [`sbx` CLI](https://docs.docker.com/ai/sandboxes/get-started/).

```
npx @cloudcli-ai/cloudcli@latest sandbox ~/my-project
```

Supports Claude Code and Codex. See the [sandbox docs](docker/) for setup and advanced options.

### Desktop Companion App

CloudCLI Desktop is an optional native companion for CloudCLI Cloud and Local CloudCLI. It ships from this repository's GitHub Releases and keeps CloudCLI available from your menu bar or tray.

- **[macOS](https://cloudcli.ai/download/macos)**
- **[Windows](https://cloudcli.ai/download/windows)**
- **[Download page](https://cloudcli.ai/download)** · **[GitHub Releases and checksums](https://github.com/siteboon/claudecodeui/releases)**

Use it to open CloudCLI Cloud environments, switch between local and remote workspaces, and copy mobile/browser URLs. To work locally, choose **Local CloudCLI** in the desktop app; it will use your running local server or start one for you.


---

## Which option is right for you?

CloudCLI UI is the open source UI layer that powers CloudCLI Cloud. You can self-host it on your own machine, run it in a Docker sandbox for isolation, or use CloudCLI Cloud for a fully managed environment.

| | Self-Hosted (npm) | Self-Hosted (Docker Sandbox) *(Experimental)* | CloudCLI Cloud |
|---|---|---|---|
| **Best for** | Local agent sessions on your own machine | Isolated agents with web/mobile IDE | Teams who want agents in the cloud |
| **How you access it** | Browser via `[yourip]:port` | Browser via `localhost:port` | Browser, any IDE, REST API, n8n |
| **Setup** | `npx @cloudcli-ai/cloudcli` | `npx @cloudcli-ai/cloudcli@latest sandbox ~/project` | No setup required |
| **Isolation** | Runs on your host | Hypervisor-level sandbox (microVM) | Full cloud isolation |
| **Machine needs to stay on** | Yes | Yes | No |
| **Mobile access** | Any browser on your network | Any browser on your network | Any device |
| **Desktop companion** | Optional. Choose Local CloudCLI | Optional. Choose Local CloudCLI | Optional. Opens cloud environments |
| **Agents supported** | Claude Code, Cursor CLI, Codex | Claude Code, Codex | Claude Code, Cursor CLI, Codex |
| **File explorer and Git** | Yes | Yes | Yes |
| **MCP configuration** | Synced with `~/.claude` | Managed via UI | Managed via UI |
| **REST API** | Yes | Yes | Yes |
| **Team sharing** | No | No | Yes |
| **Platform cost** | Free, open source | Free, open source | Starts at €7/month |

> All options use your own AI subscriptions (Claude, Cursor, etc.) — CloudCLI provides the environment, not the AI.

---

## Security & Tools Configuration

**🔒 Important Notice**: All Claude Code tools are **disabled by default**. This prevents potentially harmful operations from running automatically.

### Enabling Tools

To use Claude Code's full functionality, you'll need to manually enable tools:

1. **Open Tools Settings** - Click the gear icon in the sidebar
2. **Enable Selectively** - Turn on only the tools you need
3. **Apply Settings** - Your preferences are saved locally

<div align="center">

![Tools Settings Modal](public/screenshots/tools-modal.png)
*Tools Settings interface - enable only what you need*

</div>

**Recommended approach**: Start with basic tools enabled and add more as needed. You can always adjust these settings later.

---

## Plugins

CloudCLI has a plugin system that lets you add custom tabs with their own frontend UI and optional Node.js backend. Install plugins from git repos directly in **Settings > Plugins**, or build your own.

### Available Plugins

| Plugin | Description |
|---|---|
| **[Project Stats](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** | Shows file counts, lines of code, file-type breakdown, largest files, and recently modified files for your current project |
| **[Web Terminal](https://github.com/cloudcli-ai/cloudcli-plugin-terminal)** | Full xterm.js terminal with multi-tab support |
| **[CloudCLI Scheduler](https://github.com/grostim/cloudcli-cron)** | Create workspace-scoped scheduled prompts and execute them through a local CLI such as Codex or Claude Code |
| **[PRISM CloudCLI](https://github.com/jakeefr/cloudcli-plugin-prism)** | Session intelligence for Claude Code inside CloudCLI, including token burn visibility |
| **[Sessions](https://github.com/strykereye2/cloudcli-plugin-session-manager)** | View, manage, and kill active Claude Code sessions |
| **[Token Cost Calculator](https://github.com/NightmareAway/cloudcli-plugin-token-cost-calculator)** | Calculate API costs from model prices and token usage, with preset model pricing support |
| **[Task Queue](https://github.com/TadMSTR/cloudcli-plugin-task-queue)** | Task queue dashboard to view, filter, and launch agent tasks |
| **[GitHub Issues Board](https://github.com/szmidtpiotr/claude-github-issue)** | Kanban board for GitHub Issues with bidirectional TaskMaster sync and /github-task CLI skill auto-install |

### Build Your Own

**[Plugin Starter Template →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** — fork this repo to create your own plugin. It includes a working example with frontend rendering, live context updates, and RPC communication to a backend server.

**[Plugin Documentation →](https://cloudcli.ai/docs/plugin-overview)** — full guide to the plugin API, manifest format, security model, and more.

### Private Repositories

The server installs and updates plugins with `git clone` and `git pull`, using the git credentials of the operating-system user it runs as (for a systemd service, the unit's `User=`). The server cannot answer a password or passphrase prompt during an install, so set up credentials for that user before installing from a private repository:

- **`https://` URLs:** configure a git credential helper, for example `gh auth login` followed by `gh auth setup-git`, or a token in `~/.git-credentials` with `git config --global credential.helper store`.
- **`git@` URLs:** give that user an SSH key the git host accepts and that works without a prompt: either it has no passphrase, or it is loaded into an `ssh-agent` whose `SSH_AUTH_SOCK` the server process inherits. Also add the host to that user's `~/.ssh/known_hosts`, for example by running `ssh -T git@github.com` once as that user.

Without credentials, an `https://` install fails with a message saying that the repository is private or does not exist. Most git hosts, GitHub included, answer the same way for both. If the host rejects the credentials (wrong, expired or revoked), or ssh cannot log in for a `git@` URL, the message says so.

---
## FAQ

<details>
<summary>How is this different from Claude Code Remote Control?</summary>

Claude Code Remote Control lets you send messages to a session already running in your local terminal. Your machine has to stay on, your terminal has to stay open, and sessions time out after roughly 10 minutes without a network connection.

CloudCLI UI and CloudCLI Cloud extend Claude Code rather than sit alongside it — your MCP servers, permissions, settings, and sessions are the exact same ones Claude Code uses natively. Nothing is duplicated or managed separately.

Here's what that means in practice:

- **All your sessions, not just one** — CloudCLI UI auto-discovers every session from your `~/.claude` folder. Remote Control only exposes the single active session to make it available in the Claude mobile app.
- **Your settings are your settings** — MCP servers, tool permissions, and project config you change in CloudCLI UI are written directly to your Claude Code config and take effect immediately, and vice versa.
- **Works with more agents** — Claude Code, Cursor CLI and Codex, not just Claude Code.
- **Full UI, not just a chat window** — file explorer, Git integration, MCP management, and a shell terminal are all built in.
- **CloudCLI Cloud runs in the cloud** — close your laptop, the agent keeps running. No terminal to babysit, no machine to keep awake.

</details>

<details>
<summary>Do I need to pay for an AI subscription separately?</summary>

Yes. CloudCLI provides the environment, not the AI. You bring your own Claude, Cursor, or Codex subscription. CloudCLI Cloud starts at €7/month for the hosted environment on top of that.

</details>

<details>
<summary>Can I use CloudCLI UI on my phone?</summary>

Yes. For self-hosted, run the server on your machine and open `[yourip]:port` in any browser on your network. For CloudCLI Cloud, open it from any device — no VPN, no port forwarding, no setup. A native app is also in the works.

</details>

<details>
<summary>Will changes I make in the UI affect my local Claude Code setup?</summary>

Yes, for self-hosted. CloudCLI UI reads from and writes to the same `~/.claude` config that Claude Code uses natively. MCP servers you add via the UI show up in Claude Code immediately and vice versa.

</details>

---

## Community & Support

- **[Documentation](https://cloudcli.ai/docs)** — installation, configuration, features, and troubleshooting
- **[Discord](https://discord.gg/buxwujPNRE)** — get help and connect with other users
- **[GitHub Issues](https://github.com/siteboon/claudecodeui/issues)** — bug reports and feature requests
- **[Contributing Guide](CONTRIBUTING.md)** — how to contribute to the project

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE) for the full text, including additional terms under Section 7.

This project is open source and free to use, modify, and distribute under the AGPL-3.0-or-later license. If you modify this software and run it as a network service, you must make your modified source code available to users of that service.

CloudCLI UI - (https://cloudcli.ai).

## Acknowledgments

### Built With
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** - Anthropic's official CLI
- **[Cursor CLI](https://docs.cursor.com/en/cli/overview)** - Cursor's official CLI
- **[Codex](https://developers.openai.com/codex)** - OpenAI Codex
- **[React](https://react.dev/)** - User interface library
- **[Vite](https://vitejs.dev/)** - Fast build tool and dev server
- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS framework
- **[CodeMirror](https://codemirror.net/)** - Advanced code editor
- **[TaskMaster AI](https://github.com/eyaltoledano/claude-task-master)** *(Optional)* - AI-powered project management and task planning


### Sponsors
- [Siteboon - AI powered website builder](https://siteboon.ai)
---

<div align="center">
 <strong>Made with care for the Claude Code, Cursor and Codex community.</strong>
</div>


### Hide providers from new-chat model selection

Set `CLOUDCLI_HIDDEN_PROVIDERS` in the backend environment or `.env`, then restart the backend and reload the browser:

```bash
export CLOUDCLI_HIDDEN_PROVIDERS="cursor,opencode"
```

Supported IDs are `claude`, `codex`, `gptweb`, `cursor`, `opencode`, and `dsh`. Commas or whitespace separate entries; IDs are case-insensitive and unknown entries are ignored. An unset or empty value shows every provider.

Hidden providers disappear from the new-chat model picker, its search results, and its model-library tabs, including all built-in and custom models. A previously selected hidden provider falls back to the first visible provider for new chats. If every provider is hidden, the picker is empty and the new-chat composer is unavailable. Existing sessions, stored model settings, provider runtimes, and API access remain available; this setting controls UI visibility only.

The new-chat `/models` command and its **Manage models** view follow the same visibility setting. If loading visibility fails or takes more than 10 seconds, new-chat model selection shows an error with **Retry** instead of displaying unconfirmed providers. A successful response from an older backend without visibility fields defaults to showing all providers. Existing-session model controls remain available during a visibility error.

### DeepSeek Harness provider

Select **DeepSeek Harness** in the provider picker. Install `@deepseek-ai/dsh` on the machine running CloudCLI and configure the same DSH home and credentials used by that service:

```bash
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
export DEEPSEEK_API_KEY="your-key"
export CLOUDCLI_DSH_RUNTIME=acp
# Optional: export CLOUDCLI_DSH_BIN=/absolute/path/to/dsh
# Optional: export DSH_HOME=/absolute/path/to/.dsh
```

Restart CloudCLI after changing launch settings. `acp` is the default persistent stdio transport; set `CLOUDCLI_DSH_RUNTIME=headless` for one-shot JSON execution with session resume. Both use the existing chat queue for prompts submitted during a run. The DSH CLI is installed separately; CloudCLI includes only its pinned read-only session format libraries.

ACP exposes one-time tool approvals in the chat. Headless uses environment/`.env` credentials by default and has no interactive approval channel. Connection status checks credential presence; the model runtime validates it when a task starts. Use `default` for DSH's configured selection, or add a custom `provider/model` entry in the model library.

The model picker also reads static `config.providers.<provider>.models` declarations from `$DSH_HOME/profiles/headless/cordis.patch.yml` (default home: `~/.dsh`). It applies that file's patches in order by entry ID: later configs replace earlier configs, disabled entries and groups are hidden, and inserted or nested group declarations are included. It uses each model's `id`, `name`, and declared `reasoningEfforts`, preserving the full `provider/model` route. Existing manually added models take precedence when discovery returns the same route, remaining editable without duplicate picker rows. The file is reread on each model-list request; missing or invalid files leave `Profile default` and manually added models available.

This discovery does not copy headless configuration into ACP: ACP must advertise the selected model in its own profile. Bundle defaults, executable YAML expressions, and `CLOUDCLI_DSH_PATCHES` overlays are not resolved by this static reader. References to bundle-owned entries are projected from the overrides in this file; their inherited configuration and group ancestry are unavailable.

If selecting a model from the headless file reports `DSH does not advertise model`, set `CLOUDCLI_DSH_RUNTIME=headless` in CloudCLI's environment (or its root `.env`) and restart the backend. To keep using ACP, configure the same provider/model in `$DSH_HOME/profiles/acp/cordis.patch.yml`; a full `provider/model` route alone does not register it with ACP.

See [DSH configuration, supported features and checks](docs/deepseek-harness-provider-plan.md) for patch overlays, native compressed history, MCP/skills, and deployment details.


### GPT Web provider

Select **GPT Web** to use a separately configured [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) connection through the existing Codex runtime.

Set the backend environment before starting CloudCLI:

```bash
export CODEX_GPTWEB_HOME="$HOME/.codex-gptweb"
```

`CODEX_GPTWEB_HOME` is required for this provider. Both Codex SDK (`codex exec`) and app-server child processes receive it as `CODEX_HOME`; the backend's global `CODEX_HOME` stays unchanged. Restart the backend after changing this directory. Config, credentials, transcript indexing, MCP and Codex-owned skill paths use the selected profile. GPT Web has its own app-server, model catalog and queue-stop scope.

Prepare that directory and run the external launcher yourself; CloudCLI does not initialize the route, sign into ChatGPT or install its harness. Models and reasoning levels are read from the configured bridge's authenticated `/v1/models` endpoint, filtered to visible `chatgpt-web/` entries. The directory must contain valid `config.toml` routing and the credentials required by the bridge's model endpoint. A service or authentication error is reported without falling back to ordinary Codex models.

For filesystem and terminal tools, enable Full harness in the launcher. If the launcher uses a different Codex home, register this directory in the launcher's `CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES`. Current upstream setup requires the built-in `openai` provider with `openai_base_url`; custom `model_provider` configurations need separate compatibility verification. See [the integration plan](docs/gptweb-provider-plan.md).
