import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerSpec } from '@aab/protocol';

export interface ToolResult {
  text: string;
  isError: boolean;
  json: unknown;
  images: number;
}

export class McpToolClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  stderr = '';

  constructor(readonly spec: McpServerSpec) {}

  async connect(): Promise<void> {
    const t = this.spec.transport;
    if (t.kind !== 'stdio')
      throw new Error(`${this.spec.name}: only stdio MCP servers are supported`);
    this.transport = new StdioClientTransport({
      command: t.command,
      args: t.args,
      env: t.env,
      stderr: 'pipe',
    });
    this.transport.stderr?.on('data', (c: Buffer) => {
      this.stderr = (this.stderr + c.toString('utf8')).slice(-8000);
    });
    this.client = new Client({ name: 'aab-scripted-agent', version: '0.2.0' });
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<string[]> {
    if (!this.client) throw new Error('not connected');
    return (await this.client.listTools()).tools.map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (!this.client) throw new Error(`${this.spec.name}: not connected`);
    const r = (await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: 15 * 60_000,
    })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const parts = r.content ?? [];
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('\n');
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      text,
      isError: r.isError === true,
      json,
      images: parts.filter((p) => p.type === 'image').length,
    };
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = null;
    this.transport = null;
  }
}
