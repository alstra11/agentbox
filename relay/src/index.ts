import { RelayRoom } from './relay-room.ts';

interface Env {
  MAC_TOKEN: string;
  IPHONE_TOKEN: string;
  WATCH_TOKEN: string;
  NTFY_URL?: string;
  NTFY_TOPIC?: string;
  RELAY_ROOM: DurableObjectNamespace<RelayRoom>;
}

export { RelayRoom };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const id = env.RELAY_ROOM.idFromName('main');
    const stub = env.RELAY_ROOM.get(id);
    return stub.fetch(req);
  },
};
