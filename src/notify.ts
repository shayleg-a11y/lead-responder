/** Rep pings: dashboard "Needs you" box always; Telegram if configured. */
export interface Notifier {
  ping(title: string, body: string): Promise<void>;
}

export class NullNotifier implements Notifier {
  async ping(): Promise<void> {}
}

export class TelegramNotifier implements Notifier {
  constructor(
    private token: string,
    private chatId: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async ping(title: string, body: string): Promise<void> {
    try {
      await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: `${title}\n${body}` }),
      });
    } catch {
      /* never let a ping failure stop the engine */
    }
  }
}

export class FanoutNotifier implements Notifier {
  constructor(private targets: Notifier[]) {}
  async ping(title: string, body: string): Promise<void> {
    await Promise.all(this.targets.map((t) => t.ping(title, body)));
  }
}
