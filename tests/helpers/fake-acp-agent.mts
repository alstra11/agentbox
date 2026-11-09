import { EventEmitter } from 'node:events';

export function fakeCursorAgent() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.sent = [];
  child.stdin = {
    write: (text, cb) => { child.sent.push(JSON.parse(text)); cb?.(); return true; },
    end: () => {},
  };
  child.kill = () => { child.killed = true; };
  child.say = (message) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
  child.reply = (id, result) => child.say({ jsonrpc: '2.0', id, result });
  child.lastCall = (method) => [...child.sent].reverse().find((m) => m.method === method) ?? null;
  return child;
}
