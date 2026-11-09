import { DurableObject } from 'cloudflare:workers';
import { RelayStore, type RelayStoreData } from './relay-store.ts';
import { handleRelay, type RelayEnv } from './http.ts';

export class RelayRoom extends DurableObject {
  store: RelayStore;

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    this.store = new RelayStore();
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RelayStoreData>('data');
      if (saved) this.store = RelayStore.fromJSON(saved);
    });
  }

  async persist() {
    await this.ctx.storage.put('data', this.store.toJSON());
  }

  async fetch(req: Request): Promise<Response> {
    const device = req.headers.get('x-agentbox-device')?.trim() || 'default';
    const res = await handleRelay(req, this.store, this.env as unknown as RelayEnv, device, fetch.bind(globalThis));
    await this.persist();
    return res;
  }
}
