import { DurableObject } from 'cloudflare:workers';
import { RelayStore, type RelayStoreData } from './relay-store.ts';
import { handleRelay, notifyFresh, type RelayEnv } from './http.ts';
import { agentProvider } from './providers.ts';
import { pollCloudSessions } from './cloud-sessions.ts';

export class RelayRoom extends DurableObject {
  store: RelayStore;

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    this.store = new RelayStore();
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RelayStoreData>('data');
      if (saved) this.store = RelayStore.fromJSON(saved);
      await this.arm();
    });
  }

  async persist() {
    await this.ctx.storage.put('data', this.store.toJSON());
  }

  async arm(now = Date.now()) {
    const at = this.store.nextCloudAlarm(now);
    if (at == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current != null && current <= at) return;
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    try {
      const provider = agentProvider('cursor', this.env as RelayEnv, fetch);
      await pollCloudSessions(this.store, provider, Date.now());
      await notifyFresh(this.store, this.env as RelayEnv, fetch);
    } catch {
      // A failed poll still gets another look.
    }
    await this.persist();
    await this.arm();
  }

  async fetch(req: Request): Promise<Response> {
    const device = req.headers.get('x-agentbox-device')?.trim() || 'default';
    const res = await handleRelay(req, this.store, this.env as unknown as RelayEnv, device, fetch.bind(globalThis));
    await this.persist();
    await this.arm();
    return res;
  }
}
