/**
 * Commands to check and restart the communication agent of an offline server,
 * run on the target itself. Restarting it keeps runners, jobs and terminals.
 */
export function agentStatusCommand(os: string): string {
  if (os === 'windows') return [
    'Get-Service HostherdAgent',
    "Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Service Control Manager'} -MaxEvents 200 | Where-Object Message -match 'Hostherd' | Select-Object -First 10 | Format-List TimeCreated, Message",
  ].join('\n');
  // launchd keeps no agent log file; print shows the state and last exit code.
  if (os === 'darwin') return 'sudo launchctl print system/io.hostherd.agent';
  return [
    'sudo systemctl status hostherd-agent --no-pager',
    'sudo journalctl -u hostherd-agent -n 50 --no-pager',
  ].join('\n');
}

export function agentRestartCommand(os: string): string {
  if (os === 'windows') return 'Restart-Service HostherdAgent';
  // kickstart needs a loaded job; bootstrap loads one that was booted out.
  if (os === 'darwin') return 'sudo launchctl kickstart -k system/io.hostherd.agent || sudo launchctl bootstrap system /Library/LaunchDaemons/io.hostherd.agent.plist';
  return 'sudo systemctl restart hostherd-agent';
}
