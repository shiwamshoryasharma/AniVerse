import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { SourceMediaCapture } from '../../electron/sourceMediaCapture';

const primary = 'https://media.test/asset?token=active';
const alternative = 'https://media.test/asset?token=rotated';

function setup() {
  const root = { processId: 1, routingId: 2, frameTreeNodeId: 3, url: 'https://player.test/episode' };
  const sibling = { processId: 1, routingId: 9, frameTreeNodeId: 10, url: root.url, top: root };
  Object.assign(root, { top: root });
  const guest = Object.assign(new EventEmitter(), { mainFrame: root, isDestroyed: () => false });
  const capture = new SourceMediaCapture();
  capture.manage(guest as never);
  const req = { id: 1, url: primary, method: 'GET', resourceType: 'xhr', frame: root };
  return { root, sibling, guest, capture, req };
}

it('keeps captured authentication tied to the current frame, document, and exact signed URL', () => {
  const { root, sibling, guest, capture, req } = setup();
  capture.request(guest as never, { ...req, requestHeaders: { Authorization: 'Bearer fixture' } } as never);
  capture.response(guest as never, { ...req, statusCode: 200, responseHeaders: { 'Content-Type': ['application/dash+xml'] } } as never);
  expect(capture.selected(guest as never, root as never, [primary, alternative])).toMatchObject([
    { url: primary, kind: 'dash', headers: { authorization: 'Bearer fixture' } },
  ]);
  expect(capture.selected(guest as never, sibling as never, [primary])).toEqual([]);
  guest.emit('did-start-navigation', { frame: root, isMainFrame: true, isSameDocument: false });
  expect(capture.selected(guest as never, root as never, [primary])).toEqual([]);
});

it('never copies a previous hop’s headers to a response at another exact URL', () => {
  const { root, guest, capture, req } = setup();
  capture.request(guest as never, { ...req, requestHeaders: { Cookie: 'fixture=old' } } as never);
  capture.response(guest as never, {
    ...req, url: alternative, statusCode: 206, responseHeaders: { 'content-type': ['video/webm'] },
  } as never);
  expect(capture.selected(guest as never, root as never, [primary, alternative])).toMatchObject([
    { url: alternative, kind: 'webm', headers: undefined },
  ]);
});

it('expires captured credentials without discarding the manifest response kind', () => {
  vi.useFakeTimers();
  try {
    const { root, guest, capture, req } = setup();
    capture.request(guest as never, { ...req, requestHeaders: { Cookie: 'fixture=old' } } as never);
    capture.response(guest as never, {
      ...req, statusCode: 200, responseHeaders: { 'Content-Type': ['application/vnd.apple.mpegurl'] },
    } as never);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect(capture.selected(guest as never, root as never, [primary])).toMatchObject([{ url: primary, kind: 'hls' }]);
    expect(capture.selected(guest as never, root as never, [primary])[0].headers).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('retains a captured extensionless manifest across segment response churn', () => {
  const { root, guest, capture, req } = setup();
  capture.response(guest as never, {
    ...req, statusCode: 200, responseHeaders: { 'Content-Type': ['application/dash+xml'] },
  } as never);
  for (let index = 0; index < 90; index++) {
    capture.response(guest as never, { ...req, id: index + 2, url: 'https://media.test/part/' + index,
      statusCode: 200, responseHeaders: { 'Content-Type': ['application/octet-stream'] } } as never);
  }
  expect(capture.selected(guest as never, root as never, [primary, 'https://media.test/part/0'])).toMatchObject([
    { url: primary, kind: 'dash' },
  ]);
});
