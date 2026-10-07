/**
 * Manual removal for agents that cannot remove themselves (offline or a
 * failed request). Mirrors what the agent's uninstaller deletes.
 */
export function manualUninstallCommand(os: string): string {
  if (os === 'windows') return [
    'Stop-Service HostherdAgent; sc.exe delete HostherdAgent',
    "Get-ScheduledTask -TaskPath '\\Hostherd\\' | ForEach-Object { Stop-ScheduledTask -InputObject $_; Unregister-ScheduledTask -InputObject $_ -Confirm:$false }",
    'Remove-Item -Recurse -Force "$env:ProgramData\\Hostherd", "$env:ProgramFiles\\Hostherd"',
  ].join('\n');
  if (os === 'darwin') return [
    'sudo launchctl bootout system/io.hostherd.agent',
    'for f in /Library/LaunchDaemons/io.hostherd.runner.*.plist; do sudo launchctl bootout "system/$(basename "$f" .plist)"; done',
    'sudo rm -f /Library/LaunchDaemons/io.hostherd.agent.plist /Library/LaunchDaemons/io.hostherd.runner.*.plist',
    'sudo rm -rf /etc/hostherd /var/lib/hostherd /opt/hostherd',
  ].join('\n');
  return [
    "sudo systemctl stop hostherd-agent.service 'hostherd-runner-*.service'",
    'sudo rm -f /etc/systemd/system/hostherd-agent.service /etc/systemd/system/hostherd-runner-*.service /etc/systemd/system/multi-user.target.wants/hostherd-*.service',
    'sudo systemctl daemon-reload',
    'sudo rm -rf /etc/hostherd /var/lib/hostherd /opt/hostherd',
  ].join('\n');
}
