import type { McpServer } from '@modelcontextprotocol/server';

type PublicMcpMessage =
  | 'Mail configuration is unavailable.'
  | 'Mail credentials are unavailable.'
  | 'Mail certificate setup failed.'
  | 'Mail Bridge connection failed.'
  | 'Mail operation failed.'
  | 'Mailbox operation failed.'
  | 'Operation requires explicit confirmation.'
  | 'Source or destination unavailable.'
  | 'Operation rejected by mailbox policy.';

/** Only these locally selected messages may cross the MCP tool boundary. */
export class PublicMcpError extends Error {
  readonly #safeMessage: PublicMcpMessage;

  constructor(message: PublicMcpMessage) {
    super(message);
    this.name = 'PublicMcpError';
    this.#safeMessage = message;
  }

  get safeMessage(): PublicMcpMessage {
    return this.#safeMessage;
  }
}

/** Wrap every registered handler before the SDK can serialize a thrown error. */
export function installMcpToolErrorBoundary(server: McpServer): void {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = new Proxy(registerTool, {
    apply(_target, _receiver, [name, config, callback]: unknown[]) {
      if (typeof callback !== 'function') {
        throw new PublicMcpError('Mail operation failed.');
      }
      return Reflect.apply(registerTool, undefined, [
        name,
        config,
        async (...args: unknown[]) => {
          try {
            return (await Reflect.apply(callback, undefined, args)) as unknown;
          } catch (error) {
            // Do not copy message, cause, stack, or arbitrary error properties.
            throw error instanceof PublicMcpError
              ? new PublicMcpError(error.safeMessage)
              : new PublicMcpError('Mail operation failed.');
          }
        },
      ]) as ReturnType<McpServer['registerTool']>;
    },
  });
}
