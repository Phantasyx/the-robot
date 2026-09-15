/**
 * MCP tool hooks — stub surface for Model Context Protocol servers.
 * Next step: plug in an MCP SDK and map tools into the runtime loop.
 */

export interface McpTool {
  name: string;
  description: string;
  destructive?: boolean;
}

export interface McpCallResult {
  ok: boolean;
  content: string;
}

export interface McpClient {
  connect(serverId: string): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  disconnect(): Promise<void>;
}

export class StubMcpClient implements McpClient {
  private connected = false;
  private readonly serverId: string | null = null;

  async connect(serverId: string): Promise<void> {
    void serverId;
    this.connected = true;
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.connected) return [];
    // Empty until a real MCP server is configured.
    return [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return {
      ok: true,
      content: `[mcp stub] ${name}(${JSON.stringify(args)}) — no server wired`,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

export function createMcpClient(): McpClient {
  return new StubMcpClient();
}
