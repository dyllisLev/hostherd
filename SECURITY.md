# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting). Do not open a public issue, discussion or pull request for a security problem.

Include the affected version (`/healthz` shows the central version; the server list shows agent versions), the steps to reproduce, and the impact you expect. You will get an acknowledgement as soon as possible, and a fix or mitigation will be coordinated with you before details are published.

Only the latest release is supported with security fixes.

## Scope

In scope: the central server, web console, MCP endpoint, the agent and its installers, the release signing and update process, and the official container image.

Keep the following design properties in mind when assessing impact:

- **Hostherd executes commands by design.** Anyone who can sign in as the admin, or who holds a valid OAuth grant or personal token, can run commands, read and write files and open terminals on every registered server. Getting those credentials through Hostherd is a vulnerability; doing what they allow is not.
- **The agent acts as the OS account chosen at install time** (the `sudo` caller, root, the Windows user, or SYSTEM). The operating system enforces what that account can do. Use a regular account to limit access.
- **Command approvals are a safety net, not a security boundary.** They analyze command text to catch mistakes and can be bypassed by an equivalent command. A bypass of an approval rule is not considered a vulnerability unless it also crosses an authentication or authorization boundary.
- Agents trust the release public key they received from the central server at install time. Compromise of the central server or of the signing key is out of scope for agent-side defenses.
- Problems in your reverse proxy, TLS setup or host configuration are out of scope, but reports that Hostherd's documentation leads to an insecure setup are welcome.
