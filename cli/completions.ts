/**
 * Shell completion generator for RailFog CLI.
 * Supports: powershell (pwsh), bash, zsh, fish.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-19
 */

import { colors } from "./ui.ts";

export type SupportedShell = "powershell" | "bash" | "zsh" | "fish";

export const SUPPORTED_SHELLS: SupportedShell[] = [
  "powershell",
  "bash",
  "zsh",
  "fish",
];

export const SUBCOMMANDS = [
  { name: "init", desc: "Initialize a new RailFog project" },
  { name: "dev", desc: "Start the local development server with hot-reload" },
  { name: "deploy", desc: "Deploy functions and configuration to Control Plane" },
  { name: "undeploy", desc: "Safely undeploy and remove project from cloud" },
  { name: "status", desc: "Show status of functions and routes in railfog.toml" },
  { name: "check", desc: "Validate railfog.toml configuration and route patterns" },
  { name: "add", desc: "Add a dependency or primitive to deno.json" },
  { name: "login", desc: "Authenticate your session via browser or API token" },
  { name: "logout", desc: "Log out and remove local credentials" },
  { name: "whoami", desc: "Display currently authenticated organization and key" },
  { name: "secrets", desc: "Manage encrypted project secrets (set, list, delete)" },
  { name: "logs", desc: "Stream and filter structured runtime logs" },
  { name: "rollback", desc: "Rollback a function to a previous revision instantly" },
  { name: "usage", desc: "Display resource consumption and itemized cost breakdown" },
  { name: "cost", desc: "Alias for usage subcommand" },
  { name: "export", desc: "Export project state to a disaster recovery archive" },
  { name: "import", desc: "Import and restore project state from disaster recovery archive" },
  { name: "upgrade", desc: "Upgrade the RailFog CLI to the latest version" },
  { name: "update", desc: "Alias for upgrade subcommand" },
  { name: "sync", desc: "Sync CLI with latest git updates (alias for update)" },
  { name: "completions", desc: "Generate shell auto-completion script" },
];

export function generatePowerShellCompletion(): string {
  const items = SUBCOMMANDS.map(
    (c) =>
      `        [System.Management.Automation.CompletionResult]::new('${c.name}', '${c.name}', 'ParameterValue', '${c.desc}'),`,
  ).join("\n");

  return `# RailFog CLI PowerShell completion script
# Generated automatically by 'rail completions powershell'

Register-ArgumentCompleter -Native -CommandName 'rail' -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commandElements = $commandAst.CommandElements
    $command = @(
        $commandElements |
        Select-Object -Skip 1 |
        ForEach-Object { $_.ToString() }
    )

    $commands = @(
${items}
        [System.Management.Automation.CompletionResult]::new('--help', '--help', 'ParameterValue', 'Show help information'),
        [System.Management.Automation.CompletionResult]::new('--version', '--version', 'ParameterValue', 'Show CLI version'),
        [System.Management.Automation.CompletionResult]::new('-h', '-h', 'ParameterValue', 'Show help information'),
        [System.Management.Automation.CompletionResult]::new('-v', '-v', 'ParameterValue', 'Show CLI version')
    )

    if ($command.Count -le 1) {
        $commands | Where-Object { $_.CompletionText -like "$wordToComplete*" }
    } else {
        $sub = $command[0]
        $subOptions = @{
            'init' = @('--template', '--name', '--force', '--help', '-h')
            'dev' = @('--port', '--host', '--no-watch', '--help', '-h')
            'deploy' = @('--control-url', '--project', '--env', '-e', '--help', '-h')
            'undeploy' = @('--control-url', '--project', '--force', '-f', '--help', '-h')
            'status' = @('--help', '-h')
            'check' = @('--help', '-h')
            'add' = @('sdk', '--help', '-h')
            'login' = @('--control-url', '--token', '--manual', '--help', '-h')
            'logout' = @('--help', '-h')
            'whoami' = @('--control-url', '--help', '-h')
            'secrets' = @('set', 'list', 'delete', '--file', '--help', '-h')
            'logs' = @('--function', '--level', '--limit', '--format', '--follow', '-f', '--help', '-h')
            'rollback' = @('--to', '--control-url', '--project', '--help', '-h')
            'usage' = @('--format', '--project-dir', '--project', '--source', '--rates', '--help', '-h')
            'cost' = @('--format', '--project-dir', '--project', '--source', '--rates', '--help', '-h')
            'export' = @('--out', '--project', '--org', '--control-url', '--help', '-h')
            'import' = @('--in', '--project', '--org', '--overwrite-kv', '--control-url', '--help', '-h')
            'upgrade' = @('--check', '--force', '-f', '--local', '-l', '--version', '--ref', '--compile', '--help', '-h')
            'update' = @('--check', '--force', '-f', '--local', '-l', '--version', '--ref', '--compile', '--help', '-h')
            'sync' = @('--check', '--force', '-f', '--local', '-l', '--version', '--ref', '--compile', '--help', '-h')
            'completions' = @('powershell', 'bash', 'zsh', 'fish', '--help', '-h')
        }

        if ($subOptions.ContainsKey($sub)) {
            $subOptions[$sub] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
        }
    }
}
`;
}

export function generateBashCompletion(): string {
  const cmdList = SUBCOMMANDS.map((c) => c.name).join(" ");

  return `#!/usr/bin/env bash
# RailFog CLI Bash completion script
# Generated automatically by 'rail completions bash'

_rail_completions() {
    local cur prev words cword
    _init_completion || return

    local commands="${cmdList}"

    if [ $cword -eq 1 ]; then
        COMPREPLY=( $(compgen -W "$commands --help -h --version -v" -- "$cur") )
        return 0
    fi

    case "\${words[1]}" in
        init)
            COMPREPLY=( $(compgen -W "--template --name --force --help -h" -- "$cur") )
            ;;
        dev)
            COMPREPLY=( $(compgen -W "--port --host --no-watch --help -h" -- "$cur") )
            ;;
        deploy)
            COMPREPLY=( $(compgen -W "--control-url --project --env -e --help -h" -- "$cur") )
            ;;
        undeploy)
            COMPREPLY=( $(compgen -W "--control-url --project --force -f --help -h" -- "$cur") )
            ;;
        secrets)
            COMPREPLY=( $(compgen -W "set list delete --file --help -h" -- "$cur") )
            ;;
        logs)
            COMPREPLY=( $(compgen -W "--function --level --limit --format --follow -f --help -h" -- "$cur") )
            ;;
        rollback)
            COMPREPLY=( $(compgen -W "--to --control-url --project --help -h" -- "$cur") )
            ;;
        usage|cost)
            COMPREPLY=( $(compgen -W "--format --project-dir --project --source --rates --help -h" -- "$cur") )
            ;;
        export)
            COMPREPLY=( $(compgen -W "--out --project --org --control-url --help -h" -- "$cur") )
            ;;
        import)
            COMPREPLY=( $(compgen -W "--in --project --org --overwrite-kv --control-url --help -h" -- "$cur") )
            ;;
        upgrade|update|sync)
            COMPREPLY=( $(compgen -W "--check --force -f --local -l --version --ref --compile --help -h" -- "$cur") )
            ;;
        completions)
            COMPREPLY=( $(compgen -W "powershell bash zsh fish --help -h" -- "$cur") )
            ;;
        *)
            COMPREPLY=( $(compgen -W "--help -h" -- "$cur") )
            ;;
    esac
}

complete -F _rail_completions rail
`;
}

export function generateZshCompletion(): string {
  const subDesc = SUBCOMMANDS.map(
    (c) => `        '${c.name}:${c.desc.replace(/'/g, "")}'`,
  ).join("\n");

  return `#compdef rail
# RailFog CLI Zsh completion script
# Generated automatically by 'rail completions zsh'

_rail() {
    local -a commands
    commands=(
${subDesc}
    )

    if (( CURRENT == 2 )); then
        _describe -t commands 'rail command' commands
        _arguments \\
            '(-h --help)'{-h,--help}'[Show help information]' \\
            '(-v --version)'{-v,--version}'[Show version]'
    else
        case "$words[2]" in
            init)
                _arguments \\
                    '--template[Template to use (minimal or worked-example)]' \\
                    '--name[Project name]' \\
                    '--force[Overwrite files in non-empty directory]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            dev)
                _arguments \\
                    '--port[Port to bind (default: 8000)]' \\
                    '--host[Host to bind (default: 0.0.0.0)]' \\
                    '--no-watch[Disable file watcher hot-reload]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            deploy)
                _arguments \\
                    '--control-url[Control Plane API URL]' \\
                    '--project[Override project name declared in railfog.toml]' \\
                    '(-e --env)'{-e,--env}'[Target deployment environment]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            undeploy)
                _arguments \\
                    '--control-url[Control Plane API URL]' \\
                    '--project[Override project name declared in railfog.toml]' \\
                    '(-f --force)'{-f,--force}'[Skip interactive confirmation prompt]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            secrets)
                _arguments \\
                    '1:subcommand:(set list delete)' \\
                    '--file[Read secret value from file]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            logs)
                _arguments \\
                    '--function[Filter logs by function name]' \\
                    '--level[Minimum log level (debug, info, warn, error)]' \\
                    '--limit[Maximum number of log entries to display]' \\
                    '--format[Output format (pretty or json)]' \\
                    '(-f --follow)'{-f,--follow}'[Tail/follow logs in real-time]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            rollback)
                _arguments \\
                    '--to[Target revision ID to rollback to]' \\
                    '--control-url[Control Plane API URL]' \\
                    '--project[Override project name declared in railfog.toml]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            usage|cost)
                _arguments \\
                    '--format[Output format (pretty or json)]' \\
                    '--project-dir[Project root directory]' \\
                    '--project[Project ID or name override]' \\
                    '--source[Custom usage source JSON string or file path]' \\
                    '--rates[Custom pricing rates JSON override]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            export)
                _arguments \\
                    '--out[Output backup archive JSON file path]' \\
                    '--project[Override project name declared in railfog.toml]' \\
                    '--org[Organization ID]' \\
                    '--control-url[Control Plane API URL]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            import)
                _arguments \\
                    '--in[Input backup archive JSON file path]' \\
                    '--project[Target project name]' \\
                    '--org[Target organization ID]' \\
                    '--overwrite-kv[Overwrite existing KV keys in target project]' \\
                    '--control-url[Control Plane API URL]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            upgrade|update|sync)
                _arguments \\
                    '--check[Check for newer versions without installing]' \\
                    '(-f --force)'{-f,--force}'[Force reinstallation even if up to date]' \\
                    '(-l --local)'{-l,--local}'[Sync directly from local repository sources]' \\
                    '--version[Upgrade to a specific semantic version]' \\
                    '--ref[Upgrade to a specific git branch or tag]' \\
                    '--compile[Compile into a standalone native binary]' \\
                    '(-h --help)'{-h,--help}'[Show help]'
                ;;
            completions)
                _arguments \\
                    '1:shell:(powershell bash zsh fish)'
                ;;
            *)
                _arguments '(-h --help)'{-h,--help}'[Show help]'
                ;;
        esac
    fi
}

_rail "$@"
`;
}

export function generateFishCompletion(): string {
  const subs = SUBCOMMANDS.map(
    (c) =>
      `complete -c rail -n "__fish_use_subcommand" -a ${c.name} -d "${c.desc.replace(/"/g, "")}"`,
  ).join("\n");

  return `# RailFog CLI Fish completion script
# Generated automatically by 'rail completions fish'

complete -c rail -f

${subs}
complete -c rail -l help -s h -d "Show help information"
complete -c rail -l version -s v -d "Show CLI version"

# init
complete -c rail -n "__fish_seen_subcommand_from init" -l template -d "Template to use (minimal or worked-example)"
complete -c rail -n "__fish_seen_subcommand_from init" -l name -d "Project name"
complete -c rail -n "__fish_seen_subcommand_from init" -l force -d "Overwrite files in non-empty directory"

# dev
complete -c rail -n "__fish_seen_subcommand_from dev" -l port -d "Port to bind"
complete -c rail -n "__fish_seen_subcommand_from dev" -l host -d "Host to bind"
complete -c rail -n "__fish_seen_subcommand_from dev" -l no-watch -d "Disable file watcher"

# deploy
complete -c rail -n "__fish_seen_subcommand_from deploy" -l control-url -d "Control Plane API URL"
complete -c rail -n "__fish_seen_subcommand_from deploy" -l project -d "Project name"
complete -c rail -n "__fish_seen_subcommand_from deploy" -s e -l env -d "Target deployment environment"

# undeploy
complete -c rail -n "__fish_seen_subcommand_from undeploy" -l control-url -d "Control Plane API URL"
complete -c rail -n "__fish_seen_subcommand_from undeploy" -l project -d "Project name"
complete -c rail -n "__fish_seen_subcommand_from undeploy" -s f -l force -d "Skip confirmation prompt"

# secrets
complete -c rail -n "__fish_seen_subcommand_from secrets" -a "set list delete"
complete -c rail -n "__fish_seen_subcommand_from secrets" -l file -d "Read secret from file"

# logs
complete -c rail -n "__fish_seen_subcommand_from logs" -l function -d "Filter by function"
complete -c rail -n "__fish_seen_subcommand_from logs" -l level -d "Minimum log level"
complete -c rail -n "__fish_seen_subcommand_from logs" -l limit -d "Maximum log entries"
complete -c rail -n "__fish_seen_subcommand_from logs" -l format -d "Output format"
complete -c rail -n "__fish_seen_subcommand_from logs" -s f -l follow -d "Tail logs in real-time"

# completions
complete -c rail -n "__fish_seen_subcommand_from completions" -a "powershell bash zsh fish"
`;
}

export function generateCompletions(shell: SupportedShell): string {
  switch (shell) {
    case "powershell":
      return generatePowerShellCompletion();
    case "bash":
      return generateBashCompletion();
    case "zsh":
      return generateZshCompletion();
    case "fish":
      return generateFishCompletion();
    default:
      throw new Error(`Unsupported shell: ${shell}`);
  }
}

export function printCompletionsHelp(): void {
  console.log(`RailFog CLI - Shell completion script generator

${colors.bold("Usage:")}
  rail completions <shell>

${colors.bold("Supported shells:")}
  powershell   Windows PowerShell and PowerShell Core
  bash         GNU Bourne-Again SHell
  zsh          Z Shell
  fish         Friendly Interactive Shell

${colors.bold("Installation instructions:")}

  ${colors.accent("PowerShell (pwsh):")}
    rail completions powershell | Out-String | Invoke-Expression
    # Or persist in your $PROFILE:
    "rail completions powershell | Out-String | Invoke-Expression" | Add-Content $PROFILE

  ${colors.accent("Bash:")}
    source <(rail completions bash)
    # Or persist in ~/.bashrc:
    rail completions bash >> ~/.bashrc

  ${colors.accent("Zsh:")}
    source <(rail completions zsh)
    # Or save into fpath:
    rail completions zsh > "\${fpath[1]}/_rail"

  ${colors.accent("Fish:")}
    rail completions fish | source
    # Or persist:
    rail completions fish > ~/.config/fish/completions/rail.fish
`);
}

export function runCompletions(shellArg?: string): { ok: boolean; script?: string } {
  if (!shellArg || shellArg === "-h" || shellArg === "--help") {
    printCompletionsHelp();
    return { ok: true };
  }

  const normalized = shellArg.toLowerCase().trim() as SupportedShell;
  if (!SUPPORTED_SHELLS.includes(normalized)) {
    console.error(
      `Error [VALIDATION_FAILED]: Unsupported shell "${shellArg}". Supported shells: ${SUPPORTED_SHELLS.join(", ")}`,
    );
    return { ok: false };
  }

  const script = generateCompletions(normalized);
  console.log(script);
  return { ok: true, script };
}
