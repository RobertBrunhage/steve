export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface Channel {
  readonly name: string;
  sendMessage(userId: string, text: string, options?: { buttons?: string[][] }): Promise<SendResult>;
  sendFile(userId: string, filePath: string, caption?: string): Promise<SendResult>;
  editMessage(userId: string, messageId: string, text: string): Promise<SendResult>;
}

const channels: Map<string, Channel> = new Map();

export function registerChannel(channel: Channel) {
  channels.set(channel.name, channel);
}

export function getChannel(name: string): Channel | undefined {
  return channels.get(name);
}

/** Get the default (first registered) channel */
export function getDefaultChannel(): Channel | undefined {
  return channels.values().next().value;
}
