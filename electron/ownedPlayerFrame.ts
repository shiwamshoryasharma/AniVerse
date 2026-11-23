import type { WebContents, WebFrameMain } from 'electron';

import { SourceRequestCookies, type CookieLookup } from './sourceRequestCookies';

const WORLD = 1021;
const WORLD_NAME = 'aniVerseOwnedSourcePlayer';
const OWNER = 'iframe[data-aniverse-media]';
const FRAME_ELEMENT = '(() => { const frames = document.querySelectorAll("' + OWNER + '"); ' +
  'const frame = frames.length === 1 ? frames[0] : null; ' +
  'return frame && frame.clientWidth >= 160 && frame.clientHeight >= 90 && ' +
  'frame.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}) ? frame : null; })()';
const CHALLENGE = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com/i;

interface FrameTree { frame: { id: string; url: string; loaderId: string; parentId?: string }; childFrames?: FrameTree[] }
interface Evaluation { exceptionDetails?: unknown; result?: { objectId?: string; value?: unknown } }
interface FrameSession { frame: string; url: string; loader: string; sessionId?: string }
interface IframeEvent {
  sessionId?: string;
  targetInfo?: {type?: string; targetId?: string; parentFrameId?: string};
}
interface GuestSession {
  subframes: Map<string,{sessionId:string; parent:string}>;
  attachSubframes?: Promise<unknown>;
  queue: Promise<unknown>;
  cookies?: SourceRequestCookies;
}
const sessions = new WeakMap<WebContents, GuestSession>();

export interface PlayerTarget {
  evaluate(code: string, gesture?: boolean): Promise<unknown | null>;
  evaluateBound(code: string, gesture?: boolean): Promise<unknown>;
}

function isLive(guest: WebContents) {
  return !guest.isDestroyed() && guest.getType() === 'webview' && !guest.isLoadingMainFrame();
}

function eligible(url: string) {
  try { return /^https?:$/.test(new URL(url).protocol) && !CHALLENGE.test(url); }
  catch { return false; }
}

async function readTop(guest: WebContents, code: string, gesture = false) {
  if (!isLive(guest) || !eligible(guest.getURL())) return null;
  const frame = guest.mainFrame, url = guest.getURL();
  try {
    const value: unknown = await guest.executeJavaScriptInIsolatedWorld(WORLD, [{code}], gesture);
    return isLive(guest) && guest.mainFrame === frame && guest.getURL() === url ? value : null;
  } catch { return null; }
}

function releaseDebugger(guest: WebContents, state: GuestSession) {
  if (sessions.get(guest) !== state) return;
  sessions.delete(guest);
  if (!guest.isDestroyed() && guest.debugger.isAttached()) {
    try { guest.debugger.detach(); } catch { /* Main frame may already be gone. */ }
  }
}

function ownedDebugger(guest: WebContents, observeNetwork = false): GuestSession | null {
  const current = sessions.get(guest);
  if (current && guest.debugger.isAttached()) return current;
  if (guest.isDestroyed() || guest.getType() !== 'webview' || (!observeNetwork && !isLive(guest)) || guest.debugger.isAttached()) return null;
  try { guest.debugger.attach('1.3'); } catch { return null; }
  let state: GuestSession;
  const cleanup = () => {
    state.cookies?.clear();
    if (sessions.get(guest) === state) sessions.delete(guest);
    guest.removeListener('did-start-navigation', navigation);
    guest.removeListener('destroyed', cleanup);
    guest.debugger.removeListener('detach', cleanup);
    guest.debugger.removeListener('message',message);
  };
  const navigation = (details: {isMainFrame: boolean;isSameDocument: boolean}) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    if (state.cookies) state.cookies.clear();
    else releaseDebugger(guest, state);
  };
  const message = (_event: unknown, method: string, params: IframeEvent & Record<string, unknown>, sessionId?: string) => {
    state.cookies?.message(method, params, sessionId);
    if (method === 'Target.attachedToTarget') {
      const info = params.targetInfo;
      if (info?.type === 'iframe' && info.targetId && info.parentFrameId && params.sessionId && state.subframes.size < 16) {
        state.subframes.set(info.targetId,{sessionId:params.sessionId,parent:info.parentFrameId});
        if (state.cookies) void guest.debugger.sendCommand('Network.enable', {}, params.sessionId).catch(() => undefined);
      }
    } else if (method === 'Target.detachedFromTarget') {
      for (const [frame,saved] of state.subframes) {
        if (saved.sessionId === params.sessionId) { state.subframes.delete(frame); break; }
      }
    }
  };
  state = {subframes:new Map(),queue:Promise.resolve()};
  sessions.set(guest, state);
  guest.on('did-start-navigation',navigation);
  guest.once('destroyed',cleanup);
  guest.debugger.once('detach',cleanup);
  guest.debugger.on('message',message);
  return state;
}

function attachFrames(guest: WebContents, state: GuestSession) {
  return state.attachSubframes ??= guest.debugger.sendCommand('Target.setAutoAttach', {
    autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe'},{exclude:true}],
  }).catch(error => { state.attachSubframes = undefined; throw error; });
}

export function observeSourceNetwork(guest: WebContents) {
  const state = ownedDebugger(guest, true);
  if (!state || state.cookies) return;
  state.cookies = new SourceRequestCookies();
  void guest.debugger.sendCommand('Network.enable').catch(() => undefined);
  void attachFrames(guest, state).catch(() => undefined);
}

export async function cookiesForTopPlayer(guest: WebContents): Promise<CookieLookup | undefined> {
  const state = sessions.get(guest);
  if (!state?.cookies || !isLive(guest)) return;
  const root = guest.mainFrame, url = guest.getURL();
  try {
    const { frameTree }: { frameTree: FrameTree } = await guest.debugger.sendCommand('Page.getFrameTree');
    if (isLive(guest) && guest.mainFrame === root && guest.getURL() === url && frameTree.frame.url === url) {
      return state.cookies.lookup(guest, { frame: frameTree.frame.id, loader: frameTree.frame.loaderId });
    }
  } catch { /* Other tooling may have detached the observer. */ }
}

async function selectedFrame(guest: WebContents, state: GuestSession): Promise<FrameSession | null> {
  const dbg = guest.debugger;
  const {frameTree}: {frameTree: FrameTree} = await dbg.sendCommand('Page.getFrameTree');
  const top = await dbg.sendCommand('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:WORLD_NAME});
  const match: Evaluation = await dbg.sendCommand('Runtime.evaluate',{
    expression:FRAME_ELEMENT,contextId:top.executionContextId,
  });
  if (!match.result?.objectId || match.exceptionDetails) return null;
  const objectId = match.result.objectId;
  let frame: string;
  try {
    const {node} = await dbg.sendCommand('DOM.describeNode',{objectId,depth:0});
    if (node?.nodeName !== 'IFRAME' || typeof node.frameId !== 'string') return null;
    frame = node.frameId;
  } finally {
    await dbg.sendCommand('Runtime.releaseObject',{objectId}).catch(() => undefined);
  }
  const local = frameTree.childFrames?.find(child => child.frame.id === frame);
  if (local) return eligible(local.frame.url) ? {frame,url:local.frame.url,loader:local.frame.loaderId} : null;
  await attachFrames(guest, state);
  const child = state.subframes.get(frame);
  if (child?.parent !== frameTree.frame.id) return null;
  const {frameTree: remote}: {frameTree: FrameTree} = await dbg.sendCommand('Page.getFrameTree',{},child.sessionId);
  if (remote.frame.id !== frame || remote.frame.parentId !== child.parent || !eligible(remote.frame.url)) return null;
  return {frame,url:remote.frame.url,loader:remote.frame.loaderId,sessionId:child.sessionId};
}

async function readFrame(guest: WebContents, code: string, gesture = false,
  accept: (frame: FrameSession) => boolean = () => true, captureFrame?: (frame: WebFrameMain, cookies?: CookieLookup) => void) {
  const state = ownedDebugger(guest);
  if (!state) return null;
  const root = guest.mainFrame, top = guest.getURL();
  const live = () => isLive(guest) && guest.getURL() === top && guest.mainFrame === root && sessions.get(guest) === state;
  const work = state.queue.then(async () => {
    if (!live()) return null;
    const child = await selectedFrame(guest,state);
    if (!child || !live() || !accept(child)) return null;
    const context = await guest.debugger.sendCommand('Page.createIsolatedWorld',{
      frameId:child.frame,worldName:WORLD_NAME,
    },child.sessionId);
    const value: Evaluation = await guest.debugger.sendCommand('Runtime.evaluate',{
      expression:code,contextId:context.executionContextId,awaitPromise:true,returnByValue:true,
      userGesture:gesture,allowUnsafeEvalBlockedByCSP:false,
    },child.sessionId);
    if (captureFrame && live() && !value.exceptionDetails) {
      const current = await selectedFrame(guest, state);
      if (!live() || !current || current.frame !== child.frame || current.loader !== child.loader ||
          current.sessionId !== child.sessionId || current.url !== child.url) return null;
      // CDP and Electron expose different frame IDs. A URL identifies this exact
      // child only when it is unique among the current native frame siblings.
      const matches = root.frames.filter(frame => !frame.detached && frame.url === child.url);
      if (matches.length === 1) captureFrame(matches[0], state.cookies?.lookup(guest, child));
    }
    return live() && !value.exceptionDetails ? value.result?.value ?? null : null;
  }).catch(() => null);
  state.queue = work;
  return work;
}

function isFrameOffer(value: unknown): value is {frame:true} {
  return !!value && typeof value === 'object' && 'frame' in value && value.frame === true;
}

/** A trusted native caller supplies fixed readonly code. Source pages have no access to this transport. */
export async function readOwnedPlayer(guest: WebContents, javascript: string,
  captureFrame?: (frame: WebFrameMain, cookies?: CookieLookup) => void): Promise<unknown | null> {
  const root = captureFrame && !guest.isDestroyed() ? guest.mainFrame : undefined;
  const top = await readTop(guest,javascript);
  if (isFrameOffer(top)) return readFrame(guest,javascript,false,undefined,captureFrame);
  const cookies = root && top !== null ? await cookiesForTopPlayer(guest) : undefined;
  if (root && top !== null && isLive(guest) && guest.mainFrame === root) captureFrame?.(root, cookies);
  return top;
}

async function readBoundFrame(guest: WebContents, child: FrameSession, code: string, gesture = false) {
  if (!isLive(guest)) return null;
  try {
    const dbg = guest.debugger;
    const state = sessions.get(guest);
    if (!state || !dbg.isAttached()) return undefined;
    if (child.sessionId && state.subframes.get(child.frame)?.sessionId !== child.sessionId) return undefined;
    const {frameTree}: {frameTree:FrameTree} = await dbg.sendCommand('Page.getFrameTree',{},child.sessionId);
    const current = child.sessionId ? frameTree.frame : frameTree.childFrames?.find(frame => frame.frame.id === child.frame)?.frame;
    if (current?.id !== child.frame || current.loaderId !== child.loader || !eligible(current.url)) return undefined;
    const context = await dbg.sendCommand('Page.createIsolatedWorld',{frameId:child.frame,worldName:WORLD_NAME},child.sessionId);
    const result: Evaluation = await dbg.sendCommand('Runtime.evaluate',{
      expression:code,contextId:context.executionContextId,awaitPromise:true,returnByValue:true,
      userGesture:gesture,allowUnsafeEvalBlockedByCSP:false,
    },child.sessionId);
    return !result.exceptionDetails ? result.result?.value ?? null : null;
  } catch { return null; }
}

export async function ownedPlayerTarget(guest: WebContents): Promise<PlayerTarget | null> {
  const useFrame = await readTop(guest,'Boolean(document.querySelector("'+OWNER+'"))');
  if (useFrame === null || !isLive(guest)) return null;
  const root = guest.mainFrame, url = guest.getURL();
  const sameRoot = () => !guest.isDestroyed() && guest.mainFrame === root && eligible(guest.getURL());
  const current = () => isLive(guest) && sameRoot() && guest.getURL() === url;
  if (!useFrame) {
    return {
      evaluate: (code,gesture) => current() ? readTop(guest,code,gesture) : Promise.resolve(null),
      evaluateBound: (code,gesture) => sameRoot() ? readTop(guest,code,gesture) : Promise.resolve(undefined),
    };
  }
  let binding: FrameSession | undefined;
  const accept = (selected: FrameSession) => {
    if (!binding) { binding = selected; return true; }
    return binding.frame === selected.frame && binding.sessionId === selected.sessionId && binding.loader === selected.loader;
  };
  return {
    evaluate: (code,gesture) => current() ? readFrame(guest,code,gesture,accept) : Promise.resolve(null),
    evaluateBound: (code,gesture) => binding && sameRoot() ? readBoundFrame(guest,binding,code,gesture) : Promise.resolve(undefined),
  };
}
