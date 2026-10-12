export class WorkspaceRequiredError extends Error {
  constructor() {
    super('Run this command in the Codespaces or Dev Container terminal. Your computer can use macOS, Windows or Linux; the lab tools run inside the configured container.');
  }
}

export function requireLinuxWorkspace(platform = process.platform) {
  if (platform !== 'linux') throw new WorkspaceRequiredError();
}
